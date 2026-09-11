import { expect, test } from 'bun:test';
import { interpretResponse } from './response.ts';
import type { ResumeContext } from './types.ts';

const ETAG = '"6aa35c0e-ffa5b2"';
const TOTAL = 16754098;

function resumeContext(overrides: Partial<ResumeContext> = {}): ResumeContext {
  return {
    canResume: true,
    metadata: { version: 1, source: 'https://file.pawchive.pw/data/ab/file.jpg', etag: ETAG, total: TOTAL },
    savedETag: ETAG,
    offset: 100,
    ...overrides,
  };
}

function response(status: number, headers: Record<string, string>, body: string | null = 'x'): Response {
  return new Response(body, { status, headers });
}

test('416 with resume context requests full restart', () => {
  const outcome = interpretResponse(response(416, {}), resumeContext());

  expect(outcome).toEqual({
    kind: 'retryFull',
    message: 'Range rejected; next attempt will start from the beginning.',
  });
});

test('206 with mismatched range start requests full restart', () => {
  const outcome = interpretResponse(
    response(206, {
      'Content-Range': `bytes 0-199/${TOTAL}`,
      'Content-Length': '200',
      ETag: ETAG,
    }),
    resumeContext(),
  );

  expect(outcome.kind).toBe('retryFull');
});

test('206 with changed ETag requests full restart', () => {
  const outcome = interpretResponse(
    response(206, {
      'Content-Range': `bytes 100-199/${TOTAL}`,
      'Content-Length': '100',
      ETag: '"changed-version"',
    }),
    resumeContext(),
  );

  expect(outcome.kind).toBe('retryFull');
});

test('206 with changed total requests full restart', () => {
  const outcome = interpretResponse(
    response(206, {
      'Content-Range': `bytes 100-199/${TOTAL + 1}`,
      'Content-Length': '100',
      ETag: ETAG,
    }),
    resumeContext(),
  );

  expect(outcome.kind).toBe('retryFull');
});

test('206 without resume context aborts', () => {
  const outcome = interpretResponse(
    response(206, {
      'Content-Range': `bytes 100-199/${TOTAL}`,
      'Content-Length': '100',
      ETag: ETAG,
    }),
    resumeContext({ canResume: false, metadata: null, savedETag: null, offset: 0 }),
  );

  expect(outcome).toEqual({ kind: 'abort', message: 'Server sent 206 without a resume request.' });
});

test('200 after resume request plans a fresh download', () => {
  // Live servers answer 200 when the resume tag no longer matches;
  // the writer then overwrites the stale partial from the start.
  const outcome = interpretResponse(response(200, { 'Content-Length': String(TOTAL), ETag: ETAG }), resumeContext());

  expect(outcome).toEqual({
    kind: 'download',
    status: 200,
    etag: ETAG,
    startOffset: 0,
    total: TOTAL,
    responseEnd: null,
  });
});

test('HTML body aborts instead of retrying', () => {
  const outcome = interpretResponse(
    response(200, { 'Content-Type': 'text/html; charset=utf-8' }, '<html></html>'),
    resumeContext({ canResume: false, metadata: null, savedETag: null, offset: 0 }),
  );

  expect(outcome).toEqual({ kind: 'abort', message: 'Server returned HTML instead of an attachment.' });
});

test('compressed response aborts, resume offset unsafe', () => {
  const outcome = interpretResponse(
    response(200, { 'Content-Encoding': 'gzip' }),
    resumeContext({ canResume: false, metadata: null, savedETag: null, offset: 0 }),
  );

  expect(outcome).toEqual({
    kind: 'abort',
    message: 'Server returned a compressed response; resume offset is unsafe.',
  });
});

test('missing body aborts', () => {
  const outcome = interpretResponse(response(200, {}, null), resumeContext());

  expect(outcome).toEqual({ kind: 'abort', message: 'Download response has no body.' });
});

test('retryable status carries retry delay', () => {
  const outcome = interpretResponse(
    response(503, { 'Retry-After': '120' }),
    resumeContext({ canResume: false, metadata: null, savedETag: null, offset: 0 }),
  );

  expect(outcome.kind).toBe('retryWithBackoff');

  if (outcome.kind === 'retryWithBackoff') {
    expect(outcome.retryAt).toBeGreaterThan(Date.now());
  }
});

test('fatal status aborts', () => {
  const outcome = interpretResponse(response(404, {}), resumeContext());

  expect(outcome).toEqual({ kind: 'abort', message: 'Download failed: HTTP 404' });
});
