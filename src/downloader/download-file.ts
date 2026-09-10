import { link, lstat, mkdir, readFile, rename } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

import pRetry, { AbortError } from 'p-retry';
import { z } from 'zod';

import type { Attachment } from '../api/schemas.ts';

import { atomicWriteJson, isExistingFile, removeIfExists } from '../utils/fs.ts';
import { RETRYABLE_STATUS, parseRetryAfterToTimestamp } from '../utils/http.ts';
import { createFileUrl, sourceIdentity } from '../utils/attachment-url.ts';
import { ProgressTracker } from './progress.ts';

const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const MAX_RETRY_WAIT_SLEEP_MS = 60_000;

export type FileManifestEntry = {
  filename: string;
  source: string;
  size: number;
  etag: string | null;
};

export type DownloadResult = {
  status: 'saved' | 'skipped';
  destination: string;
  manifest: FileManifestEntry;
};

export type DownloadFileOptions = {
  expected?: FileManifestEntry;
};

const ResumeSchema = z.object({
  version: z.literal(1),
  source: z.string(),
  etag: z.string().nullable(),
  total: z.number().int().nonnegative().safe().nullable(),
});

type ResumeMetadata = z.infer<typeof ResumeSchema>;

class RetryableDownloadError extends Error {
  retryAt = 0;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RetryableDownloadError';
  }
}

/*
 * URL and filesystem
 */

async function verifyExistingFile(
  destination: string,
  sourceIdentity: string,
  expected?: FileManifestEntry,
): Promise<FileManifestEntry | null> {
  if (!(await isExistingFile(destination))) {
    return null;
  }

  if (!expected) {
    throw new Error('Final file exists but is not recorded in the manifest: ' + destination);
  }

  if (expected.filename !== basename(destination)) {
    throw new Error(`Filename differs from manifest: ${destination}`);
  }

  if (expected.source !== sourceIdentity) {
    throw new Error('Final file originates from a different attachment: ' + destination);
  }

  const info = await lstat(destination);

  if (info.size !== expected.size) {
    throw new Error('Final file size mismatch: ' + `${destination} (disk ${info.size}, manifest ${expected.size})`);
  }

  return expected;
}

/*
 * Resume metadata
 */

function strongETag(value: string | null): string | null {
  if (!value || !/^"[^"\r\n]*"$/.test(value)) {
    return null;
  }

  return value;
}

function parseByteCount(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }

  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < 0) {
    return null;
  }

  return number;
}

async function readResumeMetadata(path: string): Promise<ResumeMetadata | null> {
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  try {
    const result = ResumeSchema.safeParse(JSON.parse(text));

    return result.success ? result.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

type ResumeContext = {
  canResume: boolean;
  metadata: ResumeMetadata | null;
  savedETag: string | null;
  offset: number;
};

async function readResumeContext(
  partialPath: string,
  metadataPath: string,
  sourceIdentity: string,
  forceRestart: boolean,
): Promise<ResumeContext> {
  const partialSize = (await isExistingFile(partialPath)) ? (await lstat(partialPath)).size : 0;

  const metadata = await readResumeMetadata(metadataPath);

  const savedETag = metadata ? strongETag(metadata.etag) : null;

  // Only resume if the server can confirm it's still the same file.
  const canResume =
    !forceRestart &&
    partialSize > 0 &&
    metadata !== null &&
    metadata.source === sourceIdentity &&
    savedETag !== null &&
    (metadata.total === null || partialSize <= metadata.total);

  return {
    canResume,
    metadata,
    savedETag,
    offset: canResume ? partialSize : 0,
  };
}

/*
 * Response interpretation
 */

type DownloadPlan = {
  status: 200 | 206;
  etag: string | null;
  startOffset: number;
  total: number | null;
  responseEnd: number | null;
};

type ResponseOutcome =
  | { kind: 'abort'; message: string }
  | { kind: 'retryFull'; message: string }
  | { kind: 'retryWithBackoff'; message: string; retryAt: number }
  | ({ kind: 'download' } & DownloadPlan);

function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '');

  if (!match) {
    return null;
  }

  const start = parseByteCount(match[1] ?? null);
  const end = parseByteCount(match[2] ?? null);
  const total = parseByteCount(match[3] ?? null);

  if (start === null || end === null || total === null) {
    return null;
  }

  return { start, end, total };
}

function buildRequestHeaders(context: ResumeContext): Headers {
  const headers = new Headers({
    'Accept-Encoding': 'identity',
  });

  if (context.canResume && context.savedETag !== null) {
    headers.set('Range', `bytes=${context.offset}-`);
    headers.set('If-Range', context.savedETag);
  }

  return headers;
}

