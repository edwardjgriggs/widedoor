import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FindingSchema,
  buildChecklist,
  errataFrom,
  getProfile,
  loadReviews,
  loadStandardsData,
  recordReview,
  reviewChecklist,
  rollup,
  type ReviewReport,
} from '@widedoor/core';
import {
  WebScanner,
  chromiumLaunchOptions,
  createFetcher,
  createHardenedContext,
  launchChromium,
  robotsPolicy,
  scanWeb,
} from '../src/index.ts';
import { reviewHashOf } from '../src/review-hash.ts';
import { page, serve, type TestServer } from './server.ts';

/*
 * Browser tests: Chromium against servers on 127.0.0.1 and temp files only,
 * never the internet. Chromium runs with its OS sandbox. A host that cannot
 * start it can set WIDEDOOR_TEST_UNSAFE_NO_SANDBOX=1; the sandbox assertion
 * is then reported as skipped, so that state is never silent.
 */

const TIMEOUT = 60_000;
const base = { unsafeNoSandbox: process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1' };
let site: TestServer;
let other: TestServer;
let tmp: string;

const FAIL_PAGE = page(
  'Fail',
  '<h1>Fail</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40">',
);
const REFLOW_PAGE = page(
  'Reflow',
  '<h1>Reflow</h1><p class="m">Only on small screens</p>',
  '<style>.m{display:none;color:#999;background:#aaa}@media (max-width:400px){.m{display:block}}</style>',
);

beforeAll(async () => {
  other = await serve(() => ({
    '/x.html': { body: page('Other', '<p>other</p>') },
    '/report': { body: '%PDF-1.7', type: 'application/pdf' },
  }));
  site = await serve((o) => ({
    '/a.html': {
      body: page(
        'A',
        `<a href="/b.html">b</a> <a href="/c.html">c</a> <a href="/a.html#frag">self</a> <a href="${o}/c.html#x">c again</a> <a href="${other.origin}/x.html">other</a> <a href="mailto:x@example.com">mail</a>`,
      ),
    },
    '/gate.html': {
      body: page('Gate', '<a href="/walled/in.html">in</a> <a href="/d.html">d</a>'),
    },
    '/walled/in.html': { body: page('Walled', '<p>walled</p>') },
    '/walled/via.html': { body: page('Via', '<p>via</p>') },
    '/open': { status: 302, body: '', headers: { location: '/walled/via.html' } },
    '/b.html': { body: page('B', '<a href="/d.html">d</a> <a href="/e.html">e</a>') },
    '/c.html': { body: page('C', '<a href="/download">download</a>') },
    '/d.html': { body: page('D', '<p>d</p>') },
    '/e.html': { body: page('E', '<p>e</p>') },
    '/download': {
      body: 'binary',
      type: 'application/octet-stream',
      headers: { 'content-disposition': 'attachment; filename="x.bin"' },
    },
    '/fail.html': { body: FAIL_PAGE },
    // A fresh CSRF field and script nonce on every request, as many sites serve them.
    '/tokens.html': {
      body: () => {
        const token = randomBytes(16).toString('hex');
        return page(
          'Tokens',
          `<h1>Sign up</h1><form><input type="hidden" name="csrf" value="${token}"><label>Name <input name="name"></label><button>Send</button></form>`,
          `<script nonce="${token}">window.started = '${token}';</script>`,
        );
      },
    },
    '/reflow.html': { body: REFLOW_PAGE },
    '/auth.html': { body: page('Auth', '<p>auth</p>') },
    '/pdf-links.html': {
      body: page('PDF links', '<a href="/doc.pdf">doc</a> <a href="/UPPER.PDF?v=1">upper</a>'),
    },
    '/doc.pdf': { body: '%PDF-1.7', type: 'application/pdf' },
    // A PDF whose URL does not say so: only the browser's response does.
    '/report': { body: '%PDF-1.7', type: 'application/pdf; charset=binary' },
    '/to-other-report': {
      status: 302,
      body: '',
      headers: { location: `${other.origin}/report` },
    },
    '/many-pdfs.html': {
      body: page(
        'Many PDFs',
        // Hidden, so axe has little to check while the link scan still sees every link.
        `<div hidden>${Array.from({ length: 6_000 }, (_, i) => `<a href="/f/${i}.pdf">f${i}</a>`).join(' ')}</div>`,
      ),
    },
    '/to-d': { status: 302, body: '', headers: { location: '/d.html' } },
    '/to-d-again': { status: 302, body: '', headers: { location: '/d.html' } },
    '/to-other': { status: 302, body: '', headers: { location: `${other.origin}/x.html` } },
    '/hang.html': {
      body: page(
        'Hang',
        '<p>hang</p>',
        "<script>addEventListener('load', () => setTimeout(() => { for (;;) {} }, 0));</script>",
      ),
    },
    '/away.html': {
      body: page(
        'Away',
        '<p>away</p>',
        "<script>addEventListener('load', () => setTimeout(() => { location.href = '/d.html'; }, 0));</script>",
      ),
    },
    '/popup.html': {
      body: page(
        'Popup',
        '<a id="blank" href="/popped-link" target="_blank">open</a>',
        "<script>addEventListener('load', () => { window.open('/popped'); document.getElementById('blank').click(); });</script>",
      ),
    },
    '/popped': { body: page('Popped', '<p>popped</p>') },
    '/popped-link': { body: page('Popped', '<p>popped</p>') },
    '/sitemap.xml': {
      type: 'application/xml',
      body: `<urlset><url><loc>${o}/d.html</loc></url><url><loc>${o}/e.html</loc></url><url><loc>${other.origin}/x.html</loc></url></urlset>`,
    },
    '/sw.html': {
      body: page(
        'SW',
        '<p>sw</p>',
        `<script>navigator.serviceWorker.register('/sw.js').then(() => { document.title = 'registered'; }, () => { document.title = 'rejected'; });</script>`,
      ),
    },
    '/sw.js': { type: 'text/javascript', body: 'self.addEventListener("fetch", () => {});' },
    '/ws.html': {
      body: page(
        'WS',
        '<p>ws</p>',
        `<script>const ws = new WebSocket('${o.replace('http', 'ws')}/socket'); ws.onclose = () => { document.title = 'closed'; };</script>`,
      ),
    },
  }));
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-web-'));
}, TIMEOUT);

afterAll(async () => {
  await site.close();
  await other.close();
  rmSync(tmp, { recursive: true, force: true });
});

const scanned = (r: Awaited<ReturnType<typeof scanWeb>>) =>
  r.pages.map((p) => new URL(p.url).pathname);
const hitsOf = (server: TestServer, path: string) =>
  server.hits.filter((h) => h.path === path).length;

describe('sandbox', () => {
  it('maps unsafeNoSandbox to the Chromium sandbox flag', () => {
    expect(chromiumLaunchOptions()).toEqual({
      headless: true,
      chromiumSandbox: true,
      env: expect.any(Object),
    });
    expect(chromiumLaunchOptions({ unsafeNoSandbox: true }).chromiumSandbox).toBe(false);
  });

  it.skipIf(base.unsafeNoSandbox)(
    'starts Chromium without --no-sandbox',
    async () => {
      const server = await chromium.launchServer(chromiumLaunchOptions(base));
      try {
        expect(server.process().spawnargs).not.toContain('--no-sandbox');
      } finally {
        await server.close();
      }
    },
    TIMEOUT,
  );

  it(
    'records a warning in the run metadata when the sandbox is off',
    async () => {
      const r = await scanWeb({ urls: [`${site.origin}/d.html`] }, { unsafeNoSandbox: true });
      expect(r.warnings).toEqual([expect.stringMatching(/without its OS sandbox/)]);
      const safe = await scanWeb({ urls: [`${site.origin}/d.html`] }, base);
      expect(safe.warnings).toEqual(base.unsafeNoSandbox ? [expect.any(String)] : []);
    },
    TIMEOUT,
  );
});

describe('scope and crawl', () => {
  it(
    'crawls same-origin links only, deduped by normalized URL',
    async () => {
      const r = await scanWeb({ urls: [`${site.origin}/a.html`], crawl: { maxPages: 20 } }, base);
      // With concurrency 2, discovery order depends on which page finishes first.
      expect(scanned(r).sort()).toEqual([
        '/a.html',
        '/b.html',
        '/c.html',
        '/d.html',
        '/download',
        '/e.html',
      ]);
      expect(other.hits).toEqual([]);
      expect(r.truncated).toBe(false);
      expect(r.assets).toHaveLength(5);
      const download = r.pages.find((p) => p.url.endsWith('/download'));
      expect(download?.error?.code).toBe('navigation-failed');
      expect(r.errors.map((e) => e.code)).toEqual(['navigation-failed']);
    },
    TIMEOUT,
  );

  it(
    'stops at maxPages',
    async () => {
      const r = await scanWeb(
        { urls: [`${site.origin}/a.html`], crawl: { maxPages: 2 } },
        { ...base, concurrency: 1 },
      );
      expect(scanned(r)).toEqual(['/a.html', '/b.html']);
      expect(r.truncated).toBe(true);
      // A crawl stopped by the cap is a scope gap, not listed pages left out.
      expect(r.unscannedListed).toBe(0);
      expect(r.maxPages).toBe(2);
    },
    TIMEOUT,
  );

  it(
    'counts listed pages the page cap left unscanned (no crawl)',
    async () => {
      const r = await scanWeb(
        {
          urls: [`${site.origin}/a.html`, `${site.origin}/b.html`, `${site.origin}/c.html`],
          maxPages: 1,
        },
        { ...base, concurrency: 1 },
      );
      expect(scanned(r)).toEqual(['/a.html']);
      expect(r.unscannedListed).toBe(2);
      expect(r.scopeGaps).toContain(
        '2 listed page(s) were not scanned: at most 1 pages are scanned per run',
      );
    },
    TIMEOUT,
  );

  it(
    'lets crawl.maxPages take precedence over the top-level maxPages',
    async () => {
      const r = await scanWeb(
        { urls: [`${site.origin}/a.html`], maxPages: 5, crawl: { maxPages: 1 } },
        { ...base, concurrency: 1 },
      );
      expect(r.maxPages).toBe(1);
      expect(scanned(r)).toEqual(['/a.html']);
      expect(r.unscannedListed).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'without crawl scans only the URL list and the same-origin sitemap entries',
    async () => {
      const r = await scanWeb(
        {
          urls: [`${site.origin}/a.html`, `${site.origin}/a.html#again`],
          sitemap: `${site.origin}/sitemap.xml`,
        },
        base,
      );
      expect(scanned(r)).toEqual(['/a.html', '/d.html', '/e.html']);
      expect(other.hits).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'records an unreadable sitemap and an unsupported URL as scan errors',
    async () => {
      const r = await scanWeb(
        { urls: ['javascript:alert(1)', 'not a url'], sitemap: `${site.origin}/missing.xml` },
        base,
      );
      expect(r.pages.map((p) => p.error?.code)).toEqual(['unsupported-url']);
      expect(r.errors.map((e) => e.code).sort()).toEqual([
        'sitemap-failed',
        'unsupported-url',
        'unsupported-url',
      ]);
      expect(r.errors.find((e) => e.code === 'sitemap-failed')?.message).toMatch(/HTTP 404/);
    },
    TIMEOUT,
  );

  it(
    'skips a page that redirects to another origin and records why',
    async () => {
      const r = await scanWeb({ urls: [`${site.origin}/to-other`] }, base);
      expect(r.assets).toEqual([]);
      expect(r.findings).toEqual([]);
      expect(r.skipped).toEqual([
        {
          url: `${site.origin}/to-other`,
          finalUrl: `${other.origin}/x.html`,
          reason: 'redirect-off-origin',
        },
      ]);
    },
    TIMEOUT,
  );

  it(
    'records a crawled link that the page policy disallows and never requests it',
    async () => {
      const asked: string[] = [];
      const r = await scanWeb(
        { urls: [`${site.origin}/gate.html`], crawl: { maxPages: 5 } },
        {
          ...base,
          pagePolicy: async (url) => {
            asked.push(new URL(url).pathname);
            return new URL(url).pathname.startsWith('/walled') ? 'robots-disallowed' : 'scan';
          },
        },
      );
      expect(scanned(r).sort()).toEqual(['/d.html', '/gate.html']);
      expect(r.skipped).toEqual([
        {
          url: `${site.origin}/walled/in.html`,
          finalUrl: `${site.origin}/walled/in.html`,
          reason: 'robots-disallowed',
        },
      ]);
      expect(asked).toContain('/walled/in.html');
      expect(hitsOf(site, '/walled/in.html')).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'skips a listed page that a robots.txt policy disallows without requesting it',
    async () => {
      const robots = await serve(() => ({
        '/robots.txt': { type: 'text/plain', body: 'User-agent: Widedoor\nDisallow: /secret\n' },
        '/secret/a.html': { body: page('Secret', '<p>secret</p>') },
        '/open.html': { body: page('Open', '<p>open</p>') },
      }));
      try {
        const r = await scanWeb(
          { urls: [`${robots.origin}/secret/a.html`, `${robots.origin}/open.html`] },
          { ...base, pagePolicy: robotsPolicy(createFetcher(), 'Widedoor') },
        );
        expect(scanned(r)).toEqual(['/open.html']);
        expect(r.skipped.map((s) => [new URL(s.url).pathname, s.reason])).toEqual([
          ['/secret/a.html', 'robots-disallowed'],
        ]);
        expect(hitsOf(robots, '/secret/a.html')).toBe(0);
        expect(hitsOf(robots, '/robots.txt')).toBe(1);
      } finally {
        await robots.close();
      }
    },
    TIMEOUT,
  );

  const walled = async (url: string) =>
    new URL(url).pathname.startsWith('/walled')
      ? ('robots-disallowed' as const)
      : ('scan' as const);

  it(
    'drops a page whose redirect ends on a disallowed URL, with its findings, and records both URLs',
    async () => {
      const r = await scanWeb(
        { urls: [`${site.origin}/open`, `${site.origin}/d.html`], crawl: { maxPages: 5 } },
        { ...base, concurrency: 1, pagePolicy: walled },
      );
      expect(scanned(r)).toEqual(['/d.html']);
      expect(r.assets.map((a) => new URL(a.uri).pathname)).toEqual(['/d.html']);
      expect(r.skipped).toEqual([
        {
          url: `${site.origin}/open`,
          finalUrl: `${site.origin}/walled/via.html`,
          reason: 'robots-disallowed',
        },
      ]);
      // The redirect was followed by Chromium before the policy could see it.
      expect(hitsOf(site, '/walled/via.html')).toBe(1);
    },
    TIMEOUT,
  );

  it(
    'records an unreadable robots.txt as robots-unreachable and stops after maxPolicySkips',
    async () => {
      const r = await scanWeb(
        {
          urls: [1, 2, 3, 4]
            .map((i) => `${site.origin}/walled/stop${i}.html`)
            .concat(`${site.origin}/d.html`),
        },
        {
          ...base,
          maxPolicySkips: 2,
          pagePolicy: async (url) =>
            new URL(url).pathname.endsWith('stop1.html') ? 'robots-unreachable' : walled(url),
        },
      );
      expect(r.skipped.map((s) => [new URL(s.url).pathname, s.reason])).toEqual([
        ['/walled/stop1.html', 'robots-unreachable'],
        ['/walled/stop2.html', 'robots-disallowed'],
      ]);
      expect(r.pages).toEqual([]);
      expect(r.scopeGaps).toEqual([expect.stringMatching(/stopped after 2 pages were skipped/)]);
      expect(r.truncated).toBe(true);
      expect(hitsOf(site, '/walled/stop3.html')).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'records a rejecting page policy as a scan error for that page and scans the rest',
    async () => {
      const r = await scanWeb(
        { urls: [`${site.origin}/e.html`, `${site.origin}/d.html`] },
        {
          ...base,
          concurrency: 1,
          pagePolicy: async (url) => {
            if (url.endsWith('/e.html')) throw new Error('policy exploded');
            return 'scan';
          },
        },
      );
      expect(scanned(r)).toEqual(['/d.html']);
      expect(r.errors).toEqual([
        {
          uri: `${site.origin}/e.html`,
          code: 'scan-failed',
          message: 'page policy failed: policy exploded',
        },
      ]);
    },
    TIMEOUT,
  );

  it(
    'scans a redirect target once, and not again when it is queued later',
    async () => {
      const r = await scanWeb(
        {
          urls: [`${site.origin}/to-d`, `${site.origin}/to-d-again`, `${site.origin}/d.html`],
        },
        { ...base, concurrency: 1 },
      );
      expect(r.assets.map((a) => new URL(a.uri).pathname)).toEqual(['/d.html']);
      expect(scanned(r)).toEqual(['/to-d']);
    },
    TIMEOUT,
  );

  it(
    'hands PDF links on for fetching without loading them or spending a page',
    async () => {
      const r = await scanWeb(
        {
          urls: [`${site.origin}/pdf-links.html`, `${site.origin}/listed.pdf`],
          crawl: { maxPages: 1 },
        },
        base,
      );
      expect(scanned(r)).toEqual(['/pdf-links.html']);
      expect(r.truncated).toBe(false);
      expect(hitsOf(site, '/doc.pdf')).toBe(0);
      expect(r.errors).toEqual([]);
      expect(r.skipped).toEqual([]);
      expect(r.pdfs).toEqual([
        { url: `${site.origin}/listed.pdf`, listed: true },
        { url: `${site.origin}/doc.pdf`, listed: false },
        { url: `${site.origin}/UPPER.PDF?v=1`, listed: false },
      ]);
    },
    TIMEOUT,
  );

  it(
    'hands on a page the server answers with a PDF, unless it redirected off-origin',
    async () => {
      const r = await scanWeb(
        { urls: [`${site.origin}/report`, `${site.origin}/to-other-report`] },
        { ...base, concurrency: 1 },
      );
      expect(r.errors).toEqual([]);
      expect(r.assets).toEqual([]);
      expect(r.pdfs).toEqual([{ url: `${site.origin}/report`, listed: true }]);
      expect(r.skipped).toEqual([
        {
          url: `${site.origin}/to-other-report`,
          finalUrl: `${other.origin}/report`,
          reason: 'redirect-off-origin',
        },
      ]);
    },
    TIMEOUT,
  );

  it(
    'caps the links read per page and the PDF links handed on, and records the rest as scope gaps',
    async () => {
      const r = await scanWeb(
        { urls: [`${site.origin}/many-pdfs.html`], crawl: { maxPages: 5 } },
        base,
      );
      expect(r.pdfs).toHaveLength(100);
      expect(r.skipped).toEqual([]);
      expect(r.scopeGaps).toEqual([
        '4900 PDF link(s) were not scanned: at most 100 are taken from one page',
        '1000 link(s) were not followed: at most 5000 are read from one page',
      ]);
      expect(r.warnings).toEqual(expect.arrayContaining(r.scopeGaps));
      expect(hitsOf(site, '/f/0.pdf')).toBe(0);

      const run = await scanWeb(
        { urls: [`${site.origin}/many-pdfs.html`], crawl: { maxPages: 5 } },
        { ...base, maxPdfLinks: 30 },
      );
      expect(run.pdfs).toHaveLength(30);
      expect(run.scopeGaps[0]).toBe(
        '4900 PDF link(s) were not scanned: at most 100 are taken from one page',
      );
      expect(run.scopeGaps[1]).toBe(
        '70 PDF link(s) were not scanned: at most 30 are scanned per run',
      );
    },
    TIMEOUT,
  );

  it('refuses an authenticated cross-origin crawl', async () => {
    await expect(
      scanWeb(
        { urls: [`${site.origin}/a.html`], crawl: { sameOrigin: false } },
        { ...base, storageState: join(tmp, 'any.json') },
      ),
    ).rejects.toThrow(/cannot crawl with sameOrigin: false/);
  });
});

describe('page deadline and page behavior', () => {
  let scanner: WebScanner;
  beforeAll(async () => {
    scanner = await WebScanner.launch({ ...base, pageTimeoutMs: 3_000 });
  }, TIMEOUT);
  afterAll(() => scanner.close());

  it(
    'ends a busy-looping page at the deadline and records a timeout error',
    async () => {
      const t0 = Date.now();
      const r = await scanner.scanPage(`${site.origin}/hang.html`);
      // The deadline is 3 s; the margin is wide so a loaded runner does not flake (ledger, Phase 1 final).
      expect(Date.now() - t0).toBeLessThan(30_000);
      expect(r.findings).toEqual([]);
      expect(r.error).toEqual({
        uri: `${site.origin}/hang.html`,
        code: 'timeout',
        message: 'page did not finish within 3000 ms',
      });
      // The slot is free: the next page scans normally.
      expect((await scanner.scanPage(`${site.origin}/d.html`)).asset).toBeDefined();
    },
    TIMEOUT,
  );

  it(
    'a hung page does not hold a crawl slot',
    async () => {
      const r = await scanWeb(
        { urls: [`${site.origin}/hang.html`, `${site.origin}/d.html`] },
        { ...base, concurrency: 1, pageTimeoutMs: 3_000 },
      );
      expect(r.errors.map((e) => e.code)).toEqual(['timeout']);
      expect(r.assets.map((a) => new URL(a.uri).pathname)).toEqual(['/d.html']);
    },
    TIMEOUT,
  );

  it(
    'reports a page that navigates itself away instead of scanning the new document',
    async () => {
      const r = await scanner.scanPage(`${site.origin}/away.html`);
      expect(r.findings).toEqual([]);
      expect(['navigated-away', 'scan-failed']).toContain(r.error?.code);
    },
    TIMEOUT,
  );

  it(
    'lets popups load nothing',
    async () => {
      await scanner.scanPage(`${site.origin}/popup.html`);
      expect(hitsOf(site, '/popped')).toBe(0);
      expect(hitsOf(site, '/popped-link')).toBe(0);
    },
    TIMEOUT,
  );
});

describe('progress and cancel', () => {
  it(
    'tells progress as each page starts and ends',
    async () => {
      const seen: string[] = [];
      await scanWeb(
        { urls: [`${site.origin}/d.html`, `${site.origin}/e.html`] },
        {
          ...base,
          concurrency: 1,
          onProgress: (p) =>
            seen.push(
              `${p.done}/${p.known} ${p.current === undefined ? '-' : new URL(p.current).pathname}`,
            ),
        },
      );
      expect(seen).toEqual(['0/2 /d.html', '1/2 -', '1/2 /e.html', '2/2 -']);
    },
    TIMEOUT,
  );

  it(
    'stops when its signal fires: the page in flight ends and no other starts',
    async () => {
      const stop = new AbortController();
      const before = hitsOf(site, '/d.html');
      const t0 = Date.now();
      const run = scanWeb(
        { urls: [`${site.origin}/hang.html`, `${site.origin}/d.html`] },
        {
          ...base,
          concurrency: 1,
          signal: stop.signal,
          onProgress: (p) => {
            if (p.current?.endsWith('/hang.html'))
              setTimeout(() => stop.abort(new Error('stop')), 500);
          },
        },
      );
      await expect(run).rejects.toThrow('stop');
      // Well before the default page deadline.
      expect(Date.now() - t0).toBeLessThan(20_000);
      expect(hitsOf(site, '/d.html')).toBe(before);
      // A signal that already fired starts no browser.
      await expect(
        scanWeb({ urls: [`${site.origin}/d.html`] }, { ...base, signal: stop.signal }),
      ).rejects.toThrow('stop');
      expect(hitsOf(site, '/d.html')).toBe(before);
    },
    TIMEOUT,
  );
});

describe('findings and evidence', () => {
  let scanner: WebScanner;
  const evidence = () => join(tmp, 'evidence');
  beforeAll(async () => {
    scanner = await WebScanner.launch({ ...base, evidenceDir: evidence() });
  }, TIMEOUT);
  afterAll(() => scanner.close());

  it(
    'anchors every finding to the sha256 of the served document',
    async () => {
      const r = await scanner.scanPage(`${site.origin}/fail.html`);
      const hash = `sha256:${createHash('sha256').update(FAIL_PAGE).digest('hex')}`;
      expect(r.asset).toEqual({
        kind: 'web',
        uri: `${site.origin}/fail.html`,
        contentHash: hash,
        reviewHash: reviewHashOf(FAIL_PAGE),
      });
      expect(r.findings.length).toBeGreaterThan(0);
      for (const f of r.findings) {
        expect(FindingSchema.safeParse(f).success).toBe(true);
        expect(f.asset.contentHash).toBe(hash);
      }
    },
    TIMEOUT,
  );

  it(
    'keeps the review hash of a page whose CSRF value and nonce change per request, so a review stays current',
    async () => {
      const data = loadStandardsData();
      const profile = getProfile('wcag21aa');
      const scanTokens = async () => {
        const r = await scanner.scanPage(`${site.origin}/tokens.html`);
        if (!r.asset) throw new Error('the page was not scanned');
        return { asset: r.asset, findings: r.findings };
      };
      const reportOf = (scan: Awaited<ReturnType<typeof scanTokens>>): ReviewReport => {
        const assets = [scan.asset];
        return {
          profile: { id: profile.id, pdfDocumentType: profile.pdfDocumentType },
          assets,
          findings: scan.findings,
          rollup: rollup({
            findings: scan.findings,
            reviews: [],
            profile,
            assets,
            errata: errataFrom(data),
          }),
        };
      };
      const first = await scanTokens();
      const second = await scanTokens();
      expect(second.asset.contentHash).not.toBe(first.asset.contentHash);
      expect(second.asset.reviewHash).toBe(first.asset.reviewHash);
      expect(first.asset.reviewHash).not.toBe(first.asset.contentHash);
      // A reviewer records a result against the first scan; the second scan still counts it.
      const before = reportOf(first);
      const item = buildChecklist({ report: before, data }).find(
        (i) => i.criterion.id === '2.1.1' && i.status === 'open',
      );
      if (!item) throw new Error('no open 2.1.1 item');
      const dir = join(tmp, 'focus-1');
      mkdirSync(dir);
      await recordReview(dir, {
        report: before,
        item: item.id,
        outcome: 'pass',
        reviewer: 'Ann',
        version: '0.0.0',
        data,
      });
      const { reviews } = await loadReviews(dir);
      const after = reviewChecklist(reportOf(second), reviews, data);
      expect(after.notApplied).toEqual([]);
      expect(after.items.find((i) => i.id === item.id)?.status).toBe('done');
    },
    TIMEOUT,
  );

  it(
    'records a snippet and an element screenshot for a failure',
    async () => {
      const r = await scanner.scanPage(`${site.origin}/fail.html`);
      const alt = r.findings.find((f) => f.source.ruleId === 'image-alt' && f.outcome === 'fail');
      expect(alt?.evidence?.snippet).toMatch(/^<img /);
      expect(alt?.evidence?.screenshot).toBe(`${alt?.id}.png`);
      expect(existsSync(join(evidence(), `${alt?.id}.png`))).toBe(true);
      expect(alt?.evidence?.viewport).toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    'records the viewport on a failure that only the 320px reflow pass finds',
    async () => {
      const r = await scanner.scanPage(`${site.origin}/reflow.html`);
      const contrast = r.findings.filter(
        (f) => f.source.ruleId === 'color-contrast' && f.outcome === 'fail',
      );
      expect(contrast).toHaveLength(1);
      expect(contrast[0]?.evidence?.viewport).toEqual({ width: 320, height: 256 });
      expect(contrast[0]?.evidence?.screenshot).toBe(`${contrast[0]?.id}.png`);
    },
    TIMEOUT,
  );

  it(
    'refuses a document over maxDocumentBytes',
    async () => {
      const small = await WebScanner.launch({ ...base, maxDocumentBytes: 100 });
      try {
        const r = await small.scanPage(`${site.origin}/fail.html`);
        expect(r.error?.code).toBe('document-too-large');
        expect(r.findings).toEqual([]);
      } finally {
        await small.close();
      }
    },
    TIMEOUT,
  );
});

describe('hardened context', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchChromium(base);
  }, TIMEOUT);
  afterAll(() => browser.close());

  it(
    'blocks service workers (a plain context fetches the worker script)',
    async () => {
      const plain = await browser.newContext();
      const before = hitsOf(site, '/sw.js');
      const p0 = await plain.newPage();
      await p0.goto(`${site.origin}/sw.html`);
      await p0.waitForFunction(() => document.title === 'registered');
      expect(hitsOf(site, '/sw.js')).toBeGreaterThan(before);
      await plain.close();

      const context = await createHardenedContext(browser);
      const after = hitsOf(site, '/sw.js');
      const p = await context.newPage();
      await p.goto(`${site.origin}/sw.html`);
      await p.waitForFunction(
        () => document.title === 'registered' || document.title === 'rejected',
      );
      expect(context.serviceWorkers()).toEqual([]);
      expect(hitsOf(site, '/sw.js')).toBe(after);
      await context.close();
    },
    TIMEOUT,
  );

  it(
    'closes WebSockets before they reach the server',
    async () => {
      const context = await createHardenedContext(browser);
      const p = await context.newPage();
      await p.goto(`${site.origin}/ws.html`);
      await p.waitForFunction(() => document.title === 'closed');
      expect(site.upgrades).toBe(0);
      await context.close();
    },
    TIMEOUT,
  );

  it(
    'refuses downloads (a plain context accepts them)',
    async () => {
      const outcome = async (accept: boolean, hardened: boolean) => {
        const context = hardened
          ? await createHardenedContext(browser)
          : await browser.newContext({ acceptDownloads: accept });
        const p = await context.newPage();
        const download = p.waitForEvent('download');
        await p.goto(`${site.origin}/download`).catch(() => undefined);
        const failure = await (await download).failure();
        await context.close();
        return failure;
      };
      expect(await outcome(true, false)).toBeNull();
      expect(await outcome(false, true)).toMatch(/acceptDownloads/);
    },
    TIMEOUT,
  );

  it(
    'applies the request guard to every routed http(s) request',
    async () => {
      const seen: string[] = [];
      const context = await createHardenedContext(browser, {
        requestGuard: ({ url, isNavigation }) => {
          seen.push(`${url.pathname}:${isNavigation}`);
          return url.pathname !== '/d.html';
        },
      });
      const p = await context.newPage();
      await p.goto(`${site.origin}/e.html`);
      await expect(p.goto(`${site.origin}/d.html`)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
      expect(seen).toEqual(['/e.html:true', '/d.html:true']);
      await context.close();
    },
    TIMEOUT,
  );

  it(
    'loads file: URLs only inside fileRoot',
    async () => {
      const root = join(tmp, 'root');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'in.html'), page('In', '<p>in</p>'));
      writeFileSync(join(tmp, 'out.html'), page('Out', '<p>out</p>'));
      const inside = pathToFileURL(join(root, 'in.html')).href;
      const outside = pathToFileURL(join(tmp, 'out.html')).href;

      const rooted = await createHardenedContext(browser, { fileRoot: root });
      const p = await rooted.newPage();
      await p.goto(inside);
      expect(await p.title()).toBe('In');
      await expect(p.goto(outside)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
      await rooted.close();

      const none = await createHardenedContext(browser);
      await expect((await none.newPage()).goto(inside)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
      await none.close();
    },
    TIMEOUT,
  );
});

describe('auth', () => {
  it(
    'sends cookies from a storageState file',
    async () => {
      const state = join(tmp, 'state.json');
      const { hostname } = new URL(site.origin);
      writeFileSync(
        state,
        JSON.stringify({
          cookies: [
            {
              name: 'session',
              value: 'test-only',
              domain: hostname,
              path: '/',
              expires: -1,
              httpOnly: true,
              secure: false,
              sameSite: 'Lax',
            },
          ],
          origins: [],
        }),
      );
      const scanner = await WebScanner.launch({ ...base, storageState: state });
      try {
        await scanner.scanPage(`${site.origin}/auth.html`);
      } finally {
        await scanner.close();
      }
      const hit = site.hits.find((h) => h.path === '/auth.html');
      expect(hit?.headers.cookie).toBe('session=test-only');
    },
    TIMEOUT,
  );

  it('fails fast on a missing storageState file', async () => {
    await expect(
      WebScanner.launch({ ...base, storageState: join(tmp, 'nope.json') }),
    ).rejects.toThrow(/storage state file not found/);
  });
});
