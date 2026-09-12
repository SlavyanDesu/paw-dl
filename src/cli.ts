import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { parseTarget, type Target } from './utils/parse-url.ts';

export type FavoritesScope = 'posts' | 'creators' | 'all';

export type CliOptions = {
  target: Target | undefined;
  output: string;
  postCount: number | undefined;
  includeFiles: string[];
  force: boolean;
  flat: boolean;
  favorites: FavoritesScope | undefined;
  session: string | undefined;
};

export const HELP = `Usage: paw-dl [options] <url>

A Pawchive downloader.

Arguments:
  url                                Creator or post URL (omit with --favorites)

Options:
  -o, --output <folder>              Output dir. Default: current working directory.
  -n, --post <number>                Limit the number of posts fetched from a creator. Omit to fetch all posts.
  --include-files <extensions>       Include attachments, separated by commas: zip,psd,pdf or all
  -f, --force                        Bypass the output directory lock. Does not overwrite files or bypass validation.
  --flat                             Download all creator files into one folder, no per-post folders.
  --favorites <posts|creators|all>  Download favorites. Needs --session or PAWCHIVE_SESSION.
  --session <cookie>                 Pawchive session cookie for favorites. Falls back to PAWCHIVE_SESSION.
  -h, --help                         Show help.
`;

function parseFavoritesScope(value: string): FavoritesScope {
  const scope = value.trim().toLowerCase();

  if (scope === 'posts' || scope === 'creators' || scope === 'all') {
    return scope;
  }

  throw new Error('Use --favorites posts, creators, or all.');
}

function parsePostCount(value: string): number {
  const number = Number(value);

  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number)) {
    throw new Error('Post count must be a whole number.');
  }

  return number;
}

function parseIncludeFiles(value: string): string[] {
  const extensions = value.split(',').map((item) => item.trim().toLowerCase().replace(/^\./, ''));

  if (extensions.some((extension) => !/^[a-z0-9]+$/.test(extension))) {
    throw new Error('Use comma-separated file extensions, example: zip,psd,pdf');
  }

  if (extensions.includes('all') && extensions.length > 1) {
    throw new Error('Use "all" without any file extensions.');
  }

  return [...new Set(extensions)];
}

export function parseCli(args: string[] = Bun.argv.slice(2)): CliOptions | null {
  let values: {
    output?: string;
    post?: string;
    'include-files'?: string;
    force?: boolean;
    flat?: boolean;
    favorites?: string;
    session?: string;
    help?: boolean;
  };
  let positionals: string[];

  try {
    ({ values, positionals } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        output: { type: 'string', short: 'o' },
        post: { type: 'string', short: 'n' },
        'include-files': { type: 'string' },
        force: { type: 'boolean', short: 'f', default: false },
        flat: { type: 'boolean', default: false },
        favorites: { type: 'string' },
        session: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  const scope = values.favorites === undefined ? undefined : parseFavoritesScope(values.favorites);

  if (values.help || (positionals.length === 0 && scope === undefined)) {
    return null;
  }

  if (positionals.length > 1) {
    throw new Error('Too many arguments. Expected a single URL.');
  }

  const session = values.session?.trim() || process.env.PAWCHIVE_SESSION?.trim() || undefined;

  if (scope !== undefined) {
    if (positionals.length > 0) {
      throw new Error('Remove the URL when using --favorites.');
    }

    if (!session) {
      throw new Error('Favorites need a session. Pass --session or set PAWCHIVE_SESSION.');
    }

    if (values.flat) {
      throw new Error('--flat only works on creator URLs.');
    }

    const output = values.output?.trim() ? resolve(values.output) : process.cwd();

    return {
      target: undefined,
      output,
      postCount: values.post === undefined ? undefined : parsePostCount(values.post),
      includeFiles: values['include-files'] === undefined ? [] : parseIncludeFiles(values['include-files']),
      force: values.force ?? false,
      flat: false,
      favorites: scope,
      session,
    };
  }

  const input = positionals[0]!;

  const target = parseTarget(input);

  if (target.type === 'post' && values.post !== undefined) {
    throw new Error('--post only works on creator URLs.');
  }

  if (target.type === 'post' && values.flat) {
    throw new Error('--flat only works on creator URLs.');
  }

  const output = values.output?.trim() ? resolve(values.output) : process.cwd();

  return {
    target,
    output,
    postCount: values.post === undefined ? undefined : parsePostCount(values.post),
    includeFiles: values['include-files'] === undefined ? [] : parseIncludeFiles(values['include-files']),
    force: values.force ?? false,
    flat: values.flat ?? false,
    favorites: undefined,
    session,
  };
}
