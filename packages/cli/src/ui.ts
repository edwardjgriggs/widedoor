import { spawn as nodeSpawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, resolve, win32 } from 'node:path';
import { findOnPath } from '@widedoor/pdf';
import {
  ReportFileError,
  UI_DIST_ENV,
  UiBuildError,
  loadConfig,
  loadReportFile,
  loadRootConfig,
  loadStaticFiles,
  onStop,
  startLocalServer,
  uiDistDir,
  type CurrentReport,
  type LocalRoot,
} from '@widedoor/server';
import type { UiArgs } from './args.js';
import type { Io } from './main.js';
import { EXIT_ERROR, EXIT_OK } from './policy.js';
import { firstLine, safeText } from './text.js';

/*
 * widedoor ui: works out the root folder (--root, the folder of --config,
 * else the working folder), validates the report, starts the local server
 * of @widedoor/server on 127.0.0.1 and opens the browser without a shell,
 * by absolute path. Runs until a stop signal (Ctrl+C, SIGTERM, or the IPC
 * interrupt message), then cancels a running scan and closes the server.
 */

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

/**
 * The folder widedoor ui works in: --root, the folder of --config (which
 * names the config), else the working folder. Undefined when --root is not
 * a folder. Throws ConfigError for a config that is not usable.
 */
export function uiRoot(args: Pick<UiArgs, 'root' | 'config'>, cwd: string): LocalRoot | undefined {
  if (args.config !== undefined) {
    const loaded = loadConfig(resolve(cwd, args.config));
    return { dir: loaded.dir, configFile: loaded.file };
  }
  const dir = resolve(cwd, args.root ?? '.');
  try {
    if (!statSync(dir).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  // Checked now, so a broken config shows at start; each scan reads it again.
  loadRootConfig({ dir });
  return { dir };
}

export async function runUi(args: UiArgs, io: Io, open: OpenFn = openBrowser): Promise<number> {
  const root = uiRoot(args, io.cwd);
  if (root === undefined) {
    io.err(`widedoor: ${safeText(resolve(io.cwd, args.root ?? '.'), 1000)} is not a folder`);
    return EXIT_ERROR;
  }
  let current: CurrentReport | undefined;
  const path = args.report === undefined ? undefined : resolve(io.cwd, args.report);
  if (path !== undefined) {
    // widedoor-review/ is where a scan reads it: in the root folder.
    try {
      current = loadReportFile(path, root.dir);
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
    server = await startLocalServer({
      files,
      root,
      ...(current ? { current } : {}),
      onCodeReuse: () =>
        io.err(
          'widedoor: warning: the access link was used a second time. Someone else may have opened it first; if your tab says the link was already used, stop widedoor ui and start it again.',
        ),
      // Scans, reviews, exports, refused codes and the cause of any server error.
      log: (line) => io.err(line),
    });
  } catch (e) {
    io.err(`widedoor: ${e instanceof UiBuildError ? e.message : safeText(firstLine(e), 1000)}`);
    return EXIT_ERROR;
  }
  io.out(
    path === undefined
      ? 'Widedoor UI: no report given; open a JSON report file in the page, or start a scan.'
      : `Widedoor UI for ${safeText(path, 1000)}`,
  );
  io.out(`Folder: ${safeText(root.dir, 1000)}`);
  io.out(
    `Open this link (it works once; reload the tab it opened to keep using it): ${server.url}`,
  );
  io.out('Press Ctrl+C to stop.');
  if (args.open) open(server.url, io);
  const ui = server;
  await new Promise<void>((stopped) => {
    const off = onStop(
      () => {
        off();
        stopped();
      },
      // An exit without a stop signal still kills a running scan's processes and containers.
      () => ui.abort(),
    );
  });
  await server.close();
  io.out('Widedoor UI stopped.');
  return EXIT_OK;
}
