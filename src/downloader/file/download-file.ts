import { lstat, mkdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { AbortError } from 'p-retry';

import type { Attachment } from '../../api/schemas.ts';

import { createFileUrl, sourceIdentity } from '../../utils/attachment-url.ts';
import { atomicWriteJson, removeIfExists } from '../../utils/fs.ts';
import { RetryableError, retryWithBackoff } from '../../utils/retry.ts';

import { ProgressTracker } from '../progress.ts';
import { finalizeDownload, verifyExistingFile } from './finalize.ts';
import { buildRequestHeaders, readResumeContext } from './resume.ts';
import { interpretResponse } from './response.ts';
import { streamToFile } from './stream.ts';
import { DOWNLOAD_TIMEOUT_MS, MAX_FILE_BYTES } from './types.ts';

import type { DownloadFileOptions, DownloadResult } from './types.ts';

class RetryableDownloadError extends RetryableError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RetryableDownloadError';
  }
}

async function performDownload(
  file: Attachment,
  destination: string,
  progress: ProgressTracker,
  options: DownloadFileOptions,
): Promise<DownloadResult> {
  if (file.deferred) {
    throw new Error(`Attachment not yet available: ${file.name || file.path}`);
  }

  const url = createFileUrl(file);

  const source = sourceIdentity(url);

  await mkdir(dirname(destination), {
    recursive: true,
  });

  const existing = await verifyExistingFile(destination, source, options.expected);

  if (existing) {
    progress.setState('verified');

    return {
      status: 'skipped',
      destination,
      manifest: existing,
    };
  }

  const partialPath = `${destination}.part`;
  const metadataPath = `${partialPath}.json`;

  let forceRestart = false;

  const completed = await retryWithBackoff(
    async (attemptNumber) => {
      progress.reset(attemptNumber);

      const resume = await readResumeContext(partialPath, metadataPath, source, forceRestart);

      let response: Response;

      try {
        response = await fetch(url, {
          headers: buildRequestHeaders(resume),
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch (error) {
        throw new RetryableDownloadError('File request failed.', {
          cause: error,
        });
      }

      try {
        const outcome = interpretResponse(response, resume);

        switch (outcome.kind) {
          case 'abort':
            throw new AbortError(outcome.message);

          case 'retryFull':
            forceRestart = true;

            throw new RetryableDownloadError(outcome.message);

          case 'retryWithBackoff': {
            const error = new RetryableDownloadError(outcome.message);

            error.retryAt = outcome.retryAt;

            throw error;
          }

          case 'download': {
            if (outcome.status === 206) {
              const actualSize = (await lstat(partialPath)).size;

              if (actualSize !== outcome.startOffset) {
                forceRestart = true;

                throw new RetryableDownloadError('Partial size changed during request; will re-download.');
              }
            }

            await atomicWriteJson(metadataPath, {
              version: 1,
              source,
              etag: outcome.etag,
              total: outcome.total,
            });

            forceRestart = false;

            const downloadedSize = await streamToFile(response, partialPath, outcome, progress);

            if (downloadedSize > MAX_FILE_BYTES) {
              await removeIfExists(partialPath);
              await removeIfExists(metadataPath);

              throw new AbortError('File exceeds size limit.');
            }

            if (
              (outcome.responseEnd !== null && downloadedSize > outcome.responseEnd + 1) ||
              (outcome.total !== null && downloadedSize > outcome.total)
            ) {
              forceRestart = true;

              throw new RetryableDownloadError('File size exceeds range; will re-download.');
            }

            if (
              (outcome.responseEnd !== null && downloadedSize !== outcome.responseEnd + 1) ||
              (outcome.total !== null && downloadedSize !== outcome.total)
            ) {
              throw new RetryableDownloadError('File incomplete; will attempt to resume.');
            }

            return {
              size: downloadedSize,
              etag: outcome.etag,
            };
          }
        }
      } finally {
        if (response.body && !response.body.locked) {
          await response.body.cancel().catch(() => {});
        }
      }
    },
    {
      onFailedAttempt: (error, attemptNumber) => {
        progress.retry(`[Download] ${file.name || file.path}: ` + `attempt ${attemptNumber} failed — ${error.message}`);
      },
    },
  );

  progress.setState('finalizing');

  await finalizeDownload(destination, partialPath, metadataPath, completed.size);

  return {
    status: 'saved',
    destination,
    manifest: {
      filename: basename(destination),
      source,
      size: completed.size,
      etag: completed.etag,
    },
  };
}

export async function downloadFile(
  file: Attachment,
  destination: string,
  options: DownloadFileOptions = {},
): Promise<DownloadResult> {
  const progress = new ProgressTracker(destination);

  try {
    return await performDownload(file, destination, progress, options);
  } finally {
    progress.close();
  }
}
