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
import {
  PROXY_REFUSED_STATUS,
  startEgressProxy,
  type DialFn,
  type EgressProxy,
} from '../src/egress/proxy.js';
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
    if (req.url === '/forbidden') {
      res.writeHead(403).end('origin says no');
      return;
    }
    if (req.url === '/forged') {
      // An origin claiming the proxy's refusal: the proxy drops its Proxy-* fields.
      res.writeHead(403, { 'proxy-status': PROXY_REFUSED_STATUS }).end('origin says no');
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

const resolverFor = (lookups: string[] = []) =>
  new PinnedResolver({
    lookup: async (host) => {
      lookups.push(host);
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

  it('without a resolver checks the policy only, and looks nothing up', async () => {
    const hop = guardedHop();
    const start = new URL('https://site.example.org/');
    await expect(hop(new URL('http://10.0.0.1/'), start)).rejects.toMatchObject({
      blockReason: 'private',
    });
    // A name no resolver knows passes: the proxy resolves it, or refuses it.
    await expect(hop(new URL('http://nowhere.example.org/'), start)).resolves.toBeUndefined();
  });
});

describe('createProxiedFetcher', () => {
  /** A proxy and a fetcher; the fetcher shares the proxy's resolver unless `childDns` is false. */
  async function setup({ childDns = true } = {}) {
    const dial = vi.fn<DialFn>((address, port) => {
      if (address !== PUBLIC) throw new Error('unexpected dial');
      return connect(port === 443 ? tlsPort : httpPort, '127.0.0.1');
    });
    const lookups: string[] = [];
    const resolver = resolverFor(lookups);
    const proxy = await startEgressProxy({ resolver, dial });
    proxies.push(proxy);
    const refused: { host: string; reason: string }[] = [];
    const fetcher = createProxiedFetcher({
      proxyUrl: proxy.url,
      ...(childDns ? { resolver } : {}),
      userAgent: UA,
      ca: certs.ca,
      maxRedirects: 3,
      onRefused: (hop, e) => void refused.push({ host: hop.hostname, reason: e.reason }),
    });
    return { dial, fetcher, proxy, lookups, refused };
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

  describe('without a resolver, as in the scan machine', () => {
    it('does no DNS of its own: a name reaches the proxy, which resolves it once', async () => {
      const { dial, fetcher, lookups } = await setup({ childDns: false });
      expect(await (await fetcher('http://site.example.org/page')).response.text()).toBe(
        'plain hello',
      );
      expect(await (await fetcher('https://site.example.org/')).response.text()).toBe(
        'secure hello',
      );
      expect(dial.mock.calls).toEqual([
        [PUBLIC, 80],
        [PUBLIC, 443],
      ]);
      // Every lookup is the proxy's (the pin is cached, so one per name).
      expect(lookups).toEqual(['site.example.org']);
    });

    it.each([
      ['http', 'a name that does not resolve', 'http://nowhere.example.org/robots.txt'],
      ['https', 'a name that does not resolve', 'https://nowhere.example.org/robots.txt'],
      ['http', 'a name with a private address', 'http://evil.example.org/'],
      ['https', 'a name with a private address', 'https://evil.example.org/'],
    ])('over %s, refuses %s when the proxy does, never as a response', async (_, __, url) => {
      const { dial, fetcher, proxy, refused } = await setup({ childDns: false });
      const error = await fetcher(url).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EgressRefusedError);
      expect(error).toMatchObject({ reason: 'proxy', blockReason: undefined });
      const host = new URL(url).hostname;
      expect(refused).toEqual([{ host, reason: 'proxy' }]);
      expect(proxy.refusals().map((r) => r.host)).toEqual([host]);
      expect(dial).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
    });

    it('refuses a redirect the proxy refuses, after only the first hop was dialed', async () => {
      const { dial, fetcher, refused } = await setup({ childDns: false });
      await expect(fetcher('http://site.example.org/to-internal')).rejects.toMatchObject({
        name: 'EgressRefusedError',
        reason: 'proxy',
      });
      expect(dial).toHaveBeenCalledTimes(1);
      expect(refused).toEqual([{ host: 'evil.example.org', reason: 'proxy' }]);
    });

    it("passes an origin's own 403 through as a response, even one claiming the proxy's field", async () => {
      const { fetcher, refused } = await setup({ childDns: false });
      for (const path of ['/forbidden', '/forged']) {
        const { response } = await fetcher(`http://site.example.org${path}`);
        expect(response.status, path).toBe(403);
        expect(response.headers.get('proxy-status'), path).toBeNull();
        expect(await response.text(), path).toBe('origin says no');
      }
      expect(refused).toEqual([]);
    });
  });
});

describe('chromiumLaunchOptions', () => {
  it('is unchanged without a proxy', () => {
    expect(chromiumLaunchOptions()).toEqual({
      headless: true,
      chromiumSandbox: true,
      env: expect.any(Object),
    });
    expect(chromiumLaunchOptions({ unsafeNoSandbox: true })).toEqual({
      headless: true,
      chromiumSandbox: false,
      env: expect.any(Object),
    });
  });

  it('gives Chromium no AI provider setting from the parent environment (3b.7 fix 1)', () => {
    const env = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-api03-FAKE-CHROMIUM-KEY',
      OPENAI_API_KEY: 'sk-proj-FAKE-CHROMIUM-KEY',
      Openai_Org_Id: 'org-x',
      UNSET: undefined,
    };
    for (const options of [{}, { proxy: { server: 'http://127.0.0.1:3128' } }]) {
      const launch = chromiumLaunchOptions(options, env);
      expect(launch.env).toEqual({ PATH: '/usr/bin' });
    }
    // The default is this process's environment, filtered the same way.
    expect(
      Object.keys(chromiumLaunchOptions().env).filter((k) => /^(anthropic|openai)_/i.test(k)),
    ).toEqual([]);
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
