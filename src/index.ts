import { parseCli, HELP } from './cli.ts';
import type { FavoritesScope } from './cli.ts';
import { getCreator, getFavorites, getPost, iterateCreatorPosts } from './api/client.ts';
import type { CreatorRef } from './api/client.ts';
import type { Post } from './api/schemas.ts';
import { createQueue, DEFAULT_CONCURRENCY } from './downloader/queue.ts';
import { downloadFlat } from './downloader/post/download-flat.ts';
import type { FlatPost } from './downloader/post/download-flat.ts';
import { downloadPost } from './downloader/post/download-post.ts';
import { acquireLock, releaseLock } from './lock.ts';
import { errorMessage } from './utils/http.ts';
import type { Target } from './utils/parse-url.ts';

const BANNER = `                           _ _
  _ __  __ ___ __ _____ __| | |
  | '_ \\/ _\` \\ V  V /___/ _\` | |
  | .__/\\__,_|\\_/\\_/    \\__,_|_|
  |_|`;

const EXIT_SIGINT = 130;
const EXIT_SIGTERM = 143;

type Totals = {
  posts: number;
  saved: number;
  skipped: number;
  failedFiles: number;
  failedPosts: number;
};

type DownloadAllOptions = {
  target: Target;
  creatorName: string;
  output: string;
  postCount: number | undefined;
  includeFiles: string[];
  flat: boolean;
  session: string | undefined;
};

function targetToString(target: Target): string {
  const base = `https://pawchive.pw/${target.service}/user/${target.userId}`;

  return target.type === 'post' ? `${base}/post/${target.postId}` : base;
}

type Queue = ReturnType<typeof createQueue>;

async function savePost(
  totals: Totals,
  queue: Queue,
  ref: CreatorRef,
  creatorName: string,
  post: Post,
  output: string,
  includeFiles: string[],
): Promise<void> {
  totals.posts++;

  try {
    const result = await downloadPost({
      creator: ref,
      userName: creatorName,
      post,
      output,
      queue,
      includeFiles,
    });

    totals.saved += result.saved;
    totals.skipped += result.skipped;
    totals.failedFiles += result.failures.length;

    if (result.failures.length > 0) {
      totals.failedPosts++;
    }
  } catch (error) {
    totals.failedPosts++;

    console.error(`[Post ${post.id}] ${errorMessage(error)}`);
  }
}

async function fetchPost(
  totals: Totals,
  queue: Queue,
  ref: CreatorRef,
  creatorName: string,
  postId: string,
  output: string,
  includeFiles: string[],
  session: string | undefined,
): Promise<void> {
  let post: Post;

  try {
    post = await getPost(ref, postId, session);
  } catch (error) {
    totals.posts++;
    totals.failedPosts++;

    console.error(`[Post ${postId}] ${errorMessage(error)}`);
    return;
  }

  await savePost(totals, queue, ref, creatorName, post, output, includeFiles);
}

async function release(output: string): Promise<void> {
  try {
    await releaseLock(output);
  } catch {
    // Lock release is best-effort; ignore failures.
  }
}

function releaseAndExit(output: string, code: number): void {
  release(output).finally(() => {
    process.exit(code);
  });
}

function setupSignalHandlers(output: string): () => Promise<void> {
  let released = false;

  const releaseOnce = async (): Promise<void> => {
    if (released) {
      return;
    }

    released = true;
    await release(output);
  };

  process.on('beforeExit', () => {
    releaseOnce();
  });
  process.on('SIGINT', () => releaseAndExit(output, EXIT_SIGINT));
  process.on('SIGTERM', () => releaseAndExit(output, EXIT_SIGTERM));
  process.on('uncaughtException', (error) => {
    console.error(error);
    releaseAndExit(output, 1);
  });

  return releaseOnce;
}

function printSummary(totals: Totals, listingFailed: boolean): void {
  console.log('\nResult:');
  console.log(`Processed post(s): ${totals.posts}`);
  console.log(`Saved file(s): ${totals.saved}`);
  console.log(`Skipped file(s): ${totals.skipped}`);
  console.log(`Failed file(s): ${totals.failedFiles}`);
  console.log(`Failed post(s): ${totals.failedPosts}`);

  if (listingFailed) {
    console.log('Listing interrupted.');
  }
}

async function downloadAll(options: DownloadAllOptions): Promise<{ totals: Totals; listingFailed: boolean }> {
  const { target, creatorName, output, postCount, includeFiles, flat, session } = options;

  const totals: Totals = { posts: 0, saved: 0, skipped: 0, failedFiles: 0, failedPosts: 0 };
  const queue = createQueue(DEFAULT_CONCURRENCY);

  if (target.type === 'post') {
    await fetchPost(totals, queue, target, creatorName, target.postId, output, includeFiles, session);

    return { totals, listingFailed: false };
  }

  if (flat) {
    const result = await downloadFlat({
      creator: target,
      userName: creatorName,
      output,
      queue,
      includeFiles,
      postCount,
      session,
    });

    totals.posts = result.posts;
    totals.saved = result.saved;
    totals.skipped = result.skipped;
    totals.failedFiles = result.failures.length;
    totals.failedPosts = result.failedPosts;

    return { totals, listingFailed: result.listingFailed };
  }

  if (postCount !== undefined) {
    console.log(`Fetching up to ${postCount} post(s)`);
  }

  let listingFailed = false;

  try {
    // Posts run one at a time; files inside a post download concurrently.
    for await (const summary of iterateCreatorPosts(target, postCount, session)) {
      await fetchPost(totals, queue, target, creatorName, summary.id, output, includeFiles, session);
    }
  } catch (error) {
    listingFailed = true;

    console.error(`[Creator listing] ${errorMessage(error)}`);
  }

  return { totals, listingFailed };
}

