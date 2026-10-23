/// <reference lib="dom" />
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseJsonReport } from '@widedoor/report';
import { launchChromium } from '@widedoor/web';
import {
  BIN,
  CORPUS,
  UI_DIST,
  buildCli,
  buildUi,
  interrupt,
  runCli,
  serveHtml,
  type StaticServer,
} from './helpers.ts';

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
const SECTIONS = ['fix', 'by-asset', 'summary', 'rollup', 'method', 'disclaimer'];
const TOKEN_KEY = 'widedoor-token';

let site: StaticServer;
let tmp: string;
let dist: string;
let out: string;
let reportFile: string;
let browser: Browser;

interface UiChild {
  child: ChildProcess;
  url: string;
  port: number;
  stdout: () => string;
  closed: Promise<number | null>;
  /** The session token, once a page has traded the link's code for it. */
  token?: string;
}

/** Starts the built bin's ui command, serving the test build, and waits for the link it prints. */
function startUi(args: string[]): Promise<UiChild> {
  return new Promise((ready, fail) => {
    const child = spawn(process.execPath, [BIN, 'ui', ...args, '--no-open'], {
      cwd: tmp,
      env: { ...process.env, WIDEDOOR_UI_DIST: dist },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let text = '';
    let err = '';
    const closed = new Promise<number | null>((done) => child.once('close', (code) => done(code)));
    const timer = setTimeout(() => fail(new Error(`no link printed: ${text} ${err}`)), 30_000);
    child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.stdout?.on('data', (c: Buffer) => {
      text += c.toString('utf8');
      const m = /(http:\/\/127\.0\.0\.1:(\d+)\/\?code=[A-Za-z0-9_-]+)/.exec(text);
      if (m?.[1] && m[2]) {
        clearTimeout(timer);
        ready({ child, url: m[1], port: Number(m[2]), stdout: () => text, closed });
      }
    });
    child.once('error', fail);
    void closed.then((code) => fail(new Error(`ui exited early (${code}): ${text} ${err}`)));
  });
}

async function stopUi(ui: UiChild): Promise<void> {
  if (ui.child.exitCode === null) interrupt(ui.child);
  expect(await ui.closed).toBe(0);
  expect(ui.stdout()).toContain('Widedoor UI stopped.');
}

interface Watched {
  page: Page;
  dialogs: string[];
  errors: string[];
  violations: () => Promise<string[]>;
}

/** A page that records dialogs, console errors, page errors and CSP violations. */
async function watchedPage(): Promise<Watched> {
  // AxeBuilder needs a context it can open a second page in.
  const page = await (await browser.newContext()).newPage();
  const dialogs: string[] = [];
  const errors: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  // Added through the DevTools protocol, so the page CSP does not block it.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __violations: string[] }).__violations = seen;
    document.addEventListener('securitypolicyviolation', (e) =>
      seen.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  return {
    page,
    dialogs,
    errors,
    violations: () =>
      page.evaluate(() => (window as unknown as { __violations: string[] }).__violations),
  };
}

/**
 * Opens the viewer. The first page uses the printed link, whose code works
 * once, and keeps the token it traded it for; later pages get that token in
 * session storage, as a reload of the first tab would.
 */
async function openViewer(ui: UiChild, ready = 'What to fix first'): Promise<Watched> {
  const w = await watchedPage();
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

async function axeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
  );
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

/** The bundle of a viewer build: its one script. */
const scriptOf = (folder: string) => {
  if (!existsSync(join(folder, 'index.html')))
    throw new Error(
      `${folder} has no viewer build: run "npm run build" before "npm run test:browser"`,
    );
  const assets = join(folder, 'assets');
  const [js] = readdirSync(assets).filter((f) => f.endsWith('.js'));
  if (!js) throw new Error(`no script in ${assets}`);
  return readFileSync(join(assets, js), 'utf8');
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
  });
});

describe('widedoor ui --report', () => {
  let ui: UiChild;
  beforeAll(async () => {
    ui = await startUi(['--report', reportFile]);
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
    'says what the HTML report of the same scan says, section by section',
    async () => {
      const w = await openViewer(ui);
      const html = await (await browser.newContext()).newPage();
      await html.goto(pathToFileURL(join(out, 'report.html')).href);
      for (const id of SECTIONS) {
        const want = await sectionText(html, id);
        expect(want?.blocks.length, id).toBeGreaterThan(0);
        expect(await sectionText(w.page, id), id).toEqual(want);
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
      const again = await watchedPage();
      await again.page.goto(ui.url);
      await again.page.getByText('This link was already used.').waitFor();
      expect(await again.page.locator('section[aria-labelledby="fix"]').count()).toBe(0);
      await again.page.context().close();

      const host = `127.0.0.1:${ui.port}`;
      const code = new URL(ui.url).searchParams.get('code') ?? '';
      const reused = await send(ui.port, '/api/session', { host, 'x-widedoor-code': code }, 'POST');
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
      const ui = await startUi([]);
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
