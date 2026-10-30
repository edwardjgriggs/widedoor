/// <reference lib="dom" />
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FindingSchema, findingId } from '@widedoor/core';
import { parseJsonReport, serializeJson } from '@widedoor/report';
import { launchChromium } from '@widedoor/web';
import {
  CORPUS,
  UI_DIST,
  buildCli,
  buildUi,
  runCli,
  serveHtml,
  type StaticServer,
} from './helpers.ts';
import {
  axeViolations,
  scrollsSideways,
  startUi,
  stopUi,
  watchedPage,
  type UiChild,
  type Watched,
} from './ui-page.ts';

/*
 * widedoor ui end to end, the way a user runs it: the built bin serves a
 * report from a real scan of corpus pages (xss.html among them) and Chromium
 * opens the printed link. No script from scanned content may run, the page
 * must say what the HTML report of the same scan says and pass axe, and the
 * server must refuse foreign Hosts, missing tokens, a reused link and every
 * interface but loopback. The viewer is a production build in a temp folder,
 * so the shipped packages/ui/dist is never overwritten.
 */

const TIMEOUT = 120_000;
const unsafeNoSandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1';
const PAGES = ['xss.html', 'alt-fail.html', 'contrast-fail.html', 'labels-pass.html'];
const DISCLAIMER =
  'This report documents the testing performed. It is not a certification of conformance.';
const XSS_TITLE = "</title><script>alert('title')</script> \"><img src=x onerror=alert('title')>";
const SECTIONS = ['manual', 'fix', 'by-asset', 'summary', 'rollup', 'method', 'disclaimer'];
const TOKEN_KEY = 'widedoor-token';

let site: StaticServer;
let tmp: string;
let dist: string;
let out: string;
let reportFile: string;
let browser: Browser;

/**
 * Opens the viewer. The first page uses the printed link, whose code works
 * once, and keeps the token it traded it for; later pages get that token in
 * session storage, as a reload of the first tab would.
 */
async function openViewer(ui: UiChild, ready = 'What to fix first'): Promise<Watched> {
  const w = await watchedPage(browser);
  if (ui.token === undefined) {
    await w.page.goto(ui.url);
    await w.page.getByText(ready).first().waitFor();
    const token = await w.page.evaluate((key) => sessionStorage.getItem(key), TOKEN_KEY);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (token) ui.token = token;
  } else {
    await w.page.addInitScript(
      ([key, token]) => sessionStorage.setItem(key as string, token as string),
      [TOKEN_KEY, ui.token],
    );
    await w.page.goto(`http://127.0.0.1:${ui.port}/`);
    await w.page.getByText(ready).first().waitFor();
  }
  return w;
}

/** A raw HTTP request with a chosen Host header. */
function send(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = 'GET',
): Promise<{ status: number; csp: unknown; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () =>
        done({ status: res.statusCode ?? 0, csp: res.headers['content-security-policy'], body }),
      );
    });
    req.once('error', fail);
    req.end();
  });
}

/** Resolves with the connect error code, or "connected" if the port answered. */
function tryConnect(host: string, port: number): Promise<string> {
  return new Promise((done) => {
    const socket = connect({ host, port, timeout: 10_000 });
    socket.once('connect', () => {
      socket.destroy();
      done('connected');
    });
    socket.once('timeout', () => {
      socket.destroy();
      done('timeout');
    });
    socket.once('error', (e: NodeJS.ErrnoException) => done(e.code ?? 'error'));
  });
}

