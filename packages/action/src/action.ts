import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Entry point of the GitHub Action (packages/action/action.yml). The composite
 * step passes every input through an environment variable; nothing reaches a
 * shell. This module checks the inputs, builds the CLI argv itself, runs the
 * CLI with no shell and writes the step outputs (ledger ruling, Task 1.6).
 */

/** Kept equal to PROFILE_IDS in @widedoor/core and FAIL_ON in @widedoor/cli (action.test.ts checks). */
export const PROFILES = ['508', 'wcag21aa', '508+wcag21aa'] as const;
export const FAIL_ON = ['critical', 'serious', 'moderate', 'minor', 'none'] as const;
export const DEFAULT_FAIL_ON = 'serious';
export const DEFAULT_OUT = 'widedoor-report';
export const CONFIG_FILE = 'widedoor.config.yaml';
/** The CLI's report folder marker (packages/server/src/output.ts). */
export const MARKER = '.widedoor-report';
/** Every format, so SARIF is there to upload and the HTML and JSON reports to keep. */
export const FORMATS = 'html,json,sarif';
export const EXIT_ERROR = 2;

/** Environment variables the composite step sets, one per input. */
export const INPUT_ENV = {
  urls: 'INPUT_URLS',
  files: 'INPUT_FILES',
  config: 'INPUT_CONFIG',
  profile: 'INPUT_PROFILE',
  failOn: 'INPUT_FAIL_ON',
  out: 'INPUT_OUT',
  uploadSarif: 'INPUT_UPLOAD_SARIF',
} as const;

export class InputError extends Error {
  override name = 'InputError';
}

export interface Plan {
  /** Arguments after the bin: scan, the options, then `--` and the targets. */
  argv: string[];
  /** Absolute report folder. */
  reportDir: string;
  uploadSarif: boolean;
}

