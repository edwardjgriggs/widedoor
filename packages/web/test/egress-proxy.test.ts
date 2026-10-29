import { createServer, type Server } from 'node:http';
import {
  connect,
  createServer as createNetServer,
  Socket,
  type AddressInfo,
  type Server as NetServer,
} from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { fetch, ProxyAgent } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PinnedResolver } from '../src/egress/resolver.js';
import {
  formatProxyEvent,
  startEgressProxy,
  type DialFn,
  type EgressProxy,
  type ProxyEvent,
} from '../src/egress/proxy.js';
import { makeTestCertificates } from './test-ca.js';

const PUBLIC = '93.184.215.14';
const DOWN = '93.184.215.15';
// Routed to a per-test upstream (sidePort) for tests that need a misbehaving server.
const SIDE = '93.184.215.16';
let sidePort = 0;
const REFUSED = 'Refused by the Widedoor egress policy.';

const answers: Record<string, string> = {
  'site.example.org': PUBLIC,
  'evil.example.org': '10.0.0.1',
  'down.example.org': DOWN,
  'side.example.org': SIDE,
};

const certs = makeTestCertificates('site.example.org');
let httpServer: Server;
let tlsServer: TlsServer;
let httpPort: number;
let tlsPort: number;
// Server-side sockets of the TLS test server, to see a tunnel end at the far side.
const tlsSockets: Socket[] = [];

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    res.setHeader(
      'x-echo',
      JSON.stringify({ url: req.url, headers: req.headers, raw: req.rawHeaders }),
    );
    res.end('plain hello');
  });
  tlsServer = createTlsServer({ cert: certs.cert, key: certs.key }, (socket) => {
    tlsSockets.push(socket);
    socket.on('error', () => undefined);
    socket.once('data', () =>
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: keep-alive\r\n\r\nsecure hello',
      ),
    );
  });
  await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
  await new Promise<void>((done) => tlsServer.listen(0, '127.0.0.1', done));
  httpPort = (httpServer.address() as AddressInfo).port;
  tlsPort = (tlsServer.address() as AddressInfo).port;
});

afterAll(async () => {
  httpServer.closeAllConnections();
  await new Promise((done) => httpServer.close(done));
  for (const socket of tlsSockets) socket.destroy();
  await new Promise((done) => tlsServer.close(done));
});

let proxies: EgressProxy[] = [];
let agents: ProxyAgent[] = [];

afterEach(async () => {
  await Promise.all(agents.map((agent) => agent.close()));
  await Promise.all(proxies.map((proxy) => proxy.close()));
  agents = [];
  proxies = [];
});

interface Harness {
  proxy: EgressProxy;
  dial: ReturnType<typeof vi.fn<DialFn>>;
  dialed: Socket[];
  lookups: () => number;
  events: ProxyEvent[];
}

async function start(
  options: { connectTimeoutMs?: number; maxConnections?: number; idleTimeoutMs?: number } = {},
): Promise<Harness> {
  let lookups = 0;
  const resolver = new PinnedResolver({
    lookup: async (host) => {
      lookups += 1;
      const address = answers[host];
      return address === undefined ? [] : [{ address, family: 4 }];
    },
  });
  const dialed: Socket[] = [];
  // Fake public addresses map to the local test servers; anything else is unreachable.
  const dial = vi.fn<DialFn>((address, port) => {
    let socket: Socket;
    if (address === PUBLIC) socket = connect(port === 443 ? tlsPort : httpPort, '127.0.0.1');
    else if (address === SIDE) socket = connect(sidePort, '127.0.0.1');
    else {
      socket = new Socket();
      setImmediate(() => socket.destroy(new Error('unreachable')));
    }
    dialed.push(socket);
    return socket;
  });
  const events: ProxyEvent[] = [];
  const proxy = await startEgressProxy({
    resolver,
    dial,
    onEvent: (event) => events.push(event),
    ...options,
  });
  proxies.push(proxy);
  return { proxy, dial, dialed, lookups: () => lookups, events };
}

function agent(proxy: EgressProxy, tunnel: boolean): ProxyAgent {
  const made = new ProxyAgent({
    uri: proxy.url,
    proxyTunnel: tunnel,
    requestTls: { ca: certs.ca },
  });
  agents.push(made);
  return made;
}