/** Block text (with block boundaries as spaces), links and images of one section of the page. */
function sectionText(page: Page, id: string) {
  return page.evaluate((sectionId) => {
    const BLOCKS = 'h2,h3,h4,p,li,dt,dd,th,td,caption,summary,pre';
    const SPACED = new Set([
      ...BLOCKS.toUpperCase().split(','),
      'UL',
      'OL',
      'DL',
      'DETAILS',
      'TABLE',
      'THEAD',
      'TBODY',
      'TR',
      'SECTION',
    ]);
    const textOf = (n: Node): string => {
      if (n.nodeType === Node.TEXT_NODE) return n.nodeValue ?? '';
      if (!(n instanceof Element)) return '';
      if (n.tagName === 'BR') return ' ';
      const inner = [...n.childNodes].map(textOf).join('');
      return SPACED.has(n.tagName) ? ` ${inner} ` : inner;
    };
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const section = document.querySelector(`section[aria-labelledby="${sectionId}"]`);
    if (!section) return undefined;
    return {
      blocks: [...section.querySelectorAll(BLOCKS)].map(
        (e) => `${e.tagName.toLowerCase()}: ${norm(textOf(e))}`,
      ),
      links: [...section.querySelectorAll('a')].map((a) => a.getAttribute('href')),
      images: [...section.querySelectorAll('img')].map(
        (i) => `${i.getAttribute('src')} ${i.getAttribute('alt')}`,
      ),
    };
  }, id);
}

beforeAll(async () => {
  buildCli();
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-ui-'));
  dist = join(tmp, 'dist');
  buildUi(dist);
  site = await serveHtml(join(CORPUS, 'web'));
  out = join(tmp, 'out');
  const scan = await runCli(
    [
      'scan',
      ...PAGES.map((p) => `${site.origin}/${p}`),
      '--out',
      out,
      '--format',
      'json,html',
      ...(unsafeNoSandbox ? ['--unsafe-no-sandbox'] : []),
    ],
    { cwd: tmp },
  );
  expect(scan.code, scan.stderr).toBe(1);
  reportFile = join(out, 'report.json');
  browser = await launchChromium({ unsafeNoSandbox });
}, TIMEOUT);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/**
 * The bundle of a viewer build: its scripts, joined (the viewer's and the hosted page's
 * entries share a chunk that holds React and the report view).
 */
const scriptOf = (folder: string) => {
  if (!existsSync(join(folder, 'index.html')) || !existsSync(join(folder, 'hosted.html')))
    throw new Error(
      `${folder} has no viewer build: run "npm run build" before "npm run test:browser"`,
    );
  const assets = join(folder, 'assets');
  const scripts = readdirSync(assets).filter((f) => f.endsWith('.js'));
  if (scripts.length === 0) throw new Error(`no script in ${assets}`);
  return scripts.map((js) => readFileSync(join(assets, js), 'utf8')).join('\n');
};

describe('viewer builds', () => {
  it.each([
    ['the test build', () => dist],
    ['the shipped build (npm run build)', () => UI_DIST],
  ])('%s is a production React build with its license notices', (_, folder) => {
    const script = scriptOf(folder());
    expect(script).toContain('Minified React error');
    expect(script).not.toContain('unique "key" prop');
    // Only what the bundle holds, each with a license (yaml must not be in it).
    const notice = readFileSync(join(folder(), 'THIRD-PARTY-LICENSES.txt'), 'utf8');
    expect([...notice.matchAll(/^(\S+) \S+ \(([^)]+)\)$/gm)].map((m) => `${m[1]} ${m[2]}`)).toEqual(
      ['react MIT', 'react-dom MIT', 'scheduler MIT', 'zod MIT'],
    );
    expect(script).not.toContain('tag:yaml.org');
    // AI suggestions come from the local server; no provider SDK or address is in the page (3b.8).
    for (const s of ['@anthropic-ai', 'openai', 'api.anthropic.com', 'api.openai.com'])
      expect(script.toLowerCase(), s).not.toContain(s);
    // The build does hold the suggestions panel, so the check reads the right bundle.
    expect(script).toContain('Suggest fixes for all');
  });
});

