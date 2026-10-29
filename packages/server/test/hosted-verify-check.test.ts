import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PinnedResolver, hostedUserAgent, startEgressProxy } from '@widedoor/web/egress';
import { INPUT_REFUSED, VerifyResultSchema } from '../src/hosted/protocol.ts';
import {
  MAX_META_TAG_CHARS,
  NOT_HTTPS,
  NO_FILE_MATCH,
  NO_META_MATCH,
  OTHER_HOST,
  OTHER_PORT,
  PAGE_MAX_BYTES,
  TOO_MANY_REDIRECTS,
  WELL_KNOWN_MAX_BYTES,
  WELL_KNOWN_PATH,
  hasVerificationMeta,
  runVerification,
  type VerificationOptions,
} from '../src/hosted/verify-check.ts';
import { makeTestCertificates } from '../../web/test/test-ca.ts';

/*
 * The scan machine's side of domain verification: the well-known file and the
 * meta tag, fetched over https through an in-process egress proxy with a fake
 * resolver. The site is a local HTTPS server with a throwaway CA's certificate
 * (verification stays on); any connection to another address lands on a
 * "private" server that must stay untouched.
 */

const HOST = 'site.example.org';
const PUBLIC = '93.184.215.14';
const OTHER_PUBLIC = '93.184.215.15';
const TOKEN = '0123456789abcdef0123456789abcdef'; // gitleaks:allow (a test fixture, not a secret)
const CONTACT = 'https://example.org/contact';
const NAMES: Record<string, string> = {
  [HOST]: PUBLIC,
  'other.example.org': OTHER_PUBLIC,
  'evil.example.org': '10.0.0.1',
};

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const certs = makeTestCertificates(HOST);
const routes = new Map<string, Handler>();
/** Requests the https site got, as `path user-agent`. */
const seen: string[] = [];
/** Requests the plain http site got. */
const plain: string[] = [];
/** Connections that reached anything but the site. */
let leaks = 0;
const dials: string[] = [];
const sockets: Socket[] = [];

const site = createHttpsServer({ cert: certs.cert, key: certs.key }, (req, res) => {
  seen.push(`${req.url ?? ''} ${req.headers['user-agent'] ?? ''}`);
  const route = routes.get(req.url ?? '');
  if (route) return route(req, res);
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
});
const http = createHttpServer((req, res) => {
  plain.push(req.url ?? '');
  res.end('plain');
});
const other = createHttpServer((_req, res) => res.end('PRIVATE'));
other.on('connection', () => (leaks += 1));

const port = (server: { address(): unknown }) => (server.address() as AddressInfo).port;
const listen = (server: { listen(port: number, host: string, done: () => void): unknown }) =>
  new Promise<void>((done) => void server.listen(0, '127.0.0.1', done));

beforeAll(async () => {
  for (const server of [site, http, other]) {
    server.on('connection', (socket: Socket) => sockets.push(socket));
    await listen(server);
  }
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all([site, http, other].map((server) => new Promise((done) => server.close(done))));
});

const proxies: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  // Not one verification fetch ever asks for robots.txt (ledger R43).
  expect(seen.some((line) => line.startsWith('/robots.txt'))).toBe(false);
  routes.clear();
  seen.length = 0;
  plain.length = 0;
  dials.length = 0;
});

/** runVerification through a fresh proxy and resolver; the log lines are kept. */
async function verify(extra: Partial<VerificationOptions> = {}) {
  const resolver = new PinnedResolver({
    lookup: (host) => {
      const address = NAMES[host];
      return Promise.resolve(address === undefined ? [] : [{ address, family: 4 as const }]);
    },
  });
  const proxy = await startEgressProxy({
    resolver,
    dial: (address, to) => {
      dials.push(`${address}:${to}`);
      if (address !== PUBLIC) return connect(port(other), '127.0.0.1');
      return connect(to === 443 ? port(site) : port(http), '127.0.0.1');
    },
  });
  proxies.push(proxy);
  const log: string[] = [];
  const result = await runVerification({
    host: HOST,
    token: TOKEN,
    proxyUrl: proxy.url,
    resolver,
    contactUrl: CONTACT,
    signal: AbortSignal.timeout(60_000),
    ca: certs.ca,
    log: (line) => void log.push(line),
    ...extra,
  });
  return { result, log };
}

