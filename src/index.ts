import { parseCli, HELP } from './cli.ts';
import { getCreator, getPost, iterateCreatorPosts } from './api/client.ts';
import { createQueue, DEFAULT_CONCURRENCY } from './downloader/queue.ts';
import { downloadFlat } from './downloader/post/download-flat.ts';
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
};

function targetToString(target: Target): string {
  const base = `https://pawchive.pw/${target.service}/user/${target.userId}`;

  return target.type === 'post' ? `${base}/post/${target.postId}` : base;
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
  const { target, creatorName, output, postCount, includeFiles, flat } = options;

  const totals: Totals = { posts: 0, saved: 0, skipped: 0, failedFiles: 0, failedPosts: 0 };
  const queue = createQueue(DEFAULT_CONCURRENCY);

  async function processPost(postId: string): Promise<void> {
    totals.posts++;

    try {
      const post = await getPost(target, postId);

      const result = await downloadPost({
        creator: target,
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

      console.error(`[Post ${postId}] ${errorMessage(error)}`);
    }
  }

  if (target.type === 'post') {
    await processPost(target.postId);

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
    });

    totals.posts = result.posts;
    totals.saved = result.saved;
    totals.skipped = result.skipped;
    totals.failedFiles = result.failures.length;
    totals.failedPosts = result.failedPosts;

    return { totals, listingFailed: false };
  }

  if (postCount !== undefined) {
    console.log(`Fetching up to ${postCount} post(s)`);
  }

  let listingFailed = false;

  try {
    // Finish each post before starting the next; its files still download concurrently.
    for await (const summary of iterateCreatorPosts(target, postCount)) {
      await processPost(summary.id);
    }
  } catch (error) {
    listingFailed = true;

    console.error(`[Creator listing] ${errorMessage(error)}`);
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

  const { target, output, postCount, includeFiles, force, flat } = options;

  try {
    await acquireLock(output, targetToString(target), force);
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
    return;
  }

  const releaseOnce = setupSignalHandlers(output);

  try {
    const creator = await getCreator(target);

    console.log(`Creator: ${creator.name}`);
    console.log(`Output: ${output}`);

    const { totals, listingFailed } = await downloadAll({
      target,
      creatorName: creator.name,
      output,
      postCount,
      includeFiles,
      flat,
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
