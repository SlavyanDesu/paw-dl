import { basename, join } from 'node:path';

import type { Attachment, Post } from '../../api/schemas.ts';

import { createFileName, getAttachmentExtension } from '../../utils/filename.ts';
import { createFileUrl, sourceIdentity } from '../../utils/attachment-url.ts';

import type { FileManifestEntry } from '../file/types.ts';
import type { PostManifest } from './manifest.ts';

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

export type DownloadJob = {
  file: Attachment;
  destination: string;
  source: string;
  expected?: FileManifestEntry;
};

export function collectFiles(post: Post, includeFiles: string[]): Attachment[] {
  const candidates = [post.file, ...post.attachments];

  const additionalExtensions = new Set(includeFiles);

  const includeAll = additionalExtensions.has('all');

  const seen = new Set<string>();
  const files: Attachment[] = [];

  for (const file of candidates) {
    if (!file || file.deferred || seen.has(file.path)) {
      continue;
    }

    const extension = getAttachmentExtension(file.name, file.path);

    const allowed = includeAll || MEDIA_EXTENSIONS.has(extension) || additionalExtensions.has(extension);

    if (!allowed) {
      continue;
    }

    seen.add(file.path);
    files.push(file);
  }

  return files;
}

export function createJobs(
  files: Attachment[],
  directory: string,
  fileStem: string,
  manifest: PostManifest,
  occupiedNames = new Set<string>(),
): { jobs: DownloadJob[]; jobFailures: { destination: string; error: unknown }[] } {
  const existingBySource = new Map<string, FileManifestEntry>();

  for (const [sourceKey, entry] of Object.entries(manifest.files)) {
    // Key and source must be consistent.
    if (sourceKey !== entry.source) {
      throw new Error(`Manifest has a mismatched source key: ${sourceKey}`);
    }

    existingBySource.set(entry.source, entry);

    occupiedNames.add(entry.filename.normalize('NFC').toLowerCase());
  }

  let nextOrder = 1;
  const jobs: DownloadJob[] = [];
  const jobFailures: { destination: string; error: unknown }[] = [];
  const seenSources = new Set<string>();

  for (const file of files) {
    let source: string;

    try {
      source = sourceIdentity(createFileUrl(file));
    } catch (error) {
      // A bad record fails only its own file, never the whole post.
      jobFailures.push({
        destination: join(directory, file.name || file.path || 'unknown'),
        error,
      });

      continue;
    }
    if (seenSources.has(source)) continue;
    seenSources.add(source);
    const existing = existingBySource.get(source);

    // Keep the old filename when rerunning with a different filter.
    if (existing) {
      const destination = join(directory, existing.filename);

      // Recheck against the schema: manifest names must never escape the folder.
      if (basename(destination) !== existing.filename) {
        throw new Error(`Manifest filename escapes post folder: ${existing.filename}`);
      }

      jobs.push({
        file,
        source,
        expected: existing,
        destination,
      });

      continue;
    }

    let filename: string;

    do {
      filename = createFileName(fileStem, file.name, file.path, nextOrder);

      nextOrder++;
    } while (occupiedNames.has(filename.normalize('NFC').toLowerCase()));

    occupiedNames.add(filename.normalize('NFC').toLowerCase());

    jobs.push({
      file,
      source,
      destination: join(directory, filename),
    });
  }

  return { jobs, jobFailures };
}
