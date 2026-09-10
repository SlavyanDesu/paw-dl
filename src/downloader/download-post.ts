import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';

import { z } from 'zod';

import type { Attachment, Post } from '../api/schemas.ts';
import type { CreatorRef } from '../api/client.ts';

import { createFileName, createPostNames, sanitizeName } from '../utils/filename.ts';

import { downloadFile, type FileManifestEntry } from './download-file.ts';

import type { createQueue } from './queue.ts';

type Queue = ReturnType<typeof createQueue>;

const FILE_ORIGIN = 'https://file.pawchive.pw';

const MEDIA_EXTENSIONS = new Set([
  // Images
  'jpg',
  'jpeg',
  'jfif',
  'png',
  'gif',
  'webp',
  'avif',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'heif',
  'apng',
  'svg',

  // Video
  'mp4',
  'm4v',
  'mkv',
  'webm',
  'mov',
  'avi',
  'wmv',
  'flv',
  'mpg',
  'mpeg',
  '3gp',
]);

const ManifestEntrySchema = z.object({
  filename: z.string().min(1),
  source: z.string().min(1),
  size: z.number().int().nonnegative().safe(),
  etag: z.string().nullable(),
});

const PostManifestSchema = z.object({
  version: z.literal(1),
  identity: z.string(),
  files: z.record(z.string(), ManifestEntrySchema),
});

type PostManifest = z.infer<typeof PostManifestSchema>;

export type PostDownloadResult = {
  postId: string;
  directory: string | null;
  saved: number;
  skipped: number;
  failures: {
    destination: string;
    error: unknown;
  }[];
};

type DownloadPostOptions = {
  creator: CreatorRef;
  userName: string;
  post: Post;
  output: string;
  queue: Queue;
  includeFiles: string[];
};

type DownloadJob = {
  file: Attachment;
  destination: string;
  source: string;
  expected?: FileManifestEntry;
};

/*
 * Attachment filtering
 */

function getFileExtension(file: Attachment): string {
  for (const source of [file.name, file.path]) {
    const cleanSource = source.split(/[?#]/)[0] ?? '';

    const extension = extname(cleanSource).slice(1).toLowerCase();

    if (/^[a-z0-9]{1,10}$/.test(extension)) {
      return extension;
    }
  }

  return '';
}

function collectFiles(post: Post, includeFiles: string[]): Attachment[] {
  const candidates = [post.file, ...post.attachments];

  const additionalExtensions = new Set(includeFiles);

  const includeAll = additionalExtensions.has('all');

  const seen = new Set<string>();
  const files: Attachment[] = [];

  for (const file of candidates) {
    if (!file || file.deferred || seen.has(file.path)) {
      continue;
    }

    const extension = getFileExtension(file);

    const allowed = includeAll || MEDIA_EXTENSIONS.has(extension) || additionalExtensions.has(extension);

    if (!allowed) {
      continue;
    }

    seen.add(file.path);
    files.push(file);
  }

  return files;
}

/*
 * Folder post
 */

async function preparePostDirectory(
  output: string,
  folderName: string,
  identity: string,
  postId: string,
): Promise<string> {
  await mkdir(output, {
    recursive: true,
  });

  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = attempt === 0 ? '' : ` [${sanitizeName(postId)}${attempt > 1 ? `-${attempt}` : ''}]`;

    const directory = join(output, folderName + suffix);

    const markerPath = join(directory, '.post-id');

    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }

      const info = await lstat(directory);

      if (!info.isDirectory()) {
        continue;
      }

      try {
        const existingIdentity = await readFile(markerPath, 'utf8');

        if (existingIdentity === identity) {
          return directory;
        }
      } catch (markerError) {
        if ((markerError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw markerError;
        }
      }

      continue;
    }

    await writeFile(markerPath, identity, {
      encoding: 'utf8',
      flag: 'wx',
    });

    return directory;
  }

  throw new Error(`Unable to determine unique folder: ${folderName}`);
}

/*
 * Manifest
 */

async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

