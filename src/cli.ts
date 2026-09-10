import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { resolve } from 'node:path';
import { parseTarget, type Target } from './utils/parse-url.ts';

export type CliOptions = {
  target: Target;
  output: string;
  iterations: number;
  includeFiles: string[];
  force: boolean;
};

type ParsedFlags = {
  output?: string | true;
  iterations: number;
  includeFiles?: string[];
  force: boolean;
};

function parseIterations(value: string): number {
  const number = Number(value);

  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number)) {
    throw new InvalidArgumentError('Iteration must be a round number.');
  }

  return number;
}

function parseIncludeFiles(value: string): string[] {
  const extensions = value.split(',').map((item) => item.trim().toLowerCase().replace(/^\./, ''));

  if (extensions.some((extension) => !/^[a-z0-9]+$/.test(extension))) {
    throw new InvalidArgumentError('Use comma-separated file extensions, example: zip,psd,pdf');
  }

  if (extensions.includes('all') && extensions.length > 1) {
    throw new InvalidArgumentError('Use "all" without any file extensions.');
  }

  return [...new Set(extensions)];
}

function createProgram(): Command {
  return new Command()
    .name('paw-dl')
    .description('Pawchive downloader.')
    .argument('<url>', 'Creator or post URL')
    .option('-o, --output [folder]', 'Output folder (default: cwd)')
    .option('-i, --iterations <number>', 'Maximum post you want to iterate', parseIterations, 1)
    .option(
      '--include-files <extensions>',
      'Include files other than images and video: zip,psd,pdf or "all"',
      parseIncludeFiles,
    )
    .option('-f, --force', 'Ignore the output key if it is already locked')
    .helpOption('-h, --help', 'Show list options')
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
}

export const HELP = createProgram().helpInformation();

export function parseCli(args: string[] = Bun.argv.slice(2)): CliOptions | null {
  const program = createProgram();

  try {
    program.parse(args, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError && error.code === 'commander.helpDisplayed') {
      return null;
    }

    throw error;
  }

  const input = program.args[0];

  if (!input) {
    throw new Error('Target URL not found.');
  }

  const target = parseTarget(input);
  const options = program.opts<ParsedFlags>();

  if (target.type === 'post' && program.getOptionValueSource('iterations') === 'cli') {
    throw new Error('--iterations only works on creator URL.');
  }

  const output = typeof options.output === 'string' && options.output.trim() ? resolve(options.output) : process.cwd();

  return {
    target,
    output,
    iterations: options.iterations,
    includeFiles: options.includeFiles ?? [],
    force: options.force ?? false,
  };
}