describe('widedoor ui --report', () => {
  let ui: UiChild;
  beforeAll(async () => {
    ui = await startUi(['--report', reportFile], tmp, dist);
  }, TIMEOUT);
  afterAll(async () => {
    if (ui) await stopUi(ui);
  });

  it(
    'shows the corpus results with no script from scanned content running',
    async () => {
      const report = parseJsonReport(readFileSync(reportFile, 'utf8'));
      const w = await openViewer(ui);

      // The code leaves the address bar once read.
      expect(w.page.url()).toBe(`http://127.0.0.1:${ui.port}/`);
      expect(await w.page.locator('h1').innerText()).toBe('Accessibility report');
      expect(await w.page.getByText('Showing the report given to widedoor ui.').count()).toBe(1);

      // Cards, per-asset sections with page titles, criteria and the disclaimer.
      const cards = w.page.locator('ol.cards > li.card');
      expect(await cards.count()).toBe(
        new Set(
          report.findings
            .filter((f) => f.outcome === 'fail' || f.outcome === 'needs-review')
            .map((f) => `${f.source.engine} ${f.source.ruleId}`),
        ).size,
      );
      expect(await cards.count()).toBeGreaterThan(2);
      await w.page.getByRole('heading', { level: 3, name: XSS_TITLE, exact: true }).waitFor();
      const criteria = w.page.locator('section[aria-labelledby="rollup"] tbody th[scope="row"]');
      const ids = await criteria.allInnerTexts();
      expect(ids).toEqual(expect.arrayContaining(['1.1.1', '1.4.3', '4.1.2', '302.1']));
      expect(await w.page.locator('p.disclaimer').innerText()).toBe(DISCLAIMER);
      const body = await w.page.locator('body').innerText();
      expect(body).toContain('aria-label=""><svg onload=alert(9)>');
      expect(body).toContain('[U+202E]gnp.exe[U+202C]');
      expect(body).not.toContain(String.fromCharCode(0x202e));

      // Screenshots came through the containment loader as data: images.
      const shots = await w.page
        .locator('img.shot')
        .evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src.slice(0, 22)));
      expect(shots.length).toBeGreaterThan(0);
      expect(new Set(shots)).toEqual(new Set(['data:image/png;base64,']));

      // Nothing from the scan became markup.
      const dom = await w.page.evaluate(() => ({
        scripts: [...document.scripts].map((s) => new URL(s.src).pathname),
        handlers: [...document.querySelectorAll('*')].flatMap((e) =>
          [...e.attributes].filter((a) => a.name.startsWith('on')).map((a) => a.name),
        ),
        hrefs: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
        iframes: document.querySelectorAll('iframe, object, embed, svg, base, meta[http-equiv]')
          .length,
      }));
      expect(dom.scripts).toHaveLength(1);
      expect(dom.scripts[0]).toMatch(/^\/assets\/[\w-]+\.js$/);
      expect(dom.handlers).toEqual([]);
      expect(dom.hrefs.filter((h) => !/^https:\/\//.test(h ?? ''))).toEqual([]);
      expect(dom.iframes).toBe(0);

      expect(w.dialogs).toEqual([]);
      expect(w.errors).toEqual([]);
      expect(await w.violations()).toEqual([]);
      await w.page.context().close();
    },
    TIMEOUT,
  );

  it(
    'says what the HTML report of the same scan says, section by section, and both reflow at 320 px',
    async () => {
      const w = await openViewer(ui);
      const html = await (await browser.newContext()).newPage();
      await html.goto(pathToFileURL(join(out, 'report.html')).href);
      for (const id of SECTIONS) {
        const want = await sectionText(html, id);
        expect(want?.blocks.length, id).toBeGreaterThan(0);
        expect(await sectionText(w.page, id), id).toEqual(want);
      }
      // Both reflow at 320 CSS pixels (the shared report style wraps table cells).
      for (const [name, page] of [
        ['report.html', html],
        ['the viewer', w.page],
      ] as const) {
        await page.setViewportSize({ width: 320, height: 800 });
        expect(await scrollsSideways(page), `${name} at 320 px`).toEqual([]);
      }
      await html.context().close();
      await w.page.context().close();
    },
    TIMEOUT,
  );

  it(
    'passes axe with zero violations, unfiltered and filtered, and keeps page counts whole',
    async () => {
      const w = await openViewer(ui);
      expect(await axeViolations(w.page)).toEqual([]);
      const leads = () =>
        w.page.locator('section[aria-labelledby="by-asset"] p.lead').allInnerTexts();
      const before = await leads();

      await w.page.getByLabel('Outcome').selectOption('fail');
      await w.page.getByLabel('Impact').selectOption('critical');
      const status = await w.page.getByText(/^Showing \d+ of \d+ listed findings\./).innerText();
      expect(status).toMatch(/always cover the whole report/);
      const badges = await w.page
        .locator('section[aria-labelledby="by-asset"] li.finding ul.badges')
        .allInnerTexts();
      for (const b of badges) expect(b).toMatch(/Problem\s+Critical/);
      // A filter narrows the lists, never what the page says about each asset.
      expect(await leads()).toEqual(before);
      expect(await axeViolations(w.page)).toEqual([]);
      expect(w.errors).toEqual([]);
      await w.page.context().close();
    },
    TIMEOUT,
  );

  it(
    'opens a JSON report file in the page, and refuses a file that is not one',
    async () => {
      const w = await openViewer(ui);
      const input = w.page.getByLabel('Widedoor JSON report (report.json)');
      await input.setInputFiles(reportFile);
      await w.page.getByText('Showing the file report.json.').waitFor();
      expect(await w.page.locator('p.disclaimer').innerText()).toBe(DISCLAIMER);
      // Opened from a file, the viewer has no evidence folder.
      expect(await w.page.locator('img.shot').count()).toBe(0);

      const hostile = {
        name: 'other.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{"name":"<img src=x onerror=alert(1)>"}'),
      };
      await input.setInputFiles(hostile);
      const alert = w.page.getByRole('alert');
      expect(await alert.innerText()).toMatch(
        /^other\.json is not usable: it is not a Widedoor JSON report/,
      );
      // The input is cleared after each read, so picking the same file again fires a change:
      // the good report, picked again after the error, replaces the error.
      expect(await input.inputValue()).toBe('');
      await input.setInputFiles(reportFile);
      await expect.poll(() => alert.count()).toBe(0);
      expect(await input.inputValue()).toBe('');
      await input.setInputFiles(reportFile);
      await w.page.getByText('Showing the file report.json.').waitFor();
      expect(w.dialogs).toEqual([]);
      expect(w.errors).toEqual([]);
      expect(await w.violations()).toEqual([]);
      await w.page.context().close();
    },
    TIMEOUT,
  );

  it(
    'refuses a reused link, a foreign Host and a missing or wrong token',
    async () => {
      // The printed link was used by the first page: a second browser gets nothing.
      const again = await watchedPage(browser);
      await again.page.goto(ui.url);
      await again.page.getByText('This link was already used.').waitFor();
      expect(await again.page.locator('section[aria-labelledby="fix"]').count()).toBe(0);
      await again.page.context().close();

      const host = `127.0.0.1:${ui.port}`;
      const code = new URL(ui.url).searchParams.get('code') ?? '';
      const reused = await send(
        ui.port,
        '/api/session',
        { host, origin: `http://${host}`, 'x-widedoor-code': code },
        'POST',
      );
      expect(reused.status).toBe(401);
      expect(reused.body).not.toContain(ui.token ?? '-');

      const token = ui.token ?? '';
      const good = await send(ui.port, '/api/report', { host, 'x-widedoor-token': token });
      expect(good.status).toBe(200);
      expect(parseJsonReport(JSON.stringify(JSON.parse(good.body).report)).findings.length).toBe(
        parseJsonReport(readFileSync(reportFile, 'utf8')).findings.length,
      );
      for (const [headers, status] of [
        [{ host: `evil.example:${ui.port}`, 'x-widedoor-token': token }, 403],
        [{ host: `evil.example:${ui.port}` }, 403],
        [{ host }, 401],
        [{ host, 'x-widedoor-token': 'wrong' }, 401],
        [{ host, 'x-widedoor-token': code }, 401],
      ] as const) {
        const r = await send(ui.port, '/api/report', headers);
        expect(r.status, JSON.stringify(headers)).toBe(status);
        expect(r.csp).toContain("default-src 'none'");
        expect(r.body).not.toContain('findings');
      }
      // The viewer itself is public, but not to a page that rebinds its own name to 127.0.0.1.
      expect((await send(ui.port, '/', { host: `rebind.example:${ui.port}` })).status).toBe(403);
    },
    TIMEOUT,
  );

  it(
    'is not reachable on any address but 127.0.0.1',
    async () => {
      const external = Object.values(networkInterfaces())
        .flat()
        .filter((a) => a !== undefined && !a.internal)
        .map((a) => (a as { address: string }).address)
        .filter((a) => !a.startsWith('fe80:'));
      expect(await tryConnect('127.0.0.1', ui.port)).toBe('connected');
      expect(await tryConnect('::1', ui.port)).not.toBe('connected');
      if (external.length === 0) {
        // No other interface on this host: the printed link is the bind address check.
        expect(new URL(ui.url).hostname).toBe('127.0.0.1');
        return;
      }
      for (const address of external)
        expect(await tryConnect(address, ui.port), address).not.toBe('connected');
    },
    TIMEOUT,
  );
});

