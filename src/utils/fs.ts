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
  // One writer per path, so a fixed tmp name plus exclusive create is safe.
  const temporaryPath = `${filePath}.tmp`;

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(temporaryPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }

    // Leftover from a crashed run; the post runner usually sweeps these first.
    await removeIfExists(temporaryPath);
    handle = await open(temporaryPath, 'wx');
  }

  try {
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');

      if (options?.sync) {
        try {
          await handle.sync();
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;

          // Flushing is only a hint; on volumes that refuse it, warn and go on.
          if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'EOPNOTSUPP') {
            console.warn(`[fsync] skipped durability sync for ${filePath}: ${code}`);
          } else {
            throw error;
          }
        }
      }
    } finally {
      await handle.close();
    }

    await rename(temporaryPath, filePath);
  } finally {
    await removeIfExists(temporaryPath);
  }
}
