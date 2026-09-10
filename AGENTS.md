# AGENTS.md

Bun CLI app that downloads posts/files from pawchive.pw (`https://pawchive.pw/{service}/user/{userId}[/post/{postId}]`).

## Commands

- Runtime is **Bun**, not Node (lockfile: `bun.lock`). Install with `bun install`.
- `bun run dev` / `bun run start` run `src/index.ts`; the root `index.ts` in package.json's `module` field does not exist.
- `bun run src/index.ts --help` is an offline CLI smoke check. Runs with a valid URL hit the live API.
- `bun test` runs offline checks beside the source files. Focus download/resume checks with `bun test src/downloader/download-file.test.ts`; they use a loopback HTTP server and temporary output, with no live API access.
- CI (`.github/workflows/ci.yml`) runs `bun install --frozen-lockfile`, `bun test`, `bunx tsc --noEmit`, `bunx prettier . --check`, and the `--help` smoke check.
- No lint/typecheck scripts exist. Typecheck with `bunx tsc --noEmit`.
- `bun run format` rewrites the whole repo with Prettier; use `bunx prettier <changed-files> --check` for focused verification (120 columns, single quotes).
- `bun run build` compiles a standalone `paw-dl` executable in the repo root; that artifact is not gitignored.

## Codebase conventions

- Keep `.ts` extensions on relative imports. Use `import type` or inline `type` specifiers for type-only imports (`verbatimModuleSyntax` is enabled).
- User-facing console messages (errors/logs) are in **English**.
- Commits use conventional-commit style (`feat:`, `chore:`, `init:`).

## Architecture

- `src/index.ts` processes posts sequentially; `src/downloader/queue.ts` limits concurrent file downloads to 3. Creator listings paginate in batches of 50 and fetch each post's detail separately.
- `src/cli.ts`: output defaults to cwd; use `-o <folder>` for live checks. `--post <n>` limits creator URLs only; omitting it fetches all posts. `--include-files zip,psd` (or `all`) adds to the default image/video filter; deferred attachments are always skipped.
- `src/api/client.ts` uses `https://pawchive.pw/api/v1`; files use `https://file.pawchive.pw/data/...`. Shared retry statuses and `Retry-After` parsing live in `src/utils/http.ts` (408/429/500/502/503/504).
- `src/utils/attachment-url.ts` owns attachment URL validation and query-free source identity for both planning and downloading. `src/downloader/progress.ts` owns the shared terminal display.
- `src/api/schemas.ts` accepts wrapped or bare post/list responses and empty attachments as null, undefined, `{}`, or an empty path; preserve this API compatibility.

## Download state

- Post folders are `<output>/[DDMMYYYY] <user>-<title>/`; `src/utils/filename.ts` rejects missing/invalid published dates rather than inventing a fallback.
- `.post-id` identifies the service/user/post for folder reuse; `.manifest.json` maps source URLs to stable filenames, sizes and ETags. Keep these with downloaded files: an existing final file without a matching manifest entry is an error, not a skip. Manifest filenames are validated to stay inside the post folder, and each saved file is recorded immediately so interrupted runs keep completed files.
- `src/downloader/download-file.ts` resumes from `.part` + `.part.json` only with matching source metadata and a strong ETag. Finalization hard-links the partial to the final name without overwriting; when hard links are unavailable (bun-termux stubs `linkat()` with `EXDEV`, Android shared storage lacks them) it falls back to a same-directory rename after rechecking the destination is absent. The `EXDEV` branch can't trigger on Linux CI — the EEXIST safety path is what's tested.
- `src/lock.ts` stores a PID lock at `<output>/.paw-dl.lock`; dead-PID locks are reclaimed. `--force` bypasses this lock, not file/manifest validation. `src/index.ts` handles lock release on signals and uncaught exceptions.
