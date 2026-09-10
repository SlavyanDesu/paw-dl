import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

export async function isExistingFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);

    if (!info.isFile()) {
      throw new Error(`Path already exists but is not a regular file: ${path}`);
    }

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

export async function atomicWriteJson<T>(filePath: string, data: T, options?: { sync?: boolean }): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx');

  try {
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');

      if (options?.sync) {
        await handle.sync();
      }
    } finally {
      await handle.close();
    }

    await rename(temporaryPath, filePath);
  } finally {
    await removeIfExists(temporaryPath);
  }
}
