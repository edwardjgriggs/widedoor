/// <reference lib="dom" />
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChromium, scanWeb } from '@widedoor/web';
import { buildSite } from '../src/site.ts';

/*
 * The docs site passes Widedoor's own check (Task 3b.11, ruling 4): every
 * built page, served as Vercel would serve it (clean URLs and the
 * vercel.json headers, so Chromium enforces the CSP), is scanned with
 * scanWeb and has no fail; and a keyboard-only pass reaches every nav link
 * on every page, each with a visible focus outline.
 */

const TIMEOUT = 300_000;
const unsafeNoSandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as {
  headers: { headers: { key: string; value: string }[] }[];
};
const HEADERS = Object.fromEntries(vercel.headers[0]!.headers.map((h) => [h.key, h.value]));

let tmp: string;
let dist: string;
let pages: string[];
let server: Server;
let origin: string;
let browser: Browser;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-docs-site-'));
  dist = join(tmp, 'dist');
  pages = buildSite(ROOT, dist)
    .filter((f) => f.endsWith('index.html'))
    .map((f) => `/${f.replace(/index\.html$/, '')}`);
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    let file = join(dist, ...path.split('/').filter(Boolean));
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    const found = file.startsWith(dist) && existsSync(file) && statSync(file).isFile();
    const body = readFileSync(found ? file : join(dist, '404.html'));
    res
      .writeHead(found ? 200 : 404, {
        ...HEADERS,
        'content-type': TYPES[found ? extname(file) : '.html'] ?? 'application/octet-stream',
      })
      .end(body);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchChromium({ unsafeNoSandbox });
}, TIMEOUT);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
  if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('the docs site', () => {
  it(
    "has no fail on any page, by Widedoor's own scan",
    async () => {
      expect(pages.length).toBeGreaterThan(5);
      const urls = [...pages, '/no-such-page/'].map((p) => `${origin}${p}`);
      const result = await scanWeb(
        { urls, maxPages: urls.length },
        { ...(unsafeNoSandbox ? { unsafeNoSandbox: true } : {}) },
      );
      expect(result.errors).toEqual([]);
      expect(result.assets).toHaveLength(urls.length);
      const fails = result.findings
        .filter((f) => f.outcome === 'fail')
        .map((f) => `${f.asset.uri} ${f.source.ruleId} ${JSON.stringify(f.location)}`);
      expect(fails).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'reaches every nav link by keyboard on every page, each with a visible focus outline',
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const violations: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') violations.push(m.text());
      });
      try {
        for (const path of pages) {
          const response = await page.goto(`${origin}${path}`);
          // Every vercel.json header reaches the browser (fix round 1 item 3 adds two).
          const got = response?.headers() ?? {};
          for (const [key, value] of Object.entries(HEADERS))
            expect(got[key.toLowerCase()], `${path} ${key}`).toBe(value);
          expect(got['permissions-policy']).toContain('camera=()');
          expect(got['cross-origin-opener-policy']).toBe('same-origin');
          const nav = await page
            .locator('nav a')
            .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href')));
          const reached = new Set<string>();
          // The skip link comes first and shows when focused.
          await page.keyboard.press('Tab');
          const skip = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement;
            const box = el.getBoundingClientRect();
            return {
              text: el.textContent,
              top: box.top,
              outline: getComputedStyle(el).outlineStyle,
            };
          });
          expect(skip.text, path).toBe('Skip to the content');
          expect(skip.top, path).toBeGreaterThanOrEqual(0);
          for (let i = 0; i < 60 && reached.size < nav.length; i++) {
            const focus = await page.evaluate(() => {
              const el = document.activeElement as HTMLElement;
              const style = getComputedStyle(el);
              return {
                inNav: el.closest('nav') !== null,
                href: el.getAttribute('href'),
                outline: `${style.outlineStyle} ${style.outlineWidth}`,
              };
            });
            if (focus.inNav && focus.href) {
              expect(focus.outline, `${path} ${focus.href}`).toMatch(/^solid [1-9]/);
              reached.add(focus.href);
            }
            await page.keyboard.press('Tab');
          }
          expect([...reached].sort(), path).toEqual([...nav].sort());
        }
        // The CSP blocked nothing the site needs (a violation logs a console error).
        expect(violations).toEqual([]);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});
