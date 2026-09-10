import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadFile } from './download-file.ts';
import { downloadPost } from './download-post.ts';
import { createQueue } from './queue.ts';

test('downloads, resumes an interrupted transfer, and reuses recorded files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paw-dl-'));
  const body = Buffer.from('a small attachment for the offline download check');
  const etag = '"version-1"';
  const requests: { range: string | undefined; ifRange: string | string[] | undefined }[] = [];
  let interrupt = false;
  const server = createServer((request, response) => {
    const range = request.headers.range;
    requests.push({ range, ifRange: request.headers['if-range'] });
    const offset = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1]) : 0;
    response.writeHead(range ? 206 : 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length - offset,
      ETag: etag,
      ...(range ? { 'Content-Range': `bytes ${offset}-${body.length - 1}/${body.length}` } : {}),
    });
    if (interrupt) {
      interrupt = false;
      response.write(body.subarray(0, 8));
      // Let the first bytes reach disk before dropping the connection.
      setTimeout(() => response.destroy(), 50);
    } else {
      response.end(body.subarray(offset));
    }
  });
  const realFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a local TCP server.');

    // Keep production URL checks intact; route only the transport to our local server.
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          expect(url.origin).toBe('https://file.pawchive.pw');
          return realFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, options);
        },
        { preconnect: realFetch.preconnect },
      ),
    );

    const file = { path: '/sample.jpg', name: 'sample.jpg', deferred: false };
    const destination = join(directory, 'sample.jpg');
    const saved = await downloadFile(file, destination);
    expect(saved.status).toBe('saved');
    expect(await readFile(destination)).toEqual(body);
    expect(saved.manifest).toEqual({
      filename: 'sample.jpg',
      source: 'https://file.pawchive.pw/data/sample.jpg',
      size: body.length,
      etag,
    });
    await expect(stat(`${destination}.part`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(`${destination}.part.json`)).rejects.toMatchObject({ code: 'ENOENT' });

    const requestCount = requests.length;
    expect((await downloadFile(file, destination, { expected: saved.manifest })).status).toBe('skipped');
    await expect(downloadFile(file, destination)).rejects.toThrow('not recorded in the manifest');
    expect(requests.length).toBe(requestCount);
    expect(await readFile(destination)).toEqual(body);

    interrupt = true;
    const resumedPath = join(directory, 'resumed.jpg');
    // The dropped connection retries in the same call and resumes from byte 8.
    expect((await downloadFile(file, resumedPath)).status).toBe('saved');
    expect(requests.at(-1)).toEqual({ range: 'bytes=8-', ifRange: etag });
    expect(await readFile(resumedPath)).toEqual(body);

    const options = {
      creator: { service: 'example', userId: '123' },
      userName: 'Creator',
      post: { id: '456', title: 'Post', published: '2026-01-02', file, attachments: [] },
      output: directory,
      queue: createQueue(),
      includeFiles: [],
    };
    const first = await downloadPost(options);
    expect(first.saved).toBe(1);
    expect(first.failures).toEqual([]);
    const manifestPath = join(first.directory!, '.manifest.json');
    const manifest = await readFile(manifestPath, 'utf8');
    options.post.file = { ...file, name: 'renamed.jpg' };
    const second = await downloadPost(options);
    expect(second.directory).toBe(first.directory);
    expect(second.skipped).toBe(1);
    expect(second.failures).toEqual([]);
    expect(await readFile(manifestPath, 'utf8')).toBe(manifest);
  } finally {
    fetchSpy?.mockRestore();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
