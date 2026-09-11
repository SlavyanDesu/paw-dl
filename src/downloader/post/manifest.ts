import { readFile, readdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { z } from 'zod';

import { FILE_ORIGIN } from '../../utils/attachment-url.ts';

const ManifestEntrySchema = z.object({
  // No separators or parent refs: loaded names must stay inside the post folder.
  // Backslash also rejected: safe on Linux but escapes on Windows.
  // Control chars rejected: they break logs and fail closed at open time.
  filename: z
    .string()
    .min(1)
    .refine(
      (name) =>
        name === basename(name) &&
        name !== '.' &&
        name !== '..' &&
        !name.includes('/') &&
        !name.includes('\\') &&
        // ponytail: manual guard cheaper than zod for closed-world file
        !/[\u0000-\u001F\u007F]/.test(name),
      'Unsafe filename in manifest.',
    ),
  source: z
    .string()
    .min(1)
    .refine((source) => source.startsWith(`${FILE_ORIGIN}/data/`), 'Foreign source in manifest.'),
  size: z.number().int().nonnegative().safe(),
  etag: z.string().nullable(),
});

const PostManifestSchema = z.object({
  version: z.literal(1),
  identity: z.string(),
  files: z.record(z.string(), ManifestEntrySchema),
});

export type PostManifest = z.infer<typeof PostManifestSchema>;

export function safeLogPath(path: string): string {
  return path.replace(/[\u0000-\u001F\u007F]/g, '_');
}

export async function readManifest(path: string, identity: string): Promise<PostManifest> {
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        version: 1,
        identity,
        files: {},
      };
    }

    throw error;
  }

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Manifest is not valid JSON: ${path}`);
  }

  const result = PostManifestSchema.safeParse(json);

  if (!result.success) {
    throw new Error(`Invalid manifest format: ${path}\n` + z.prettifyError(result.error));
  }

  if (result.data.identity !== identity) {
    throw new Error(`Manifest belongs to a different post: ${path}`);
  }

  return result.data;
}

export async function sweepOrphanTempFiles(directory: string): Promise<void> {
  let entries: string[];

  try {
    entries = await readdir(directory);
  } catch {
    return;
  }

  for (const entry of entries) {
    // Only atomicWriteJson leftovers: manifest / resume metadata tmp files.
    // Never touch .part resume data here.
    const isManifestTmp = entry === '.manifest.json.tmp';
    const isResumeTmp = entry.endsWith('.part.json.tmp');

    if (isManifestTmp || isResumeTmp) {
      try {
        await unlink(join(directory, entry));
      } catch {
        // Best-effort cleanup; download proceeds regardless.
      }
    }
  }
}
