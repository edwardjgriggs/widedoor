import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import AjvDraft04 from 'ajv-draft-04';
import addFormats from 'ajv-formats';

/*
 * Helpers for the tests that run the built bin as a child process (browser
 * and docker suites), the way a user runs it: node packages/cli/dist/bin.js.
 */

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const CORPUS = join(ROOT, 'corpus');
export const BIN = join(ROOT, 'packages', 'cli', 'dist', 'bin.js');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/** Builds the CLI and the packages it references, so the bin under test matches the sources. */
export function buildCli(): void {
  execFileSync(process.execPath, [TSC, '-b', 'packages/cli'], { cwd: ROOT, stdio: 'pipe' });
}

/**
 * Builds the viewer, as a production build, into its own temp folder (after
 * buildCli: the Vite config reads the built packages). Tests serve it through
 * WIDEDOOR_UI_DIST, so they never overwrite the shipped packages/ui/dist.
 */
export function buildUi(outDir: string): void {
  const vite = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  execFileSync(
    process.execPath,
    [vite, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'],
    {
      cwd: join(ROOT, 'packages', 'ui'),
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: 'pipe',
    },
  );
}

/** The shipped viewer build. */
export const UI_DIST = join(ROOT, 'packages', 'ui', 'dist');

export interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Called once the child has started (for interrupt tests). */
  onStart?: (child: ChildProcess) => void;
}

/** Runs the built bin with an IPC channel (used only by the interrupt tests). */
export function runCli(args: readonly string[], options: CliOptions = {}): Promise<CliRun> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.once('error', fail);
    child.once('close', (code, signal) => done({ code, signal, stdout, stderr }));
    options.onStart?.(child);
  });
}

/** An environment where neither Docker nor a local veraPDF can be found. */
export function envWithoutTools(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  env.PATH = '';
  return env;
}

export interface StaticServer {
  origin: string;
  close(): Promise<void>;
}

/** Serves the .html files of one folder on 127.0.0.1, the corpus pages as a site would. */
export async function serveHtml(
  dir: string,
  extra: Record<string, (res: import('node:http').ServerResponse) => void> = {},
): Promise<StaticServer> {
  const pages = new Map(
    readdirSync(dir)
      .filter((f) => extname(f) === '.html')
      .map((f) => [`/${f}`, readFileSync(join(dir, f))]),
  );
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const handler = extra[path];
    if (handler) return handler(res);
    const body = pages.get(path);
    if (!body) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

export const corpusPages = (names: readonly string[]) =>
  readdirSync(join(CORPUS, 'web')).filter((f) => names.length === 0 || names.includes(f));

export function reportValidator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats.default(ajv);
  return ajv.compile(
    JSON.parse(readFileSync(join(ROOT, 'packages/report/schema/report.v1.json'), 'utf8')),
  );
}

export function openAcrValidator() {
  const ajv = new Ajv({ strict: true, allErrors: true });
  return ajv.compile(
    JSON.parse(
      readFileSync(join(ROOT, 'packages/report/vendor/openacr/openacr-0.1.0.json'), 'utf8'),
    ),
  );
}

export function sarifValidator() {
  // The CommonJS module under NodeNext, the class itself under the viewer's bundler resolution
  // (packages/ui/test imports these helpers); at run time it is the module.
  const Draft04 = ((AjvDraft04 as unknown as { default?: typeof Ajv }).default ??
    (AjvDraft04 as unknown as typeof Ajv)) as typeof Ajv;
  // Same settings as the report package's SARIF test: strictRequired is off for the OASIS anyOf branches.
  const ajv = new Draft04({ strict: true, strictRequired: false, allErrors: true });
  addFormats.default(ajv);
  return ajv.compile(
    JSON.parse(
      readFileSync(join(ROOT, 'packages/report/vendor/sarif/sarif-schema-2.1.0.json'), 'utf8'),
    ),
  );
}

/** Pids of every process below pid (children, grandchildren). */
export function descendants(pid: number): number[] {
  let rows: { pid: number; ppid: number }[];
  if (process.platform === 'win32') {
    const out = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ],
      { encoding: 'utf8', windowsHide: true },
    ).stdout;
    rows = parseRows(out);
  } else {
    rows = parseRows(spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout);
  }
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const row of rows)
      if (row.ppid === parent && !found.includes(row.pid)) {
        found.push(row.pid);
        queue.push(row.pid);
      }
  }
  return found;
}

const parseRows = (text: string) =>
  text.split(/\r?\n/).flatMap((line) => {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    return pid && ppid !== undefined && Number.isFinite(ppid) ? [{ pid, ppid }] : [];
  });

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** Waits until check() is true, polling; throws after timeoutMs. */
export async function waitFor(check: () => boolean, timeoutMs: number, what: string) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

/** Interrupts a running CLI: SIGINT on POSIX; on Windows, which cannot deliver a catchable signal, the IPC interrupt message. */
export function interrupt(child: ChildProcess): void {
  if (process.platform === 'win32') child.send('widedoor:interrupt');
  else child.kill('SIGINT');
}
