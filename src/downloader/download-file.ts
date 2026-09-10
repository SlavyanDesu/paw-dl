import { link, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

import cliProgress from 'cli-progress';
import pRetry, { AbortError } from 'p-retry';
import { z } from 'zod';

import type { Attachment } from '../api/schemas.ts';

import { atomicWriteJson, isExistingFile, removeIfExists } from '../utils/fs.ts';
import { FILE_ORIGIN, RETRYABLE_STATUS, parseRetryAfterToTimestamp } from '../utils/http.ts';

const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const MAX_RETRY_WAIT_SLEEP_MS = 60_000;
const PROGRESS_THROTTLE_MS = 200;
const PROGRESS_BAR_SIZE = 16;
const PROGRESS_FPS = 5;
const MAX_DISPLAY_NAME_LENGTH = 32;

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
 * Progress bar
 */

const PROGRESS_FORMAT = '{bar} | {filename} | {percent} | {size} | {speed} | ETA {etaText} | {state}';

const PROGRESS_INITIAL_STATE = {
  percent: '--',
  size: '0 B / ?',
  speed: '--',
  etaText: '--',
  state: 'waiting',
};

let progressGroup: cliProgress.MultiBar | undefined;
let activeProgressBars = 0;

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  const decimals = unitIndex === 0 ? 0 : 1;

  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

class ProgressTracker {
  private readonly group: cliProgress.MultiBar | undefined;
  private readonly bar: cliProgress.SingleBar | undefined;

  private received = 0;
  private initialBytes = 0;
  private total: number | null = null;
  private startedAt = performance.now();
  private lastUpdate = 0;

  constructor(destination: string) {
    if (process.stderr.isTTY && !progressGroup) {
      progressGroup = new cliProgress.MultiBar(
        {
          format: PROGRESS_FORMAT,
          barsize: PROGRESS_BAR_SIZE,
          fps: PROGRESS_FPS,
          hideCursor: true,
          clearOnComplete: true,
          stopOnComplete: false,
        },
        cliProgress.Presets.shades_classic,
      );
    }

    this.group = progressGroup;

    const displayName = Array.from(basename(destination).replace(/[\u0000-\u001F\u007F]/g, '_'))
      .slice(0, MAX_DISPLAY_NAME_LENGTH)
      .join('');

    this.bar = this.group?.create(1, 0, {
      filename: displayName,
      ...PROGRESS_INITIAL_STATE,
    });

    if (this.bar) {
      activeProgressBars++;
    }
  }

  private render(force = false): void {
    const now = performance.now();

    if (!force && now - this.lastUpdate < PROGRESS_THROTTLE_MS) {
      return;
    }

    this.lastUpdate = now;

    const elapsedSeconds = (now - this.startedAt) / 1_000;
    const transferred = this.received - this.initialBytes;

    const speed = elapsedSeconds > 0 ? transferred / elapsedSeconds : 0;

    const currentTotal = this.total;

    let percentage: number | null = null;
    let eta: number | null = null;
    let progressValue = 0;

    if (currentTotal !== null && currentTotal > 0) {
      percentage = Math.min((this.received / currentTotal) * 100, 100);

      progressValue = Math.min(this.received, currentTotal);

      if (speed > 0) {
        eta = Math.ceil(Math.max(currentTotal - this.received, 0) / speed);
      }
    }

    this.bar?.update(progressValue, {
      percent: percentage === null ? '--' : `${percentage.toFixed(1)}%`,

      size: `${formatBytes(this.received)} / ` + `${currentTotal === null ? '?' : formatBytes(currentTotal)}`,

      speed: `${formatBytes(speed)}/s`,
      etaText: eta === null ? '--' : `${eta}s`,
    });
  }

  reset(attempt: number): void {
    this.received = 0;
    this.initialBytes = 0;
    this.total = null;
    this.startedAt = performance.now();
    this.lastUpdate = 0;

    this.bar?.setTotal(1);

    this.bar?.update(0, {
      ...PROGRESS_INITIAL_STATE,
      state: `request #${attempt}`,
    });
  }

  meter(offset: number, totalBytes: number | null): Transform {
    this.initialBytes = offset;
    this.received = offset;
    this.total = totalBytes;
    this.startedAt = performance.now();
    this.lastUpdate = 0;

    this.bar?.setTotal(totalBytes !== null && totalBytes > 0 ? totalBytes : 1);

    this.bar?.update({
      state: offset > 0 ? 'resume' : 'download',
    });

    this.render(true);

    return new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        this.received += chunk.byteLength;
        this.render();

        callback(null, chunk);
      },

      flush: (callback) => {
        this.render(true);
        callback();
      },
    });
  }

  setState(state: string): void {
    this.bar?.update({
      state,
      speed: '--',
      etaText: '--',
    });
  }

  retry(message: string): void {
    this.bar?.update({
      state: 'waiting for retry',
      speed: '--',
      etaText: '--',
    });

    const safeMessage = message.replace(/[\u0000-\u001F\u007F]/g, ' ');

    if (this.group) {
      this.group.log(`${safeMessage}\n`);
    } else {
      console.warn(safeMessage);
    }
  }

  close(): void {
    if (!this.group || !this.bar) {
      return;
    }

    this.group.remove(this.bar);
    activeProgressBars--;

    if (activeProgressBars === 0) {
      this.group.stop();
      progressGroup = undefined;
    }
  }
}

/*
 * URL and filesystem
 */

function createFileUrl(file: Attachment): URL {
  if (!file.path.startsWith('/') || file.path.startsWith('//') || /[\\?#]/.test(file.path)) {
    throw new Error(`Invalid attachment path: ${file.path}`);
  }

  const url = new URL(`/data${file.path}`, FILE_ORIGIN);

  if (url.origin !== FILE_ORIGIN || !url.pathname.startsWith('/data/')) {
    throw new Error('Attachment URL escapes file location.');
  }

  if (file.name) {
    url.searchParams.set('f', file.name);
  }

  return url;
}

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

async function writeResumeMetadata(path: string, metadata: ResumeMetadata): Promise<void> {
  await atomicWriteJson(path, metadata);
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

  let sourceFailed = false;

  source.once('error', () => {
    sourceFailed = true;
  });

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

    if (sourceFailed) {
      throw new RetryableDownloadError('Transfer disconnected; partial retained.', { cause: error });
    }

    throw error;
  }

  return (await lstat(partialPath)).size;
}

async function finalizeDownload(
  destination: string,
  partialPath: string,
  metadataPath: string,
  expectedSize: number,
): Promise<void> {
  await link(partialPath, destination);

  const finalInfo = await lstat(destination);

  if (finalInfo.size !== expectedSize) {
    throw new Error(`File size changed during finalization: ${destination}`);
  }

  await unlink(partialPath);
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

  // The ?f= parameter only affects the download filename.
  const sourceIdentity = `${url.origin}${url.pathname}`;

  await mkdir(dirname(destination), {
    recursive: true,
  });

  const existing = await verifyExistingFile(destination, sourceIdentity, options.expected);

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

      const resume = await readResumeContext(partialPath, metadataPath, sourceIdentity, forceRestart);

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

            await writeResumeMetadata(metadataPath, {
              version: 1,
              source: sourceIdentity,
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
      source: sourceIdentity,
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
