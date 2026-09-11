import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { CreatorRef } from '../../api/client.ts';
import { getPost, iterateCreatorPosts } from '../../api/client.ts';

import { atomicWriteJson } from '../../utils/fs.ts';
import { createFlatFileStem } from '../../utils/filename.ts';
import { errorMessage } from '../../utils/http.ts';

import { downloadFile } from '../file/download-file.ts';
import type { createQueue } from '../queue.ts';
import { collectFiles, createJobs } from './jobs.ts';
import { readManifest, safeLogPath } from './manifest.ts';

type Queue = ReturnType<typeof createQueue>;

export type FlatDownloadResult = {
  posts: number;
  saved: number;
  skipped: number;
  failedPosts: number;
  failures: {
    destination: string;
    error: unknown;
  }[];
};

type DownloadFlatOptions = {
  creator: CreatorRef;
  userName: string;
  output: string;
  queue: Queue;
  includeFiles: string[];
  postCount?: number;
};

/*
 * Every post's files land directly in the output folder.
 * Stems carry date + post ID, so same-title posts never collide.
 */
export async function downloadFlat(options: DownloadFlatOptions): Promise<FlatDownloadResult> {
  const { creator, userName, output, queue, includeFiles, postCount } = options;

  const summary: FlatDownloadResult = { posts: 0, saved: 0, skipped: 0, failedPosts: 0, failures: [] };
  const failedPostIds = new Set<string>();

  type PlannedJob = ReturnType<typeof createJobs>['jobs'][number];
  const jobs: { job: PlannedJob; postId: string }[] = [];

  const noteFailure = (destination: string, error: unknown, postId?: string): void => {
    summary.failures.push({ destination, error });

    if (postId && !failedPostIds.has(postId)) {
      failedPostIds.add(postId);
      summary.failedPosts++;
    }

    const message = error instanceof Error ? error.message : String(error);

    console.error(`[failed] ${safeLogPath(destination)}: ${message}`);
  };

  await mkdir(output, { recursive: true });

  const identity = JSON.stringify([creator.service, creator.userId]);
  const manifestPath = join(output, '.manifest.json');
  const manifest = await readManifest(manifestPath, identity);

  try {
    for await (const postSummary of iterateCreatorPosts(creator, postCount)) {
      let detail;
      try {
        detail = await getPost(creator, postSummary.id);
      } catch (error) {
        summary.posts++;
        noteFailure(`[Post ${postSummary.id}]`, error, postSummary.id);
        continue;
      }

      summary.posts++;

      const files = collectFiles(detail, includeFiles);

      if (files.length === 0) {
        console.log(`[Post ${detail.id}] No files ` + 'available matching the filter.');
        continue;
      }

      let planned;
      try {
        planned = createJobs(
          files,
          output,
          createFlatFileStem(userName, detail.title, detail.published, detail.id),
          manifest,
        );
      } catch (error) {
        noteFailure(`[Post ${detail.id}]`, error, detail.id);
        continue;
      }

      for (const failure of planned.jobFailures) {
        noteFailure(failure.destination, failure.error, detail.id);
      }

      for (const job of planned.jobs) {
        jobs.push({ job, postId: detail.id });
      }
    }
  } catch (error) {
    console.error(`[Creator listing] ${errorMessage(error)}`);
    summary.failures.push({ destination: output, error });
  }

  console.log(`[Flat] ${jobs.length} file(s) into ${output}`);

  // Record each save right away, so a crash keeps finished files.
  // A failed save must not block the saves after it.
  let persist: Promise<void> = Promise.resolve();

  const results = await queue.run(
    jobs.map(({ job }) => async () => {
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

  // Failures are already counted per file below; a bad final save must not throw here.
  await persist.catch(() => {});

  for (const [index, result] of results.entries()) {
    const entry = jobs[index];

    if (!entry) {
      throw new Error('Queue result does not match job.');
    }

    const { job, postId } = entry;

    if (result.status === 'fulfilled') {
      if (result.value.status === 'saved') {
        summary.saved++;
      } else {
        summary.skipped++;
      }

      console.log(`[${result.value.status}] ` + safeLogPath(job.destination));

      continue;
    }

    noteFailure(job.destination, result.reason, postId);
  }

  return summary;
}