describe('widedoor ui without --report', () => {
  it(
    'asks for a report file and passes axe',
    async () => {
      const ui = await startUi([], tmp, dist);
      try {
        expect(ui.stdout()).toContain('no report given');
        const w = await openViewer(ui, 'widedoor ui was started without --report.');
        expect(await axeViolations(w.page)).toEqual([]);
        expect(w.errors).toEqual([]);
        await w.page.context().close();
      } finally {
        await stopUi(ui);
      }
      // Stopped means closed: nothing listens on the port any more.
      expect(await tryConnect('127.0.0.1', ui.port)).not.toBe('connected');
    },
    TIMEOUT,
  );
});

describe('widedoor ui --report --config', () => {
  /** A whole 1x1 PNG. */
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  );

  it(
    'serves the attachments from widedoor-review/ in the folder of --config',
    async () => {
      // A report whose one manual record names an image, and a project folder that holds it.
      const project = join(tmp, 'project');
      mkdirSync(join(project, 'widedoor-review', 'attachments'), { recursive: true });
      writeFileSync(join(project, 'widedoor-review', 'attachments', 'shot.png'), PNG);
      const config = join(project, 'widedoor.config.yaml');
      writeFileSync(config, 'web:\n  urls: [https://example.com/]\n');
      const report = parseJsonReport(readFileSync(reportFile, 'utf8'));
      const asset = report.assets[0];
      if (!asset) throw new Error('the scan has no asset');
      const record = FindingSchema.parse({
        schemaVersion: 1,
        id: findingId(asset.uri, { selector: 'html' }, 'manual', 'wcag-2.1.1'),
        asset,
        location: { selector: 'html' },
        source: { engine: 'manual', engineVersion: '0.0.0', ruleId: 'wcag-2.1.1' },
        criteria: { wcag: ['2.1.1'] },
        outcome: 'pass',
        review: {
          reviewer: 'Ann',
          date: '2026-10-23',
          expiresOnChangeOf: asset.reviewHash ?? asset.contentHash,
          attachments: ['attachments/shot.png'],
        },
      });
      const file = join(tmp, 'with-attachment.json');
      writeFileSync(file, serializeJson({ ...report, findings: [...report.findings, record] }));

      // Started from tmp, so only --config can point it at the project folder.
      const ui = await startUi(['--report', file, '--config', config], tmp, dist);
      try {
        const host = `127.0.0.1:${ui.port}`;
        const code = new URL(ui.url).searchParams.get('code') ?? '';
        const session = await send(
          ui.port,
          '/api/session',
          { host, origin: `http://${host}`, 'x-widedoor-code': code },
          'POST',
        );
        expect(session.status).toBe(200);
        const token = (JSON.parse(session.body) as { token: string }).token;
        const served = await send(ui.port, '/api/report', { host, 'x-widedoor-token': token });
        expect(served.status).toBe(200);
        expect(JSON.parse(served.body).attachments).toEqual({
          'attachments/shot.png': {
            ok: true,
            dataUri: `data:image/png;base64,${PNG.toString('base64')}`,
          },
        });
      } finally {
        await stopUi(ui);
      }
    },
    TIMEOUT,
  );
});