const text =
  (body: string, type = 'text/plain', status = 200): Handler =>
  (_req, res) =>
    void res.writeHead(status, { 'content-type': type }).end(body);
const page = (head: string) =>
  text(`<!doctype html><html><head>${head}</head></html>`, 'text/html');
const redirect =
  (location: string): Handler =>
  (_req, res) =>
    void res.writeHead(302, { location }).end();
const meta = (token = TOKEN) => `<meta name="widedoor-verification" content="${token}">`;

describe('runVerification', () => {
  it('verifies by the well-known file alone, and asks for nothing else', async () => {
    routes.set(WELL_KNOWN_PATH, text(`${TOKEN}\n`));
    const { result } = await verify();
    expect(result).toEqual({ status: 'verified', tried: [{ method: 'well_known', ok: true }] });
    expect(VerifyResultSchema.safeParse(result).success).toBe(true);
    expect(seen).toEqual([`${WELL_KNOWN_PATH} ${hostedUserAgent(CONTACT)}`]);
    expect(dials).toEqual([`${PUBLIC}:443`]);
    expect(leaks).toBe(0);
  });

  it('verifies by the meta tag alone once the file is missing', async () => {
    routes.set('/', page(meta()));
    const { result } = await verify();
    expect(result).toEqual({
      status: 'verified',
      tried: [
        { method: 'well_known', ok: false, reason: 'the site answered 404' },
        { method: 'meta_tag', ok: true },
      ],
    });
    expect(seen.map((line) => line.split(' ')[0])).toEqual([WELL_KNOWN_PATH, '/']);
  });

  it('fails both methods for a wrong token, quoting none of the content', async () => {
    const wrong = 'f'.repeat(32);
    routes.set(WELL_KNOWN_PATH, text(`${wrong}\n`));
    routes.set('/', page(meta(wrong)));
    const { result } = await verify();
    expect(result).toEqual({
      status: 'not_verified',
      tried: [
        { method: 'well_known', ok: false, reason: NO_FILE_MATCH },
        { method: 'meta_tag', ok: false, reason: NO_META_MATCH },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(wrong);
  });

  it('takes the first line of the file, trimmed, and follows a redirect on the same host', async () => {
    routes.set(WELL_KNOWN_PATH, redirect('/elsewhere.txt'));
    routes.set('/elsewhere.txt', text(`  ${TOKEN}  \r\nsecond line\n`));
    const { result } = await verify();
    expect(result.status).toBe('verified');
  });

  it('verifies a meta tag with its attributes reversed, single quotes and upper case', async () => {
    routes.set('/', page(`<META CONTENT='${TOKEN}' Name='widedoor-verification' />`));
    expect((await verify()).result.status).toBe('verified');
  });

  it('does not see a meta tag past the first 1 MiB of the page', async () => {
    routes.set('/', text(`<!--${'x'.repeat(PAGE_MAX_BYTES)}-->${meta()}`, 'text/html'));
    const { result } = await verify();
    expect(result).toMatchObject({
      status: 'not_verified',
      tried: [{ method: 'well_known' }, { method: 'meta_tag', ok: false, reason: NO_META_MATCH }],
    });
  });

  it('cuts a well-known file at 4 KiB and fails it cleanly', async () => {
    routes.set(WELL_KNOWN_PATH, text(`${TOKEN}${'x'.repeat(WELL_KNOWN_MAX_BYTES * 4)}`));
    const { result } = await verify();
    expect(result).toMatchObject({
      status: 'not_verified',
      tried: [{ method: 'well_known', ok: false, reason: NO_FILE_MATCH }, { method: 'meta_tag' }],
    });
  });

  it('fails a redirect to a private address with the egress reason, before any request', async () => {
    routes.set(WELL_KNOWN_PATH, redirect('https://evil.example.org/widedoor.txt'));
    const { result, log } = await verify();
    expect(result).toMatchObject({
      tried: [{ method: 'well_known', ok: false, reason: 'private address' }, {}],
    });
    expect(leaks).toBe(0);
    expect(dials.every((dial) => dial.startsWith(`${PUBLIC}:`))).toBe(true);
    expect(log).toContain('widedoor event=fetch_refused host=evil.example.org reason=private');
  });

  it('fails a redirect to another public host without requesting it', async () => {
    routes.set(WELL_KNOWN_PATH, redirect('https://other.example.org/.well-known/widedoor.txt'));
    const { result } = await verify();
    expect(result).toMatchObject({
      tried: [{ method: 'well_known', ok: false, reason: OTHER_HOST }, {}],
    });
    expect(dials).not.toContain(`${OTHER_PUBLIC}:443`);
    expect(leaks).toBe(0);
  });

  it('fails a redirect from https to http on the same host without requesting it', async () => {
    routes.set(WELL_KNOWN_PATH, redirect(`http://${HOST}${WELL_KNOWN_PATH}`));
    routes.set('/', redirect(`http://${HOST}/`));
    const { result } = await verify();
    expect(result).toEqual({
      status: 'not_verified',
      tried: [
        { method: 'well_known', ok: false, reason: NOT_HTTPS },
        { method: 'meta_tag', ok: false, reason: NOT_HTTPS },
      ],
    });
    expect(plain).toEqual([]);
  });

  it('fails a redirect to another port on the same host without requesting it', async () => {
    // Port 80 passes the egress policy; only the same-port rule stops it.
    routes.set(WELL_KNOWN_PATH, redirect(`https://${HOST}:80${WELL_KNOWN_PATH}`));
    const { result } = await verify();
    expect(result).toMatchObject({
      tried: [{ method: 'well_known', ok: false, reason: OTHER_PORT }, {}],
    });
    expect(plain).toEqual([]);
    expect(dials).not.toContain(`${PUBLIC}:80`);
  });

  it('stops after 3 redirects', async () => {
    routes.set(WELL_KNOWN_PATH, redirect('/a'));
    routes.set('/a', redirect('/b'));
    routes.set('/b', redirect('/c'));
    routes.set('/c', redirect('/d'));
    routes.set('/d', text(TOKEN));
    const { result } = await verify();
    expect(result).toMatchObject({
      tried: [{ method: 'well_known', ok: false, reason: TOO_MANY_REDIRECTS }, {}],
    });
    expect(seen.map((line) => line.split(' ')[0])).not.toContain('/d');
  });

  it('refuses a bad host or token before anything is requested', async () => {
    for (const extra of [{ host: '10.0.0.1' }, { host: 'Site.Example.org' }, { token: 'abc' }]) {
      const { result } = await verify(extra);
      expect(result).toEqual({ status: 'failed', error: INPUT_REFUSED });
    }
    expect(dials).toEqual([]);
  });

  it('never asks for robots.txt, even when the site disallows everything', async () => {
    routes.set('/robots.txt', text('User-agent: *\nDisallow: /\n'));
    routes.set(WELL_KNOWN_PATH, text(TOKEN));
    expect((await verify()).result.status).toBe('verified');
    expect(seen.map((line) => line.split(' ')[0])).toEqual([WELL_KNOWN_PATH]);
  });
});

describe('hasVerificationMeta', () => {
  it.each([
    [`<meta name="widedoor-verification" content="${TOKEN}">`, true],
    [`<meta content="${TOKEN}" name="widedoor-verification">`, true],
    [`<meta\nname='widedoor-verification'\ncontent='${TOKEN}'/>`, true],
    [`<META NAME="WIDEDOOR-VERIFICATION" CONTENT="${TOKEN}">`, true],
    [`<meta name="widedoor-verification" content="${TOKEN.toUpperCase()}">`, false],
    [`<meta name="widedoor-verification" content="${TOKEN}x">`, false],
    [`<meta name="other" content="${TOKEN}">`, false],
    [`<metadata name="widedoor-verification" content="${TOKEN}">`, false],
    [`<meta name="widedoor-verification" content="${TOKEN}"`, false],
    [`<p>widedoor-verification ${TOKEN}</p>`, false],
  ])('%s gives %s', (html, expected) => {
    expect(hasVerificationMeta(html, TOKEN)).toBe(expected);
  });

  const head = (inner: string, body = '') =>
    `<!doctype html><html><head><meta charset="utf-8">${inner}</head><body>${body}</body></html>`;
  const tag = `<meta name="widedoor-verification" content="${TOKEN}">`;

  it.each([
    ['inside a comment', head(`<!-- ${tag} -->`)],
    ['inside script JSON', head(`<script type="application/json">{"x":"${tag}"}</script>`)],
    ["inside another tag's attribute value", head(`<link rel="x" title='${tag}'>`)],
    ['inside a quoted value holding >', head(`<link title="a > ${tag}">`)],
    ['inside a title', head(`<title>${tag}</title>`)],
    ['inside a noscript', head(`<noscript>${tag}</noscript>`)],
    ['inside a template', head(`<template>${tag}</template>`)],
    ['after <body>', head('', tag)],
    ['after </head>', `<html><head></head>${tag}<body></body></html>`],
    ['in a page with no head, after <body>', `<body>${tag}</body>`],
    ['after a <div> on a page with no <body>', `<html><head></head><div>x</div>${tag}`],
    ['after a <div> in the head itself', head(`<div>x</div>${tag}`)],
    ['inside a noframes', head(`<noframes>${tag}</noframes>`)],
    ['inside a noembed', head(`<noembed>${tag}</noembed>`)],
    ['inside an xmp', `<xmp>${tag}</xmp>`],
    ['after a <?x bogus comment', head(`<?x ${tag}`)],
    ['inside a style', head(`<style>${tag}</style>`)],
    ['inside a textarea', head(`<textarea>${tag}</textarea>`)],
  ])('does not verify a tag %s', (_, html) => {
    expect(hasVerificationMeta(html, TOKEN)).toBe(false);
  });

  it('verifies a tag in a head that also holds scripts, styles and comments', () => {
    const html = head(
      `<!-- <body> -->
      <script>if (a < b && c > d) document.write("</head><body>");</script>
      <style>body > p { color: red }</style>
      <title>Home</title>
      ${tag}`,
      '<p>hi</p>',
    );
    expect(hasVerificationMeta(html, TOKEN)).toBe(true);
  });

  it('skips a meta tag longer than 2 KiB', () => {
    const pad = ' '.repeat(MAX_META_TAG_CHARS);
    expect(
      hasVerificationMeta(`<meta name="widedoor-verification"${pad}content="${TOKEN}">`, TOKEN),
    ).toBe(false);
  });

  // Each of these took minutes with the unanchored attribute pattern; 5 s is generous.
  // They are stopped by the 2 KiB tag cap or an unclosed tag before the attribute regex
  // runs, so the regex's own lookbehind is guarded by the cap, not proved by these tests.
  it('reads one tag of 1 MiB of name characters quickly', () => {
    const began = performance.now();
    expect(hasVerificationMeta(`<head><meta ${'a'.repeat(PAGE_MAX_BYTES)}>`, TOKEN)).toBe(false);
    expect(hasVerificationMeta(`<head><meta ${'a'.repeat(PAGE_MAX_BYTES)}`, TOKEN)).toBe(false);
    expect(performance.now() - began).toBeLessThan(5_000);
  });

  it('reads 1 MiB of <meta starts quickly', () => {
    const began = performance.now();
    const starts = '<meta '.repeat(Math.ceil(PAGE_MAX_BYTES / 6));
    expect(hasVerificationMeta(starts, TOKEN)).toBe(false);
    expect(hasVerificationMeta(`<head>${'<meta a=b>'.repeat(PAGE_MAX_BYTES / 10)}`, TOKEN)).toBe(
      false,
    );
    expect(hasVerificationMeta(`<head>${'<!--'.repeat(PAGE_MAX_BYTES / 4)}`, TOKEN)).toBe(false);
    expect(performance.now() - began).toBeLessThan(5_000);
  });
});
