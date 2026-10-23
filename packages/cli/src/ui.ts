import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { findOnPath } from '@widedoor/pdf';
import {
  MAX_REPORT_BYTES,
  ScreenshotLoader,
  describeReportError,
  parseJsonReport,
} from '@widedoor/report';
import type { UiArgs } from './args.js';
import { onStop } from './lifecycle.js';
import type { Io } from './main.js';
import { evidencePath } from './output.js';
import { EXIT_ERROR, EXIT_OK } from './policy.js';
import { firstLine, safeText } from './text.js';
import { UiBuildError, loadStaticFiles, startUiServer } from './ui-server.js';

/*
 * widedoor ui: validates the report, loads its screenshots through the report
 * package's containment loader, serves the viewer on 127.0.0.1 and opens the
 * browser without a shell, by absolute path. Runs until a stop signal
 * (Ctrl+C, SIGTERM, or the IPC interrupt message), then closes the server.
 */

/**
 * Environment variable naming another built viewer folder (absolute path).
 * For tests, which build the viewer to a temp folder so they never overwrite
 * the shipped packages/ui/dist.
 */
export const UI_DIST_ENV = 'WIDEDOOR_UI_DIST';

/** The built viewer: dist/ of the @widedoor/ui package, wherever Node resolves it. */
export function uiDistDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[UI_DIST_ENV];
  if (override) {
    if (!isAbsolute(override)) throw new UiBuildError(`${UI_DIST_ENV} must be an absolute path`);
    return override;
  }
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@widedoor/ui/package.json')), 'dist');
}

export class ReportFileError extends Error {}

type ScreenshotResult = { ok: true; dataUri: string } | { ok: false; reason: string };

/**
 * The /api/report body: the validated report and every screenshot it names,
 * loaded from the evidence folder next to it (or why a screenshot was left out).
 */
export function reportBody(path: string): string {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new ReportFileError('it is not a file');
    size = stat.size;
  } catch (e) {
    if (e instanceof ReportFileError) throw e;
    throw new ReportFileError('it cannot be read');
  }
  if (size > MAX_REPORT_BYTES) throw new ReportFileError('it is over 100 MiB');
  let report;
  try {
    report = parseJsonReport(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ReportFileError(describeReportError(e));
  }
  const loader = new ScreenshotLoader(evidencePath(dirname(path)));
  // A Map, so a path such as "__proto__" is an ordinary key.
  const screenshots = new Map<string, ScreenshotResult>();
  for (const f of report.findings) {
    const shot = f.evidence?.screenshot;
    if (shot === undefined || screenshots.has(shot)) continue;
    const loaded = loader.load(shot);
    screenshots.set(
      shot,
      loaded.ok ? { ok: true, dataUri: loaded.dataUri } : { ok: false, reason: loaded.reason },
    );
  }
  return JSON.stringify({ report, screenshots: Object.fromEntries(screenshots) });
}

/** Only the link this command builds is ever opened: loopback, a port and a base64url code. */
const OPENABLE = /^http:\/\/127\.0\.0\.1:\d{1,5}\/\?code=[A-Za-z0-9_-]+$/;

/** What rundll32 runs to open a URL: url.dll's handler keeps the query string (explorer.exe drops such a URL). */
export const URL_HANDLER = 'url.dll,FileProtocolHandler';

/** Windows' own System32 rundll32.exe, never one found in the current folder or on PATH. */
export function rundll32Path(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot;
  return win32.join(
    root && win32.isAbsolute(root) ? root : 'C:\\Windows',
    'System32',
    'rundll32.exe',
  );
}

/**
 * The program (an absolute path) and arguments that open a URL in the default
 * browser, with no shell in between. On POSIX the opener is looked up only in
 * absolute PATH entries, so a relative or empty entry cannot plant one.
 */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  find: (name: string) => string | undefined = findOnPath,
  env: NodeJS.ProcessEnv = process.env,
): [string, string[]] {
  if (!OPENABLE.test(url)) throw new Error('refusing to open an unexpected URL');
  if (platform === 'win32') return [rundll32Path(env), [URL_HANDLER, url]];
  const name = platform === 'darwin' ? 'open' : 'xdg-open';
  const path = find(name);
  if (path === undefined || !isAbsolute(path)) throw new Error(`${name} was not found on PATH`);
  return [path, [url]];
}

export type OpenFn = (url: string, io: Io) => void;

export const openBrowser: OpenFn = (url, io) => {
  const failed = () => io.err('widedoor: could not open a browser; open the link above yourself.');
  try {
    const [command, args] = browserCommand(url);
    const child = nodeSpawn(command, args, {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
      shell: false,
    });
    child.once('error', failed);
    child.unref();
  } catch {
    failed();
  }
};

export async function runUi(args: UiArgs, io: Io, open: OpenFn = openBrowser): Promise<number> {
  let body: string | undefined;
  const path = args.report === undefined ? undefined : resolve(io.cwd, args.report);
  if (path !== undefined) {
    try {
      body = reportBody(path);
    } catch (e) {
      if (!(e instanceof ReportFileError)) throw e;
      io.err(`widedoor: ${safeText(path, 1000)} is not usable: ${safeText(e.message, 1000)}`);
      return EXIT_ERROR;
    }
  }
  const override = process.env[UI_DIST_ENV];
  let server;
  try {
    const dist = uiDistDir();
    if (override)
      io.err(`widedoor: serving the viewer from ${safeText(dist, 1000)} (${UI_DIST_ENV})`);
    let files;
    try {
      files = loadStaticFiles(dist);
    } catch (e) {
      // A missing build is fixed by npm run build, a wrong override by fixing the variable.
      if (override && e instanceof UiBuildError)
        throw new UiBuildError(
          `${UI_DIST_ENV} names ${safeText(dist, 1000)}, which is not a built viewer folder (no index.html)`,
        );
      throw e;
    }
    server = await startUiServer({
      files,
      ...(body !== undefined ? { reportBody: body } : {}),
      onCodeReuse: () =>
        io.err(
          'widedoor: warning: the access link was used a second time. Someone else may have opened it first; if your tab says the link was already used, stop widedoor ui and start it again.',
        ),
    });
  } catch (e) {
    io.err(`widedoor: ${e instanceof UiBuildError ? e.message : safeText(firstLine(e), 1000)}`);
    return EXIT_ERROR;
  }
  io.out(
    path === undefined
      ? 'Widedoor UI: no report given; open a JSON report file in the page.'
      : `Widedoor UI for ${safeText(path, 1000)}`,
  );
  io.out(
    `Open this link (it works once; reload the tab it opened to keep using it): ${server.url}`,
  );
  io.out('Press Ctrl+C to stop.');
  if (args.open) open(server.url, io);
  await new Promise<void>((stopped) => {
    const off = onStop(
      () => {
        off();
        stopped();
      },
      () => undefined,
    );
  });
  await server.close();
  io.out('Widedoor UI stopped.');
  return EXIT_OK;
}
