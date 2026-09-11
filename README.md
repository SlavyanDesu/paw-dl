# paw-dl

A CLI tool using [Bun](https://bun.com) as a runtime to download your hearts content from [Pawchive](https://pawchive.pw)!

It features resumable download, fetch all posts from creator, and includes attachment to download.

## Setup

```sh
git clone https://github.com/SlavyanDesu/paw-dl
cd paw-dl
bun install
```

If you are planning to use this downloader on Android through Termux, [follow these steps](#run-on-termux).

## Usage

Download a post:

```sh
bun run start "https://pawchive.pw/<service>/user/<userId>/post/<postId>" -o ./downloads
```

Download all posts from creator page:

```sh
bun run start "https://pawchive.pw/<service>/user/<userId>" -o ./downloads
```

Download five latest posts from creator page and include ZIP and PSD attachments:

```sh
bun run start "https://pawchive.pw/<service>/user/<userId>" -o ./downloads --post 5 --include-files zip,psd
```

### Options

| Option                         | Behavior                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `-o, --output [folder_name]`   | Output dir. Default: current working directory.                                  |
| `-n, --post <number>`          | Limit the number of posts fetched from a creator. Omit to fetch all posts.       |
| `--include-files <extensions>` | Include attachments, separated by commas, or use `all`.                          |
| `-f, --force`                  | Bypass the output directory lock. Does not overwrite files or bypass validation. |
| `-h, --help`                   | Show help.                                                                       |

`--post` only works with creator URLs. Images and videos are included by default.  
Use `--include-files all` to include every available attachment type.

Posts are processed one at a time, with up to three files downloading concurrently.

## Output

Each post gets a folder named `[YYYYMMDD] <creator>-<title>`, with numbered files inside:

```text
downloads/
  [20260102] Creator-Post title/
    .post-id
    .manifest.json
    Creator-Post title-001.jpg
    Creator-Post title-002.mp4
```

## Run on Termux

Install Termux from F-Droid or GitHub (Play Store build is outdated). This needs a 64-bit device (`aarch64` or `x86_64`); upstream Bun only ships Android builds for those.

Install native Bun from TUR:

```sh
pkg update
pkg install -y tur-repo git
pkg update
pkg install -y bun
bun --version
```

Clone and run paw-dl from Termux home:

```sh
git clone https://github.com/SlavyanDesu/paw-dl
cd paw-dl
bun install
bun run start --help
bun run start "https://pawchive.pw/<service>/user/<userId>" -o ./downloads
```

To save into shared storage, keep the repo in Termux home and point only the output there:

```sh
termux-setup-storage
bun run start "https://pawchive.pw/<service>/user/<userId>" -o ~/storage/downloads/paw-dl
```

Shared storage does not support hard links, but paw-dl falls back to a same-directory rename automatically. Lock file and `--force` behave the same as on desktop.

## Build an executable

```sh
bun run build
./paw-dl --help
```

The build produces an executable for the current platform with Bun bundled in. It accepts the same arguments as the source command.

## License

**paw-dl** © [SlavyanDesu](https://github.com/SlavyanDesu), released under the [MIT](LICENSE) License. Authored and maintained by SlavyanDesu.
