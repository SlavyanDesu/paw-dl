import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

import cliProgress from "cli-progress";
import pRetry, { AbortError } from "p-retry";
import { z } from "zod";

import type { Attachment } from "../api/schemas.ts";

const FILE_ORIGIN = "https://file.pawchive.pw";
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export type FileManifestEntry = {
  filename: string;
  source: string;
  size: number;
  etag: string | null;
};

export type DownloadResult = {
  status: "saved" | "skipped";
  destination: string;
  manifest: FileManifestEntry;
};

export type DownloadFileOptions = {
  expected?: FileManifestEntry;
};

const ResumeSchema = z.object({
  version: z.literal(1),
  source: z.string(),
  etag: z.string().nullable(),
  total: z.number().int().nonnegative().safe().nullable(),
});

type ResumeMetadata = z.infer<typeof ResumeSchema>;

class RetryableDownloadError extends Error {
  retryAt = 0;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableDownloadError";
  }
}

/*
 * Progress bar
 */

let progressGroup: cliProgress.MultiBar | undefined;
let activeBars = 0;

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];

  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  const decimals = unitIndex === 0 ? 0 : 1;

  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function createProgress(destination: string) {
  if (process.stderr.isTTY && !progressGroup) {
    progressGroup = new cliProgress.MultiBar(
      {
        format:
          "{bar} | {filename} | {percent} | " +
          "{size} | {speed} | ETA {etaText} | {state}",
        barsize: 16,
        fps: 5,
        hideCursor: true,
        clearOnComplete: true,
        stopOnComplete: false,
      },
      cliProgress.Presets.shades_classic,
    );
  }

  const group = progressGroup;

  const displayName = Array.from(
    basename(destination).replace(/[\u0000-\u001F\u007F]/g, "_"),
  )
    .slice(0, 32)
    .join("");

  const bar = group?.create(1, 0, {
    filename: displayName,
    percent: "--",
    size: "0 B / ?",
    speed: "--",
    etaText: "--",
    state: "menunggu",
  });

  if (bar) {
    activeBars++;
  }

  let received = 0;
  let initialBytes = 0;
  let total: number | null = null;
  let startedAt = performance.now();
  let lastUpdate = 0;

  function render(force = false): void {
    const now = performance.now();

    if (!force && now - lastUpdate < 200) {
      return;
    }

    lastUpdate = now;

    const elapsedSeconds = (now - startedAt) / 1_000;
    const transferred = received - initialBytes;

    const speed = elapsedSeconds > 0 ? transferred / elapsedSeconds : 0;

    const currentTotal = total;

    let percentage: number | null = null;
    let eta: number | null = null;
    let progressValue = 0;

    if (currentTotal !== null && currentTotal > 0) {
      percentage = Math.min((received / currentTotal) * 100, 100);

      progressValue = Math.min(received, currentTotal);

      if (speed > 0) {
        eta = Math.ceil(Math.max(currentTotal - received, 0) / speed);
      }
    }

    bar?.update(progressValue, {
      percent: percentage === null ? "--" : `${percentage.toFixed(1)}%`,

      size:
        `${formatBytes(received)} / ` +
        `${currentTotal === null ? "?" : formatBytes(currentTotal)}`,

      speed: `${formatBytes(speed)}/s`,
      etaText: eta === null ? "--" : `${eta}s`,
    });
  }

  return {
    reset(attempt: number): void {
      received = 0;
      initialBytes = 0;
      total = null;
      startedAt = performance.now();
      lastUpdate = 0;

      bar?.setTotal(1);

      bar?.update(0, {
        percent: "--",
        size: "0 B / ?",
        speed: "--",
        etaText: "--",
        state: `request #${attempt}`,
      });
    },

    meter(offset: number, totalBytes: number | null): Transform {
      initialBytes = offset;
      received = offset;
      total = totalBytes;
      startedAt = performance.now();
      lastUpdate = 0;

      bar?.setTotal(totalBytes !== null && totalBytes > 0 ? totalBytes : 1);

      bar?.update({
        state: offset > 0 ? "resume" : "download",
      });

      render(true);

      return new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.byteLength;
          render();

          callback(null, chunk);
        },

        flush(callback) {
          render(true);
          callback();
        },
      });
    },

    setState(state: string): void {
      bar?.update({
        state,
        speed: "--",
        etaText: "--",
      });
    },

    retry(message: string): void {
      bar?.update({
        state: "menunggu retry",
        speed: "--",
        etaText: "--",
      });

      const safeMessage = message.replace(/[\u0000-\u001F\u007F]/g, " ");

      if (group) {
        group.log(`${safeMessage}\n`);
      } else {
        console.warn(safeMessage);
      }
    },

    close(): void {
      if (!group || !bar) {
        return;
      }

      group.remove(bar);
      activeBars--;

      if (activeBars === 0) {
        group.stop();
        progressGroup = undefined;
      }
    },
  };
}

