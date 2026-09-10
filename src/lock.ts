import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWriteJson, removeIfExists } from './utils/fs.ts';

const LOCK_NAME = '.paw-dl.lock';

type LockData = {
  pid: number;
  startedAt: string;
  target: string;
};

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

  try {
    return JSON.parse(text) as LockData;
  } catch {
    return null;
  }
}

async function writeLock(lockPath: string, data: LockData): Promise<void> {
  await atomicWriteJson(lockPath, data);
}

export async function acquireLock(output: string, target: string, force = false): Promise<void> {
  const lockPath = join(output, LOCK_NAME);

  await mkdir(output, {
    recursive: true,
  });

  const existing = await readLock(lockPath);

  if (existing && !force) {
    if (isProcessAlive(existing.pid)) {
      throw new Error(`Output is currently locked (PID ${existing.pid}). ` + 'Use --force to bypass.');
    }
  }

  await writeLock(lockPath, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    target,
  });
}

export async function releaseLock(output: string): Promise<void> {
  const lockPath = join(output, LOCK_NAME);

  const existing = await readLock(lockPath);

  if (existing && existing.pid === process.pid) {
    await removeIfExists(lockPath);
  }
}
