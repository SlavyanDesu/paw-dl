import { Command, CommanderError, InvalidArgumentError } from "commander";
import { resolve } from "node:path";
import { parseTarget, type Target } from "./utils/parse-url.ts";

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
    throw new InvalidArgumentError(
      "Jumlah iterasi harus berupa bilangan bulat positif.",
    );
  }

  return number;
}

function parseIncludeFiles(value: string): string[] {
  const extensions = value
    .split(",")
    .map((item) => item.trim().toLowerCase().replace(/^\./, ""));

  if (extensions.some((extension) => !/^[a-z0-9]+$/.test(extension))) {
    throw new InvalidArgumentError(
      "Gunakan ekstensi dipisahkan koma, misalnya zip,psd,pdf.",
    );
  }

  if (extensions.includes("all") && extensions.length > 1) {
    throw new InvalidArgumentError(
      'Gunakan "all" sendiri, tanpa ekstensi lain.',
    );
  }

  return [...new Set(extensions)];
}

function createProgram(): Command {
  return new Command()
    .name("paw-dl")
    .description("Download attachment dari URL post atau kreator Pawchive.")
    .argument("<url>", "URL post atau kreator")
    .option("-o, --output [folder]", "Folder tujuan download (default: cwd)")
    .option(
      "-i, --iterations <number>",
      "Maksimum halaman listing kreator",
      parseIterations,
      1,
    )
    .option(
      "--include-files <extensions>",
      'Tambahkan tipe file di luar gambar/video: zip,psd,pdf atau "all"',
      parseIncludeFiles,
    )
    .option("-f, --force", "Abaikan kunci output jika sudah terkunci")
    .helpOption("-h, --help", "Tampilkan bantuan")
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
}

export const HELP = createProgram().helpInformation();

export function parseCli(
  args: string[] = Bun.argv.slice(2),
): CliOptions | null {
  const program = createProgram();

  try {
    program.parse(args, { from: "user" });
  } catch (error) {
    if (
      error instanceof CommanderError &&
      error.code === "commander.helpDisplayed"
    ) {
      return null;
    }

    throw error;
  }

  const input = program.args[0];

  if (!input) {
    throw new Error("URL target tidak ditemukan.");
  }

  const target = parseTarget(input);
  const options = program.opts<ParsedFlags>();

  if (
    target.type === "post" &&
    program.getOptionValueSource("iterations") === "cli"
  ) {
    throw new Error("--iterations hanya berlaku untuk URL kreator.");
  }

  const output =
    typeof options.output === "string" && options.output.trim()
      ? resolve(options.output)
      : process.cwd();

  return {
    target,
    output,
    iterations: options.iterations,
    includeFiles: options.includeFiles ?? [],
    force: options.force ?? false,
  };
}
