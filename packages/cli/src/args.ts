import { parseArgs } from 'node:util';
import {
  CHECKLIST_STATUSES,
  MANUAL_OUTCOMES,
  PROFILE_IDS,
  type ChecklistItemStatus,
  type ManualOutcome,
} from '@widedoor/core';
import {
  AI_KEY_IN_CONFIG,
  FAIL_ON,
  FORMATS,
  MAX_CONCURRENCY,
  MAX_MEMORY_MB,
  MIN_MEMORY_MB,
  UsageError,
  keyShapedModel,
  type Format,
  type PlanArgs,
} from '@widedoor/server';

// The scan settings live with the scan engine in @widedoor/server; the CLI parses flags into them.
export {
  ACR_FORMATS,
  CONFIG_FILE,
  DEFAULT_CONCURRENCY,
  DEFAULT_FAIL_ON,
  DEFAULT_FORMATS,
  DEFAULT_MEMORY_MB,
  DEFAULT_OUT,
  DEFAULT_PROFILE,
  FAIL_ON,
  FORMATS,
  MAX_CONCURRENCY,
  MAX_MEMORY_MB,
  MIN_MEMORY_MB,
  UsageError,
  type FailOn,
  type Format,
} from '@widedoor/server';

/** AI fix suggestion flags (spec section 9); the key never comes from a flag. */
export interface AiFlags {
  /** --ai-fixes: suggest fixes after the scan (also on with ai.enabled in the config). */
  fixes: boolean;
  /** --ai-dry-run: print what would be sent and send nothing; needs no key. */
  dryRun: boolean;
  provider?: AiProviderId;
  model?: string;
}

