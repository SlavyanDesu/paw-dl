import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const LOCK_NAME = ".paw-dl.lock";

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
    // EPERM berarti proses ada tetapi tidak punya izin sinyal.
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }

    return false;
  }
}

async function readLock(lockPath: string): Promise<LockData | null> {
  let text: string;

  try {
    text = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
  const temporaryPath = `${lockPath}.${randomUUID()}.tmp`;

  const handle = await open(temporaryPath, "wx");

  try {
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }

    await rename(temporaryPath, lockPath);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch {
      // abaikan
    }
  }
}

export async function acquireLock(
  output: string,
  target: string,
  force = false,
): Promise<void> {
  const lockPath = join(output, LOCK_NAME);

  await mkdir(output, {
    recursive: true,
  });

  const existing = await readLock(lockPath);

  if (existing && !force) {
    if (isProcessAlive(existing.pid)) {
      throw new Error(
        `Output sudah dikunci oleh proses lain (PID ${existing.pid}). ` +
          "Gunakan --force untuk mengabaikan kunci.",
      );
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
    try {
      await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
