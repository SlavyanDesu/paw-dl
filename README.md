# paw-dl

A CLI downloader for [Pawchive](https://pawchive.pw).

## Setup

Requires [Bun](https://bun.com).

```sh
git clone https://github.com/SlavyanDesu/paw-dl
cd paw-dl
bun install
```

Termux Android users, see the [Termux guide](#run-on-termux) instead.

## Update

```sh
git pull
bun install
```

## Usage

The URL shape is `https://pawchive.pw/{service}/user/{userId}[/post/{postId}]`.

- Download a single post:

```sh
bun run start "https://pawchive.pw/{service}/user/{userId}/post/{postId}" -o ./downloads
```

- Download all posts from a creator:

```sh
bun run start "https://pawchive.pw/{service}/user/{userId}" -o ./downloads
```

- Download the five latest posts from a creator, including ZIP and PSD attachments:

```sh
bun run start "https://pawchive.pw/{service}/user/{userId}" -o ./downloads --post 5 --include-files zip,psd
```

- Download everything into one folder instead of per-post folders:

```sh
bun run start "https://pawchive.pw/{service}/user/{userId}" -o ./downloads --flat
```

### Favorites

To use `--favorites` option, you need a `session` cookie — see [Authentication](#authentication).

- Download your favorited posts:

```sh
bun run start --favorites posts -o ./downloads
```

- Download all posts from your favorited creators:

```sh
bun run start --favorites creators -o ./downloads
```

## Authentication

Favorites require a `session` cookie. Find it in logged-in browser DevTools:

1. Log in at `https://pawchive.pw` and open DevTools → **Application** → **Cookies**.
2. Copy the value of the `session` cookie.

On Android, DevTools is not available in mobile browsers. Install **Kiwi Browser** (a Chromium fork that supports desktop Chrome extensions), log in, install **EditThisCookie** from the Chrome Web Store, and copy the `session` value from there. Or just copy it from your desktop and send it to your phone.

Pass it per run:

```sh
bun run start --favorites posts --session <cookie> -o ./downloads
```

To avoid passing it every time, save it once to `.env` in the repo root. `--session` on the command line will override it:

```sh
printf 'PAWCHIVE_SESSION=<cookie>\n' > .env
bun run start --favorites posts -o ./downloads
```

If `.env` already has unrelated entries, append the line instead of overwriting them. When the cookie expires, you get:

```
Session invalid or expired. Log in again and refresh the cookie.
```

Replace the cookie and rerun.

## Options

| Option                          | Behavior                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `-o, --output <folder>`         | Output dir. Default: current working directory.                                 |
| `-n, --post <number>`           | Limit posts per creator, or favorited posts in posts scope. Omit for all posts. |
| `--include-files <extensions>`  | Include attachments: comma-separated extensions (`zip,psd,pdf`) or `all`.       |
| `-f, --force`                   | Bypass the output directory lock.                                               |
| `--flat`                        | Flat layout into one folder.                                                    |
| `--favorites <posts\|creators>` | Download favorites without a URL. Needs `--session` or `PAWCHIVE_SESSION`.      |
| `--session <cookie>`            | Pawchive session cookie for favorites. Falls back to `PAWCHIVE_SESSION`.        |
| `-h, --help`                    | Show help.                                                                      |

Images and videos are always included. `--include-files all` adds every remaining attachment type.

## Output

Each post gets a folder named `[YYYYMMDD] <user>-<title>`, with numbered files inside:

```text
output/
  [20260102] Creator-Title/
    .post-id
    .manifest.json
    Creator-Title-001.jpg
    Creator-Title-002.png
```

With `--flat`, everything lands directly in the output folder, named `[YYYYMMDD] <user>-<title> [<postId>]-<number>.<ext>`, with a single root `.manifest.json`:

```text
output/
  .manifest.json
  [20260102] Creator-Title [456]-001.jpg
  [20260102] Creator-Title [457]-001.png
```

`.manifest.json` (and, non-flat, `.post-id`) are kept with your files: they map sources to stable names and sizes so reruns skip what already downloaded. A final file without a matching manifest entry is an error, not a skip. Keep flat output for `--favorites posts` and `--favorites creators` in separate folders — they carry different manifest identities.

Rerunning the same command reflects on the output folder: already-downloaded files are skipped (unless changed upstream), completed files are always reused, and a `paw-dl` process holds a `.paw-dl.lock` in the output folder (stale-PID locks are reclaimed; `--force` bypasses the lock but does not disable file checks).

## How downloading works

```text
CLI options + session cookie
        |
        v
acquire output lock (.paw-dl.lock)
        |
        v
pick the posts to process: post URL | creator listing | favorites scope
  creator   -> GET /api/v1/{service}/user/{userId}/profile  (name)
  creator   -> page through the creator listing in batches of 50 (each detail refetched)
  favorites -> GET /account/favorites?type=post             (full posts)
  favorites -> GET /account/favorites                       (favorited creators)
        |
        v
for each post:
  - combine images/videos + included attachments
  - name files from date/title, reserving names already taken
  - download up to 3 files concurrently (resuming via .part/.part.json + ETag)
  - write each finished file via hard-link / exclusive-copy publish
  - record the file in .manifest.json immediately
        |
        v
shutdown summary -> exit status (1 on failure/listing interruption) -> release lock
```

Post details are always fetched separately; creator listings page in batches of 50, and favorite posts arrive as full post objects so no refetch is needed. Flat mode processes one post at a time and updates the manifest between posts, so interrupting a run keeps every completed file — nothing is buffered in memory, and never-planned posts are simply refetched next run.

Resumption relies on a matching source and a strong ETag, and is capped at 10 GiB per file. Finalization hard-links the temporary file to the final name without overwriting; where hard links are unavailable (Android/Termux, shared storage), it uses an exclusive copy that still refuses to overwrite.

## Run on Termux

Install Termux from F-Droid or GitHub (the Play Store build is outdated). You need a 64-bit device (`aarch64` or `x86_64`) — upstream Bun only ships Android builds for those.

Install Bun from TUR:

```sh
pkg update
pkg install -y tur-repo git
pkg update
pkg install -y bun
bun --version
```

Keep the repo in Termux home, not in shared storage:

```sh
git clone https://github.com/SlavyanDesu/paw-dl
cd paw-dl
bun install
bun run start --help
bun run start "https://pawchive.pw/{service}/user/{userId}" -o ./downloads
```

Set up the session once so favorites work without typing the cookie every time:

```sh
printf 'PAWCHIVE_SESSION=<cookie>\n' > .env
bun run start --favorites posts -o ./downloads
```

To save downloads into Android shared storage, grant access and point only the output directory there (the repo and `.env` stay in Termux home):

```sh
termux-setup-storage
bun run start --favorites creators -o ~/storage/downloads/paw-dl
```

Android shared storage has no hard links, so paw-dl publishes files with an exclusive copy that refuses to overwrite. Locking and `--force` behave the same as on desktop.

## Development

```sh
bun test            # offline tests — loopback HTTP + fetch rewriting, no live API
bunx tsc --noEmit   # strict typecheck
bunx prettier . --check
bun run start --help
```

The codebase maps to the pipeline above:

```text
src/
  cli.ts                    option parsing, --post/--flat/favorites rules, help
  index.ts                  entrypoint: lock, favorites lookup, per-post loop, summary
  lock.ts                   .paw-dl.lock with stale-PID reclaim
  api/
    client.ts               pawchive API calls + session cookie + favorites lists
    schemas.ts              Zod validation (wrapped/bare responses, empty attachments)
  utils/
    retry.ts / http.ts      backoff loop, retryable statuses, Retry-After
    filename.ts             folder/stem naming, date handling
    attachment-url.ts       file origin + URL validation
    fs.ts                   atomic JSON writes
  downloader/
    queue.ts                cap 3 concurrent file downloads
    progress.ts             TTY progress bars (stable ProgressTracker)
    post/                   per-post planning: directory, manifest, naming, jobs
    file/                   per-file transfer: resume, response matrix, stream, finalize
```

## License

**paw-dl** © [SlavyanDesu](https://github.com/SlavyanDesu), released under the [MIT](LICENSE) License. Authored and maintained by SlavyanDesu.
