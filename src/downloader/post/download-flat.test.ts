import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadFlat } from './download-flat.ts';
import { createQueue } from '../queue.ts';

const CREATOR = { service: 'patreon', userId: '123' };

function postDetail(id: string, filePath: string) {
  return {
    id,
    title: 'Post',
    published: '2026-01-02',
    file: { path: filePath, name: `${id}.jpg`, deferred: false },
    attachments: [],
  };
}

const JPEG = Buffer.from('flat fixture body');

test('creator flat CLI exits nonzero when listing fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paw-dl-flat-'));
  try {
    const script = `
      Bun.argv = ['bun', 'paw-dl', 'https://pawchive.pw/patreon/user/123', '--flat', '-o', ${JSON.stringify(directory)}];
      globalThis.fetch = async (input) => {
        const url = new URL(input);
        if (url.origin !== 'https://pawchive.pw') throw new Error('Unexpected origin');
        return url.pathname.endsWith('/profile')
          ? Response.json({ name: 'Creator' })
          : Response.json({}, { status: 404 });
      };
      await import(${JSON.stringify(new URL('../../index.ts', import.meta.url).href)});
    `;
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain('Listing interrupted.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('flat streams collisions and shared sources safely, preserving listing failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paw-dl-flat-'));
  try {
    await withRoutes(async () => {
      async function* posts() {
        yield { creator: CREATOR, userName: 'Same', post: postDetail('1', '/first.jpg') };
        // Download and persistence must finish before requesting the next post.
        expect(Object.keys(JSON.parse(await readFile(join(directory, '.manifest.json'), 'utf8')).files)).toHaveLength(
          1,
        );
        yield { creator: { service: 'fanbox', userId: '999' }, userName: 'Same', post: postDetail('1', '/second.jpg') };
        yield { creator: CREATOR, userName: 'Other', post: postDetail('2', '/first.jpg') };
        throw new Error('listing interrupted');
      }
      const result = await downloadFlat({ output: directory, queue: createQueue(), includeFiles: [], posts: posts() });
      expect(result.saved).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.failures).toEqual([]);
      expect(result.listingFailed).toBe(true);
      expect((await readdir(directory)).sort()).toEqual([
        '.manifest.json',
        '[20260102] Same-Post [1]-001.jpg',
        '[20260102] Same-Post [1]-002.jpg',
      ]);
      const manifest = JSON.parse(await readFile(join(directory, '.manifest.json'), 'utf8'));
      expect(new Set(Object.values(manifest.files).map((entry: any) => entry.filename)).size).toBe(2);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('flat counts matching post IDs on different services separately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paw-dl-flat-'));
  try {
    const result = await downloadFlat({
      output: directory,
      queue: createQueue(),
      includeFiles: [],
      posts: ['patreon', 'fanbox'].map((service) => ({
        creator: { service, userId: '123' },
        userName: 'Same',
        post: { ...postDetail('1', '/1.jpg'), published: null },
      })),
    });
    expect(result.failedPosts).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/*
 * One local server plays both roles: API JSON and file bytes.
 * Downloads get redirected to it, exactly like the other offline suites.
 */
async function withRoutes<T>(run: () => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/v1/patreon/user/123') {
      const page = url.searchParams.get('o') ?? '0';
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(page === '0' ? [{ id: '1' }, { id: '2' }] : []));
      return;
    }

    const postMatch = /^\/api\/v1\/patreon\/user\/123\/post\/(\d+)$/.exec(url.pathname);
    if (postMatch) {
      const id = postMatch[1]!;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(postDetail(id, `/${id}.jpg`)));
      return;
    }

    if (url.pathname.startsWith('/data/')) {
      response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': JPEG.length, ETag: '"v1"' });
      response.end(JPEG);
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('no route');
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
          expect(['pawchive.pw', 'file.pawchive.pw']).toContain(url.hostname);
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

test('flat lands same-title posts in one folder with post IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paw-dl-flat-'));

  try {
    await withRoutes(async () => {
      const options = {
        creator: CREATOR,
        userName: 'Creator',
        output: directory,
        queue: createQueue(),
        includeFiles: [],
      };

      const first = await downloadFlat(options);

      expect(first.posts).toBe(2);
      expect(first.saved).toBe(2);
      expect(first.failures).toEqual([]);

      // Everything sits in the output root: files plus one manifest.
      expect((await readdir(directory)).sort()).toEqual(
        ['.manifest.json', '[20260102] Creator-Post [1]-001.jpg', '[20260102] Creator-Post [2]-001.jpg'].sort(),
      );

      const second = await downloadFlat(options);

      expect(second.saved).toBe(0);
      expect(second.skipped).toBe(2);
      expect(second.failures).toEqual([]);
      expect(JSON.parse(await readFile(join(directory, '.manifest.json'), 'utf8')).identity).toBe(
        JSON.stringify(['patreon', '123']),
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('flat direct posts span creators under one manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paw-dl-flat-'));

  try {
    await withRoutes(async () => {
      const options = {
        output: directory,
        queue: createQueue(),
        includeFiles: [],
        posts: [
          {
            creator: { service: 'patreon', userId: '123' },
            userName: 'Anna',
            post: postDetail('7', '/7.jpg'),
          },
          {
            creator: { service: 'fanbox', userId: '999' },
            userName: 'Mochi',
            post: postDetail('8', '/8.jpg'),
          },
        ],
      };

      const first = await downloadFlat(options);

      expect(first.posts).toBe(2);
      expect(first.saved).toBe(2);
      expect(first.failures).toEqual([]);
      expect((await readdir(directory)).sort()).toEqual(
        ['.manifest.json', '[20260102] Anna-Post [7]-001.jpg', '[20260102] Mochi-Post [8]-001.jpg'].sort(),
      );

      const second = await downloadFlat(options);

      expect(second.saved).toBe(0);
      expect(second.skipped).toBe(2);
      expect(second.failures).toEqual([]);
      expect(JSON.parse(await readFile(join(directory, '.manifest.json'), 'utf8')).identity).toBe(
        JSON.stringify(['favorites', 'posts']),
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('flat direct posts accept a manifest identity override', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paw-dl-flat-'));

  try {
    await withRoutes(async () => {
      const result = await downloadFlat({
        output: directory,
        queue: createQueue(),
        includeFiles: [],
        posts: [{ creator: CREATOR, userName: 'Creator', post: postDetail('1', '/1.jpg') }],
        identity: JSON.stringify(['favorites', 'creators']),
      });

      expect(result.saved).toBe(1);
      expect(result.failures).toEqual([]);
      expect(JSON.parse(await readFile(join(directory, '.manifest.json'), 'utf8')).identity).toBe(
        JSON.stringify(['favorites', 'creators']),
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