/*
 * URL dan filesystem
 */

function createFileUrl(file: Attachment): URL {
  if (
    !file.path.startsWith("/") ||
    file.path.startsWith("//") ||
    /[\\?#]/.test(file.path)
  ) {
    throw new Error(`Path attachment tidak valid: ${file.path}`);
  }

  const url = new URL(`/data${file.path}`, FILE_ORIGIN);

  if (url.origin !== FILE_ORIGIN || !url.pathname.startsWith("/data/")) {
    throw new Error("URL attachment keluar dari lokasi file.");
  }

  if (file.name) {
    url.searchParams.set("f", file.name);
  }

  return url;
}

async function isExistingFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);

    if (!info.isFile()) {
      throw new Error(`Path sudah ada tetapi bukan file biasa: ${path}`);
    }

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/*
 * Resume metadata
 */

function strongETag(value: string | null): string | null {
  if (!value || !/^"[^"\r\n]*"$/.test(value)) {
    return null;
  }

  return value;
}

function parseByteCount(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }

  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < 0) {
    return null;
  }

  return number;
}

async function readResumeMetadata(
  path: string,
): Promise<ResumeMetadata | null> {
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }

  try {
    const result = ResumeSchema.safeParse(JSON.parse(text));

    return result.success ? result.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

async function writeResumeMetadata(
  path: string,
  metadata: ResumeMetadata,
): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx");

  try {
    try {
      await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }

    await rename(temporaryPath, path);
  } finally {
    await removeIfExists(temporaryPath);
  }
}

function getRetryAt(value: string | null): number {
  if (!value) {
    return 0;
  }

  const raw = value.trim();

  const timestamp = /^\d+$/.test(raw)
    ? Date.now() + Number(raw) * 1_000
    : Date.parse(raw);

  if (Number.isNaN(timestamp)) {
    return 0;
  }

  if (!Number.isSafeInteger(timestamp)) {
    throw new AbortError("Nilai Retry-After terlalu besar.");
  }

  return timestamp;
}

/*
 * Manifest file final
 */

async function verifyExistingFile(
  destination: string,
  sourceIdentity: string,
  expected?: FileManifestEntry,
): Promise<FileManifestEntry | null> {
  if (!(await isExistingFile(destination))) {
    return null;
  }

  if (!expected) {
    throw new Error(
      `File final ada tetapi belum tercatat di manifest: ` + destination,
    );
  }

  if (expected.filename !== basename(destination)) {
    throw new Error(`Nama file berbeda dari manifest: ${destination}`);
  }

  if (expected.source !== sourceIdentity) {
    throw new Error(
      `File final berasal dari attachment berbeda: ` + destination,
    );
  }

  const info = await lstat(destination);

  if (info.size !== expected.size) {
    throw new Error(
      `Ukuran file final tidak cocok: ${destination} ` +
        `(disk ${info.size}, manifest ${expected.size})`,
    );
  }

  return expected;
}