/** Sends `text` on a fresh connection and collects everything until the proxy closes it. */
function exchange(proxy: EgressProxy, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxy.port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    socket.write(text);
  });
}

const connectLine = (authority: string): string =>
  `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`;

/** Opens a CONNECT tunnel and resolves with the client socket once the proxy answers 200. */
function openTunnel(proxy: EgressProxy, authority: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxy.port, '127.0.0.1');
    let seen = '';
    const onData = (chunk: Buffer): void => {
      seen += chunk.toString('latin1');
      if (!seen.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      if (seen.startsWith('HTTP/1.1 200')) resolve(socket);
      else reject(new Error(seen));
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.write(connectLine(authority));
  });
}

const closed = (socket: Socket): Promise<void> =>
  socket.closed ? Promise.resolve() : new Promise((done) => socket.once('close', () => done()));

/** Starts the upstream that side.example.org reaches; resolves with a function that stops it. */
async function side(server: NetServer): Promise<() => Promise<void>> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  sidePort = (server.address() as AddressInfo).port;
  return () =>
    new Promise<void>((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    });
}

const body = (response: string): string => response.slice(response.indexOf('\r\n\r\n') + 4);

describe('startEgressProxy', () => {
  it('listens on loopback', async () => {
    const { proxy } = await start();
    expect(proxy.url).toBe(`http://127.0.0.1:${proxy.port}`);
  });

  it('tunnels CONNECT to a public host', async () => {
    const { proxy, dial } = await start();
    const response = await fetch('https://site.example.org/', { dispatcher: agent(proxy, true) });
    expect(await response.text()).toBe('secure hello');
    expect(dial).toHaveBeenCalledWith(PUBLIC, 443);
  });

  it('forwards plain http to a public host', async () => {
    const { proxy, dial } = await start();
    const response = await fetch('http://site.example.org/path?q=1', {
      dispatcher: agent(proxy, false),
      headers: { 'x-kept': 'yes', 'proxy-secret': 'no' },
    });
    expect(await response.text()).toBe('plain hello');
    const echo = JSON.parse(response.headers.get('x-echo') ?? '{}') as {
      url: string;
      headers: Record<string, string>;
    };
    expect(echo.url).toBe('/path?q=1');
    expect(echo.headers.host).toBe('site.example.org');
    expect(echo.headers.connection).toBe('close');
    expect(echo.headers['x-kept']).toBe('yes');
    expect(echo.headers['proxy-secret']).toBeUndefined();
    expect(dial).toHaveBeenCalledWith(PUBLIC, 80);
  });

  it('drops headers named in Connection and replaces the client Host', async () => {
    const { proxy } = await start();
    const response = await exchange(
      proxy,
      'GET http://site.example.org/x HTTP/1.1\r\nHost: www.site.example.org\r\n' +
        'Connection: keep-alive, x-dropped\r\nX-Dropped: no\r\nKeep-Alive: 5\r\n\r\n',
    );
    expect(response.startsWith('HTTP/1.1 200 ')).toBe(true);
    const echo = /x-echo: (.*)\r\n/.exec(response)?.[1] ?? '{}';
    const headers = (JSON.parse(echo) as { headers: Record<string, string> }).headers;
    expect(headers.host).toBe('site.example.org');
    expect(headers.connection).toBe('close');
    expect(headers['x-dropped']).toBeUndefined();
    expect(headers['keep-alive']).toBeUndefined();
  });

  it('refuses a private host with 403 and never dials', async () => {
    const { proxy, dial } = await start();
    const response = await fetch('http://evil.example.org/', { dispatcher: agent(proxy, false) });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(REFUSED);
    const tunnel = await exchange(proxy, connectLine('evil.example.org:443'));
    expect(tunnel.startsWith('HTTP/1.1 403 ')).toBe(true);
    expect(body(tunnel)).toBe(REFUSED);
    expect(dial).not.toHaveBeenCalled();
  });

  it('refuses port 8080', async () => {
    const { proxy, dial } = await start();
    const response = await fetch('http://site.example.org:8080/', {
      dispatcher: agent(proxy, false),
    });
    expect(response.status).toBe(403);
    await response.text();
    const tunnel = await exchange(proxy, connectLine('site.example.org:8080'));
    expect(tunnel.startsWith('HTTP/1.1 403 ')).toBe(true);
    expect(dial).not.toHaveBeenCalled();
  });

  it('refuses CONNECT to 127.0.0.1:443', async () => {
    const { proxy, dial } = await start();
    for (const authority of ['127.0.0.1:443', '[::1]:443', '0x7f.1:443', 'localhost:443']) {
      const response = await exchange(proxy, connectLine(authority));
      expect(response.startsWith('HTTP/1.1 403 '), authority).toBe(true);
    }
    expect(dial).not.toHaveBeenCalled();
  });

  it('refuses origin-form requests', async () => {
    const { proxy, dial } = await start();
    const response = await exchange(proxy, 'GET /x HTTP/1.1\r\nHost: site.example.org\r\n\r\n');
    expect(response.startsWith('HTTP/1.1 400 ')).toBe(true);
    expect(dial).not.toHaveBeenCalled();
  });

  it('answers absolute-form https with 400 and other schemes with 403', async () => {
    const { proxy, dial, lookups, events } = await start();
    const request = (target: string): string =>
      `GET ${target} HTTP/1.1\r\nHost: site.example.org\r\n\r\n`;
    const https = await exchange(proxy, request('https://site.example.org/'));
    expect(https.startsWith('HTTP/1.1 400 ')).toBe(true);
    expect(events).toEqual([{ kind: 'malformed', status: 400 }]);
    const ftp = await exchange(proxy, request('ftp://site.example.org/'));
    expect(ftp.startsWith('HTTP/1.1 403 ')).toBe(true);
    expect(proxy.refusals().map(({ reason }) => reason)).toEqual(['scheme']);
    expect(lookups()).toBe(0);
    expect(dial).not.toHaveBeenCalled();
  });

  it('refuses CONNECT targets that are not host:port', async () => {
    const { proxy, dial, events } = await start();
    for (const authority of [
      'site.example.org',
      'user@site.example.org:443',
      'site.example.org:443/x',
    ]) {
      const response = await exchange(proxy, connectLine(authority));
      expect(response.startsWith('HTTP/1.1 400 '), authority).toBe(true);
    }
    expect(dial).not.toHaveBeenCalled();
    expect(events).toEqual(Array(3).fill({ kind: 'malformed', status: 400 }));
  });

  it('refuses CONNECT to any port but 443', async () => {
    // Over a tunnel to port 80 the client would write plain HTTP with a Host of its own.
    const { proxy, dial, events } = await start();
    const response = await exchange(proxy, connectLine('site.example.org:80'));
    expect(response.startsWith('HTTP/1.1 403 ')).toBe(true);
    expect(body(response)).toBe(REFUSED);
    expect(proxy.refusals().map(({ host, reason }) => [host, reason])).toEqual([
      ['site.example.org', 'port'],
    ]);
    expect(events).toEqual([
      {
        kind: 'refused',
        host: 'site.example.org',
        reason: 'port',
        method: 'CONNECT',
        via: 'connect',
      },
    ]);
    expect(dial).not.toHaveBeenCalled();
  });

  it('uses the pinned address for every connection', async () => {
    const { proxy, dial, lookups } = await start();
    const tunnel = agent(proxy, true);
    const plain = agent(proxy, false);
    for (const [url, dispatcher] of [
      ['https://site.example.org/', tunnel],
      ['http://site.example.org/a', plain],
      ['http://site.example.org/b', plain],
    ] as const) {
      const response = await fetch(url, { dispatcher });
      expect(await response.text()).toMatch(/^(secure|plain) hello$/);
    }
    expect(lookups()).toBe(1);
    expect(dial.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [address] of dial.mock.calls) expect(address).toBe(PUBLIC);
  });

  it('records refusals', async () => {
    const { proxy } = await start();
    const response = await fetch('http://evil.example.org/secret?token=abc', {
      dispatcher: agent(proxy, false),
    });
    await response.text();
    await exchange(proxy, connectLine('metadata.internal:443'));
    await exchange(proxy, connectLine('site.example.org:8443'));
    expect(proxy.refusals().map(({ host, reason }) => ({ host, reason }))).toEqual([
      { host: 'evil.example.org', reason: 'private' },
      { host: 'metadata.internal', reason: 'host-name' },
      { host: 'site.example.org', reason: 'port' },
    ]);
    for (const refusal of proxy.refusals()) {
      expect(Object.keys(refusal).sort()).toEqual(['at', 'host', 'reason']);
      expect(typeof refusal.at).toBe('number');
    }
  });

  it('reports refusals, upstream errors and over-capacity through onEvent', async () => {
    const { proxy, events } = await start();
    const refused = await fetch('http://evil.example.org/secret?token=abc', {
      dispatcher: agent(proxy, false),
    });
    await refused.text();
    await exchange(proxy, connectLine('metadata.internal:443'));
    await exchange(proxy, connectLine('down.example.org:443'));
    const limited = await start({ maxConnections: 1 });
    const held = await openTunnel(limited.proxy, 'site.example.org:443');
    await exchange(
      limited.proxy,
      'GET http://site.example.org/ HTTP/1.1\r\nHost: site.example.org\r\n\r\n',
    );
    held.destroy();
    expect([...events, ...limited.events]).toEqual([
      {
        kind: 'refused',
        host: 'evil.example.org',
        reason: 'private',
        method: 'GET',
        via: 'absolute',
      },
      {
        kind: 'refused',
        host: 'metadata.internal',
        reason: 'host-name',
        method: 'CONNECT',
        via: 'connect',
      },
      { kind: 'upstream-error', host: 'down.example.org' },
      { kind: 'over-capacity' },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/secret|token|443/);
  });

  it('answers different refusals with byte-identical responses', async () => {
    const { proxy } = await start();
    const privateAddress = await exchange(proxy, connectLine('10.0.0.1:443'));
    const internalName = await exchange(proxy, connectLine('metadata.internal:443'));
    expect(privateAddress).toBe(internalName);
    expect(body(privateAddress)).toBe(REFUSED);
  });

  it('answers 502 when the pinned address cannot be reached', async () => {
    const { proxy } = await start();
    const response = await fetch('http://down.example.org/', { dispatcher: agent(proxy, false) });
    expect(response.status).toBe(502);
    await response.text();
    const tunnel = await exchange(proxy, connectLine('down.example.org:443'));
    expect(tunnel.startsWith('HTTP/1.1 502 ')).toBe(true);
  });

  it('close() ends open tunnels', async () => {
    const { proxy, dialed } = await start();
    const client = await openTunnel(proxy, 'site.example.org:443');
    const upstream = dialed[0];
    if (upstream === undefined) throw new Error('no upstream');
    await proxy.close();
    await Promise.all([closed(client), closed(upstream)]);
    expect(client.destroyed).toBe(true);
    expect(upstream.destroyed).toBe(true);
  });

  it('survives a client reset mid-tunnel and serves the next request', async () => {
    const { proxy, dialed } = await start();
    const client = await openTunnel(proxy, 'site.example.org:443');
    client.write('\x16\x03\x01');
    client.resetAndDestroy();
    const upstream = dialed[0];
    if (upstream === undefined) throw new Error('no upstream');
    await closed(upstream);
    const response = await fetch('http://site.example.org/', { dispatcher: agent(proxy, false) });
    expect(await response.text()).toBe('plain hello');
  });

  it('answers 503 over maxConnections', async () => {
    const { proxy } = await start({ maxConnections: 1 });
    const held = await openTunnel(proxy, 'site.example.org:443');
    const response = await exchange(
      proxy,
      'GET http://site.example.org/ HTTP/1.1\r\nHost: site.example.org\r\n\r\n',
    );
    expect(response.startsWith('HTTP/1.1 503 ')).toBe(true);
    held.destroy();
  });

  it('drops a request line that never finishes', async () => {
    const { proxy, dial } = await start({ connectTimeoutMs: 200 });
    const socket = connect(proxy.port, '127.0.0.1');
    socket.on('error', () => undefined);
    socket.write('CONNECT site.exam');
    await closed(socket);
    expect(dial).not.toHaveBeenCalled();
  });

  it('caps the request header size', async () => {
    const { proxy, dial } = await start();
    const response = await exchange(
      proxy,
      `GET http://site.example.org/ HTTP/1.1\r\nHost: site.example.org\r\nx-big: ${'a'.repeat(20000)}\r\n\r\n`,
    );
    expect(response.startsWith('HTTP/1.1 431 ')).toBe(true);
    expect(dial).not.toHaveBeenCalled();
  });

  it('answers 502 to an upstream status outside 100..999 and keeps serving', async () => {
    const { proxy, events } = await start();
    for (const line of ['HTTP/1.1 099 X', 'HTTP/1.1 000 X']) {
      const stop = await side(
        createNetServer((socket) => {
          socket.on('error', () => undefined);
          socket.once('data', () => socket.end(`${line}\r\n\r\n`));
        }),
      );
      try {
        const response = await fetch('http://side.example.org/', {
          dispatcher: agent(proxy, false),
        });
        expect(response.status, line).toBe(502);
        await response.text();
      } finally {
        await stop();
      }
    }
    const next = await fetch('http://site.example.org/', { dispatcher: agent(proxy, false) });
    expect(await next.text()).toBe('plain hello');
    expect(events.filter(({ kind }) => kind === 'upstream-error')).toHaveLength(2);
  });

  it('re-frames a chunked body so it cannot smuggle a second request', async () => {
    const { proxy } = await start();
    const seen: { method: string; url: string; body: string }[] = [];
    const upstreamSockets: Socket[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          body: Buffer.concat(chunks).toString('latin1'),
        });
        res.end('ok');
      });
    });
    server.on('connection', (socket) => upstreamSockets.push(socket));
    const stop = await side(server);
    try {
      const smuggled = 'GET /smuggled HTTP/1.1\r\nHost: side.example.org\r\n\r\n';
      for (const method of ['DELETE', 'GET']) {
        seen.length = 0;
        upstreamSockets.length = 0;
        const response = await exchange(
          proxy,
          `${method} http://side.example.org/a HTTP/1.1\r\nHost: side.example.org\r\n` +
            'Transfer-Encoding: chunked\r\n\r\n' +
            `${smuggled.length.toString(16)}\r\n${smuggled}\r\n0\r\n\r\n`,
        );
        expect(response.startsWith('HTTP/1.1 200 '), method).toBe(true);
        await Promise.all(upstreamSockets.map(closed));
        expect(seen, method).toEqual([{ method, url: '/a', body: smuggled }]);
      }
    } finally {
      await stop();
    }
  });

  it('refuses ambiguous request framing', async () => {
    const { proxy, dial, events } = await start();
    const head = 'POST http://site.example.org/ HTTP/1.1\r\nHost: site.example.org\r\n';
    for (const framing of [
      'Transfer-Encoding: chunked\r\nContent-Length: 5\r\n',
      'Transfer-Encoding: gzip\r\n',
      'Transfer-Encoding: gzip, chunked\r\n',
      'Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n',
    ]) {
      const response = await exchange(proxy, `${head}${framing}\r\n0\r\n\r\n`);
      expect(response.startsWith('HTTP/1.1 400 '), framing).toBe(true);
    }
    expect(dial).not.toHaveBeenCalled();
    // One event each, whether the parser or the proxy's own check refused the framing.
    expect(events).toEqual(Array(4).fill({ kind: 'malformed', status: 400 }));
  });

  it('frees the connection slot of a refused CONNECT that sent trailing bytes', async () => {
    const { proxy } = await start({ maxConnections: 1 });
    // Trailing bytes in the CONNECT packet itself (they land in `head`)...
    const response = await exchange(proxy, `${connectLine('10.0.0.1:443')}trailing!`);
    expect(response.startsWith('HTTP/1.1 403 ')).toBe(true);
    // ...and trailing bytes sent after the answer, which sit unread on the paused socket.
    const late = await new Promise<string>((resolve) => {
      const socket = connect(proxy.port, '127.0.0.1');
      let seen = '';
      socket.on('data', (chunk: Buffer) => {
        if (seen === '') socket.write('trailing!');
        seen += chunk.toString('latin1');
      });
      // The proxy may already have destroyed its side, so a reset here is expected.
      socket.on('error', () => undefined);
      socket.on('close', () => resolve(seen));
      socket.write(connectLine('10.0.0.1:443'));
    });
    expect(late.startsWith('HTTP/1.1 403 ')).toBe(true);
    await vi.waitFor(
      async () => {
        const next = await exchange(
          proxy,
          'GET http://site.example.org/ HTTP/1.1\r\nHost: site.example.org\r\n\r\n',
        );
        expect(next.startsWith('HTTP/1.1 200 ')).toBe(true);
      },
      { timeout: 2000, interval: 50 },
    );
  });

  it('sends exactly one Host, the checked target, whatever the client sent', async () => {
    const { proxy } = await start();
    const response = await exchange(
      proxy,
      'GET http://site.example.org/x HTTP/1.1\r\nHost: 10.0.0.1\r\nHost: 10.0.0.1\r\n\r\n',
    );
    expect(response.startsWith('HTTP/1.1 200 ')).toBe(true);
    const echo = /x-echo: (.*)\r\n/.exec(response)?.[1] ?? '{}';
    const raw = (JSON.parse(echo) as { raw: string[] }).raw;
    const hosts = raw.filter((_, i) => i % 2 === 1 && raw[i - 1]?.toLowerCase() === 'host');
    expect(hosts).toEqual(['site.example.org']);
  });

  it('closes a tunnel where neither side moves for idleTimeoutMs', async () => {
    const stop = await side(createNetServer((socket) => socket.on('error', () => undefined)));
    try {
      const { proxy, events, dialed } = await start({ idleTimeoutMs: 200 });
      const client = await openTunnel(proxy, 'side.example.org:443');
      client.on('error', () => undefined);
      await closed(client);
      const upstream = dialed[0];
      if (upstream === undefined) throw new Error('no upstream');
      await closed(upstream);
      expect(events).toContainEqual({ kind: 'idle-timeout', host: 'side.example.org' });
    } finally {
      await stop();
    }
  });

  it('closes an exchange whose upstream body stalls', async () => {
    const stop = await side(
      createNetServer((socket) => {
        socket.on('error', () => undefined);
        socket.once('data', () =>
          socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nfirst'),
        );
      }),
    );
    try {
      const { proxy, events } = await start({ idleTimeoutMs: 200 });
      const started = Date.now();
      const response = await exchange(
        proxy,
        'GET http://side.example.org/ HTTP/1.1\r\nHost: side.example.org\r\n\r\n',
      );
      expect(response.startsWith('HTTP/1.1 200 ')).toBe(true);
      expect(body(response)).toBe('first');
      expect(Date.now() - started).toBeLessThan(5000);
      expect(events).toContainEqual({ kind: 'idle-timeout', host: 'side.example.org' });
    } finally {
      await stop();
    }
  });

  it('keeps a slow but live tunnel open past idleTimeoutMs', async () => {
    const stop = await side(
      createNetServer((socket) => {
        socket.on('error', () => undefined);
        socket.pipe(socket);
      }),
    );
    try {
      // A byte every 50 ms against 400 ms: an 8x margin for a stalled CI event loop, and
      // 600 ms in all, so a timer that is never refreshed still fires.
      const { proxy, events } = await start({ idleTimeoutMs: 400 });
      const client = await openTunnel(proxy, 'side.example.org:443');
      let echoed = '';
      client.on('data', (chunk: Buffer) => (echoed += chunk.toString('latin1')));
      for (let i = 0; i < 12; i += 1) {
        client.write('x');
        await new Promise((done) => setTimeout(done, 50));
      }
      expect(client.closed).toBe(false);
      expect(echoed).toBe('x'.repeat(12));
      expect(events.filter(({ kind }) => kind === 'idle-timeout')).toEqual([]);
      client.destroy();
    } finally {
      await stop();
    }
  });

  it('refuses sockets past twice maxConnections at accept', async () => {
    const { proxy } = await start({ maxConnections: 1 });
    const sockets = Array.from({ length: 10 }, () => {
      const socket = connect(proxy.port, '127.0.0.1');
      socket.on('error', () => undefined);
      return socket;
    });
    try {
      await vi.waitFor(
        () => expect(sockets.filter((s) => s.closed).length).toBeGreaterThanOrEqual(8),
        {
          timeout: 3000,
          interval: 20,
        },
      );
      // The accepted two wait for a request line (connectTimeoutMs, 10 s); the rest are gone.
      await new Promise((done) => setTimeout(done, 200));
      expect(sockets.filter((s) => !s.closed)).toHaveLength(2);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });

  it('counts the refusals it does not keep', { timeout: 30000 }, async () => {
    const { proxy } = await start();
    const request = 'GET http://10.0.0.1/ HTTP/1.1\r\nHost: 10.0.0.1\r\n\r\n';
    for (let sent = 0; sent < 1005; sent += 50)
      await Promise.all(
        Array.from({ length: Math.min(50, 1005 - sent) }, () => exchange(proxy, request)),
      );
    expect(proxy.refusals()).toHaveLength(1000);
    expect(proxy.droppedRefusals()).toBe(5);
  });

  it('reports malformed requests by status alone', async () => {
    const { proxy, events } = await start();
    const answers = [
      await exchange(proxy, 'GET /x HTTP/1.1\r\nHost: site.example.org\r\n\r\n'),
      await exchange(proxy, 'NOT\x01A REQUEST\r\n\r\n'),
      await exchange(
        proxy,
        `GET http://site.example.org/ HTTP/1.1\r\nHost: site.example.org\r\nx-big: ${'a'.repeat(20000)}\r\n\r\n`,
      ),
    ];
    expect(answers.map((answer) => answer.slice(0, 12))).toEqual([
      'HTTP/1.1 400',
      'HTTP/1.1 400',
      'HTTP/1.1 431',
    ]);
    expect(events).toEqual([
      { kind: 'malformed', status: 400 },
      { kind: 'malformed', status: 400 },
      { kind: 'malformed', status: 431 },
    ]);
    // A client that resets mid-request is not a malformed request.
    const reset = connect(proxy.port, '127.0.0.1');
    reset.on('error', () => undefined);
    reset.write('GET http://site.exa');
    await new Promise((done) => setTimeout(done, 50));
    reset.resetAndDestroy();
    await new Promise((done) => setTimeout(done, 200));
    expect(events).toHaveLength(3);
  });

  it('listens on loopback addresses only', async () => {
    const resolver = new PinnedResolver({ lookup: async () => [] });
    for (const host of ['0.0.0.0', '::', '192.168.1.5', 'localhost'])
      await expect(startEgressProxy({ resolver, host }), host).rejects.toThrow(/loopback/);
  });

  it('listens on the port it is given, and refuses one out of range', async () => {
    const resolver = new PinnedResolver({ lookup: async () => [] });
    // A port known to be free a moment ago.
    const probe = createNetServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    const free = (probe.address() as AddressInfo).port;
    await new Promise<void>((done) => probe.close(() => done()));
    const proxy = await startEgressProxy({ resolver, port: free });
    try {
      expect(proxy.port).toBe(free);
      expect(proxy.url).toBe(`http://127.0.0.1:${free}`);
    } finally {
      await proxy.close();
    }
    for (const port of [-1, 65536, 1.5, Number.NaN])
      await expect(startEgressProxy({ resolver, port }), String(port)).rejects.toThrow(/port/);
  });
});

