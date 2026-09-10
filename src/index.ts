import { parseCli, HELP } from "./cli.ts";
import { getCreator, getPost, iterateCreatorPosts } from "./api/client.ts";
import { createQueue } from "./downloader/queue.ts";
import { downloadPost } from "./downloader/download-post.ts";
import { acquireLock, releaseLock } from "./lock.ts";
import type { Target } from "./utils/parse-url.ts";

function targetToString(target: Target): string {
  const base = `https://pawchive.pw/${target.service}/user/${target.userId}`;

  return target.type === "post" ? `${base}/post/${target.postId}` : base;
}

async function release(output: string): Promise<void> {
  try {
    await releaseLock(output);
  } catch {
    // abaikan
  }
}

function releaseAndExit(output: string, code: number): void {
  release(output).finally(() => {
    process.exit(code);
  });
}

async function main(): Promise<void> {
  const options = parseCli();

  if (!options) {
    console.log(HELP);
    return;
  }

  const { target, output, iterations, includeFiles, force } = options;

  const targetUrl = targetToString(target);

  try {
    await acquireLock(output, targetUrl, force);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(message);
    process.exitCode = 1;
    return;
  }

  let released = false;

  async function releaseOnce(): Promise<void> {
    if (released) {
      return;
    }

    released = true;
    await release(output);
  }

  process.on("beforeExit", () => {
    releaseOnce();
  });
  process.on("SIGINT", () => releaseAndExit(output, 130));
  process.on("SIGTERM", () => releaseAndExit(output, 143));
  process.on("uncaughtException", (error) => {
    console.error(error);
    releaseAndExit(output, 1);
  });

  const creator = await getCreator(target);
  const queue = createQueue(3);

  const totals = {
    posts: 0,
    saved: 0,
    skipped: 0,
    failedFiles: 0,
    failedPosts: 0,
  };

  console.log(`Kreator: ${creator.name}`);
  console.log(`Output: ${output}`);

  async function processPost(postId: string): Promise<void> {
    totals.posts++;

    try {
      const post = await getPost(target, postId);

      const result = await downloadPost({
        creator: target,
        userName: creator.name,
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

      const message = error instanceof Error ? error.message : String(error);

      console.error(`[Post ${postId}] ${message}`);
    }
  }

  let listingFailed = false;

  if (target.type === "post") {
    await processPost(target.postId);
  } else {
    console.log(`Maksimum iterasi listing: ${iterations}`);

    try {
      for await (const summary of iterateCreatorPosts(target, iterations)) {
        await processPost(summary.id);
      }
    } catch (error) {
      listingFailed = true;

      const message = error instanceof Error ? error.message : String(error);

      console.error(`[Listing kreator] ${message}`);
    }
  }

  console.log("\nHasil:");
  console.log(`Post diproses: ${totals.posts}`);
  console.log(`File tersimpan: ${totals.saved}`);
  console.log(`File dilewati: ${totals.skipped}`);
  console.log(`File gagal: ${totals.failedFiles}`);
  console.log(`Post bermasalah: ${totals.failedPosts}`);

  if (listingFailed) {
    console.log("Listing terhenti sebelum seluruh iterasi selesai.");
  }

  if (totals.failedPosts > 0 || listingFailed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  console.error(message);
  process.exitCode = 1;
});
