# AGENTS.md

CLI downloader for Pawchive.com archives (`pawchive.pw`). Bun-only TypeScript; no npm/Node toolchain. User-facing strings are Indonesian — keep that convention.

## Commands

- Run CLI: `bun run src/index.ts <pawchive-url>` (also `bun start`)
- Tests: `bun test` — uses `bun:test`; **no test files exist yet**
- Typecheck: `bunx tsc --noEmit` (tsconfig has `noEmit`, `strict`)
- Format: `bunx prettier . --write` (config is `{}`; ignores `build/`, `coverage/`)
- Build single-file binary: `bun build ./src/index.ts --compile --outfile paw-dl`

Use `bun`/`bunx`, never npm/yarn. `node_modules/.bin` here only holds bun-compiled Windows shims (installed via WSL mount), so tooling outside Bun won't run.

## TypeScript conventions

- Relative imports use explicit `.ts` extensions (`import x from "./cli.ts"`) — mandatory, do not strip.
- `verbatimModuleSyntax` is on: type-only imports must use `import type`.
- `noUncheckedIndexedAccess` is on: array/record indexing yields `T | undefined`; code pairs that with explicit guards.
- tsconfig `"types": ["bun"]` — no `@types/node`.

## Architecture

Entry: `src/index.ts` → `src/cli.ts` (commander CLI, parsing + validation) → `src/api/client.ts` → `src/downloader/*`.

- `src/api/client.ts`: REST to `https://pawchive.pw/api/v1`. All responses validated via `src/api/schemas.ts` (zod). Retries 408/429/5xx with `Retry-After` handling.
- Pagination: creator listing uses `o` offset query param, `PAGE_SIZE = 50`, dedupes post IDs. **`PAGE_SIZE`/offset shape is a stated assumption** (comment in `client.ts`) — not verified against the real API.
- `src/downloader/queue.ts`: shared p-limit queue (concurrency 3, set in `index.ts`). All downloads must go through this queue, never bare `fetch`.
- Attachment files come from `https://file.pawchive.pw`; `file.path` is prefixed with `/data`. `deferred` attachments are always skipped.

## Persistence design (easy to break — preserve exactly)

- Each post folder carries `.post-id` marker containing identity `JSON.stringify([service, userId, postId])`. Folder is reused only when the marker matches; otherwise the name is suffixed ` [postId]`.
- `.manifest.json` in each folder (version 1, atomically written tmp→`fsync`→`rename`) maps `source` → `{filename, source, size, etag}` and is used to skip already-downloaded files.
- Per-file resume: `{filename}.part` + `{filename}.part.json`. Resume requires a strong ETag (`If-Range`) and Range; any mismatch forces a fresh full download. Finalization is `link(partial, dest)` then `unlink(partial)`.
- Progress bars (`cli-progress`) render only when stderr is a TTY; never assume TTY.

## Verification

No tests and no sandbox exists — changes are validated by running against the live API: `bun run src/index.ts <post-or-creator-url>`. Requires network; runs real downloads and writes to the output dir. Prefer typecheck + prettier for cheap verification: `bunx tsc --noEmit && bunx prettier . --check`.