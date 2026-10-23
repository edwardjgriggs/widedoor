import { parseArgs } from 'node:util';
import { PROFILE_IDS, type ProfileId } from '@widedoor/core';

export const FORMATS = ['html', 'json', 'sarif'] as const;
export type Format = (typeof FORMATS)[number];

/** `--fail-on` levels, most severe first; `none` turns the threshold off. */
export const FAIL_ON = ['critical', 'serious', 'moderate', 'minor', 'none'] as const;
export type FailOn = (typeof FAIL_ON)[number];

export const DEFAULT_PROFILE: ProfileId = '508+wcag21aa';
export const DEFAULT_FAIL_ON: FailOn = 'serious';
export const DEFAULT_OUT = 'widedoor-report';
export const CONFIG_FILE = 'widedoor.config.yaml';
/** One page and one PDF at a time keeps a default run small (ledger F1). */
export const DEFAULT_CONCURRENCY = 1;
/** Memory cap per PDF, in MiB, for the veraPDF container and the PDF reader. */
export const DEFAULT_MEMORY_MB = 768;
export const MIN_MEMORY_MB = 256;
export const MAX_MEMORY_MB = 65_536;
export const MAX_CONCURRENCY = 32;

/** Bad command-line input: printed with the usage hint, exit code 2. */
export class UsageError extends Error {
  constructor(
    message: string,
    /** Print the full usage text, not just the hint. */
    readonly showUsage = false,
  ) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface ScanArgs {
  command: 'scan';
  /** Positional URLs and PDF files, as given. */
  targets: string[];
  config?: string;
  profile?: ProfileId;
  formats?: Format[];
  out?: string;
  /** Playwright storage state file, from the command line (beats the environment and the config). */
  storageState?: string;
  failOn?: FailOn;
  unsafeNoSandbox: boolean;
  concurrency?: number;
  memoryMb?: number;
}

export interface UiArgs {
  command: 'ui';
  /** JSON report to serve, as given. */
  report?: string;
  /** Open the system browser at the printed URL. */
  open: boolean;
}

export type Command = { command: 'help' } | { command: 'version' } | ScanArgs | UiArgs;

export const USAGE = `Usage: widedoor scan [urls and PDF files...] [options]
       widedoor ui [--report <file>] [--no-open]

Scans web pages (http and https URLs) and local PDF files against Section 508
and WCAG 2.1 AA and writes reports. Without targets, the scope comes from
widedoor.config.yaml in the current folder, or from the file named by --config.
Targets given on the command line replace the config's web.urls and pdf.include.

Options:
  --config <file>       config file (default: ./widedoor.config.yaml when present)
  --profile <id>        508, wcag21aa or 508+wcag21aa (default: 508+wcag21aa)
  --format <list>       comma-separated list of html, json, sarif (default: all three)
  --out <dir>           report folder (default: ./widedoor-report)
  --fail-on <level>     critical, serious, moderate, minor or none (default: serious)
  --concurrency <n>     pages and PDFs scanned at once (default: 1)
  --memory <MiB>        memory cap per PDF for the veraPDF container and the PDF reader
                        (default: 768; a local veraPDF keeps its own 1 GiB heap cap)
  --storage-state <file>  Playwright storage state for signed-in pages (also from
                        WIDEDOOR_STORAGE_STATE); overrides web.auth.storageState
  --unsafe-no-sandbox   run Chromium without its OS sandbox (recorded as a warning)
  -h, --help            show this help
  -v, --version         show the version

widedoor ui serves a local report viewer on 127.0.0.1 (a random port) and
opens it in the browser. It prints the link, which carries a one-time access
code (the page trades it for a per-run token, so the link works once; reload
that tab to keep using it), and runs until Ctrl+C. It never scans.

ui options:
  --report <file>       JSON report to show (a report.json that widedoor scan wrote);
                        without it, open a report file in the page
  --no-open             print the link but do not open a browser

Exit codes:
  0  no failed check at or above --fail-on
  1  a failed check at or above --fail-on (needs-review results never count)
  2  a tool error: bad arguments or config, a page or file that could not be
     scanned (the reports are still written), or an interrupted run
`;

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new UsageError(`${flag} must be one of ${allowed.join(', ')}; got "${value}"`);
}

