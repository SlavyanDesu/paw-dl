import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadFile } from './download-file.ts';

/*
 * Mock mirrors live file server: strong ETag, accept-ranges,
 * 200 on If-Range miss, 206 on hit, 416 past the end.
 */
function startServer(body: string, etag: string) {
  return createServer((request, response) => {
    const range = request.headers.range;
    const ifRange = request.headers['if-range'];

    if (range) {
      const offset = Number(/^bytes=(\d+)-$/.exec(range)?.[1]);

      if (ifRange !== etag) {
        response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': body.length, ETag: etag });
        response.end(body);
        return;
      }

      if (!Number.isSafeInteger(offset) || offset >= body.length) {
        response.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
        response.end();
        return;
      }

      response.writeHead(206, {
        'Content-Type': 'image/jpeg',
        'Content-Length': body.length - offset,
        ETag: etag,
        'Content-Range': `bytes ${offset}-${body.length - 1}/${body.length}`,
      });
      response.end(body.slice(offset));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': body.length, ETag: etag });
    response.end(body);
  });
}

async function withRoute<T>(server: ReturnType<typeof startServer>, run: () => Promise<T>): Promise<T> {
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
          expect(url.origin).toBe('https://file.pawchive.pw');
          return realFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, options);
        },
        { preconnect: realFetch.preconnect },
      ),
    );

    return await run();
  } finally {
    fetchSpy?.mockRestore();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('If-Range miss restarts from zero and truncates stale partial', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paw-dl-ifrange-'));
  const body = 'full fresh body from server';
  const server = startServer(body, '"v2"');

  try {
    await withRoute(server, async () => {
      const file = { path: '/photo.jpg', name: 'photo.jpg', deferred: false };
      const destination = join(directory, 'photo.jpg');

      // Stale partial from an older version with a matching-size lie.
      await writeFile(`${destination}.part`, 'stale partial data here!');
      await writeFile(
        `${destination}.part.json`,
        JSON.stringify({ version: 1, source: 'https://file.pawchive.pw/data/photo.jpg', etag: '"v1"', total: 23 }),
      );

      const result = await downloadFile(file, destination);

      expect(result.status).toBe('saved');
      expect(await readFile(destination, 'utf8')).toBe(body);
      expect(result.manifest.etag).toBe('"v2"');
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('416 recovers with full download', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paw-dl-416-'));
  const body = 'short body';
  const server = startServer(body, '"v1"');

  try {
    await withRoute(server, async () => {
      const file = { path: '/photo.jpg', name: 'photo.jpg', deferred: false };
      const destination = join(directory, 'photo.jpg');

      // Partial offset past the real end, metadata still claims room.
      await writeFile(`${destination}.part`, 'x'.repeat(50));
      await writeFile(
        `${destination}.part.json`,
        JSON.stringify({ version: 1, source: 'https://file.pawchive.pw/data/photo.jpg', etag: '"v1"', total: 100 }),
      );

      const result = await downloadFile(file, destination);

      expect(result.status).toBe('saved');
      expect(await readFile(destination, 'utf8')).toBe(body);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('chunked body without Content-Length saves with unknown total', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paw-dl-chunked-'));
  const body = 'chunked live body';
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'image/jpeg', ETag: '"v1"' });
    response.end(body);
  });

  try {
    await withRoute(server, async () => {
      const result = await downloadFile({ path: '/c.jpg', name: 'c.jpg', deferred: false }, join(directory, 'c.jpg'));

      expect(result.status).toBe('saved');
      expect(result.manifest.size).toBe(body.length);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTML error page aborts without retry storm', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paw-dl-html-'));
  let hits = 0;
  const server = createServer((_request, response) => {
    hits++;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<html><body>ddos-guard</body></html>');
  });

  try {
    await withRoute(server, async () => {
      await expect(
        downloadFile({ path: '/c.jpg', name: 'c.jpg', deferred: false }, join(directory, 'c.jpg')),
      ).rejects.toThrow('HTML instead of an attachment');
      expect(hits).toBe(1);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
