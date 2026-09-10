import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock } from './lock.ts';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'paw-dl-lock-'));
}

test('only one concurrent acquire wins', async () => {
  const directory = await tempDir();

  try {
    const [first, second] = await Promise.allSettled([
      acquireLock(directory, 'target-a'),
      acquireLock(directory, 'target-b'),
    ]);

    const fulfilled = [first, second].filter((result) => result.status === 'fulfilled');
    const rejected = [first, second].filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/locked/);

    await releaseLock(directory);
    await acquireLock(directory, 'target-c');
    await releaseLock(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('dead locks are reclaimed, live locks are not', async () => {
  const directory = await tempDir();

  try {
    // No such process, so the next acquire must take over the directory.
    await writeFile(
      join(directory, '.paw-dl.lock'),
      JSON.stringify({ pid: 2147483647, startedAt: new Date().toISOString(), target: 'old' }),
    );
    await acquireLock(directory, 'new');
    expect(JSON.parse(await readFile(join(directory, '.paw-dl.lock'), 'utf8')).target).toBe('new');

    // Our own lock stays: a second acquire without --force must fail.
    await expect(acquireLock(directory, 'other')).rejects.toThrow(/locked/);
    await releaseLock(directory);

    // A half-written lock from a crashed process must not block forever either.
    await writeFile(join(directory, '.paw-dl.lock'), '{"pid":');
    await acquireLock(directory, 'recovered');
    await releaseLock(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release only removes our own lock', async () => {
  const directory = await tempDir();

  try {
    await writeFile(
      join(directory, '.paw-dl.lock'),
      JSON.stringify({ pid: 2147483647, startedAt: new Date().toISOString(), target: 'someone-else' }),
    );
    await releaseLock(directory);
    expect(JSON.parse(await readFile(join(directory, '.paw-dl.lock'), 'utf8')).target).toBe('someone-else');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
