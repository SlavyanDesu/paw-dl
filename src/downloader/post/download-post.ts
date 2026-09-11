import { join } from 'node:path';

import type { Post } from '../../api/schemas.ts';
import type { CreatorRef } from '../../api/client.ts';

import { createPostNames } from '../../utils/filename.ts';
import { atomicWriteJson } from '../../utils/fs.ts';

import { downloadFile } from '../file/download-file.ts';
import type { createQueue } from '../queue.ts';
import { preparePostDirectory } from './directory.ts';
import { collectFiles, createJobs } from './jobs.ts';
import { readManifest, safeLogPath, sweepOrphanTempFiles } from './manifest.ts';

type Queue = ReturnType<typeof createQueue>;

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

  await sweepOrphanTempFiles(directory);

  const { jobs, jobFailures } = createJobs(files, directory, names.fileStem, manifest);

  for (const failure of jobFailures) {
    summary.failures.push(failure);

    const message = failure.error instanceof Error ? failure.error.message : String(failure.error);

    console.error(`[failed] ${safeLogPath(failure.destination)}: ${message}`);
  }

  console.log(`[Post ${post.id}] ${post.title}: ` + `${jobs.length} file`);

  // Record each save right away, so a crash keeps finished files.
  // A failed save must not block the saves after it.
  let persist: Promise<void> = Promise.resolve();

  const results = await queue.run(
    jobs.map((job) => async () => {
      const result = await downloadFile(job.file, job.destination, {
        expected: job.expected,
      });

      if (result.status === 'saved') {
        manifest.files[result.manifest.source] = result.manifest;
        persist = persist.catch(() => {}).then(() => atomicWriteJson(manifestPath, manifest, { sync: true }));
        await persist;
      }

      return result;
    }),
  );

  // Failures are already counted per file above; a bad final save must not throw here.
  await persist.catch(() => {});

  for (const [index, result] of results.entries()) {
    const job = jobs[index];

    if (!job) {
      throw new Error('Queue result does not match job.');
    }

    if (result.status === 'fulfilled') {
      if (result.value.status === 'saved') {
        summary.saved++;
      } else {
        summary.skipped++;
      }

      console.log(`[${result.value.status}] ` + safeLogPath(job.destination));

      continue;
    }

    summary.failures.push({
      destination: job.destination,
      error: result.reason,
    });

    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);

    console.error(`[failed] ${safeLogPath(job.destination)}: ${message}`);
  }

  return summary;
}
