import { parseCreator, parsePost, parsePostList, type Creator, type Post, type PostSummary } from './schemas.ts';
import pRetry, { AbortError } from 'p-retry';

const API_BASE_URL = 'https://pawchive.pw/api/v1';

const PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 30_000;

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

class RetryableHttpError extends Error {
  readonly retryAt: number;

  constructor(status: number, path: string, retryAt: number) {
    super(`API gagal: HTTP ${status} — ${path}`);
    this.name = 'RetryableHttpError';
    this.retryAt = retryAt;
  }
}

function parseRetryAfter(value: string | null): number {
  if (!value) {
    return 0;
  }

  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1_000;
    const retryAt = Date.now() + milliseconds;

    if (!Number.isSafeInteger(retryAt)) {
      throw new AbortError('Nilai Retry-After terlalu besar.');
    }

    return retryAt;
  }

  const timestamp = Date.parse(trimmed);

  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export type CreatorRef = {
  service: string;
  userId: string;
};

function creatorPath(creator: CreatorRef): string {
  const service = encodeURIComponent(creator.service);
  const userId = encodeURIComponent(creator.userId);

  return `/${service}/user/${userId}`;
}

async function requestJson(path: string, query: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${API_BASE_URL}${path}`);

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  return pRetry(
    async (): Promise<unknown> => {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after');

        await response.body?.cancel();

        if (RETRYABLE_STATUS.has(response.status)) {
          throw new RetryableHttpError(response.status, url.pathname, parseRetryAfter(retryAfter));
        }

        throw new AbortError(`API gagal: HTTP ${response.status} — ${url.pathname}`);
      }

      const contentType = response.headers.get('content-type') ?? '';

      if (!contentType.toLowerCase().includes('json')) {
        await response.body?.cancel();

        throw new AbortError(`API tidak mengirim JSON — ${url.pathname}`);
      }

      try {
        const data: unknown = await response.json();
        return data;
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new AbortError('API mengirim JSON yang tidak valid.');
        }

        throw error;
      }
    },
    {
      retries: 3,
      factor: 2,
      minTimeout: 1_000,
      maxTimeout: 10_000,
      randomize: true,

      onFailedAttempt: ({ error, attemptNumber }) => {
        console.warn(`[API] Percobaan ${attemptNumber} gagal: ${error.message}`);
      },

      shouldRetry: async ({ error }) => {
        if (error instanceof RetryableHttpError) {
          while (Date.now() < error.retryAt) {
            const remaining = error.retryAt - Date.now();
            await Bun.sleep(Math.min(remaining, 60_000));
          }

          return true;
        }

        // Timeout error
        return (
          error.name === 'TimeoutError' ||
          error instanceof TypeError ||
          ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ConnectionClosed', 'ConnectionRefused'].includes(
            String((error as Error & { code?: string }).code ?? ''),
          )
        );
      },
    },
  );
}

export async function getCreator(creator: CreatorRef): Promise<Creator> {
  const data = await requestJson(`${creatorPath(creator)}/profile`);

  return parseCreator(data);
}

export async function getPost(creator: CreatorRef, postId: string): Promise<Post> {
  const data = await requestJson(`${creatorPath(creator)}/post/${encodeURIComponent(postId)}`);

  const post = parsePost(data);

  if (post.id !== postId) {
    throw new Error('ID post pada respons berbeda dari permintaan.');
  }

  return post;
}

export async function getPostPage(creator: CreatorRef, offset: number): Promise<PostSummary[]> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Offset harus berupa integer nonnegatif.');
  }

  const data = await requestJson(creatorPath(creator), {
    o: String(offset),
  });

  return parsePostList(data);
}

export async function* iterateCreatorPosts(
  creator: CreatorRef,
  iterations: number,
): AsyncGenerator<PostSummary, void, unknown> {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || !Number.isSafeInteger((iterations - 1) * PAGE_SIZE)) {
    throw new Error('Jumlah iterasi tidak valid.');
  }

  const seen = new Set<string>();

  for (let page = 0; page < iterations; page++) {
    const offset = page * PAGE_SIZE;
    const posts = await getPostPage(creator, offset);

    if (posts.length === 0) {
      return;
    }

    let newPosts = 0;

    for (const post of posts) {
      if (seen.has(post.id)) {
        continue;
      }

      seen.add(post.id);
      newPosts++;

      yield post;
    }

    if (newPosts === 0) {
      return;
    }
  }
}
