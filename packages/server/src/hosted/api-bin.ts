import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { BlockList, isIP, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { getRequestListener, type Http2Bindings, type HttpBindings } from '@hono/node-server';
import { PinnedResolver } from '@widedoor/web/egress';
import { SECURITY_HEADERS } from '../security.js';
import { UiBuildError, loadStaticFiles, uiDistDir, type StaticFile } from '../static-files.js';
import {
  HOSTED_PAGE,
  LICENSES_PATH,
  createHostedApi,
  withSecurityHeaders,
  type HostedApi,
} from './api.js';
import { caresLookup, caresTxtLookup } from './dns.js';
import { REGION, createFlyClient, type FlyClient, type FlyClientOptions } from './fly.js';
import { eventLine } from './jobs.js';
import { CONTACT_URL_ENV, DEFAULT_CONTACT_URL } from './protocol.js';

/*
 * The hosted API process (the image's hosted target, ledger R8). It reads its
 * settings from the environment, refusing to start on a missing or invalid one
 * (the log names the variable, never its value), then serves the public app on
 * PUBLIC_PORT and the control app on the machine's 6PN address (FLY_PRIVATE_IP)
 * at CONTROL_PORT, so scan machines reach it over the private network only. The
 * Fly token is removed from process.env once read. The process's initial environ
 * block (/proc/self/environ) still holds it; that is acceptable because the API
 * runs no child processes. The DNS preflight and domain verification's TXT lookup
 * use c-ares (dns.ts), not the thread pool. The hosted page comes from the UI
 * build (WIDEDOOR_UI_DIST or @widedoor/ui's dist), read into memory once at
 * start; without it the API does not start. SIGTERM closes both.
 */

export const PUBLIC_PORT = 8080;
export const CONTROL_PORT = 8081;
/** What @hono/node-server passes a fetch callback: the Node request and response. */
type NodeBindings = HttpBindings | Http2Bindings;

/** Where the public listener binds: every address, behind Fly's proxy. */
const PUBLIC_HOST = '0.0.0.0';
/**
 * Overrides the control listener's bind host and the control URL's host (tests use 127.0.0.1).
 * Only loopback or a 6PN address (fdaa::/16): the control routes must never face the internet.
 */
export const CONTROL_HOST_ENV = 'WIDEDOOR_CONTROL_HOST';
const CONTROL_HOSTS = new BlockList();
CONTROL_HOSTS.addAddress('127.0.0.1', 'ipv4');
CONTROL_HOSTS.addAddress('::1', 'ipv6');
CONTROL_HOSTS.addSubnet('fdaa::', 16, 'ipv6');
const SCAN_APP_DEFAULT = 'widedoor-scan';

export interface ApiBinOptions {
  env: NodeJS.ProcessEnv;
  /** Stops both listeners (SIGTERM or SIGINT); main then resolves with 0. */
  signal: AbortSignal;
  /** Where lines go. Default: stdout. */
  write?: (line: string) => void;
  /** Tests: listen ports (0 for any free port) and the public bind host. */
  publicPort?: number;
  controlPort?: number;
  publicHost?: string;
  /** Tests: called with both listeners' addresses once they listen. */
  onListening?: (addresses: { public: AddressInfo; control: AddressInfo }) => void;
  /** Tests: makes the Fly client (no test reaches the real Machines API). Default createFlyClient. */
  createFly?: (options: FlyClientOptions) => FlyClient;
}

/** The scan image: `registry.fly.io/<scan app>@sha256:<64 hex>`; group 1 is the app. */
const SCAN_IMAGE = /^registry\.fly\.io\/([a-z0-9-]+)@sha256:[0-9a-f]{64}$/;

/** A Fly token: `FlyV1 fm2_...` as Fly issues deploy tokens (comma-separated parts), or a bare one. */
const FLY_TOKEN = /^(?:FlyV1 )?[\x21-\x7e]{20,16384}$/;

/** Whether a control bind host is loopback or in fdaa::/16. */
function isControlHost(value: string): boolean {
  // No zone id (fe80::1%eth0): isIP takes one, and a bind address has no use for it.
  if (value.includes('%')) return false;
  const family = isIP(value);
  return family !== 0 && CONTROL_HOSTS.check(value, family === 6 ? 'ipv6' : 'ipv4');
}

/** A value with no whitespace or control characters. */
const isPlain = (value: string): boolean => /^[\x21-\x7e]+$/.test(value);

/** An https origin and nothing more (no path, query, fragment or credentials). */
function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value.replace(/\/$/, '');
  } catch {
    return false;
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/**
 * The UI build as the hosted API serves it: loadStaticFiles (known types, regular files
 * only), which must hold the hosted page, plus the license notice (a .txt, which
 * loadStaticFiles does not read). Throws UiBuildError when either is missing.
 */
export function loadHostedFiles(dir: string): Map<string, StaticFile> {
  const files = loadStaticFiles(dir);
  if (!files.has(HOSTED_PAGE))
    throw new UiBuildError(`the hosted page is not built (no hosted.html in ${dir})`);
  const notice = join(realpathSync(dir), LICENSES_PATH.slice(1));
  let body: Uint8Array<ArrayBuffer>;
  try {
    if (!lstatSync(notice).isFile()) throw new Error('not a regular file');
    body = new Uint8Array(readFileSync(notice));
  } catch {
    throw new UiBuildError(`the license notice is not built (no ${LICENSES_PATH} in ${dir})`);
  }
  files.set(LICENSES_PATH, { body, type: 'text/plain; charset=utf-8' });
  return files;
}

async function listen(
  fetch: (req: Request, env: NodeBindings) => Response | Promise<Response>,
  host: string,
  port: number,
): Promise<Server> {
  const listener = getRequestListener(
    // The node bindings go on to the app: a report download ends its own socket (api.ts).
    async (req, env: NodeBindings) => {
      const res = await fetch(req, env);
      withSecurityHeaders(res.headers);
      return res;
    },
    {
      overrideGlobalObjects: false,
      // A request node-server cannot turn into a Request (no or a malformed Host header).
      errorHandler: () => {
        const res = new Response(null, { status: 400 });
        withSecurityHeaders(res.headers);
        return res;
      },
    },
  );
  const server = createServer({ requireHostHeader: false }, listener);
  // A request Node cannot parse at all gets a bare 400 that still carries the headers.
  server.on('clientError', (_, socket) => {
    if (!socket.writable) return void socket.destroy();
    const headers = Object.entries(SECURITY_HEADERS)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('');
    socket.end(
      `HTTP/1.1 400 Bad Request\r\n${headers}content-length: 0\r\nconnection: close\r\n\r\n`,
    );
  });
  await new Promise<void>((ready, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      ready();
    });
  });
  return server;
}

