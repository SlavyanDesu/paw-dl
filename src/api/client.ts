import {
  parseCreator,
  parseFavoriteCreators,
  parseFavoritePosts,
  parsePost,
  parsePostList,
  type Creator,
  type FavoriteCreator,
  type FavoritePost,
  type Post,
  type PostSummary,
} from './schemas.ts';

import { NETWORK_ERROR_CODES, RETRYABLE_STATUS, parseRetryAfterToTimestamp } from '../utils/http.ts';
import { RetryableError, retryWithBackoff } from '../utils/retry.ts';

const API_BASE_URL = 'https://pawchive.pw/api/v1';

const PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 30_000;

class RetryableHttpError extends RetryableError {
  constructor(status: number, path: string, retryAt: number) {
    super(`API failed: HTTP ${status} — ${path}`);
    this.name = 'RetryableHttpError';
    this.retryAt = retryAt;
  }
}

function isTransientRequestError(error: unknown): boolean {
  return (
    (error as Error).name === 'TimeoutError' ||
    error instanceof TypeError ||
    NETWORK_ERROR_CODES.has(String((error as Error & { code?: string }).code ?? ''))
  );
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

async function requestJson(path: string, query: Record<string, string> = {}, session?: string): Promise<unknown> {
  const url = new URL(`${API_BASE_URL}${path}`);

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = { Accept: 'application/json' };

  if (session) {
    headers.Cookie = `session=${session}`;
  }

  return retryWithBackoff(
    async (): Promise<unknown> => {
      let response: Response;

      try {
        response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (isTransientRequestError(error)) {
          throw new RetryableError('API request failed.', { cause: error });
        }

        throw error;
      }

      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after');

        await response.body?.cancel();

        // Auth failures never recover on retry; say so plainly.
        if (session && (response.status === 401 || response.status === 403)) {
          throw new Error('Session invalid or expired. Log in again and refresh the cookie.');
        }

        if (RETRYABLE_STATUS.has(response.status)) {
          throw new RetryableHttpError(response.status, url.pathname, parseRetryAfterToTimestamp(retryAfter));
        }

        throw new Error(`API failed: HTTP ${response.status} — ${url.pathname}`);
      }

      const contentType = response.headers.get('content-type') ?? '';

      if (!contentType.toLowerCase().includes('json')) {
        await response.body?.cancel();

        throw new Error(`API did not send JSON — ${url.pathname}`);
      }

      try {
        const data: unknown = await response.json();
        return data;
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error('API sent invalid JSON.');
        }

        if (isTransientRequestError(error)) {
          throw new RetryableError('API request failed.', { cause: error });
        }

        throw error;
      }
    },
    {
      onFailedAttempt: (error, attemptNumber) => {
        console.warn(`[API] Attempt ${attemptNumber} failed: ${error.message}`);
      },
    },
  );
}

export async function getCreator(creator: CreatorRef, session?: string): Promise<Creator> {
  const data = await requestJson(`${creatorPath(creator)}/profile`, {}, session);

  return parseCreator(data);
}

export async function getPost(creator: CreatorRef, postId: string, session?: string): Promise<Post> {
  const data = await requestJson(`${creatorPath(creator)}/post/${encodeURIComponent(postId)}`, {}, session);

  const post = parsePost(data);

  if (post.id !== postId) {
    throw new Error('Post ID in response differs from request.');
  }

  return post;
}

export async function getPostPage(creator: CreatorRef, offset: number, session?: string): Promise<PostSummary[]> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Offset must be a non-negative integer.');
  }

  const data = await requestJson(
    creatorPath(creator),
    {
      o: String(offset),
    },
    session,
  );

  return parsePostList(data);
}

export type Favorites = {
  posts: FavoritePost[];
  creators: FavoriteCreator[];
};

export async function getFavorites(session: string, scope?: 'posts' | 'creators'): Promise<Favorites> {
  const [postsData, creatorsData] = await Promise.all([
    scope === 'creators' ? [] : requestJson('/account/favorites', { type: 'post' }, session),
    scope === 'posts' ? [] : requestJson('/account/favorites', {}, session),
  ]);

  return { posts: parseFavoritePosts(postsData), creators: parseFavoriteCreators(creatorsData) };
}

export async function* iterateCreatorPosts(
  creator: CreatorRef,
  postCount?: number,
  session?: string,
): AsyncGenerator<PostSummary, void, unknown> {
  if (postCount !== undefined && (!Number.isSafeInteger(postCount) || postCount < 1)) {
    throw new Error('Invalid post count.');
  }

  const seen = new Set<string>();

  let yielded = 0;

  for (let page = 0; ; page++) {
    const offset = page * PAGE_SIZE;
    const posts = await getPostPage(creator, offset, session);

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
