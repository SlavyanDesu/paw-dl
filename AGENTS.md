# AGENTS.md

Bun CLI app that downloads posts/files from pawchive.pw (`https://pawchive.pw/{service}/user/{userId}[/post/{postId}]`).

## Commands

- Runtime is **Bun**, not Node (lockfile: `bun.lock`). Install with `bun install`.
- `bun run dev` / `bun run start` run `src/index.ts`.
- `bun run src/index.ts --help` is an offline CLI smoke check. Runs with a valid URL hit the live API.
- `bun test` runs offline checks beside the source files (loopback HTTP server + `spyOn(globalThis, 'fetch')` rewriting pawchive origins to `127.0.0.1`; temporary output; no live API access). Focus e.g. with `bun test src/downloader/file/`.
- CI (`.github/workflows/ci.yml`) runs `bun install --frozen-lockfile`, `bun test`, `bunx tsc --noEmit`, `bunx prettier . --check`, and the `--help` smoke check.
- No lint/typecheck scripts exist. Typecheck with `bunx tsc --noEmit` (`strict` + `noUnusedLocals`/`noUnusedParameters` are on).
- `bun run format` rewrites the whole repo with Prettier; use `bunx prettier <changed-files> --check` for focused verification (120 columns, single quotes).
- `bun run build` compiles a standalone `paw-dl` executable in the repo root; that artifact is not gitignored.

## Codebase conventions

- Keep `.ts` extensions on relative imports. Use `import type` or inline `type` specifiers for type-only imports (`verbatimModuleSyntax` is enabled).
- User-facing console messages (errors/logs) are in **English**.
- Commits use conventional-commit style (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
- No `commander`: CLI parsing is `node:util parseArgs` in `src/cli.ts`. Progress bars use `cli-progress` in `src/downloader/progress.ts` (TTY stderr `MultiBar`, `console.warn` fallback off-TTY); keep the `ProgressTracker` class (`reset`/`meter`/`retry`/`setState`/`close`) stable so downloaders stay untouched. Don't reintroduce `commander`.

## Architecture

- `src/index.ts` processes posts sequentially; `src/downloader/queue.ts` limits concurrent file downloads to 3 (`DEFAULT_CONCURRENCY` lives there). Creator listings paginate in batches of 50 and fetch each post's detail separately.
- `src/cli.ts`: output defaults to cwd (`-o <folder>` takes a required value). `--post <n>` and `--flat` work on creator URLs only; omitting `--post` fetches all posts. `--include-files zip,psd` (or `all`) adds to the default image/video filter; deferred attachments are always skipped.
- `src/api/client.ts` uses `https://pawchive.pw/api/v1`; files use `https://file.pawchive.pw/data/...`. Retryable statuses (408/429/500/502/503/504) and `Retry-After` parsing live in `src/utils/http.ts`; the shared backoff loop lives in `src/utils/retry.ts` and is used by both the API client and the file downloader. `FILE_ORIGIN` lives in `src/utils/attachment-url.ts`, which also owns URL validation and query-free source identity.
- `src/api/schemas.ts` accepts wrapped or bare post/list responses and empty attachments as null, undefined, `{}`, or an empty path; preserve this API compatibility (`src/api/schemas.test.ts` pins it with recorded live shapes).
- Per-file download is split in `src/downloader/file/`: `types.ts` (types + size/timeout constants), `resume.ts` (ETag/range/resume state), `response.ts` (status matrix), `stream.ts` (disk write), `finalize.ts` (verify + publish), `download-file.ts` (orchestrator only).
- Per-post planning is split in `src/downloader/post/`: `directory.ts` (folder + `.post-id`), `manifest.ts` (manifest + log sanitizing + tmp sweep), `jobs.ts` (filter + stable naming), `download-post.ts` / `download-flat.ts` (orchestrators only).

## Download state

- Default mode folders are `<output>/[YYYYMMDD] <user>-<title>/`; `--flat` puts everything in the output root as `[YYYYMMDD] <user>-<title> [<postId>]-NNN.<ext>` instead. `src/utils/filename.ts` rejects missing/invalid published dates rather than inventing a fallback.
- `.post-id` identifies the service/user/post for folder reuse (unused in flat mode). `.manifest.json` (per post folder, or output root in flat mode with creator identity) maps source URLs to stable filenames, sizes and ETags. Keep these with downloaded files: an existing final file without a matching manifest entry is an error, not a skip. Manifest filenames are validated to stay inside the folder (no `/`, `\`, controls; source must be under `FILE_ORIGIN/data/`), and each saved file is recorded immediately so interrupted runs keep completed files.
- `src/downloader/file/` resumes from `.part` + `.part.json` only with matching source metadata and a strong ETag, capped at 10 GiB (`MAX_FILE_BYTES`). Finalization hard-links the partial to the final name without overwriting; when hard links are unavailable (bun-termux stubs `linkat()` with `EXDEV`, Android shared storage lacks them) it falls back to `copyFile` with `COPYFILE_EXCL`, which still refuses to overwrite atomically. Fallback triggers on EXDEV/EPERM/EOPNOTSUPP/ENOSYS/EACCES (EACCES observed on Termux, where the real link syscall is denied). The fallback path can't trigger on Linux CI.
- `src/lock.ts` stores a PID lock at `<output>/.paw-dl.lock`; dead-PID locks are reclaimed. `--force` bypasses this lock, not file/manifest validation. `src/index.ts` releases the lock via `try/finally` plus signal and uncaught-exception handlers.
