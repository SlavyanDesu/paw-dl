import { expect, test } from 'bun:test';
import { createFileUrl, sourceIdentity } from './attachment-url.ts';

test('download names do not change source identity', () => {
  const url = createFileUrl({ path: '/ab/file.jpg', name: 'photo & sketch.jpg', deferred: false });
  expect(url.searchParams.get('f')).toBe('photo & sketch.jpg');
  expect(sourceIdentity(url)).toBe('https://file.pawchive.pw/data/ab/file.jpg');
  expect(sourceIdentity(createFileUrl({ path: '/ab/file.jpg', name: 'renamed.jpg', deferred: false }))).toBe(
    sourceIdentity(url),
  );
});

test('attachment paths stay under the file origin and data directory', () => {
  for (const path of [
    'https://example.com/file',
    '//example.com/file',
    '/file?x=1',
    '/file#x',
    '/a\\b',
    '/../file',
    '/%2e%2e/file',
  ]) {
    expect(() => createFileUrl({ path, name: '', deferred: false })).toThrow();
  }
});
