# paw-dl

A Bun CLI for downloading images, videos, and other attachments from [Pawchive](https://pawchive.pw).
Give it a creator URL to download their posts, or a post URL to download just that post.

Work in progress.

## Setup

Install [Bun](https://bun.sh), then run these commands from the repository directory:

```sh
bun install
bun run src/index.ts --help
```

## Usage

Replace the placeholders below with the service and IDs from a Pawchive URL.

Download a creator's posts:

```sh
bun run src/index.ts "https://pawchive.pw/<service>/user/<userId>" -o ./downloads
```

Download one post:

```sh
bun run src/index.ts "https://pawchive.pw/<service>/user/<userId>/post/<postId>" -o ./downloads
```

Limit a creator run to five posts and include ZIP and PSD attachments:

```sh
bun run src/index.ts "https://pawchive.pw/<service>/user/<userId>" -o ./downloads --post 5 --include-files zip,psd
```

### Options

| Option                         | Behavior                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `-o, --output [folder]`        | Save to this directory. Defaults to the current working directory.                                     |
| `-n, --post <number>`          | Limit the number of posts fetched from a creator. Must be a positive integer. Omit to fetch all posts. |
| `--include-files <extensions>` | Include extra file extensions, separated by commas, or use `all`.                                      |
| `-f, --force`                  | Bypass the output directory lock. Does not overwrite files or bypass validation.                       |
| `-h, --help`                   | Show help.                                                                                             |

`--post` only works with creator URLs. Images and videos are included by default;
`--include-files` adds to that selection. Use `--include-files all` to include every available attachment type.
Attachments marked as deferred by the API are always skipped.

Posts are processed one at a time, with up to three files downloading concurrently.
The CLI prints a summary and exits with a nonzero status if a post or file fails, or the listing is interrupted.

## Output and reruns

Each post gets a folder named `[DDMMYYYY] <creator>-<title>`, with numbered files inside:

```text
downloads/
  [02012026] Creator-Post title/
    .post-id
    .manifest.json
    Creator-Post title-001.jpg
    Creator-Post title-002.mp4
```

Names are sanitized for the filesystem. Posts without a valid published date cannot have a download folder created.

Run the same command with the same output directory to continue a previous download:

- Completed files are skipped when their filename, source, and size match the manifest.
- Each finished file is recorded in `.manifest.json` immediately, so an interrupted post run keeps
  what already completed instead of losing the whole post's progress.
- Interrupted downloads leave `.part` and `.part.json` files. These allow resuming when the source matches and the server confirms the same file with a strong ETag; otherwise, the download starts over.
- Keep `.post-id` and `.manifest.json` with the downloaded files. An existing file without a matching manifest entry is an error, not an automatic skip.
  Manifest filenames are validated to stay inside the post folder.
- Final files are created using hard links to avoid overwriting an existing destination. The output filesystem must support hard links.

A `.paw-dl.lock` file in the output directory prevents overlapping runs. The lock is created
exclusively, so two processes cannot both claim the directory; locks from dead processes and
half-written locks from crashes are reclaimed automatically.
Use `--force` only when you know another downloader is not writing to that directory.

## Build a standalone executable

```sh
bun run build
./paw-dl --help
```

The build produces an executable for the current platform with Bun bundled in. It accepts the same arguments as the source command.
The generated executable is not gitignored; leave it out of commits.

## Development

```sh
bun test                                      # All offline checks
bun test src/downloader/download-file.test.ts  # Download, resume, and manifest checks
bunx tsc --noEmit                              # Typecheck
bunx prettier . --check                        # Check formatting
bun run format                                # Rewrite files with Prettier
```

Tests live beside the source files. Download tests use a local HTTP server and temporary output; they do not contact Pawchive.
`--help` is also an offline check. Commands with a valid creator or post URL contact the live API.

The entrypoint is `src/index.ts`. API requests and response schemas live in `src/api/`;
download planning, transfers, and terminal progress live in `src/downloader/`.
Shared URL validation, naming, filesystem, and HTTP helpers live in `src/utils/`.

## Termux (Android)

Bun needs glibc, which Android doesn't ship, so install it via
[bun-termux](https://github.com/Happ1ness-dev/bun-termux) (no proot required):

```sh
curl -fsSL "https://raw.githubusercontent.com/Happ1ness-dev/bun-termux/main/helper_scripts/bun-termux-manager" | bash -s install
```

Then use the project normally, but run from source — compiled binaries need the
bun-termux wrapper and shim present, so they don't travel well:

```sh
git clone <this-repo> paw-dl
cd paw-dl
bun install
bun run src/index.ts "https://pawchive.pw/<service>/user/<userId>" -o ~/downloads
```

Notes:

- Keep output under Termux home (`~`). Shared storage (`/sdcard`) has no hard-link
  support; the downloader falls back to an atomic rename there, but internal storage is safer.
- All dependencies are pure JavaScript. If `bun install` complains about a native
  module, retry with `BUN_OPTIONS="--os=android" bun install`.
