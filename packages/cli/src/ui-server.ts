import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { CODE_HEADER, TOKEN_HEADER } from '@widedoor/report';

/*
 * The widedoor ui server (ledger ruling for Task 1.5). It binds 127.0.0.1 on
 * a random port and serves two things: the built viewer, read into memory at
 * start from one folder (regular files of known types only, so no request
 * path can reach the disk), and the report, behind a per-run token. Requests
 * whose Host header is not this server (DNS rebinding) are refused. Every
 * response, refusals and 404s included, carries the CSP and the other
 * security headers.
 *
 * The opened link carries a one-time code, not the token: the page trades it
 * for the token once (POST /api/session). A code read later from the
 * opener's command line (visible to other local users on POSIX) is dead.
 */

export const LOOPBACK = '127.0.0.1';
export { CODE_HEADER, TOKEN_HEADER };

export const UI_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  'img-src data:',
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': UI_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface StaticFile {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}

/** The viewer build is missing or unusable. */
export class UiBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiBuildError';
  }
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_DEPTH = 4;

/**
 * Reads the built viewer into memory, keyed by URL path. Only plain names,
 * known file types and regular files count: symbolic links, junctions and
 * anything else are skipped, so the set of servable paths is fixed at start.
 */
export function loadStaticFiles(dir: string): Map<string, StaticFile> {
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    throw new UiBuildError(`the viewer is not built (no ${dir}); run "npm run build"`);
  }
  const files = new Map<string, StaticFile>();
  const walk = (abs: string, prefix: string, depth: number) => {
    for (const name of readdirSync(abs)) {
      if (!SAFE_NAME.test(name)) continue;
      const path = join(abs, name);
      const stat = lstatSync(path);
      if (stat.isDirectory() && depth < MAX_DEPTH) walk(path, `${prefix}${name}/`, depth + 1);
      else if (stat.isFile()) {
        const type = TYPES[extname(name).toLowerCase()];
        if (type)
          files.set(`/${prefix}${name}`, { body: new Uint8Array(readFileSync(path)), type });
      }
    }
  };
  walk(root, '', 0);
  if (!files.has('/index.html'))
    throw new UiBuildError(
      `the viewer is not built (no index.html in ${dir}); run "npm run build"`,
    );
  return files;
}

export function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const h = host.toLowerCase();
  return h === `${LOOPBACK}:${port}` || h === `localhost:${port}`;
}

export function tokenMatches(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The response with every security header set (replacing any the handler set). */
export function secured(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
  return out;
}

export interface UiAppOptions {
  files: ReadonlyMap<string, StaticFile>;
  /** The JSON body of GET /api/report; without it the API answers 204 (no report). */
  reportBody?: string;
  token: string;
  /** The one-time code the opened link holds; POST /api/session trades it for the token once. */
  code: string;
  /** The port the server listens on (known only after listen). */
  port: () => number;
  /** Called when the right code comes again after it was traded: someone else may hold the token. */
  onCodeReuse?: () => void;
}

export function createUiApp(options: UiAppOptions): Hono {
  const { files, reportBody, token, code, port, onCodeReuse } = options;
  let codeUsed = false;
  const text = (body: string, status: 401 | 403 | 404 | 500) =>
    new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const app = new Hono();
  app.use(async (c, next) => {
    if (!hostAllowed(c.req.header('host'), port())) return text('Forbidden: unexpected Host.', 403);
    await next();
  });
  app.post('/api/session', (c) => {
    const right = tokenMatches(c.req.header(CODE_HEADER), code);
    if (codeUsed || !right) {
      if (codeUsed && right) onCodeReuse?.();
      return text('Unauthorized: this link was already used or is wrong.', 401);
    }
    codeUsed = true;
    return new Response(JSON.stringify({ token }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });
  app.use('/api/*', async (c, next) => {
    if (!tokenMatches(c.req.header(TOKEN_HEADER), token))
      return text('Unauthorized: open the link widedoor ui printed.', 401);
    await next();
  });
  app.get('/api/report', () =>
    reportBody === undefined
      ? new Response(null, { status: 204 })
      : new Response(reportBody, {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
  );
  app.get('*', (c) => {
    const path = new URL(c.req.url).pathname;
    const file = files.get(path === '/' ? '/index.html' : path);
    if (!file) return text('Not found.', 404);
    return new Response(file.body, { headers: { 'content-type': file.type } });
  });
  app.notFound(() => text('Not found.', 404));
  app.onError(() => text('Server error.', 500));
  return app;
}

export interface UiServer {
  /** The link to open: loopback address, port and the one-time code. */
  url: string;
  port: number;
  address: AddressInfo;
  token: string;
  code: string;
  close(): Promise<void>;
}

export interface UiServerOptions {
  files: ReadonlyMap<string, StaticFile>;
  reportBody?: string;
  /** For tests; a random 256-bit token otherwise. */
  token?: string;
  /** For tests; a random 256-bit code otherwise. */
  code?: string;
  onCodeReuse?: () => void;
}

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const token = options.token ?? randomBytes(32).toString('base64url');
  const code = options.code ?? randomBytes(32).toString('base64url');
  let port = 0;
  const app = createUiApp({
    files: options.files,
    ...(options.reportBody !== undefined ? { reportBody: options.reportBody } : {}),
    token,
    code,
    port: () => port,
    ...(options.onCodeReuse ? { onCodeReuse: options.onCodeReuse } : {}),
  });
  const listener = getRequestListener(async (req, env) => secured(await app.fetch(req, env)), {
    overrideGlobalObjects: false,
    // A request node-server cannot turn into a Request (no or a malformed Host header).
    errorHandler: () =>
      secured(
        new Response('Bad request.', {
          status: 400,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      ),
  });
  // Without a Host header the request still reaches the listener, which refuses it with the headers.
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
    server.listen(0, LOOPBACK, () => {
      server.off('error', fail);
      ready();
    });
  });
  const address = server.address() as AddressInfo;
  port = address.port;
  return {
    url: `http://${LOOPBACK}:${port}/?code=${code}`,
    port,
    address,
    token,
    code,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