const close = (server: Server) =>
  new Promise<void>((done) => {
    server.closeAllConnections();
    server.close(() => done());
  });

/**
 * Runs the API until `signal` aborts. Resolves with the exit code: 0 once stopped,
 * 1 for a missing or invalid setting or a listener that could not start.
 */
export async function main(options: ApiBinOptions): Promise<number> {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const { env } = options;
  const configError = (name: string) => {
    write(eventLine('api_config_error', { name }));
    return 1;
  };

  const apiToken = env.FLY_API_TOKEN ?? '';
  // Gone from process.env (and from any env a child would inherit). The initial environ
  // block keeps it; the API runs no child processes, which is why that is acceptable.
  delete env.FLY_API_TOKEN;
  if (!FLY_TOKEN.test(apiToken)) return configError('FLY_API_TOKEN');
  const app = env.WIDEDOOR_SCAN_APP ?? SCAN_APP_DEFAULT;
  // Pinned by digest, in the scan app's own registry: a tag could be moved under the API.
  const image = env.WIDEDOOR_SCAN_IMAGE ?? '';
  if (SCAN_IMAGE.exec(image)?.[1] !== app) return configError('WIDEDOOR_SCAN_IMAGE');
  const publicOrigin = env.WIDEDOOR_PUBLIC_ORIGIN ?? '';
  if (!isHttpsOrigin(publicOrigin)) return configError('WIDEDOOR_PUBLIC_ORIGIN');
  // Set explicitly, https, and not the placeholder (the about page would link to itself).
  const contactUrl = env[CONTACT_URL_ENV];
  if (
    contactUrl === undefined ||
    !isHttpsUrl(contactUrl) ||
    !isPlain(contactUrl) ||
    contactUrl === DEFAULT_CONTACT_URL ||
    contactUrl === `${publicOrigin.replace(/\/$/, '')}/about-scanner`
  )
    return configError(CONTACT_URL_ENV);
  // Scan machines go to the API's own region when Fly names it.
  const region = env.FLY_REGION;
  if (region !== undefined && !REGION.test(region)) return configError('FLY_REGION');
  const override = env[CONTROL_HOST_ENV];
  if (override !== undefined && !isControlHost(override)) return configError(CONTROL_HOST_ENV);
  const privateIp = env.FLY_PRIVATE_IP;
  if (
    override === undefined &&
    (privateIp === undefined || isIP(privateIp) !== 6 || privateIp.includes('%'))
  )
    return configError('FLY_PRIVATE_IP');
  const controlHost = override ?? privateIp ?? '';

  let staticFiles;
  try {
    staticFiles = loadHostedFiles(uiDistDir(env));
  } catch {
    return configError('ui_build');
  }

  let fly;
  try {
    fly = (options.createFly ?? createFlyClient)({ app, apiToken });
  } catch {
    return configError('WIDEDOOR_SCAN_APP');
  }

  const lookup = caresLookup();
  const servers: Server[] = [];
  let api: HostedApi | undefined;
  try {
    // The control URL needs the port, which a test's port 0 only gives after listen; until
    // the API exists (right after), the control listener answers 404.
    const controlServer = await listen(
      (req) => api?.controlApp.fetch(req) ?? new Response(null, { status: 404 }),
      controlHost,
      options.controlPort ?? CONTROL_PORT,
    );
    servers.push(controlServer);
    const controlAddress = controlServer.address() as AddressInfo;
    const hostPart = isIP(controlHost) === 6 ? `[${controlHost}]` : controlHost;
    const hosted = createHostedApi({
      fly,
      image,
      controlUrl: `http://${hostPart}:${controlAddress.port}`,
      publicOrigin,
      contactUrl,
      ...(region !== undefined ? { region } : {}),
      staticFiles,
      // One c-ares channel for every preflight; a fresh pinned resolver per request.
      resolver: () => new PinnedResolver({ lookup }),
      // Domain verification's TXT lookup: c-ares too, never the thread pool.
      txtLookup: caresTxtLookup(),
      log: write,
    });
    api = hosted;
    const publicServer = await listen(
      (req, env) => hosted.publicApp.fetch(req, env),
      options.publicHost ?? PUBLIC_HOST,
      options.publicPort ?? PUBLIC_PORT,
    );
    servers.push(publicServer);
    options.onListening?.({
      public: publicServer.address() as AddressInfo,
      control: controlAddress,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    write(
      typeof code === 'string' && /^E[A-Z]+$/.test(code)
        ? eventLine('api_start_failed', { code })
        : eventLine('api_start_failed'),
    );
    await Promise.all(servers.map(close));
    return 1;
  }
  api?.start();
  write(eventLine('api_ready'));

  const { signal } = options;
  await new Promise<void>((done) => {
    if (signal.aborted) done();
    else signal.addEventListener('abort', () => done(), { once: true });
  });
  api?.stop();
  await Promise.all(servers.map(close));
  return 0;
}

// Only as a process entry point.
if (import.meta.main) {
  const stop = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT'] as const)
    process.once(name, () => {
      stop.abort();
      // Backstop from the signal on: a close that hangs must not keep the API up.
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  const code = await main({ env: process.env, signal: stop.signal });
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2_000).unref();
}
