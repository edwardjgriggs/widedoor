import { createHash, X509Certificate } from 'node:crypto';
import { createSocket, type Socket as DgramSocket } from 'node:dgram';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { HardeningOptions, LaunchOptions, RequestGuard } from '../src/context.ts';
import { guardedRequestGuard, hostedUserAgent } from '../src/egress/guarded.ts';
import { PinnedResolver } from '../src/egress/resolver.ts';
import { startEgressProxy, type EgressProxy, type ProxyEvent } from '../src/egress/proxy.ts';
import { makeTestCertificates } from './test-ca.ts';

/*
 * The SSRF lab: a "public" site and a "private" server on 127.0.0.1, a fake resolver and a
 * dial hook that make the public one look like 93.184.215.14 and send every other address to
 * the private one, and a UDP listener. Anything that reaches the private server or the
 * listener got past the egress stack, so each test asserts both stay at zero.
 */

export const PUBLIC_V4 = '93.184.215.14';
export const PUBLIC_V6 = '2606:2800:220:1::1';
export const SITE = 'site.example.org';

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A server that counts connections as well as requests: a bare TCP connect is a leak too. */
export interface CountingServer {
  port: number;
  connections: number;
  requests: string[];
  close(): Promise<void>;
}

async function listen(
  handle: Handler,
  onRequest: (url: string) => void,
  tls?: { cert: string; key: string },
): Promise<CountingServer> {
  const state: CountingServer = {
    port: 0,
    connections: 0,
    requests: [],
    close: async () => undefined,
  };
  const serve = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? '';
    state.requests.push(url);
    onRequest(url);
    handle(req, res);
  };
  const server: Server = tls === undefined ? createServer(serve) : createTlsServer(tls, serve);
  server.on('connection', () => (state.connections += 1));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
  return state;
}

export interface Udp {
  port: number;
  datagrams: number;
  close(): Promise<void>;
}

async function listenUdp(): Promise<Udp> {
  const state: Udp = { port: 0, datagrams: 0, close: async () => undefined };
  const socket: DgramSocket = createSocket('udp4');
  socket.on('message', () => (state.datagrams += 1));
  await new Promise<void>((done) => socket.bind(0, '127.0.0.1', done));
  state.port = socket.address().port;
  state.close = () => new Promise<void>((done) => socket.close(() => done()));
  return state;
}

/**
 * The scanWeb options the lab sets. Typed from context.ts rather than scan.ts, so a
 * package whose tests are checked without the DOM lib (the hosted agent's) can share the lab.
 */
export type LabScanOptions = HardeningOptions &
  LaunchOptions & { navigationTimeoutMs: number; pageTimeoutMs: number };

/**
 * How a refused request travelled: the proxy's `via` (a CONNECT tunnel for https, an
 * absolute-form request for http), or the request guard and the scheme it saw.
 */
export type RefusalRoute = 'connect' | 'absolute' | 'guard:http' | 'guard:https';

export interface Refusal {
  host: string;
  route: RefusalRoute;
}

export interface LabOptions {
  /** Name to answers; a function is called per lookup, so a name can change its answer. */
  names: Record<string, string[] | ((call: number) => string[])>;
  /**
   * Also serve the public site over TLS on 443, with a leaf for SITE from a throwaway CA. Off,
   * a tunnel to the public site on 443 reaches the plain http server and its handshake fails.
   */
  https?: boolean;
}

export interface Lab {
  pub: CountingServer;
  /** The public site over TLS, when the lab was started with `https`. */
  pubTls?: CountingServer;
  /**
   * Base64 SHA-256 of the TLS leaf's public key, for Chromium's
   * `--ignore-certificate-errors-spki-list`: Chromium takes no CA, so the test trusts this
   * one throwaway key instead, and every other certificate is still verified.
   */
  spki?: string;
  priv: CountingServer;
  udp: Udp;
  proxy: EgressProxy;
  resolver: PinnedResolver;
  /** Every lookup the fake resolver answered, in order. */
  lookups: string[];
  /** Every address the proxy dialled, as `address:port`. */
  dials: string[];
  events: ProxyEvent[];
  /** Routes for the public site, by path (query ignored). Unrouted paths get 404. */
  routes: Map<string, Handler>;
  /** Paths the page reported through /beacon, in order, with their query. */
  beacons: string[];
  /** Resolves when `/beacon` has been called (used by /hold to keep `load` open). */
  beaconed: Promise<void>;
  /** Hosts the early request guard refused (with the guard on it stops most targets before the proxy). */
  guardRefusals: string[];
  /** The request guard `scanOptions(true)` installs, counting what it refuses. */
  requestGuard: RequestGuard;
  /** Every refusal, the proxy's then the guard's, with the route each was refused on. */
  refusals(): Refusal[];
  /** Every host the proxy or the guard refused: evidence that a probe was attempted and stopped. */
  refusedHosts(): Set<string>;
  /** scanWeb options: the proxy, the early request guard when `guard`, and the hosted UA. */
  scanOptions(guard: boolean): LabScanOptions;
  /** Counts of everything that must stay zero. */
  leaks(): { requests: string[]; connections: number; datagrams: number };
  close(): Promise<void>;
}

