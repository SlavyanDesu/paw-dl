import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadPost } from './post/download-post.ts';
import { createQueue } from './queue.ts';
import type { Attachment } from '../api/schemas.ts';

function postOptions(output: string, files: { file: Attachment | null; attachments: Attachment[] }) {
  return {
    creator: { service: 'example', userId: '123' },
    userName: 'Creator',
    post: { id: '456', title: 'Post', published: '2026-01-02', ...files },
    output,
    queue: createQueue(),
    includeFiles: [],
  };
}

test('a manifest filename outside the post folder is rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paw-dl-post-'));

  try {
    const folder = join(directory, '[20260102] Creator-Post');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, '.post-id'), JSON.stringify(['example', '123', '456']));
    await writeFile(
      join(folder, '.manifest.json'),
      JSON.stringify({
        version: 1,
        identity: JSON.stringify(['example', '123', '456']),
        files: {
          'https://file.pawchive.pw/data/evil.jpg': {
            filename: '../escape.jpg',
            source: 'https://file.pawchive.pw/data/evil.jpg',
            size: 3,
            etag: null,
          },
        },
      }),
    );

    await expect(
      downloadPost(
        postOptions(directory, {
          file: { path: '/evil.jpg', name: 'evil.jpg', deferred: false },
          attachments: [],
        }),
      ),
    ).rejects.toThrow(/manifest/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('completed files stay recorded when a sibling file fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paw-dl-post-'));
  const good = Buffer.from('good file contents');
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/data/good.jpg')) {
      response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': good.length });
      response.end(good);
    } else {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('broken');
    }
  });
  const realFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a local TCP server.');

    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          return realFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, options);
        },
        { preconnect: realFetch.preconnect },
      ),
    );

    const result = await downloadPost(
      postOptions(directory, {
        file: { path: '/good.jpg', name: 'good.jpg', deferred: false },
        attachments: [{ path: '/bad.jpg', name: 'bad.jpg', deferred: false }],
      }),
    );

    expect(result.saved).toBe(1);
    expect(result.failures).toHaveLength(1);

    // The good file hits the manifest the moment it finishes, so even a
    // crash right after still leaves it recorded.
    const manifest = JSON.parse(await readFile(join(result.directory!, '.manifest.json'), 'utf8')) as {
      files: Record<string, { filename: string; size: number }>;
    };
    expect(Object.keys(manifest.files)).toEqual(['https://file.pawchive.pw/data/good.jpg']);
    expect(Object.values(manifest.files)[0]?.size).toBe(good.length);
  } finally {
    fetchSpy?.mockRestore();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