function interpretResponse(response: Response, context: ResumeContext): ResponseOutcome {
  const { canResume, offset } = context;

  if (response.status === 416 && canResume) {
    return { kind: 'retryFull', message: 'Range rejected; next attempt will start from the beginning.' };
  }

  if (response.status !== 200 && response.status !== 206) {
    if (!RETRYABLE_STATUS.has(response.status)) {
      return { kind: 'abort', message: `Download failed: HTTP ${response.status}` };
    }

    return {
      kind: 'retryWithBackoff',
      message: `Download failed: HTTP ${response.status}`,
      retryAt: parseRetryAfterToTimestamp(response.headers.get('retry-after')),
    };
  }

  if (!response.body) {
    return { kind: 'abort', message: 'Download response has no body.' };
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.toLowerCase().includes('text/html')) {
    return { kind: 'abort', message: 'Server returned HTML instead of an attachment.' };
  }

  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();

  if (encoding && encoding !== 'identity') {
    return { kind: 'abort', message: 'Server returned a compressed response; resume offset is unsafe.' };
  }

  const etag = strongETag(response.headers.get('etag'));

  if (response.status === 206) {
    const metadata = context.metadata;

    if (!canResume || !metadata) {
      return { kind: 'abort', message: 'Server sent 206 without a resume request.' };
    }

    const range = parseContentRange(response.headers.get('content-range'));

    const bodyLength = parseByteCount(response.headers.get('content-length'));

    const invalidRange =
      range === null ||
      range.start !== offset ||
      range.end < range.start ||
      range.end >= range.total ||
      (bodyLength !== null && bodyLength !== range.end - range.start + 1);

    const changedFile =
      range !== null && (etag !== context.savedETag || (metadata.total !== null && range.total !== metadata.total));

    // Appending a different range or version would silently corrupt the file.
    if (invalidRange || changedFile) {
      return { kind: 'retryFull', message: 'Resume response mismatch; will request the full file.' };
    }

    return {
      kind: 'download',
      status: 206,
      etag,
      startOffset: offset,
      total: range.total,
      responseEnd: range.end,
    };
  }

  return {
    kind: 'download',
    status: 200,
    etag,
    startOffset: 0,
    total: parseByteCount(response.headers.get('content-length')),
    responseEnd: null,
  };
}

/*
 * Download
 */

async function streamToFile(
  response: Response,
  partialPath: string,
  plan: DownloadPlan,
  progress: ProgressTracker,
): Promise<number> {
  const source = Readable.fromWeb(response.body!);

  const writer = createWriteStream(partialPath, {
    // 206 resumes from the end of the file.
    // 200 clears the file and writes from the beginning.
    flags: plan.status === 206 ? 'a' : 'w',
  });

  try {
    await pipeline(source, progress.meter(plan.startOffset, plan.total), writer);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EIO', 'EROFS'].includes(code ?? '')) {
      throw error;
    }

    // Anything else mid-transfer (dropped connection, reset stream) keeps a
    // usable partial, so retrying from the recorded offset is safe.
    throw new RetryableDownloadError('Transfer disconnected; partial retained.', { cause: error });
  }

  return (await lstat(partialPath)).size;
}

async function finalizeDownload(
  destination: string,
  partialPath: string,
  metadataPath: string,
  expectedSize: number,
): Promise<void> {
  try {
    // A hard link fails if the destination exists, so we won't overwrite it.
    await link(partialPath, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    // Some setups have no hard links: bun-termux stubs linkat() with EXDEV,
    // and Android shared storage doesn't support them either. Same directory,
    // so a rename is still atomic — but only when nothing is in the way.
    if (code === 'EXDEV' || code === 'EPERM' || code === 'EOPNOTSUPP' || code === 'ENOSYS') {
      if (await isExistingFile(destination)) {
        throw error;
      }

      await rename(partialPath, destination);
    } else {
      throw error;
    }
  }

  const finalInfo = await lstat(destination);

  if (finalInfo.size !== expectedSize) {
    throw new Error(`File size changed during finalization: ${destination}`);
  }

  await removeIfExists(partialPath);
  await removeIfExists(metadataPath);
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

  const completed = await pRetry(
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
                throw new AbortError('Partial size changed during request.');
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
      retries: 3,
      factor: 2,
      minTimeout: 1_000,
      maxTimeout: 10_000,
      randomize: true,

      onFailedAttempt: ({ error, attemptNumber }) => {
        progress.retry(`[Download] ${file.name || file.path}: ` + `attempt ${attemptNumber} failed — ${error.message}`);
      },

      shouldRetry: async ({ error }) => {
        if (!(error instanceof RetryableDownloadError)) {
          return false;
        }

        while (Date.now() < error.retryAt) {
          await Bun.sleep(Math.min(error.retryAt - Date.now(), MAX_RETRY_WAIT_SLEEP_MS));
        }

        return true;
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
