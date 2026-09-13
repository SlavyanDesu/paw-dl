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

test('--flat reaches the options and is rejected on post URLs', () => {
  expect(parseCli([CREATOR, '--flat'])?.flat).toBe(true);
  expect(parseCli([CREATOR])?.flat).toBe(false);
  expect(() => parseCli([POST, '--flat'])).toThrow('--flat only works on creator URLs.');
});

test('--favorites takes a scope, needs a session and no URL', () => {
  const saved = process.env.PAWCHIVE_SESSION;

  delete process.env.PAWCHIVE_SESSION;

  try {
    expect(() => parseCli(['--favorites', 'posts'])).toThrow('need a session');
  } finally {
    if (saved !== undefined) {
      process.env.PAWCHIVE_SESSION = saved;
    }
  }
  expect(() => parseCli([CREATOR, '--favorites', 'creators', '--session', 'abc'])).toThrow('Remove the URL');
  expect(() => parseCli(['--favorites', 'bogus', '--session', 'abc'])).toThrow('posts or creators');
  expect(() => parseCli(['--favorites', 'all', '--session', 'abc'])).toThrow('posts or creators');
  expect(() => parseCli(['--favorites'])).toThrow('argument missing');

  expect(parseCli(['--favorites', 'posts', '--session', 'abc', '-n', '5'])).toMatchObject({
    favorites: 'posts',
    target: undefined,
    session: 'abc',
    postCount: 5,
  });
  expect(parseCli(['--favorites', 'creators', '--session', 'abc'])?.favorites).toBe('creators');
  expect(parseCli(['--favorites', 'posts', '--flat', '--session', 'abc'])?.flat).toBe(true);
  expect(parseCli(['--favorites', 'creators', '--flat', '--session', 'abc'])?.flat).toBe(true);
});

test('--session falls back to PAWCHIVE_SESSION', () => {
  const saved = process.env.PAWCHIVE_SESSION;
  process.env.PAWCHIVE_SESSION = 'env-cookie';

  try {
    expect(parseCli(['--favorites', 'posts'])?.session).toBe('env-cookie');
    expect(parseCli([CREATOR])?.session).toBe('env-cookie');
  } finally {
    if (saved === undefined) delete process.env.PAWCHIVE_SESSION;
    else process.env.PAWCHIVE_SESSION = saved;
  }
});