/*
 * Download
 */

async function performDownload(
  file: Attachment,
  destination: string,
  progress: ReturnType<typeof createProgress>,
  options: DownloadFileOptions,
): Promise<DownloadResult> {
  if (file.deferred) {
    throw new Error(`Attachment belum tersedia: ${file.name || file.path}`);
  }

  const url = createFileUrl(file);

  // Parameter ?f= hanya memengaruhi nama download.
  const sourceIdentity = `${url.origin}${url.pathname}`;

  await mkdir(dirname(destination), {
    recursive: true,
  });

  const existing = await verifyExistingFile(
    destination,
    sourceIdentity,
    options.expected,
  );

  if (existing) {
    progress.setState("verified");

    return {
      status: "skipped",
      destination,
      manifest: existing,
    };
  }

  const partialPath = `${destination}.part`;
  const metadataPath = `${partialPath}.json`;

  let forceRestart = false;

  const completed = await pRetry(
    async (attemptNumber) => {
      progress.reset(attemptNumber);

      const partialExists = await isExistingFile(partialPath);

      const partialSize = partialExists ? (await lstat(partialPath)).size : 0;

      const metadata = await readResumeMetadata(metadataPath);

      const savedETag = metadata ? strongETag(metadata.etag) : null;

      const canResume =
        !forceRestart &&
        partialSize > 0 &&
        metadata !== null &&
        metadata.source === sourceIdentity &&
        savedETag !== null &&
        (metadata.total === null || partialSize <= metadata.total);

      const offset = canResume ? partialSize : 0;

      const headers = new Headers({
        "Accept-Encoding": "identity",
      });

      if (canResume && savedETag !== null) {
        headers.set("Range", `bytes=${offset}-`);
        headers.set("If-Range", savedETag);
      }

      let response: Response;

      try {
        response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch (error) {
        throw new RetryableDownloadError("Request file gagal.", {
          cause: error,
        });
      }

      try {
        if (response.status === 416 && canResume) {
          forceRestart = true;

          throw new RetryableDownloadError(
            "Range ditolak; percobaan berikutnya " + "dimulai dari awal.",
          );
        }

        if (response.status !== 200 && response.status !== 206) {
          if (!RETRYABLE_STATUS.has(response.status)) {
            throw new AbortError(`Download gagal: HTTP ${response.status}`);
          }

          const error = new RetryableDownloadError(
            `Download gagal: HTTP ${response.status}`,
          );

          error.retryAt = getRetryAt(response.headers.get("retry-after"));

          throw error;
        }

        if (!response.body) {
          throw new AbortError("Respons download tidak memiliki body.");
        }

        const contentType = response.headers.get("content-type") ?? "";

        if (contentType.toLowerCase().includes("text/html")) {
          throw new AbortError("Server mengirim HTML, bukan attachment.");
        }

        const encoding = response.headers
          .get("content-encoding")
          ?.trim()
          .toLowerCase();

        if (encoding && encoding !== "identity") {
          throw new AbortError(
            "Server mengirim respons terkompresi; " +
              "offset resume tidak aman.",
          );
        }

        const responseETag = strongETag(response.headers.get("etag"));

        let startOffset = 0;
        let total: number | null = null;
        let responseEnd: number | null = null;

        if (response.status === 206) {
          if (!canResume || metadata === null) {
            throw new AbortError("Server mengirim 206 tanpa request resume.");
          }

          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
            response.headers.get("content-range") ?? "",
          );

          const start = parseByteCount(range?.[1] ?? null);

          const end = parseByteCount(range?.[2] ?? null);

          const completeSize = parseByteCount(range?.[3] ?? null);

          const bodyLength = parseByteCount(
            response.headers.get("content-length"),
          );

          const invalidRange =
            start === null ||
            end === null ||
            completeSize === null ||
            start !== offset ||
            end < start ||
            end >= completeSize ||
            (bodyLength !== null && bodyLength !== end - start + 1);

          const changedFile =
            responseETag !== savedETag ||
            (metadata.total !== null && completeSize !== metadata.total);

          if (invalidRange || changedFile) {
            forceRestart = true;

            throw new RetryableDownloadError(
              "Respons resume tidak cocok; " + "akan meminta file penuh.",
            );
          }

          startOffset = offset;
          total = completeSize;
          responseEnd = end;
        } else {
          // HTTP 200 berarti body berisi file penuh.
          total = parseByteCount(response.headers.get("content-length"));
        }

        if (response.status === 206) {
          const actualSize = (await lstat(partialPath)).size;

          if (actualSize !== startOffset) {
            throw new AbortError("Ukuran partial berubah selama request.");
          }
        }

        await writeResumeMetadata(metadataPath, {
          version: 1,
          source: sourceIdentity,
          etag: responseETag,
          total,
        });

        forceRestart = false;

        const source = Readable.fromWeb(response.body);

        let sourceFailed = false;

        source.once("error", () => {
          sourceFailed = true;
        });

        const writer = createWriteStream(partialPath, {
          // 206 melanjutkan dari akhir file.
          // 200 mengosongkan file lalu menulis dari awal.
          flags: response.status === 206 ? "a" : "w",
        });

        try {
          await pipeline(source, progress.meter(startOffset, total), writer);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;

          if (
            ["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EIO", "EROFS"].includes(
              code ?? "",
            )
          ) {
            throw error;
          }

          if (sourceFailed) {
            throw new RetryableDownloadError(
              "Transfer terputus; partial dipertahankan.",
              { cause: error },
            );
          }

          throw error;
        }

        const downloadedSize = (await lstat(partialPath)).size;

        if (
          (responseEnd !== null && downloadedSize > responseEnd + 1) ||
          (total !== null && downloadedSize > total)
        ) {
          forceRestart = true;

          throw new RetryableDownloadError(
            "Ukuran file melebihi rentang; " + "akan mengunduh ulang.",
          );
        }

        if (
          (responseEnd !== null && downloadedSize !== responseEnd + 1) ||
          (total !== null && downloadedSize !== total)
        ) {
          throw new RetryableDownloadError(
            "File belum lengkap; " + "akan mencoba melanjutkan.",
          );
        }

        return {
          size: downloadedSize,
          etag: responseETag,
        };
      } finally {
        if (response.body && !response.body.locked) {
          await response.body.cancel().catch(() => {});
        }
      }
    },
    {
      retries: 3,
      factor: 2,
      minTimeout: 1_000,
      maxTimeout: 10_000,
      randomize: true,

      onFailedAttempt: ({ error, attemptNumber }) => {
        progress.retry(
          `[Download] ${file.name || file.path}: ` +
            `percobaan ${attemptNumber} gagal — ` +
            error.message,
        );
      },

      shouldRetry: async ({ error }) => {
        if (!(error instanceof RetryableDownloadError)) {
          return false;
        }

        while (Date.now() < error.retryAt) {
          await Bun.sleep(Math.min(error.retryAt - Date.now(), 60_000));
        }

        return true;
      },
    },
  );

  progress.setState("finalisasi");

  await link(partialPath, destination);

  const finalInfo = await lstat(destination);

  if (finalInfo.size !== completed.size) {
    throw new Error(`Ukuran file berubah saat finalisasi: ${destination}`);
  }

  await unlink(partialPath);
  await removeIfExists(metadataPath);

  return {
    status: "saved",
    destination,
    manifest: {
      filename: basename(destination),
      source: sourceIdentity,
      size: finalInfo.size,
      etag: completed.etag,
    },
  };
}

export async function downloadFile(
  file: Attachment,
  destination: string,
  options: DownloadFileOptions = {},
): Promise<DownloadResult> {
  const progress = createProgress(destination);

  try {
    return await performDownload(file, destination, progress, options);
  } finally {
    progress.close();
  }
}
