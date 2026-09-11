import { lstat, open, rename, unlink } from 'node:fs/promises';

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

export async function atomicWriteJson(filePath: string, data: unknown, options?: { sync?: boolean }): Promise<void> {
  // Single writer per path: fixed tmp name plus exclusive create is enough.
  const temporaryPath = `${filePath}.tmp`;

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(temporaryPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }

    // Leftover from a crashed run; sweepOrphanTempFiles normally clears these.
    await removeIfExists(temporaryPath);
    handle = await open(temporaryPath, 'wx');
  }

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
