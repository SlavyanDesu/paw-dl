import { expect, spyOn, test } from 'bun:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { getCreator, getFavorites, getPost, getPostPage, iterateCreatorPosts } from './client.ts';

const CREATOR = { service: 'patreon', userId: '123' };

type Route = (
  url: URL,
  headers: Record<string, string | string[] | undefined>,
) => { status: number; headers?: Record<string, string>; body: string } | null;

async function withApi<T>(route: Route, run: () => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://api.test');
    const hit = route(url, request.headers);

    if (!hit) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('no route');
      return;
    }

    response.writeHead(hit.status, { 'Content-Type': 'application/json', ...hit.headers });
    response.end(hit.body);
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
          expect(url.origin).toBe('https://pawchive.pw');
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

test('profile, post page and single post parse', async () => {
  await withApi(
    (url) => {
      if (url.pathname.endsWith('/profile')) return { status: 200, body: JSON.stringify({ name: 'Live' }) };
      if (url.pathname.endsWith('/post/9'))
        return {
          status: 200,
          body: JSON.stringify({ id: '9', title: 'T', published: null, file: null, attachments: [] }),
        };
      return { status: 200, body: JSON.stringify([{ id: '1' }, { id: '2' }]) };
    },
    async () => {
      expect(await getCreator(CREATOR)).toEqual({ name: 'Live' });
      expect((await getPostPage(CREATOR, 0)).map((post) => post.id)).toEqual(['1', '2']);
      expect((await getPost(CREATOR, '9')).title).toBe('T');
    },
  );
});

test('listing paginates, dedupes and honors post count', async () => {
  const pages: Record<string, { id: string }[]> = {
    '0': [{ id: '1' }, { id: '2' }],
    '50': [{ id: '2' }, { id: '3' }],
    '100': [],
  };

  await withApi(
    (url) => ({ status: 200, body: JSON.stringify(pages[url.searchParams.get('o') ?? ''] ?? []) }),
    async () => {
      const all: string[] = [];
      for await (const post of iterateCreatorPosts(CREATOR)) all.push(post.id);
      expect(all).toEqual(['1', '2', '3']);

      const limited: string[] = [];
      for await (const post of iterateCreatorPosts(CREATOR, 2)) limited.push(post.id);
      expect(limited).toEqual(['1', '2']);
    },
  );
});

test('post ID mismatch throws', async () => {
  await withApi(
    () => ({
      status: 200,
      body: JSON.stringify({ id: 'other', title: 'T', published: null, file: null, attachments: [] }),
    }),
    async () => {
      await expect(getPost(CREATOR, '9')).rejects.toThrow('differs from request');
    },
  );
});

test('retryable status recovers, fatal status throws', async () => {
  let flaky = 0;

  await withApi(
    (url) => {
      if (url.pathname.endsWith('/profile')) {
        flaky++;
        if (flaky === 1) return { status: 503, body: '{}' };
        return { status: 200, body: JSON.stringify({ name: 'Back' }) };
      }
      return { status: 404, body: '{}' };
    },
    async () => {
      expect(await getCreator(CREATOR)).toEqual({ name: 'Back' });
      expect(flaky).toBe(2);
      await expect(getPostPage(CREATOR, 0)).rejects.toThrow('HTTP 404');
    },
  );
});

test('non-JSON and invalid JSON throw', async () => {
  await withApi(
    (url) => {
      if (url.searchParams.get('o') === '0')
        return { status: 200, headers: { 'Content-Type': 'text/html' }, body: '<html></html>' };
      return { status: 200, body: '{broken' };
    },
    async () => {
      await expect(getPostPage(CREATOR, 0)).rejects.toThrow('did not send JSON');
      await expect(getPostPage(CREATOR, 50)).rejects.toThrow('invalid JSON');
    },
  );
});

test('favorites send the session cookie and parse both lists', async () => {
  const seen: (string | string[] | undefined)[] = [];

  await withApi(
    (url, headers) => {
      seen.push(headers.cookie);

      if (url.searchParams.get('type') === 'post') {
        return {
          status: 200,
          body: JSON.stringify([
            { id: '9', user: '123', service: 'patreon', title: 'T', published: null, file: null, attachments: [] },
          ]),
        };
      }

      return { status: 200, body: JSON.stringify([{ id: '123', service: 'patreon', name: 'Live' }]) };
    },
    async () => {
      const favorites = await getFavorites('s3cr3t');

      expect(seen).toEqual(['session=s3cr3t', 'session=s3cr3t']);
      expect(favorites.posts.map((favorite) => favorite.post.id)).toEqual(['9']);
      expect(favorites.creators).toEqual([{ service: 'patreon', userId: '123', name: 'Live' }]);
    },
  );
});

test('expired session throws plainly', async () => {
  await withApi(
    () => ({ status: 401, body: '{}' }),
    async () => {
      await expect(getFavorites('stale')).rejects.toThrow('Session invalid or expired');
    },
  );
});