type DownloadFavoritesOptions = {
  scope: FavoritesScope;
  session: string;
  output: string;
  postCount: number | undefined;
  includeFiles: string[];
  flat: boolean;
};

async function downloadFavorites(
  options: DownloadFavoritesOptions,
): Promise<{ totals: Totals; listingFailed: boolean }> {
  const { scope, session, output, postCount, includeFiles, flat } = options;

  const totals: Totals = { posts: 0, saved: 0, skipped: 0, failedFiles: 0, failedPosts: 0 };
  const queue = createQueue(DEFAULT_CONCURRENCY);
  const names = new Map<string, string>();

  async function creatorName(ref: CreatorRef): Promise<string> {
    const key = `${ref.service}/${ref.userId}`;
    const cached = names.get(key);

    if (cached) {
      return cached;
    }

    const creator = await getCreator(ref, session);

    names.set(key, creator.name);

    return creator.name;
  }

  let listingFailed = false;
  let favorites: Awaited<ReturnType<typeof getFavorites>>;

  try {
    favorites = await getFavorites(session, scope);
  } catch (error) {
    console.error(`[Favorites] ${errorMessage(error)}`);

    return { totals, listingFailed: true };
  }

  const posts = postCount === undefined ? favorites.posts : favorites.posts.slice(0, postCount);

  // Yield posts as they arrive, so flat downloads do not buffer entire creators.
  if (flat) {
    async function* entries(): AsyncGenerator<FlatPost> {
      if (scope === 'posts') {
        for (const favorite of posts) {
          try {
            yield {
              creator: favorite.creator,
              userName: await creatorName(favorite.creator),
              post: favorite.post,
            };
          } catch (error) {
            totals.posts++;
            totals.failedPosts++;

            console.error(`[Post ${favorite.post.id}] ${errorMessage(error)}`);
          }
        }
      } else {
        for (const creator of favorites.creators) {
          const ref: CreatorRef = { service: creator.service, userId: creator.userId };

          try {
            for await (const summary of iterateCreatorPosts(ref, postCount, session)) {
              try {
                yield { creator: ref, userName: creator.name, post: await getPost(ref, summary.id, session) };
              } catch (error) {
                totals.posts++;
                totals.failedPosts++;

                console.error(`[Post ${summary.id}] ${errorMessage(error)}`);
              }
            }
          } catch (error) {
            listingFailed = true;

            console.error(`[Creator ${creator.name}] ${errorMessage(error)}`);
          }
        }
      }
    }
    const result = await downloadFlat({
      output,
      queue,
      includeFiles,
      posts: entries(),
      identity: JSON.stringify(['favorites', scope]),
    });

    totals.posts += result.posts;
    totals.saved = result.saved;
    totals.skipped = result.skipped;
    totals.failedFiles = result.failures.length;
    totals.failedPosts += result.failedPosts;

    return { totals, listingFailed: listingFailed || result.listingFailed };
  }

  if (scope !== 'creators') {
    if (postCount !== undefined) {
      console.log(`Fetching up to ${postCount} favorited post(s)`);
    }

    // Favorite posts arrive as full details; no extra fetch needed.
    for (const favorite of posts) {
      try {
        const name = await creatorName(favorite.creator);

        await savePost(totals, queue, favorite.creator, name, favorite.post, output, includeFiles);
      } catch (error) {
        totals.posts++;
        totals.failedPosts++;

        console.error(`[Post ${favorite.post.id}] ${errorMessage(error)}`);
      }
    }
  }

  if (scope !== 'posts') {
    for (const creator of favorites.creators) {
      const ref: CreatorRef = { service: creator.service, userId: creator.userId };

      names.set(`${ref.service}/${ref.userId}`, creator.name);

      try {
        // Posts run one at a time; files inside a post download concurrently.
        for await (const summary of iterateCreatorPosts(ref, postCount, session)) {
          await fetchPost(totals, queue, ref, creator.name, summary.id, output, includeFiles, session);
        }
      } catch (error) {
        listingFailed = true;

        console.error(`[Creator ${creator.name}] ${errorMessage(error)}`);
      }
    }
  }

  return { totals, listingFailed };
}

async function main(): Promise<void> {
  console.log(BANNER);
  console.log();

  const options = parseCli();

  if (!options) {
    console.log(HELP);
    return;
  }

  const { target, output, postCount, includeFiles, force, flat, favorites, session } = options;

  try {
    await acquireLock(output, favorites ? 'https://pawchive.pw/favorites' : targetToString(target!), force);
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
    return;
  }

  const releaseOnce = setupSignalHandlers(output);

  try {
    if (favorites) {
      console.log(`Favorites (${favorites})`);
      console.log(`Output: ${output}`);

      const { totals, listingFailed } = await downloadFavorites({
        scope: favorites,
        session: session!,
        output,
        postCount,
        includeFiles,
        flat,
      });

      printSummary(totals, listingFailed);

      if (totals.failedPosts > 0 || listingFailed) {
        process.exitCode = 1;
      }

      return;
    }

    const creator = await getCreator(target!, session);

    console.log(`Creator: ${creator.name}`);
    console.log(`Output: ${output}`);

    const { totals, listingFailed } = await downloadAll({
      target: target!,
      creatorName: creator.name,
      output,
      postCount,
      includeFiles,
      flat,
      session,
    });

    printSummary(totals, listingFailed);

    if (totals.failedPosts > 0 || listingFailed) {
      process.exitCode = 1;
    }
  } finally {
    await releaseOnce();
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
