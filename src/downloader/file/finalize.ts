import { constants as fsConstants } from 'node:fs';
import { copyFile, link, lstat, open } from 'node:fs/promises';
import { basename } from 'node:path';

import { isExistingFile, removeIfExists } from '../../utils/fs.ts';

import type { FileManifestEntry } from './types.ts';

export async function verifyExistingFile(
  destination: string,
  sourceIdentity: string,
  expected?: FileManifestEntry,
): Promise<FileManifestEntry | null> {
  if (!(await isExistingFile(destination))) {
    return null;
  }

  if (!expected) {
    throw new Error('Final file exists but is not recorded in the manifest: ' + destination);
  }

  if (expected.filename !== basename(destination)) {
    throw new Error(`Filename differs from manifest: ${destination}`);
  }

  if (expected.source !== sourceIdentity) {
    throw new Error('Final file originates from a different attachment: ' + destination);
  }

  const info = await lstat(destination);

  if (info.size !== expected.size) {
    throw new Error('Final file size mismatch: ' + `${destination} (disk ${info.size}, manifest ${expected.size})`);
  }

  return expected;
}

export async function finalizeDownload(
  destination: string,
  partialPath: string,
  metadataPath: string,
  expectedSize: number,
): Promise<void> {
  // Crash consistency: manifest writes use sync; file data must be durable too.
  // 'r+' not 'r': Windows FlushFileBuffers needs write access on the handle.
  // Still best-effort below for exotic volumes where even that fails.
  const syncHandle = await open(partialPath, 'r+');

  try {
    try {
      await syncHandle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'EOPNOTSUPP') {
        console.warn(`[fsync] skipped durability sync for ${destination}: ${code}`);
      } else {
        throw error;
      }
    }
  } finally {
    await syncHandle.close();
  }

  try {
    // A hard link fails if the destination exists, so we won't overwrite it.
    await link(partialPath, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    // Some setups have no hard links: bun-termux stubs linkat() with EXDEV,
    // Android shared storage doesn't support them either.
    // Same directory, so copy with EXCL still refuses to overwrite atomically.
    if (code === 'EXDEV' || code === 'EACCES' || code === 'EPERM' || code === 'EOPNOTSUPP' || code === 'ENOSYS') {
      await copyFile(partialPath, destination, fsConstants.COPYFILE_EXCL);
    } else {
      throw error;
    }
  }

  const finalInfo = await lstat(destination);

  if (finalInfo.size !== expectedSize) {
    throw new Error(`File size changed during finalization: ${destination}`);
  }

  await removeIfExists(partialPath);
  await removeIfExists(metadataPath);
}