export async function startLab(options: LabOptions): Promise<Lab> {
  const routes = new Map<string, Handler>();
  const beacons: string[] = [];
  let beaconSeen: () => void = () => undefined;
  const beaconed = new Promise<void>((done) => (beaconSeen = done));
  const site: Handler = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const route = routes.get(url.pathname);
    if (route) return route(req, res);
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  };
  const beacon = (url: string): void => {
    if (url.startsWith('/beacon')) {
      beacons.push(url);
      beaconSeen();
    }
  };
  const pub = await listen(site, beacon);
  let pubTls: CountingServer | undefined;
  let spki: string | undefined;
  if (options.https === true) {
    const { cert, key } = makeTestCertificates(SITE);
    const der = new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' });
    spki = createHash('sha256').update(der).digest('base64');
    pubTls = await listen(site, beacon, { cert, key });
  }
  const priv = await listen(
    (_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('PRIVATE'),
    () => undefined,
  );
  const udp = await listenUdp();
  const lookups: string[] = [];
  const dials: string[] = [];
  const events: ProxyEvent[] = [];
  const calls = new Map<string, number>();
  const resolver = new PinnedResolver({
    lookup: async (host) => {
      lookups.push(host);
      const call = calls.get(host) ?? 0;
      calls.set(host, call + 1);
      const entry = options.names[host];
      const addresses = typeof entry === 'function' ? entry(call) : (entry ?? []);
      return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
  });
  const proxy = await startEgressProxy({
    resolver,
    onEvent: (event) => events.push(event),
    dial: (address, port): Socket => {
      dials.push(`${address}:${port}`);
      // Only the two public addresses reach the public site; any other address would be a leak.
      const isPublic = address === PUBLIC_V4 || address === PUBLIC_V6;
      if (isPublic && port === 443 && pubTls !== undefined)
        return connect(pubTls.port, '127.0.0.1');
      return connect(isPublic ? pub.port : priv.port, '127.0.0.1');
    },
  });
  const guardRefusals: string[] = [];
  const guarded: Refusal[] = [];
  const inner = guardedRequestGuard();
  const requestGuard: RequestGuard = async (request) => {
    const allowed = await inner(request);
    if (!allowed) {
      guardRefusals.push(request.url.hostname);
      guarded.push({
        host: request.url.hostname,
        route: request.url.protocol === 'https:' ? 'guard:https' : 'guard:http',
      });
    }
    return allowed;
  };
  const refusals = (): Refusal[] => [
    ...events.flatMap((event): Refusal[] =>
      event.kind === 'refused' ? [{ host: event.host, route: event.via }] : [],
    ),
    ...guarded,
  ];
  const ua = hostedUserAgent('https://example.org/contact');
  return {
    pub,
    ...(pubTls !== undefined ? { pubTls } : {}),
    ...(spki !== undefined ? { spki } : {}),
    priv,
    udp,
    proxy,
    resolver,
    lookups,
    dials,
    events,
    routes,
    beacons,
    beaconed,
    guardRefusals,
    requestGuard,
    refusals,
    refusedHosts: () => new Set(refusals().map((refusal) => refusal.host)),
    scanOptions: (guard) => ({
      unsafeNoSandbox: process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1',
      proxy: { server: proxy.url },
      userAgent: ua,
      ...(guard ? { requestGuard } : {}),
      navigationTimeoutMs: 20_000,
      pageTimeoutMs: 40_000,
    }),
    leaks: () => ({
      requests: priv.requests,
      connections: priv.connections,
      datagrams: udp.datagrams,
    }),
    close: async () => {
      await proxy.close();
      await Promise.all([pub.close(), pubTls?.close(), priv.close(), udp.close()]);
    },
  };
}

export const NO_LEAKS = { requests: [], connections: 0, datagrams: 0 };

export const html = (body: string, head = ''): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SSRF</title>${head}</head><body><main><h1>SSRF</h1>${body}</main></body></html>`;

/** A route that serves a fixed body. */
export const send =
  (body: string, type = 'text/html; charset=utf-8', status = 200): Handler =>
  (_req, res) =>
    void res.writeHead(status, { 'content-type': type }).end(body);

/** A route that serves a fixed page with extra response headers. */
export const sendWith =
  (body: string, headers: Record<string, string>): Handler =>
  (_req, res) =>
    void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers }).end(body);

export const redirect =
  (location: string, status = 302): Handler =>
  (_req, res) =>
    void res.writeHead(status, { location }).end();

/**
 * Keeps the page's `load` event open until the page has reported (or 8 s pass), so scripts
 * that start network requests at load time finish before the scan closes the browser.
 */
export const hold =
  (lab: Lab): Handler =>
  (_req, res) => {
    const done = (): void => {
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'image/gif' }).end();
    };
    void lab.beaconed.then(done);
    setTimeout(done, 8000).unref();
  };

/**
 * A script that tries a target with fetch, XHR and sendBeacon, then reports to /beacon.
 * The report is how a test knows the script ran to the end.
 */
export const probeScript = (targets: readonly string[]): string => `<script>
const targets = ${JSON.stringify(targets)};
const xhr = (url) => new Promise((done) => {
  const x = new XMLHttpRequest();
  x.onloadend = () => done(x.status);
  try { x.open('GET', url); x.send(); } catch { done(-1); }
});
Promise.allSettled(targets.flatMap((url) => [
  fetch(url, { mode: 'no-cors' }),
  xhr(url),
  Promise.resolve(navigator.sendBeacon(url, 'x')),
])).then((r) => fetch('/beacon?probed=' + r.length));
</script>`;
