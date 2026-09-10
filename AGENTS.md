# AGENTS.md

Bun CLI app that downloads posts/files from pawchive.pw (`https://pawchive.pw/{service}/user/{userId}[/post/{postId}]`).

## Commands

- Runtime is **Bun**, not Node (lockfile: `bun.lock`). Install with `bun install`.
- `bun run dev` / `bun run start` — run `src/index.ts`.
- `bun test` — Bun's built-in test runner. **There are currently no tests**; downloader hits the live API with no fixtures. Don't fake offline tests for it.
- `bun run format` — `bunx prettier . --write` (printWidth 120, single quote).
- No lint/typecheck scripts exist. Typecheck with `bunx tsc --noEmit` (tsconfig sets `noEmit`, `types: ["bun"]`).
- Build (not used in dev): `bun build ./src/index.ts --compile --outfile paw-dl`.

## Codebase conventions

- Relative imports **must keep the `.ts` extension** (`./cli.ts`), and type-only imports **must use `import type`** (`verbatimModuleSyntax` on). Zero-config tooling will otherwise resolve these fine, but writing bare `./cli` imports silently breaks the tsconfig contract and repo style.
- User-facing console messages (errors/logs) are in **English**.

## Architecture

- `src/cli.ts` (commander) parses the URL and flags; `--post <n>` limits a creator run to `n` posts (fetches all when omitted) and is only valid for creator URLs, `--include-files` is a comma-separated extension list (or `all`), `-f/--force` bypasses the output lock.
- `src/api/` — pawchive.pw API v1 via `fetch` + `p-retry`. `requestJson` retries 408/429/5xx with `Retry-After` backoff (in `client.ts`). `schemas.ts` validates responses with zod; API tolerates several "empty file" shapes (null / undefined / `{}` / empty path).
- `src/downloader/` — per-file resume download (`.part` + `.part.json`), then hard-link to final name. Per-post state lives in the output folder: `.manifest.json` (records source/etag/size per file), `.post-id` (identity marker), so folders survive re-runs. `queue.ts` is a p-limit wrapper. Default concurrency is 3.
- `src/lock.ts` — `.paw-dl.lock` JSON file in the output dir keyed by PID; a stale lock from a dead PID is auto-reclaimed. Signals/uncaught exceptions release it.
- Output layout per post: `<output>/[DDMMYYYY] <user>-<title>[/]` folder containing numbered media files and the hidden dotfiles above.

## Tooling notes

- `.prettierignore` only excludes `build` and `coverage`; `node_modules` is gitignored so Prettier formats it too.
- Commits use conventional-commit style (`feat:`, `chore:`, `init:`).
