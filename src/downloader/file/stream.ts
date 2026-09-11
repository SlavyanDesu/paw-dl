import { createWriteStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AbortError } from 'p-retry';

import { isExistingFile, removeIfExists } from '../../utils/fs.ts';
import { RetryableError } from '../../utils/retry.ts';

import type { ProgressTracker } from '../progress.ts';
import { MAX_FILE_BYTES } from './types.ts';

import type { DownloadPlan } from './types.ts';

export async function streamToFile(
  response: Response,
  partialPath: string,
  plan: DownloadPlan,
  progress: ProgressTracker,
): Promise<number> {
  const source = Readable.fromWeb(response.body!);

  // Recheck right before opening: catches a link swapped in after the first check.
  // A local writer racing this exact moment still wins; that threat is accepted.
  await isExistingFile(partialPath).catch((error) => {
    if (error instanceof Error && error.message.startsWith('Path already exists')) {
      throw error;
    }
  });

  const writer = createWriteStream(partialPath, {
    // 206 resumes from the end of the file.
    // 200 clears the file and writes from the beginning.
    flags: plan.status === 206 ? 'a' : 'w',
  });

  try {
    await pipeline(source, progress.meter(plan.startOffset, plan.total, MAX_FILE_BYTES), writer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Size cap exceeded: drop partial so next run starts clean.
    if (message.includes('size limit')) {
      await removeIfExists(partialPath);
      await removeIfExists(`${partialPath}.json`);

      throw new AbortError('File exceeds size limit.');
    }

    if (error instanceof AbortError) {
      throw error;
    }

    const code = (error as NodeJS.ErrnoException).code;

    if (['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EIO', 'EROFS'].includes(code ?? '')) {
      throw error;
    }

    // Anything else mid-transfer (dropped connection, reset stream) leaves a
    // usable partial behind, so the next attempt can resume from it.
    throw new RetryableError('Transfer disconnected; partial retained.', { cause: error });
  }

  return (await lstat(partialPath)).size;
}
