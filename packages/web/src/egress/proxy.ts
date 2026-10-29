import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { BlockList, connect, isIP, type Socket } from 'node:net';
import type { Duplex, Readable } from 'node:stream';
import { EgressRefusedError } from '../fetch.js';
import { checkTarget } from './policy.js';
import type { PinnedResolver } from './resolver.js';

/*
 * The egress proxy of a hosted scan machine. Chromium and every Node fetch reach the
 * internet only through it (the kernel blocks everything else), so it is the one place
 * the SSRF policy is enforced: each CONNECT or absolute-form request is checked with
 * checkTarget, its host goes through the pinned resolver, and the proxy dials the
 * pinned address itself, never the host name. Refusals get one generic 403 that names
 * neither the host nor the reason; the reason is kept in refusals() for the report.
 */

export type DialFn = (address: string, port: number) => Socket;

export interface ProxyRefusal {
  host: string;
  /** The EgressRefusedError block reason, or 'policy' when none was set. */
  reason: string;
  at: number;
}

/**
 * What the proxy did, for the scan machine's server log. Never carries a path, query,
 * port or header value.
 */
export type ProxyEvent =
  | { kind: 'refused'; host: string; reason: string; method: string; via: 'connect' | 'absolute' }
  | { kind: 'upstream-error' | 'over-capacity'; host?: string }
  | { kind: 'idle-timeout'; host: string }
  | { kind: 'malformed'; status: 400 | 431 };

export interface EgressProxy {
  /** `http://127.0.0.1:<port>` */
  url: string;
  port: number;
  /** The first 1000 refusals: host and reason only, never a path, query or port. */
  refusals(): readonly ProxyRefusal[];
  /** Refusals past the first 1000, counted but not kept. */
  droppedRefusals(): number;
  close(): Promise<void>;
}

export interface EgressProxyOptions {
  resolver: PinnedResolver;
  /** Opens the upstream connection. Default net.connect. */
  dial?: DialFn;
  /** Listen address. Default 127.0.0.1. */
  host?: string;
  /** Listen port. Default 0 (any free port). */
  port?: number;
  /** Longest wait for a request line and headers, and for an upstream dial. Default 10000. */
  connectTimeoutMs?: number;
  /**
   * Client connections served at once; more get 503, and past twice this many the server
   * refuses them at accept. Default 256.
   */
  maxConnections?: number;
  /**
   * Once a tunnel or an upstream exchange is under way, how long neither side may move a
   * byte before both sockets are destroyed. Default 120000.
   */
  idleTimeoutMs?: number;
  /** Called for every refusal, 400, 431, 502, 503 and idle timeout. A throw from it is ignored. */
  onEvent?: (event: ProxyEvent) => void;
}

const REFUSED_BODY = 'Refused by the Widedoor egress policy.';
const MAX_REFUSALS = 1000;
const MAX_HEADER_BYTES = 16 * 1024;

/** RFC 9110 hop-by-hop fields, plus the legacy Proxy-Connection; Proxy-* is dropped by prefix. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  431: 'Request Header Fields Too Large',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

const defaultDial: DialFn = (address, port) => connect({ host: address, port });

/** A complete HTTP/1.1 response for a socket the HTTP server no longer manages. */
function rawResponse(status: number, body: string): string {
  return (
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    'Connection: close\r\n\r\n' +
    body
  );
}

/** Copies raw header pairs, dropping hop-by-hop and Proxy-* fields and those named in Connection. */
function forwardHeaders(raw: readonly string[]): string[] {
  const named = new Set<string>();
  for (let i = 0; i < raw.length; i += 2)
    if (raw[i]?.toLowerCase() === 'connection')
      for (const token of (raw[i + 1] ?? '').split(',')) named.add(token.trim().toLowerCase());
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] ?? '';
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower.startsWith('proxy-') || named.has(lower)) continue;
    out.push(name, raw[i + 1] ?? '');
  }
  return out;
}

/**
 * Percent-encodes everything outside a safe set, so a value can never split or forge a log
 * line. Shared by every `widedoor event=...` line of a scan machine.
 */
export function logValue(text: string): string {
  return text.replace(/[^A-Za-z0-9._:[\]-]/gu, (char) =>
    [...Buffer.from(char, 'utf8')]
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
      .join(''),
  );
}