describe('formatProxyEvent', () => {
  it('writes one line per event', () => {
    expect(
      formatProxyEvent({
        kind: 'refused',
        host: 'metadata.internal',
        reason: 'host-name',
        method: 'CONNECT',
        via: 'connect',
      }),
    ).toBe(
      'widedoor event=egress_refused host=metadata.internal reason=host-name method=CONNECT via=connect',
    );
    expect(formatProxyEvent({ kind: 'upstream-error', host: 'down.example.org' })).toBe(
      'widedoor event=egress_upstream_error host=down.example.org',
    );
    expect(formatProxyEvent({ kind: 'over-capacity' })).toBe('widedoor event=egress_over_capacity');
    expect(formatProxyEvent({ kind: 'idle-timeout', host: 'site.example.org' })).toBe(
      'widedoor event=egress_idle_timeout host=site.example.org',
    );
    expect(formatProxyEvent({ kind: 'malformed', status: 431 })).toBe(
      'widedoor event=egress_malformed status=431',
    );
  });

  it('escapes the host so it cannot split or forge a line', () => {
    const line = formatProxyEvent({
      kind: 'refused',
      host: 'a.example.org\r\nwidedoor event=egress_refused host=x é',
      reason: 'private',
      method: 'GET',
      via: 'absolute',
    });
    expect(line).not.toMatch(/[\r\n]/);
    expect(line.match(/ event=/g)).toHaveLength(1);
    expect(line).toContain('host=a.example.org%0D%0Awidedoor%20event%3Degress_refused');
    expect(line).toContain('%C3%A9');
  });
});
