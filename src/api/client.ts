import { parseCreator, parsePost, parsePostList, type Creator, type Post, type PostSummary } from './schemas.ts';
import pRetry, { AbortError } from 'p-retry';

import { NETWORK_ERROR_CODES, RETRYABLE_STATUS, parseRetryAfterToTimestamp } from '../utils/http.ts';

const API_BASE_URL = 'https://pawchive.pw/api/v1';

const PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_WAIT_SLEEP_MS = 60_000;

class RetryableHttpError extends Error {
  readonly retryAt: number;

  constructor(status: number, path: string, retryAt: number) {
    super(`API failed: HTTP ${status} — ${path}`);
    this.name = 'RetryableHttpError';
    this.retryAt = retryAt;
  }
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
          throw new RetryableHttpError(response.status, url.pathname, parseRetryAfterToTimestamp(retryAfter));
        }

        throw new AbortError(`API failed: HTTP ${response.status} — ${url.pathname}`);
      }

      const contentType = response.headers.get('content-type') ?? '';

      if (!contentType.toLowerCase().includes('json')) {
        await response.body?.cancel();

        throw new AbortError(`API did not send JSON — ${url.pathname}`);
      }

      try {
        const data: unknown = await response.json();
        return data;
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new AbortError('API sent invalid JSON.');
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
        console.warn(`[API] Attempt ${attemptNumber} failed: ${error.message}`);
      },

      shouldRetry: async ({ error }) => {
        if (error instanceof RetryableHttpError) {
          while (Date.now() < error.retryAt) {
            const remaining = error.retryAt - Date.now();
            await Bun.sleep(Math.min(remaining, MAX_RETRY_WAIT_SLEEP_MS));
          }

          return true;
        }

        // Timeout error
        return (
          error.name === 'TimeoutError' ||
          error instanceof TypeError ||
          NETWORK_ERROR_CODES.has(String((error as Error & { code?: string }).code ?? ''))
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
    throw new Error('Post ID in response differs from request.');
  }

  return post;
}

export async function getPostPage(creator: CreatorRef, offset: number): Promise<PostSummary[]> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Offset must be a non-negative integer.');
  }

  const data = await requestJson(creatorPath(creator), {
    o: String(offset),
  });

  return parsePostList(data);
}

export async function* iterateCreatorPosts(
  creator: CreatorRef,
  postCount?: number,
): AsyncGenerator<PostSummary, void, unknown> {
  if (postCount !== undefined && (!Number.isSafeInteger(postCount) || postCount < 1)) {
    throw new Error('Invalid post count.');
  }

  const seen = new Set<string>();

  let yielded = 0;

  for (let page = 0; ; page++) {
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

      yielded++;

      if (postCount !== undefined && yielded >= postCount) {
        return;
      }
    }

    if (newPosts === 0) {
      return;
    }
  }
}
