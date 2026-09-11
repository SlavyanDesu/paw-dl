import { RETRYABLE_STATUS, parseRetryAfterToTimestamp } from '../../utils/http.ts';

import { parseByteCount, strongETag } from './resume.ts';

import type { ResponseOutcome, ResumeContext } from './types.ts';

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

export function interpretResponse(response: Response, context: ResumeContext): ResponseOutcome {
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