// Control characters (C0, DEL, C1) and the line and paragraph separators.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Shows a value in an error message on one line, cut to a sane length. */
const show = (value: string) =>
  JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}...` : value);

function single(name: string, value: string): string {
  const v = value.trim();
  if (CONTROL.test(v)) throw new InputError(`${name} must be one line with no control characters`);
  return v;
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new InputError(`${name} must be one of ${allowed.join(', ')}; got ${show(value)}`);
}

/** Newline-separated list: each line trimmed, blank lines dropped. */
function lines(name: string, value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => {
      if (CONTROL.test(l)) throw new InputError(`${name} has a line with control characters`);
      return l;
    });
}

function url(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InputError(`urls: ${show(value)} is not a URL; give one http or https URL per line`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new InputError(`urls: ${show(value)} is not an http or https URL`);
  return value;
}

/**
 * Checks the inputs and builds the CLI argv. Throws InputError. Option values
 * use the --flag=value form and the targets follow `--`, so no input value can
 * be read as a flag (a file named --unsafe-no-sandbox stays a file).
 */
export function plan(env: NodeJS.ProcessEnv, cwd: string): Plan {
  const read = (key: keyof typeof INPUT_ENV) => env[INPUT_ENV[key]] ?? '';
  const urls = lines('urls', read('urls')).map(url);
  const files = lines('files', read('files'));
  const config = single('config', read('config'));
  const profile = single('profile', read('profile'));
  const failOn = oneOf('fail-on', single('fail-on', read('failOn')) || DEFAULT_FAIL_ON, FAIL_ON);
  const out = single('out', read('out')) || DEFAULT_OUT;
  const upload = oneOf('upload-sarif', single('upload-sarif', read('uploadSarif')) || 'true', [
    'true',
    'false',
  ]);

  if (
    urls.length === 0 &&
    files.length === 0 &&
    config === '' &&
    !existsSync(join(cwd, CONFIG_FILE))
  )
    throw new InputError(
      `nothing to scan: set urls or files, or config (or add ${CONFIG_FILE} to the repository root)`,
    );

  const argv = ['scan', `--format=${FORMATS}`, `--out=${out}`, `--fail-on=${failOn}`];
  if (profile !== '') argv.push(`--profile=${oneOf('profile', profile, PROFILES)}`);
  if (config !== '') argv.push(`--config=${config}`);
  argv.push('--', ...urls, ...files);
  return {
    argv,
    reportDir: isAbsolute(out) ? resolve(out) : resolve(cwd, out),
    uploadSarif: upload === 'true',
  };
}

/**
 * One output in the GITHUB_OUTPUT heredoc form with a random delimiter, so a
 * value with newlines cannot end the value early or add outputs.
 */
export function outputRecord(name: string, value: string, delimiter = `widedoor_${randomUUID()}`) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`bad output name ${name}`);
  if (value.includes(delimiter)) throw new Error('output value contains the delimiter');
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

export function writeOutputs(file: string | undefined, outputs: Record<string, string>): void {
  if (!file) return;
  appendFileSync(
    file,
    Object.entries(outputs)
      .map(([name, value]) => outputRecord(name, value))
      .join(''),
  );
}

/** The CLI exit code: 0, 1 and 2 pass through; a signal or any other code is a tool error. */
export const exitCode = (code: number | null) =>
  code === 0 || code === 1 || code === 2 ? code : EXIT_ERROR;

export const CLI_BIN = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  bin?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** Runs the action: returns the exit code for the step. */
export async function run(options: RunOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const out = options.out ?? ((t: string) => void process.stdout.write(t));
  const err = options.err ?? ((t: string) => void process.stderr.write(t));
  // Scanned pages can put text in the log; stop the runner reading workflow commands from it.
  const token = env.GITHUB_ACTIONS === 'true' ? `widedoor-${randomUUID()}` : undefined;
  if (token) out(`::stop-commands::${token}\n`);
  try {
    let p: Plan;
    try {
      p = plan(env, cwd);
    } catch (e) {
      if (!(e instanceof InputError)) throw e;
      err(`widedoor action: ${e.message}\n`);
      writeOutputs(env.GITHUB_OUTPUT, { 'exit-code': String(EXIT_ERROR) });
      return EXIT_ERROR;
    }
    clearReports(p.reportDir);
    const childEnv = { ...env };
    for (const key of Object.values(INPUT_ENV)) delete childEnv[key];
    const code = await new Promise<number>((done) => {
      const child = spawn(process.execPath, [options.bin ?? CLI_BIN, ...p.argv], {
        cwd,
        env: childEnv,
        shell: false,
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
      });
      child.once('error', (e) => {
        err(`widedoor action: could not start the CLI: ${e.message}\n`);
        done(EXIT_ERROR);
      });
      child.once('close', (c) => done(exitCode(c)));
    });
    let sarif = '';
    if (p.uploadSarif) {
      sarif = sarifReady(p.reportDir) ?? '';
      if (!sarif)
        err(
          'widedoor action: this run wrote no report.sarif in a Widedoor report folder; skipping the SARIF upload\n',
        );
    }
    writeOutputs(env.GITHUB_OUTPUT, {
      'exit-code': String(code),
      'report-dir': p.reportDir,
      'sarif-file': sarif,
    });
    return code;
  } finally {
    if (token) out(`::${token}::\n`);
  }
}

/**
 * Runs the action and never rejects: an unexpected error is a tool error
 * (exit 2), never read as failed checks (exit 1).
 */
export async function main(options: RunOptions = {}): Promise<number> {
  try {
    return await run(options);
  } catch (e) {
    const err = options.err ?? ((t: string) => void process.stderr.write(t));
    err(`widedoor action: unexpected error: ${(e as Error)?.message ?? String(e)}\n`);
    try {
      writeOutputs((options.env ?? process.env).GITHUB_OUTPUT, { 'exit-code': String(EXIT_ERROR) });
    } catch {
      // GITHUB_OUTPUT itself may be what failed.
    }
    return EXIT_ERROR;
  }
}

const isFile = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;
const isDir = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
/** A real folder (not a link) that carries Widedoor's marker file. */
const ownedFolder = (dir: string) => isDir(dir) && isFile(join(dir, MARKER));

/** The report files the CLI writes, all cleared before a run. */
export const REPORT_FILES = ['report.sarif', 'report.json', 'report.html'] as const;

/**
 * Removes the report files (report.sarif, report.json and report.html) left
 * in the report folder before the CLI runs, so an early CLI failure cannot
 * leave an old run's reports to upload as this run's. Only in a folder that
 * carries the marker, the same rule the CLI clears by; a link is removed, not
 * followed.
 */
export function clearReports(reportDir: string): void {
  if (!ownedFolder(reportDir)) return;
  for (const name of REPORT_FILES) {
    const file = join(reportDir, name);
    if (lstatSync(file, { throwIfNoEntry: false })) rmSync(file, { force: true });
  }
}

/** The SARIF file to upload: a regular file (not a link) in a marker-owned report folder, or undefined. */
export function sarifReady(reportDir: string): string | undefined {
  const sarif = join(reportDir, 'report.sarif');
  return ownedFolder(reportDir) && isFile(sarif) ? sarif : undefined;
}
