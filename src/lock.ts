import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { removeIfExists } from './utils/fs.ts';

const LOCK_NAME = '.paw-dl.lock';

// Only retry briefly; a stuck writer means something else is wrong.
const MAX_ACQUIRE_ATTEMPTS = 10;
const LOCK_RETRY_DELAY_MS = 50;

type LockData = {
  pid: number;
  startedAt: string;
  target: string;
};

function isLockData(value: unknown): value is LockData {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    Number.isSafeInteger(record['pid']) &&
    (record['pid'] as number) > 0 &&
    typeof record['startedAt'] === 'string' &&
    (record['startedAt'] as string).length > 0 &&
    typeof record['target'] === 'string' &&
    (record['target'] as string).length > 0
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      return true;
    }
    return false;
  }
}

async function readLock(lockPath: string): Promise<LockData | null> {
  let text: string;

  try {
    text = await readFile(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  const data = tryParseJson(text);

  // A corrupt file is usually a half-written lock from a crashed process.
  // Return null so the caller waits, rereads, and only then treats it as stale.
  return isLockData(data) ? data : null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function createLockFile(lockPath: string, data: LockData): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    // Exclusive create: the filesystem decides the winner, not our read check.
    handle = await open(lockPath, 'wx');
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }

    throw error;
  } finally {
    await handle?.close();
  }
}

export async function acquireLock(output: string, target: string, force = false): Promise<void> {
  const lockPath = join(output, LOCK_NAME);

  await mkdir(output, {
    recursive: true,
  });

  const wanted: LockData = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    target,
  };

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    if (await createLockFile(lockPath, wanted)) {
      return;
    }

    const existing = await readLock(lockPath);

    if (!existing) {
      // Deleted between our attempt and read, or still being written. Wait and
      // reread; a file that stays unreadable is a crashed writer's leftover.
      await Bun.sleep(LOCK_RETRY_DELAY_MS);

      if (await readLock(lockPath)) {
        continue;
      }

      await removeIfExists(lockPath);
      continue;
    }

    if (!force && isProcessAlive(existing.pid)) {
      throw new Error(`Output is currently locked (PID ${existing.pid}). ` + 'Use --force to bypass.');
    }

    // Stale lock (or --force): remove it, then loop back to the exclusive create.
    // If another process wins the race, our next create returns false and we recheck.
    await removeIfExists(lockPath);
  }

  throw new Error(`Could not acquire output lock: ${lockPath}`);
}

export async function releaseLock(output: string): Promise<void> {
  const lockPath = join(output, LOCK_NAME);

  const existing = await readLock(lockPath);

  if (existing && existing.pid === process.pid) {
    await removeIfExists(lockPath);
  }
}