/** One log line per event: `widedoor event=egress_refused host=... reason=... method=... via=...`. */
export function formatProxyEvent(event: ProxyEvent): string {
  if (event.kind === 'refused')
    return (
      `widedoor event=egress_refused host=${logValue(event.host)} reason=${logValue(event.reason)}` +
      ` method=${logValue(event.method)} via=${logValue(event.via)}`
    );
  if (event.kind === 'malformed') return `widedoor event=egress_malformed status=${event.status}`;
  const name =
    event.kind === 'upstream-error'
      ? 'egress_upstream_error'
      : event.kind === 'idle-timeout'
        ? 'egress_idle_timeout'
        : 'egress_over_capacity';
  return event.host === undefined
    ? `widedoor event=${name}`
    : `widedoor event=${name} host=${logValue(event.host)}`;
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/** `host:port` as a CONNECT target; anything else (paths, userinfo, no port) is not one. */
const AUTHORITY = /^(?:\[[0-9a-f:.]+\]|[^\s/?#@[\]:\\]+):[0-9]{1,5}$/i;

export function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const listenHost = options.host ?? '127.0.0.1';
  const family = isIP(listenHost);
  if (family === 0 || !LOOPBACK.check(listenHost, family === 6 ? 'ipv6' : 'ipv4'))
    return Promise.reject(new Error('the egress proxy listens on a loopback address only'));
  const listenPort = options.port ?? 0;
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535)
    return Promise.reject(new Error('the egress proxy port must be 0 to 65535'));
  const { resolver } = options;
  const dial = options.dial ?? defaultDial;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10000;
  const maxConnections = options.maxConnections ?? 256;
  const idleTimeoutMs = options.idleTimeoutMs ?? 120000;
  const recorded: ProxyRefusal[] = [];
  let dropped = 0;
  // Every socket the proxy holds, client or upstream, so close() can end tunnels too.
  const open = new Set<Duplex>();
  // Client sockets that arrived over maxConnections: answered 503 and never served.
  const overLimit = new WeakSet<Duplex>();
  // Client sockets still waiting for a complete request line and headers.
  const waiting = new WeakMap<Duplex, NodeJS.Timeout>();
  // Client sockets already reported as malformed: the parser may fail on the rest of the
  // same request (its body) after the proxy answered 400, and that is not a second one.
  const reported = new WeakSet<Duplex>();
  let served = 0;

  const emit = (event: ProxyEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // Logging must never take the proxy down.
    }
  };

  const track = (socket: Duplex): void => {
    open.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => open.delete(socket));
  };

  const started = (socket: Duplex): void => {
    clearTimeout(waiting.get(socket));
    waiting.delete(socket);
  };

  /** Checks the target and resolves its pinned address, or records the refusal and returns undefined. */
  const admit = async (
    url: URL,
    method: string,
    via: 'connect' | 'absolute',
  ): Promise<string | undefined> => {
    try {
      // A tunnel is for TLS on 443 only (`url` is https:, so 443 leaves port empty). Over a
      // tunnel to 80 the client writes plain HTTP with a Host of its own choosing.
      if (via === 'connect' && url.port !== '')
        throw new EgressRefusedError('CONNECT is for port 443 only', 'policy', 'port');
      checkTarget(url);
      return await resolver.resolve(url.hostname);
    } catch (error) {
      // Fail closed: any throw is a refusal, tagged 'policy' when it carries no block reason.
      const reason =
        error instanceof EgressRefusedError ? (error.blockReason ?? 'policy') : 'policy';
      if (recorded.length < MAX_REFUSALS)
        recorded.push({ host: url.hostname, reason, at: Date.now() });
      else dropped += 1;
      emit({ kind: 'refused', host: url.hostname, reason, method, via });
      return undefined;
    }
  };

  /** Dials the pinned address; resolves once connected, rejects on error or after connectTimeoutMs. */
  const openUpstream = (address: string, port: number): Promise<Socket> =>
    new Promise((resolve, reject) => {
      let upstream: Socket;
      try {
        upstream = dial(address, port);
      } catch (error) {
        reject(error instanceof Error ? error : new Error('dial failed'));
        return;
      }
      track(upstream);
      const timer = setTimeout(() => {
        upstream.destroy();
        reject(new Error('upstream connect timed out'));
      }, connectTimeoutMs);
      const fail = (): void => {
        clearTimeout(timer);
        reject(new Error('upstream connect failed'));
      };
      upstream.once('error', fail);
      upstream.once('close', fail);
      upstream.once('connect', () => {
        clearTimeout(timer);
        upstream.off('error', fail);
        upstream.off('close', fail);
        resolve(upstream);
      });
    });

  /**
   * Destroys `sockets` once no stream in `sources` has delivered a byte for idleTimeoutMs.
   * Each source must already be flowing (piped). A reader so slow that backpressure pauses
   * every source for the whole window counts as idle too. Returns the function that stops
   * watching.
   */
  const watchIdle = (
    host: string,
    sources: readonly Readable[],
    sockets: readonly Duplex[],
  ): (() => void) => {
    const timer = setTimeout(() => {
      emit({ kind: 'idle-timeout', host });
      for (const socket of sockets) socket.destroy();
    }, idleTimeoutMs);
    const moved = (): void => void timer.refresh();
    for (const source of sources) source.on('data', moved);
    return () => {
      clearTimeout(timer);
      for (const source of sources) source.off('data', moved);
    };
  };

  const port = (url: URL): number =>
    url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);

  const onConnect = async (req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> => {
    started(client);
    // The socket is detached and paused: drain what the client sent after the CONNECT so
    // the close can complete, and destroy once the answer is flushed so the slot frees.
    const reply = (status: number, body: string): void => {
      client.resume();
      client.end(rawResponse(status, body), () => client.destroy());
    };
    if (overLimit.has(client)) {
      emit({ kind: 'over-capacity' });
      return reply(503, 'Too many connections.');
    }
    const malformed = (): void => {
      emit({ kind: 'malformed', status: 400 });
      reply(400, 'Bad request.');
    };
    const authority = req.url ?? '';
    if (!AUTHORITY.test(authority)) return malformed();
    let url: URL;
    try {
      url = new URL(`https://${authority}`);
    } catch {
      return malformed();
    }
    const address = await admit(url, 'CONNECT', 'connect');
    if (address === undefined) return reply(403, REFUSED_BODY);
    if (client.destroyed) return;

    let upstream: Socket;
    try {
      upstream = await openUpstream(address, port(url));
    } catch {
      emit({ kind: 'upstream-error', host: url.hostname });
      return reply(502, 'Upstream connection failed.');
    }
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
    const unwatch = watchIdle(url.hostname, [client, upstream], [client, upstream]);
    // Either side closing or failing ends both: a tunnel never outlives its peer.
    const teardown = (): void => {
      unwatch();
      client.destroy();
      upstream.destroy();
    };
    client.once('close', teardown);
    upstream.once('close', teardown);
  };

  const onRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    started(req.socket);
    res.shouldKeepAlive = false;
    const reply = (status: number, body: string): void => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    };
    req.on('error', () => res.destroy());
    res.on('error', () => req.destroy());
    if (overLimit.has(req.socket)) {
      emit({ kind: 'over-capacity' });
      return reply(503, 'Too many connections.');
    }

    const malformed = (): void => {
      reported.add(req.socket);
      emit({ kind: 'malformed', status: 400 });
      reply(400, 'Bad request.');
    };
    const target = req.url ?? '';
    // Origin-form (`GET /x`) means a client that does not know it is talking to a proxy.
    if (target.startsWith('/')) return malformed();
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return malformed();
    }
    // https goes through CONNECT; the proxy never originates TLS itself. Other schemes
    // fall through to admit, which refuses them.
    if (url.protocol === 'https:') return malformed();

    // Transfer-Encoding is hop-by-hop, so the body is re-framed upstream, never passed
    // through raw (a raw chunked body on a GET would be read upstream as a second request).
    // Only plain `chunked` is accepted, and never alongside Content-Length.
    const encodings: string[] = [];
    let hasLength = false;
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]?.toLowerCase();
      if (name === 'transfer-encoding') encodings.push(req.rawHeaders[i + 1] ?? '');
      if (name === 'content-length') hasLength = true;
    }
    const chunked = encodings.length > 0;
    if (chunked && (hasLength || encodings.join(',').trim().toLowerCase() !== 'chunked'))
      return malformed();

    const address = await admit(url, req.method ?? 'GET', 'absolute');
    if (address === undefined) return reply(403, REFUSED_BODY);

    const upstreamFailed = (): void => {
      emit({ kind: 'upstream-error', host: url.hostname });
      reply(502, 'Upstream connection failed.');
    };
    let upstream: Socket;
    try {
      upstream = await openUpstream(address, port(url));
    } catch {
      return upstreamFailed();
    }
    if (req.socket.destroyed) {
      upstream.destroy();
      return;
    }
    // Host is the target the policy checked, never what the client sent: a second or
    // different Host would let a shared upstream route the request somewhere unchecked.
    const headers = forwardHeaders(req.rawHeaders).filter(
      (_, i, all) => all[i - (i % 2)]?.toLowerCase() !== 'host',
    );
    headers.push('Host', url.host);
    if (chunked) headers.push('Transfer-Encoding', 'chunked');
    headers.push('Connection', 'close');
    // No `agent`: Node only uses createConnection when the agent is unset (`agent: false`
    // builds a fresh Agent that dials host/port itself). host and port name the pinned
    // address anyway, so no code path can dial anything else.
    const outgoing = httpRequest({
      host: address,
      port: port(url),
      method: req.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers,
      setHost: false,
      maxHeaderSize: MAX_HEADER_BYTES,
      createConnection: () => upstream,
    });
    outgoing.on('error', () => {
      upstream.destroy();
      upstreamFailed();
    });
    outgoing.on('response', (incoming) => {
      incoming.on('error', () => res.destroy());
      // llhttp accepts any three digits (`099`, `000`), but writeHead throws outside
      // 100..999, and a throw in this listener would end the process.
      const status = incoming.statusCode ?? 0;
      try {
        if (status < 100 || status > 999) throw new RangeError('upstream status out of range');
        res.writeHead(status, forwardHeaders(incoming.rawHeaders));
      } catch {
        incoming.destroy();
        upstream.destroy();
        try {
          for (const name of res.getHeaderNames()) res.removeHeader(name);
          upstreamFailed();
        } catch {
          res.destroy();
        }
        return;
      }
      incoming.pipe(res);
    });
    req.pipe(outgoing);
    // The request body counts as movement, not its socket: the HTTP server may read that
    // socket without emitting 'data'.
    const unwatch = watchIdle(url.hostname, [req, upstream], [req.socket, upstream]);
    res.once('close', () => {
      unwatch();
      upstream.destroy();
    });
  };

  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES });
  // Sockets between maxConnections and this get 503; past it they are closed at accept,
  // so idle sockets cannot pile up.
  server.maxConnections = 2 * maxConnections;

  server.on('connection', (socket: Socket) => {
    track(socket);
    if (served >= maxConnections) overLimit.add(socket);
    else {
      served += 1;
      socket.once('close', () => (served -= 1));
    }
    // A request line or header block that never finishes is dropped after connectTimeoutMs.
    waiting.set(
      socket,
      setTimeout(() => socket.destroy(), connectTimeoutMs),
    );
    socket.once('close', () => clearTimeout(waiting.get(socket)));
  });

  server.on('clientError', (error: NodeJS.ErrnoException, socket: Duplex) => {
    const status = error.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
    // Parse errors only: a reset or a socket error is not a malformed request.
    if (error.code?.startsWith('HPE_') === true && !reported.has(socket)) {
      reported.add(socket);
      emit({ kind: 'malformed', status });
    }
    if (socket.writable && !socket.destroyed) socket.end(rawResponse(status, 'Bad request.'));
    socket.destroy();
  });

  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    // The HTTP server has let go of the socket; the tunnel owns its errors from here.
    client.on('error', () => client.destroy());
    onConnect(req, client, head).catch(() => client.destroy());
  });

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    onRequest(req, res).catch(() => res.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, () => {
      server.off('error', reject);
      server.on('error', () => undefined);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('egress proxy has no port'));
        return;
      }
      const urlHost = isIP(listenHost) === 6 ? `[${listenHost}]` : listenHost;
      resolve({
        url: `http://${urlHost}:${address.port}`,
        port: address.port,
        refusals: () => [...recorded],
        droppedRefusals: () => dropped,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            for (const socket of open) socket.destroy();
          }),
      });
    });
  });
}