export const AI_PROVIDERS = ['anthropic', 'openai'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

export interface ScanArgs extends PlanArgs {
  command: 'scan';
  config?: string;
  /** The exit gate counts automated fails that review records override (CI on untrusted changes). */
  ignoreOverrides: boolean;
  ai: AiFlags;
}

export interface SuggestArgs {
  command: 'suggest';
  /** The report.json to suggest fixes for, as given. */
  report: string;
  /** Folder for the sidecar files, as given (default: the report's folder). */
  out?: string;
  config?: string;
  ai: Omit<AiFlags, 'fixes'>;
}

export interface UiArgs {
  command: 'ui';
  /** JSON report to serve, as given. */
  report?: string;
  /** Folder, as given, that holds widedoor.config.yaml and widedoor-review/ (default: the working folder). */
  root?: string;
  /** Config file, as given: its folder is the root. */
  config?: string;
  /** Open the system browser at the printed URL. */
  open: boolean;
}

/** `widedoor review list --status`: one checklist status, or every item. */
export const REVIEW_STATUSES = [...CHECKLIST_STATUSES, 'all'] as const;
export type ReviewStatus = ChecklistItemStatus | 'all';
export const REVIEW_FORMATS = ['text', 'json'] as const;
export type ReviewFormat = (typeof REVIEW_FORMATS)[number];

export interface ReviewListArgs {
  command: 'review';
  action: 'list';
  /** JSON report, as given. */
  report: string;
  /** Config file, as given: widedoor-review/ is in its folder (else the working folder). */
  config?: string;
  status: ReviewStatus;
  format: ReviewFormat;
}

export interface ReviewRecordArgs {
  command: 'review';
  action: 'record';
  /** JSON report, as given. */
  report: string;
  /** Config file, as given: widedoor-review/ is in its folder (else the working folder). */
  config?: string;
  item: string;
  outcome: ManualOutcome;
  reviewer: string;
  notes?: string;
  /** Image files, as given (relative to the working folder). */
  attach: string[];
  overrides: string[];
}

export type ReviewArgs = ReviewListArgs | ReviewRecordArgs;

export const DIFF_FORMATS = ['text', 'json'] as const;
export type DiffFormat = (typeof DIFF_FORMATS)[number];

/** widedoor mcp: an MCP server on stdio (Task 3b.9). */
export interface McpArgs {
  command: 'mcp';
  /** The folder reports go under and paths resolve in (default: the current folder). */
  root?: string;
  config?: string;
  /** Lets scans reach localhost and private hosts (the default is public only, Decision 6). */
  allowLocal: boolean;
}

export interface DiffArgs {
  command: 'diff';
  /** The two JSON reports, as given. */
  before: string;
  after: string;
  format: DiffFormat;
  /** Exit 1 when the after report has a new fail. */
  failOnNew: boolean;
}

export type Command =
  | { command: 'help' }
  | { command: 'version' }
  | ScanArgs
  | UiArgs
  | ReviewArgs
  | DiffArgs
  | SuggestArgs
  | McpArgs;

export const USAGE = `Usage: widedoor scan [urls and PDF files...] [options]
       widedoor ui [--report <file>] [--root <dir> | --config <file>] [--no-open]
       widedoor review list --report <file> [--config <file>] [--status <status>]
                            [--format text|json]
       widedoor review record --report <file> [--config <file>] --item <id> --outcome <outcome>
                              --reviewer <name> [--notes <text>] [--attach <file>...]
                              [--override <finding id>...]
       widedoor diff <before.json> <after.json> [--format text|json] [--fail-on-new]
       widedoor suggest --report <file> [--out <dir>] [--config <file>]
                        [--ai-provider anthropic|openai] [--ai-model <id>] [--ai-dry-run]
       widedoor mcp [--root <dir>] [--config <file>] [--allow-local]

Scans web pages (http and https URLs), PDFs by URL (a URL ending in .pdf) and
local PDF files against Section 508 and WCAG 2.1 AA and writes reports. Without
targets, the scope comes from widedoor.config.yaml in the current folder, or
from the file named by --config. Targets given on the command line replace the
config's web.urls, web.sitemap, pdf.include and pdf.urls.

Options:
  --config <file>       config file (default: ./widedoor.config.yaml when present)
  --profile <id>        508, wcag21aa or 508+wcag21aa (default: 508+wcag21aa)
  --format <list>       comma-separated list of html, json, sarif, junit, openacr,
                        vpat-html, vpat-docx (default: html,json,sarif). junit
                        writes report.junit.xml. The ACR formats need a 508
                        profile and acr.product.name in the config:
                        openacr writes the ACR as report.openacr.yaml, and
                        vpat-html and vpat-docx as report.vpat.html and
                        report.vpat.docx (VPAT® 2.5Rev Section 508 layout)
  --out <dir>           report folder (default: ./widedoor-report)
  --fail-on <level>     critical, serious, moderate, minor or none (default: serious)
  --concurrency <n>     pages and PDFs scanned at once (default: 1)
  --memory <MiB>        memory cap per PDF for the veraPDF container and the PDF reader
                        (default: 768; a local veraPDF keeps its own 1 GiB heap cap)
  --storage-state <file>  Playwright storage state for signed-in pages (also from
                        WIDEDOOR_STORAGE_STATE); overrides web.auth.storageState
  --unsafe-no-sandbox   run Chromium without its OS sandbox (recorded as a warning)
  --ignore-overrides    the exit code counts automated fails that a review record
                        overrides; the reports still show the overrides. For CI on
                        changes whose widedoor-review/ files are not trusted
  --ai-fixes            after the scan, ask an AI provider for fix suggestions for the
                        failed checks (off by default; also on with ai.enabled in the
                        config). Needs ANTHROPIC_API_KEY, or OPENAI_API_KEY with
                        --ai-provider openai, in the environment. Writes
                        ai-suggestions.json and ai-suggestions.html beside the reports;
                        the reports and the exit code never change
  --ai-dry-run          print exactly what --ai-fixes would send, and send nothing (no key
                        needed)
  --ai-provider <id>    anthropic or openai (default: ai.provider, else anthropic)
  --ai-model <id>       the model (default: ai.model; anthropic: claude-opus-5-5; openai
                        has no default)
  -h, --help            show this help
  -v, --version         show the version

widedoor suggest asks for AI fix suggestions for an existing report.json without
scanning again, and writes ai-suggestions.json and ai-suggestions.html to --out
(default: the report's folder). Only redacted snippets of failed checks are sent:
no page URL, no full page and no PDF text. Suggestions are AI-generated; review
them before use. It exits 0 when it wrote the files, 1 when it could not write
them, and 2 on bad input or a missing key.

widedoor ui serves a local report viewer on 127.0.0.1 (a random port) and
opens it in the browser. It prints the link, which carries a one-time access
code (the page trades it for a per-run token, so the link works once; reload
that tab to keep using it), and runs until Ctrl+C. The page can scan, record
manual results and download reports, in the root folder: it holds
widedoor.config.yaml (optional) and widedoor-review/. A scan in the page keeps
its report in memory; only review records are written, to widedoor-review/.

ui options:
  --report <file>       JSON report to show (a report.json that widedoor scan wrote);
                        without it, open a report file in the page or start a scan
  --root <dir>          the root folder (default: the current folder)
  --config <file>       config file to use; its folder is the root (not with --root)
  --no-open             print the link but do not open a browser

widedoor review works with the manual review results in widedoor-review/, in the
folder a scan reads it from: the folder of --config, else the current folder (commit
it with your code).
review list prints the checklist for a JSON report with those results applied,
and lists any record it could not apply (for a page or file the report did not
scan, for example). review record writes one result for a checklist item,
replacing an earlier result for the same item, and prints the file it wrote, the
record id, the page or file and any overrides.

review options:
  --report <file>       the report.json a scan wrote (required)
  --config <file>       config file whose folder holds widedoor-review/ (default: the
                        current folder)
  --status <status>     list: open, done, expired, failed-automated or all (default: open)
  --format <format>     list: text or json (default: text)
  --item <id>           record: the checklist item (ck_...) that review list shows
  --outcome <outcome>   record: pass, fail or not-applicable
  --reviewer <name>     record: who did the review
  --notes <text>        record: what was checked; required for not-applicable and --override
  --attach <file>       record: a PNG or JPEG screenshot, up to 5 MiB (repeat, up to 10)
  --override <id>       record, with --outcome pass: an automated fail (wd_...) on the same
                        page or file and criterion that is a false positive (repeat for more)

widedoor diff compares two JSON reports: fail and needs-review results that are
new, fixed or unchanged, and criteria whose level changed. Only pages and files
scanned in both reports are compared; results on the others, a manual result
current in one report and expired in the other, and every criterion when the
profiles differ, are listed as not compared. It exits 0, 1 with --fail-on-new
when there is a new failed check, and 2 on bad input.

diff options:
  --format <format>     text or json (default: text)
  --fail-on-new         exit 1 when the after report has a new failed check

widedoor mcp runs an MCP server on stdin and stdout for an AI coding agent. Its
tools scan web pages and PDFs, read the findings of a report and list the
reports in the root folder. Reports go to widedoor-report/mcp/<time>/ in the root,
and paths resolve only inside it. It scans public hosts only, unless
--allow-local is given; it takes no signed-in session and never calls an AI
provider. Page text in its results is marked as untrusted data. It runs until
the client closes stdin.

mcp options:
  --root <dir>          the root folder (default: the current folder)
  --config <file>       config file (default: widedoor.config.yaml in the root, when present)
  --allow-local         let scans reach localhost, private and other local hosts (for a
                        dev server); without it they are refused

Exit codes:
  0  no failed check at or above --fail-on
  1  a failed check at or above --fail-on (needs-review results never count)
  2  a tool error: bad arguments or config, a page or file that could not be
     scanned (the reports are still written), or an interrupted run
widedoor review exits 0 when it listed or recorded, and 2 on bad input (an unknown
item, an override the report does not support, a file it cannot use).
widedoor diff exits 0, or 1 with --fail-on-new when there is a new failed check (new
needs-review results and results not compared never count), and 2 on bad input.
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

const UI_ONLY = ['report', 'root', 'no-open'] as const;
const MCP_OPTIONS: readonly string[] = ['root', 'config', 'allow-local'];
const SUGGEST_OPTIONS: readonly string[] = [
  'report',
  'out',
  'config',
  'ai-dry-run',
  'ai-provider',
  'ai-model',
];
const DIFF_ONLY = ['fail-on-new'] as const;
const DIFF_OPTIONS: readonly string[] = ['format', ...DIFF_ONLY];
const REVIEW_LIST_ONLY = ['status'] as const;
const REVIEW_RECORD_ONLY = ['item', 'outcome', 'reviewer', 'notes', 'attach', 'override'] as const;
/** Options of widedoor review, by action; --report and --format are shared. */
const REVIEW_OPTIONS = {
  list: ['report', 'config', 'format', ...REVIEW_LIST_ONLY],
  record: ['report', 'config', ...REVIEW_RECORD_ONLY],
} as const;

type Values = Record<string, string | boolean | string[] | undefined>;

function required(values: Values, flag: string): string {
  const value = values[flag];
  if (typeof value !== 'string' || value === '')
    throw new UsageError(`widedoor review needs --${flag}`);
  return value;
}

function reviewArgs(values: Values, rest: string[]): ReviewArgs {
  const [action, ...extra] = rest;
  if (action !== 'list' && action !== 'record')
    throw new UsageError(
      `widedoor review needs list or record${action === undefined ? '' : `; got "${action}"`}`,
    );
  if (extra.length > 0)
    throw new UsageError(`widedoor review ${action} takes no other arguments; got "${extra[0]}"`);
  const allowed: readonly string[] = REVIEW_OPTIONS[action];
  for (const [flag, value] of Object.entries(values)) {
    if (value === undefined || allowed.includes(flag)) continue;
    const other = action === 'list' ? 'record' : 'list';
    if ((REVIEW_OPTIONS[other] as readonly string[]).includes(flag))
      throw new UsageError(`--${flag} is an option of widedoor review ${other}`);
    throw new UsageError(`--${flag} is not an option of widedoor review`);
  }
  const report = required(values, 'report');
  if (values.config === '') throw new UsageError('--config needs a file');
  const config = typeof values.config === 'string' ? { config: values.config } : {};
  if (action === 'list') {
    return {
      command: 'review',
      action,
      report,
      ...config,
      status:
        typeof values.status === 'string'
          ? oneOf('--status', values.status, REVIEW_STATUSES)
          : 'open',
      format:
        typeof values.format === 'string'
          ? oneOf('--format', values.format, REVIEW_FORMATS)
          : 'text',
    };
  }
  const args: ReviewRecordArgs = {
    command: 'review',
    action,
    report,
    ...config,
    item: required(values, 'item'),
    outcome: oneOf('--outcome', required(values, 'outcome'), MANUAL_OUTCOMES),
    reviewer: required(values, 'reviewer'),
    attach: [...((values.attach as string[] | undefined) ?? [])],
    overrides: [...((values.override as string[] | undefined) ?? [])],
  };
  if (typeof values.notes === 'string') args.notes = values.notes;
  return args;
}

function diffArgs(values: Values, files: string[]): DiffArgs {
  for (const [flag, value] of Object.entries(values))
    if (value !== undefined && !DIFF_OPTIONS.includes(flag))
      throw new UsageError(`--${flag} is not an option of widedoor diff`);
  const [before, after] = files;
  if (files.length !== 2 || !before || !after)
    throw new UsageError(
      `widedoor diff needs two JSON reports, before and after; got ${files.length}`,
    );
  return {
    command: 'diff',
    before,
    after,
    format:
      typeof values.format === 'string' ? oneOf('--format', values.format, DIFF_FORMATS) : 'text',
    failOnNew: values['fail-on-new'] === true,
  };
}

/** The same rule as the ai.model config field. */
const MODEL_ID = /^[A-Za-z0-9._:-]{1,100}$/;

function aiFlags(values: Values): Omit<AiFlags, 'fixes'> {
  const flags: Omit<AiFlags, 'fixes'> = { dryRun: values['ai-dry-run'] === true };
  const provider = values['ai-provider'];
  if (typeof provider === 'string') flags.provider = oneOf('--ai-provider', provider, AI_PROVIDERS);
  const model = values['ai-model'];
  if (typeof model === 'string') {
    // A pasted key: refused without echoing it, before any other check.
    if (keyShapedModel(model)) throw new UsageError(AI_KEY_IN_CONFIG);
    if (!MODEL_ID.test(model))
      throw new UsageError('--ai-model must be 1 to 100 letters, digits, ".", "_", ":" or "-"');
    flags.model = model;
  }
  return flags;
}

function suggestArgs(values: Values, rest: string[]): SuggestArgs {
  if (rest.length > 0)
    throw new UsageError(
      `widedoor suggest takes no targets; got "${rest[0]}". Use --report <file>`,
    );
  for (const [flag, value] of Object.entries(values))
    if (value !== undefined && !SUGGEST_OPTIONS.includes(flag))
      throw new UsageError(`--${flag} is not an option of widedoor suggest`);
  if (typeof values.report !== 'string' || values.report === '')
    throw new UsageError('widedoor suggest needs --report');
  const args: SuggestArgs = { command: 'suggest', report: values.report, ai: aiFlags(values) };
  if (values.out !== undefined) {
    if (values.out === '') throw new UsageError('--out needs a folder');
    args.out = values.out as string;
  }
  if (values.config !== undefined) {
    if (values.config === '') throw new UsageError('--config needs a file');
    args.config = values.config as string;
  }
  return args;
}

function mcpArgs(values: Values, targets: string[]): McpArgs {
  if (targets.length > 0)
    throw new UsageError(`widedoor mcp takes no targets; got "${targets[0]}"`);
  for (const [flag, value] of Object.entries(values))
    if (value !== undefined && !MCP_OPTIONS.includes(flag))
      throw new UsageError(`--${flag} is not an option of widedoor mcp`);
  const args: McpArgs = { command: 'mcp', allowLocal: values['allow-local'] === true };
  if (typeof values.root === 'string') {
    if (values.root === '') throw new UsageError('--root needs a folder');
    args.root = values.root;
  }
  if (typeof values.config === 'string') {
    if (values.config === '') throw new UsageError('--config needs a file');
    args.config = values.config;
  }
  return args;
}

function uiArgs(values: Values, targets: string[]): UiArgs {
  if (targets.length > 0)
    throw new UsageError(`widedoor ui takes no targets; got "${targets[0]}". Use --report <file>`);
  for (const [flag, value] of Object.entries(values))
    if (value !== undefined && ![...UI_ONLY, 'config'].includes(flag))
      throw new UsageError(`--${flag} is not an option of widedoor ui`);
  const args: UiArgs = { command: 'ui', open: values['no-open'] !== true };
  if (typeof values.report === 'string') {
    if (values.report === '') throw new UsageError('--report needs a file');
    args.report = values.report;
  }
  if (typeof values.root === 'string') {
    if (values.root === '') throw new UsageError('--root needs a folder');
    args.root = values.root;
  }
  if (typeof values.config === 'string') {
    if (values.config === '') throw new UsageError('--config needs a file');
    if (args.root !== undefined)
      throw new UsageError(
        'widedoor ui takes --root or --config, not both: the folder of the config file is the root',
      );
    args.config = values.config;
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
        'ignore-overrides': { type: 'boolean' },
        report: { type: 'string' },
        root: { type: 'string' },
        'no-open': { type: 'boolean' },
        'fail-on-new': { type: 'boolean' },
        status: { type: 'string' },
        item: { type: 'string' },
        outcome: { type: 'string' },
        reviewer: { type: 'string' },
        notes: { type: 'string' },
        attach: { type: 'string', multiple: true },
        override: { type: 'string', multiple: true },
        'ai-fixes': { type: 'boolean' },
        'ai-dry-run': { type: 'boolean' },
        'ai-provider': { type: 'string' },
        'ai-model': { type: 'string' },
        'allow-local': { type: 'boolean' },
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
  if (command === 'mcp') return mcpArgs(values, targets);
  if (command === 'review') return reviewArgs(values, targets);
  if (command === 'diff') return diffArgs(values, targets);
  if (command === 'suggest') return suggestArgs(values, targets);
  if (command !== 'scan')
    throw new UsageError(
      `unknown command "${command}"; expected scan, ui, review, diff, suggest or mcp`,
    );
  for (const flag of UI_ONLY)
    if (values[flag] !== undefined) throw new UsageError(`--${flag} is an option of widedoor ui`);
  if (values['allow-local'] !== undefined)
    throw new UsageError('--allow-local is an option of widedoor mcp');
  for (const flag of DIFF_ONLY)
    if (values[flag] !== undefined) throw new UsageError(`--${flag} is an option of widedoor diff`);
  for (const flag of [...REVIEW_LIST_ONLY, ...REVIEW_RECORD_ONLY])
    if (values[flag] !== undefined)
      throw new UsageError(`--${flag} is an option of widedoor review`);

  const args: ScanArgs = {
    command: 'scan',
    targets,
    unsafeNoSandbox: values['unsafe-no-sandbox'] === true,
    ignoreOverrides: values['ignore-overrides'] === true,
    ai: { fixes: values['ai-fixes'] === true, ...aiFlags(values) },
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
