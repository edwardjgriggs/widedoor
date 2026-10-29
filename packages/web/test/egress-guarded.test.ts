import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromiumLaunchOptions } from '../src/context.js';
import { EgressRefusedError } from '../src/fetch.js';
import {
  createProxiedFetcher,
  guardedHop,
  guardedRequestGuard,
  hostedUserAgent,
} from '../src/egress/guarded.js';
import { PinnedResolver } from '../src/egress/resolver.js';
import { startEgressProxy, type DialFn, type EgressProxy } from '../src/egress/proxy.js';
import { makeTestCertificates } from './test-ca.js';

const PUBLIC = '93.184.215.14';
const answers: Record<string, string> = {
  'site.example.org': PUBLIC,
  'evil.example.org': '10.0.0.1',
};
const UA = hostedUserAgent('https://example.org/contact');

const certs = makeTestCertificates('site.example.org');
let httpServer: Server;
let tlsServer: TlsServer;
let httpPort = 0;
let tlsPort = 0;
const tlsSockets: Socket[] = [];
const seen: { url?: string | undefined; ua?: string | undefined }[] = [];

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    seen.push({ url: req.url, ua: req.headers['user-agent'] });
    if (req.url === '/to-internal') {
      res.writeHead(302, { location: 'http://evil.example.org/' }).end();
      return;
    }
    res.end('plain hello');
  });
  tlsServer = createTlsServer({ cert: certs.cert, key: certs.key }, (socket) => {
    tlsSockets.push(socket);
    socket.on('error', () => undefined);
    socket.once('data', (data) => {
      const ua = /user-agent: (.*)\r\n/i.exec(data.toString('latin1'))?.[1];
      seen.push({ ua });
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nsecure hello',
      );
    });
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
afterEach(async () => {
  await Promise.all(proxies.map((proxy) => proxy.close()));
  proxies = [];
  seen.length = 0;
});

const resolverFor = () =>
  new PinnedResolver({
    lookup: async (host) => {
      const address = answers[host];
      return address === undefined ? [] : [{ address, family: 4 }];
    },
  });

describe('hostedUserAgent', () => {
  it('names Widedoor, its version and the contact URL', () => {
    expect(UA).toMatch(
      /^Mozilla\/5\.0 \(compatible; Widedoor\/\d+\.\d+\.\d+[^;]*; \+https:\/\/example\.org\/contact\)$/,
    );
  });
});

describe('guardedRequestGuard', () => {
  const guard = guardedRequestGuard();
  const ask = (url: string) =>
    guard({ url: new URL(url), isNavigation: true, resourceType: 'document' });

  it('allows a public http(s) target', async () => {
    expect(await ask('https://site.example.org/')).toBe(true);
    expect(await ask('http://93.184.215.14/')).toBe(true);
  });

  it.each([
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://localhost/',
    'http://[::1]/',
    'http://site.example.org:8080/',
    'http://user:pw@site.example.org/',
  ])('blocks %s', async (url) => {
    expect(await ask(url)).toBe(false);
  });
});

describe('guardedHop', () => {
  it('refuses a policy violation and a private DNS answer', async () => {
    const hop = guardedHop(resolverFor());
    const start = new URL('https://site.example.org/');
    await expect(hop(new URL('http://10.0.0.1/'), start)).rejects.toBeInstanceOf(
      EgressRefusedError,
    );
    await expect(hop(new URL('http://evil.example.org/'), start)).rejects.toBeInstanceOf(
      EgressRefusedError,
    );
    await expect(hop(new URL('https://site.example.org/'), start)).resolves.toBeUndefined();
  });
});

describe('createProxiedFetcher', () => {
  async function setup() {
    const dial = vi.fn<DialFn>((address, port) => {
      if (address !== PUBLIC) throw new Error('unexpected dial');
      return connect(port === 443 ? tlsPort : httpPort, '127.0.0.1');
    });
    const resolver = resolverFor();
    const proxy = await startEgressProxy({ resolver, dial });
    proxies.push(proxy);
    const fetcher = createProxiedFetcher({
      proxyUrl: proxy.url,
      resolver,
      userAgent: UA,
      ca: certs.ca,
      maxRedirects: 3,
    });
    return { dial, fetcher };
  }

  it('goes through the proxy over http and sends the user agent', async () => {
    const { dial, fetcher } = await setup();
    const { response } = await fetcher('http://site.example.org/page');
    expect(await response.text()).toBe('plain hello');
    expect(dial).toHaveBeenCalledWith(PUBLIC, 80);
    expect(seen).toEqual([{ url: expect.stringContaining('/page'), ua: UA }]);
  });

  it('goes through the proxy over https with verification on', async () => {
    const { dial, fetcher } = await setup();
    const { response } = await fetcher('https://site.example.org/');
    expect(await response.text()).toBe('secure hello');
    expect(dial).toHaveBeenCalledWith(PUBLIC, 443);
    expect(seen).toEqual([{ ua: UA }]);
  });

  it('refuses a redirect to an internal address before it is requested', async () => {
    const { dial, fetcher } = await setup();
    await expect(fetcher('http://site.example.org/to-internal')).rejects.toMatchObject({
      name: 'EgressRefusedError',
      blockReason: 'private',
    });
    // Only the first hop was dialed; the redirect target never left.
    expect(dial).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });

  it('refuses a literal private address without touching the proxy', async () => {
    const { dial, fetcher } = await setup();
    await expect(fetcher('http://10.0.0.1/')).rejects.toBeInstanceOf(EgressRefusedError);
    expect(dial).not.toHaveBeenCalled();
  });
});

describe('chromiumLaunchOptions', () => {
  it('is unchanged without a proxy', () => {
    expect(chromiumLaunchOptions()).toEqual({ headless: true, chromiumSandbox: true });
    expect(chromiumLaunchOptions({ unsafeNoSandbox: true })).toEqual({
      headless: true,
      chromiumSandbox: false,
    });
  });

  it('routes through the proxy, bypasses nothing and switches off the side channels', () => {
    const options = chromiumLaunchOptions({ proxy: { server: 'http://127.0.0.1:3128' } });
    expect(options.proxy).toEqual({ server: 'http://127.0.0.1:3128', bypass: '<-loopback>' });
    expect(options.args).toEqual([
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-features=DnsOverHttps',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ]);
    expect(options.chromiumSandbox).toBe(true);
  });

  it('excludes an IPv6 proxy host without brackets (Chromium matches the bare address)', () => {
    const options = chromiumLaunchOptions({ proxy: { server: 'http://[::1]:3128' } });
    expect(options.args).toContain('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ::1');
  });

  it.each(['http://proxy.internal:3128', 'http://localhost:3128', 'not a url'])(
    'throws for a proxy that is not an IP literal: %s',
    (server) => {
      expect(() => chromiumLaunchOptions({ proxy: { server } })).toThrow();
    },
  );
});
