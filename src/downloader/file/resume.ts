import { lstat, readFile } from 'node:fs/promises';

import { isExistingFile } from '../../utils/fs.ts';

import type { ResumeContext, ResumeMetadata } from './types.ts';

const RESUME_VERSION = 1;

export function strongETag(value: string | null): string | null {
  if (!value || !/^"[^"\r\n]*"$/.test(value)) {
    return null;
  }

  return value;
}

export function parseByteCount(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }

  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < 0) {
    return null;
  }

  return number;
}

function isResumeMetadata(value: unknown): value is ResumeMetadata {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  if (record['version'] !== RESUME_VERSION) {
    return false;
  }

  if (typeof record['source'] !== 'string') {
    return false;
  }

  const etag = record['etag'];
  const total = record['total'];

  if (etag !== null && typeof etag !== 'string') {
    return false;
  }

  if (total !== null && (!Number.isSafeInteger(total) || (total as number) < 0)) {
    return false;
  }

  return true;
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
    const parsed: unknown = JSON.parse(text);

    return isResumeMetadata(parsed) ? parsed : null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

export async function readResumeContext(
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

export function buildRequestHeaders(context: ResumeContext): Headers {
  const headers = new Headers({
    'Accept-Encoding': 'identity',
  });

  if (context.canResume && context.savedETag !== null) {
    headers.set('Range', `bytes=${context.offset}-`);
    headers.set('If-Range', context.savedETag);
  }

  return headers;
}
