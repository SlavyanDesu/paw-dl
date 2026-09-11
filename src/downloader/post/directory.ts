import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sanitizeName } from '../../utils/filename.ts';

const MAX_FOLDER_COLLISION_ATTEMPTS = 100;

async function isSamePost(directory: string, identity: string): Promise<boolean> {
  try {
    const info = await lstat(directory);

    if (!info.isDirectory()) {
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }

  const markerPath = join(directory, '.post-id');

  try {
    const marker = await readFile(markerPath, 'utf8');

    return marker === identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

export async function preparePostDirectory(
  output: string,
  folderName: string,
  identity: string,
  postId: string,
): Promise<string> {
  await mkdir(output, {
    recursive: true,
  });

  for (let attempt = 0; attempt < MAX_FOLDER_COLLISION_ATTEMPTS; attempt++) {
    const suffix = attempt === 0 ? '' : ` [${sanitizeName(postId)}${attempt > 1 ? `-${attempt}` : ''}]`;

    const directory = join(output, folderName + suffix);

    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }

      // Matching titles aren't enough; the marker tells us who owns this folder.
      if (!(await isSamePost(directory, identity))) {
        continue;
      }

      return directory;
    }

    await writeFile(join(directory, '.post-id'), identity, { encoding: 'utf8', flag: 'wx' });

    return directory;
  }

  throw new Error(`Unable to determine unique folder: ${folderName}`);
}
