import { expect, test } from 'bun:test';
import { parseCli } from './cli.ts';

const CREATOR = 'https://pawchive.pw/patreon/user/123';
const POST = 'https://pawchive.pw/patreon/user/123/post/456';

test('--post reaches the options as postCount', () => {
  expect(parseCli([CREATOR, '-n', '5'])?.postCount).toBe(5);
  expect(parseCli([CREATOR, '--post', '50'])?.postCount).toBe(50);
  expect(parseCli([CREATOR])?.postCount).toBeUndefined();
});

test('--post is rejected on post URLs', () => {
  expect(() => parseCli([POST, '-n', '5'])).toThrow('--post only works on creator URLs.');
});