async function readManifest(path: string, identity: string): Promise<PostManifest> {
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        version: 1,
        identity,
        files: {},
      };
    }

    throw error;
  }

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Manifest is not valid JSON: ${path}`);
  }

  const result = PostManifestSchema.safeParse(json);

  if (!result.success) {
    throw new Error(`Invalid manifest format: ${path}\n` + z.prettifyError(result.error));
  }

  if (result.data.identity !== identity) {
    throw new Error(`Manifest belongs to a different post: ${path}`);
  }

  return result.data;
}

async function writeManifest(path: string, manifest: PostManifest): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;

  const handle = await open(temporaryPath, 'wx');

  try {
    try {
      await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      // Ask the filesystem to flush the file
      // before publishing the manifest.
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporaryPath, path);
  } finally {
    await removeIfExists(temporaryPath);
  }
}

/*
 * Stable naming
 */

function createSourceIdentity(file: Attachment): string {
  if (!file.path.startsWith('/') || file.path.startsWith('//') || /[\\?#]/.test(file.path)) {
    throw new Error(`Path attachment tidak valid: ${file.path}`);
  }

  const url = new URL(`/data${file.path}`, FILE_ORIGIN);

  if (url.origin !== FILE_ORIGIN || !url.pathname.startsWith('/data/')) {
    throw new Error('URL attachment keluar dari lokasi file.');
  }

  return `${url.origin}${url.pathname}`;
}

function createJobs(files: Attachment[], directory: string, fileStem: string, manifest: PostManifest): DownloadJob[] {
  const existingBySource = new Map<string, FileManifestEntry>();

  const occupiedNames = new Set<string>();

  for (const [sourceKey, entry] of Object.entries(manifest.files)) {
    // Key and source must be consistent.
    if (sourceKey !== entry.source) {
      throw new Error(`Manifest has a mismatched source key: ${sourceKey}`);
    }

    existingBySource.set(entry.source, entry);

    occupiedNames.add(entry.filename.toLowerCase());
  }

  let nextOrder = 1;
  const jobs: DownloadJob[] = [];

  for (const file of files) {
    const source = createSourceIdentity(file);
    const existing = existingBySource.get(source);

    if (existing) {
      jobs.push({
        file,
        source,
        expected: existing,
        destination: join(directory, existing.filename),
      });

      continue;
    }

    let filename: string;

    do {
      filename = createFileName(fileStem, file.name, file.path, nextOrder);

      nextOrder++;
    } while (occupiedNames.has(filename.toLowerCase()));

    occupiedNames.add(filename.toLowerCase());

    jobs.push({
      file,
      source,
      destination: join(directory, filename),
    });
  }

  return jobs;
}

/*
 * Download satu post
 */

export async function downloadPost(options: DownloadPostOptions): Promise<PostDownloadResult> {
  const { creator, userName, post, output, queue, includeFiles } = options;

  const summary: PostDownloadResult = {
    postId: post.id,
    directory: null,
    saved: 0,
    skipped: 0,
    failures: [],
  };

  const files = collectFiles(post, includeFiles);

  if (files.length === 0) {
    console.log(`[Post ${post.id}] No files ` + 'available matching the filter.');

    return summary;
  }

  const names = createPostNames(userName, post.title, post.published);

  const identity = JSON.stringify([creator.service, creator.userId, post.id]);

  const directory = await preparePostDirectory(output, names.folderName, identity, post.id);

  summary.directory = directory;

  const manifestPath = join(directory, '.manifest.json');

  const manifest = await readManifest(manifestPath, identity);

  const jobs = createJobs(files, directory, names.fileStem, manifest);

  console.log(`[Post ${post.id}] ${post.title}: ` + `${jobs.length} file`);

  const results = await queue.run(
    jobs.map(
      (job) => () =>
        downloadFile(job.file, job.destination, {
          expected: job.expected,
        }),
    ),
  );

  let manifestChanged = false;

  for (const [index, result] of results.entries()) {
    const job = jobs[index];

    if (!job) {
      throw new Error('Queue result does not match job.');
    }

    if (result.status === 'fulfilled') {
      summary[result.value.status]++;

      const entry = result.value.manifest;

      manifest.files[entry.source] = entry;
      manifestChanged = true;

      console.log(`[${result.value.status}] ` + job.destination);

      continue;
    }

    summary.failures.push({
      destination: job.destination,
      error: result.reason,
    });

    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);

    console.error(`[failed] ${job.destination}: ${message}`);
  }

  if (manifestChanged) {
    await writeManifest(manifestPath, manifest);
  }

  return summary;
}