describe('widedoor ui --root: the API from inside the page, under the CSP', () => {
  // A scan job always keeps the Chromium sandbox on, as widedoor scan does by default.
  it.skipIf(unsafeNoSandbox)(
    'scans, records a review and exports with no CSP violation, then shows the scan',
    async () => {
      const root = join(tmp, 'api-root');
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, 'widedoor.config.yaml'),
        'acr:\n  vendor: { name: Example Agency }\n  product: { name: Test portal }\n',
      );
      const ui = await startUi(['--root', root], tmp, dist);
      try {
        expect(ui.stdout()).toContain(`Folder: ${root}`);
        const w = await openViewer(ui, 'widedoor ui was started without --report.');
        const urls = ['alt-fail.html', 'labels-pass.html'].map((p) => `${site.origin}/${p}`);
        // What the UI will do: fetch with the token, from the page's own origin.
        const result = await w.page.evaluate(
          async ({ key, urls }) => {
            const token = sessionStorage.getItem(key) ?? '';
            const api = (path: string, init: RequestInit = {}) =>
              fetch(path, {
                ...init,
                headers: { 'x-widedoor-token': token, ...(init.headers ?? {}) },
              });
            const post = (path: string, body: unknown) =>
              api(path, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              });
            const started = await post('/api/scans', { urls, profile: '508+wcag21aa' });
            const job = (await started.json()) as { id: string };
            let status: { status: string; report?: { assets: { uri: string }[] } } = {
              status: 'queued',
            };
            for (let i = 0; i < 600 && ['queued', 'running'].includes(status.status); i++) {
              await new Promise((done) => setTimeout(done, 200));
              status = await (await api(`/api/scans/${job.id}`)).json();
            }
            const checklist = (await (await api('/api/checklist')).json()) as {
              items: { id: string; status: string; criterion: { id: string } }[];
            };
            const item = checklist.items.find(
              (i) => i.status === 'open' && i.criterion.id === '2.1.1',
            );
            const review = await post('/api/reviews', {
              item: item?.id,
              outcome: 'pass',
              reviewer: 'Browser Test',
              notes: 'Tabbed through the page.',
            });
            const exports: Record<string, { status: number; disposition: string | null }> = {};
            for (const format of ['openacr', 'vpat-html', 'json', 'html']) {
              const r = await api(`/api/export/${format}`);
              await r.arrayBuffer();
              exports[format] = {
                status: r.status,
                disposition: r.headers.get('content-disposition'),
              };
            }
            return {
              started: started.status,
              status: status.status,
              assets: status.report?.assets.map((a) => a.uri) ?? [],
              review: review.status,
              exports,
            };
          },
          { key: TOKEN_KEY, urls },
        );
        expect(result.started).toBe(202);
        expect(result.status).toBe('done');
        expect(result.assets.sort()).toEqual([...urls].sort());
        expect(result.review).toBe(201);
        expect(result.exports).toEqual({
          openacr: { status: 200, disposition: 'attachment; filename="report.openacr.yaml"' },
          'vpat-html': { status: 200, disposition: 'attachment; filename="report.vpat.html"' },
          json: { status: 200, disposition: 'attachment; filename="report.json"' },
          html: { status: 200, disposition: 'attachment; filename="report.html"' },
        });
        // The job kept its report in memory; only the review was written, to widedoor-review/.
        expect(readdirSync(root).sort()).toEqual(['widedoor-review', 'widedoor.config.yaml']);
        expect(readdirSync(join(root, 'widedoor-review')).some((f) => f.endsWith('.yaml'))).toBe(
          true,
        );
        expect(w.dialogs).toEqual([]);
        expect(w.errors).toEqual([]);
        expect(await w.violations()).toEqual([]);
        await w.page.context().close();

        // The built viewer shows the scan's report, still with no violation.
        const shown = await openViewer(ui);
        expect(await shown.page.locator('p.disclaimer').innerText()).toBe(DISCLAIMER);
        expect(shown.errors).toEqual([]);
        expect(await shown.violations()).toEqual([]);
        await shown.page.context().close();
      } finally {
        await stopUi(ui);
      }
    },
    TIMEOUT,
  );
});