function integer(flag: string, value: string, min: number, max: number): number {
  const n = /^\d{1,6}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > max)
    throw new UsageError(`${flag} must be a whole number from ${min} to ${max}; got "${value}"`);
  return n;
}

export function parseFormats(flag: string, value: string): Format[] {
  const parts = value.split(',').map((p) => p.trim());
  if (parts.some((p) => p === ''))
    throw new UsageError(`${flag} must be a comma-separated list of ${FORMATS.join(', ')}`);
  return [...new Set(parts.map((p) => oneOf(flag, p, FORMATS)))];
}

const UI_ONLY = ['report', 'no-open'] as const;

function uiArgs(values: Record<string, string | boolean | undefined>, targets: string[]): UiArgs {
  if (targets.length > 0)
    throw new UsageError(`widedoor ui takes no targets; got "${targets[0]}". Use --report <file>`);
  for (const [flag, value] of Object.entries(values))
    if (value !== undefined && !(UI_ONLY as readonly string[]).includes(flag))
      throw new UsageError(`--${flag} is not an option of widedoor ui`);
  const args: UiArgs = { command: 'ui', open: values['no-open'] !== true };
  if (typeof values.report === 'string') {
    if (values.report === '') throw new UsageError('--report needs a file');
    args.report = values.report;
  }
  return args;
}

/** Parses the command line (without the node and script arguments). Throws UsageError. */
export function parseCommand(argv: readonly string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string' },
        profile: { type: 'string' },
        format: { type: 'string' },
        out: { type: 'string' },
        'fail-on': { type: 'string' },
        concurrency: { type: 'string' },
        memory: { type: 'string' },
        'storage-state': { type: 'string' },
        'unsafe-no-sandbox': { type: 'boolean' },
        report: { type: 'string' },
        'no-open': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (e) {
    throw new UsageError((e as Error).message.split('\n')[0] ?? 'invalid arguments');
  }
  const { values, positionals } = parsed;
  if (values.help) return { command: 'help' };
  if (values.version) return { command: 'version' };
  const [command, ...targets] = positionals;
  if (command === undefined) throw new UsageError('no command given', true);
  if (command === 'ui') return uiArgs(values, targets);
  if (command !== 'scan') throw new UsageError(`unknown command "${command}"; expected scan or ui`);
  for (const flag of UI_ONLY)
    if (values[flag] !== undefined) throw new UsageError(`--${flag} is an option of widedoor ui`);

  const args: ScanArgs = {
    command: 'scan',
    targets,
    unsafeNoSandbox: values['unsafe-no-sandbox'] === true,
  };
  if (values.config !== undefined) {
    if (values.config === '') throw new UsageError('--config needs a file');
    args.config = values.config;
  }
  if (values.profile !== undefined) args.profile = oneOf('--profile', values.profile, PROFILE_IDS);
  if (values.format !== undefined) args.formats = parseFormats('--format', values.format);
  if (values.out !== undefined) {
    if (values.out === '') throw new UsageError('--out needs a folder');
    args.out = values.out;
  }
  if (values['fail-on'] !== undefined) args.failOn = oneOf('--fail-on', values['fail-on'], FAIL_ON);
  if (values.concurrency !== undefined)
    args.concurrency = integer('--concurrency', values.concurrency, 1, MAX_CONCURRENCY);
  if (values['storage-state'] !== undefined) {
    if (values['storage-state'] === '') throw new UsageError('--storage-state needs a file');
    args.storageState = values['storage-state'];
  }
  if (values.memory !== undefined)
    args.memoryMb = integer('--memory', values.memory, MIN_MEMORY_MB, MAX_MEMORY_MB);
  return args;
}
