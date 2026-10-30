/// <reference lib="dom" />
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProfile } from '@widedoor/core';
import { buildScanReport, serializeJson } from '@widedoor/report';
import { launchChromium } from '@widedoor/web';
import type { PinnedResolver } from '@widedoor/web/egress';
import { buildUi } from '../../cli/test/helpers.ts';
import {
  expectAxeClean,
  expectKeyboardOperable,
  scrollsSideways,
  watchedPage,
} from '../../cli/test/ui-page.ts';
import {
  createHostedApi,
  withSecurityHeaders,
  type HostedApi,
} from '../../server/src/hosted/api.ts';
import { loadHostedFiles } from '../../server/src/hosted/api-bin.ts';
import { JobInputSchema, type JobInput } from '../../server/src/hosted/protocol.ts';
import { fakeFly } from '../../server/test/hosted-api-fixtures.ts';
import {
  NO_LEAKS,
  SITE,
  hostedLab,
  html,
  scanInLab,
  send,
  type Lab,
} from '../../server/test/hosted-fixtures.ts';

/*
 * The hosted page in Chromium (npm run test:browser), served by the Task 10
 * and 11 API from a fresh build of the page, with a fake Fly client whose
 * "machine" is an in-process agent: a URL job is scanned in the SSRF lab
 * through its egress proxy (two pages with the same title), a PDF job fetches
 * the upload and answers a report of it (veraPDF is the docker suite's), and
 * a verify job never answers. Each machine waits until the test lets it go,
 * so the page can be seen running. From the keyboard: a URL scan to a
 * rendered report (axe clean empty, running and done; no horizontal scroll
 * at 320 px or 200% zoom), a cancel mid scan, a PDF upload pressed twice (one
 * request) to its report, a new verification made while an old one's check
 * was on its way (the old check changes nothing and polls nothing), and a
 * 429 told in words with the form held. No console error or CSP violation.
 */

const TIMEOUT = 240_000;
const unsafeNoSandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1';

let tmp: string;
let lab: Lab;
let browser: Browser;
let server: Server;
let api: HostedApi;
let origin: string;
const agents: Promise<void>[] = [];
/** Requests the page made, as "METHOD /path". */
const requests: string[] = [];
/** Machines waiting to be let go. */
const held: (() => void)[] = [];
const letGo = () => held.splice(0).forEach((go) => go());
/** The DNS TXT answer; a test may hold it. */
let txt: (name: string) => Promise<string[][]> = () => Promise.resolve([]);

/** The fake machine's report of an uploaded PDF (no veraPDF here). */
function pdfReport(fileName: string, bytes: Buffer): string {
  const asset = {
    kind: 'pdf' as const,
    uri: fileName,
    contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
  return serializeJson(
    buildScanReport({
      profile: getProfile('508+wcag21aa'),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      toolVersion: '0.0.0',
      scope: { pdf: { files: [fileName], include: [] } },
      pdf: {
        engines: {
          verapdf: { version: '1.30.3', runner: 'docker', description: null },
          widedoor: { version: '0.0.0' },
        },
        assets: [asset],
        findings: [],
        informational: [],
        errors: [],
        warnings: [],
      },
    }),
  );
}

/** One scan machine: input, the scan (or the PDF), the result. */
async function machine(jobId: string, token: string): Promise<void> {
  await new Promise<void>((go) => held.push(go));
  const auth = { authorization: `Bearer ${token}` };
  const got = await api.controlApp.request(`/internal/jobs/${jobId}/input`, { headers: auth });
  // Cancelled while it waited: its token is gone.
  if (got.status !== 200) return;
  const input: JobInput = JobInputSchema.parse(await got.json());
  if (input.target.kind === 'verify') return;
  let result: unknown;
  if (input.target.kind === 'pdf') {
    const pdf = await api.controlApp.request(`/internal/jobs/${jobId}/pdf`, { headers: auth });
    const bytes = Buffer.from(await pdf.arrayBuffer());
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // A done result carries the JSON report only; the API renders the HTML (R37).
    result = { status: 'done', reportJson: pdfReport(input.target.fileName, bytes) };
  } else result = (await scanInLab(lab, input)).result;
  await api.controlApp.request(`/internal/jobs/${jobId}/result`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(result),
  });
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-hosted-page-'));
  const dist = join(tmp, 'dist');
  buildUi(dist);
  lab = await hostedLab();
  // Both pages carry the fixture's one title: the report must still name each section uniquely.
  lab.routes.set('/', send(html('<img src="/pixel.gif"><a href="/about">About</a>')));
  lab.routes.set('/about', send(html('<p>Plain page.</p>')));
  lab.routes.set('/pixel.gif', (_req, res) => res.writeHead(404).end());

  const fly = fakeFly();
  fly.fake.create = (spec) => {
    agents.push(machine(spec.jobId, spec.token).catch(() => undefined));
    return Promise.resolve({ id: `m${spec.jobId.slice(0, 8)}` });
  };

  // The API needs its own origin, which the port gives: listen first, then make it.
  server = createServer(
    getRequestListener(
      async (req) => {
        requests.push(`${req.method} ${new URL(req.url).pathname}`);
        const res = await api.publicApp.fetch(req);
        withSecurityHeaders(res.headers);
        return res;
      },
      { overrideGlobalObjects: false },
    ),
  );
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api = createHostedApi({
    fly: fly.client,
    image: 'registry.fly.io/widedoor-scan:test',
    controlUrl: 'http://127.0.0.1:9',
    publicOrigin: origin,
    contactUrl: 'https://example.org/contact',
    // The lab's fake DNS, so the site's name is public; the source class, as scanInLab casts it.
    resolver: () => lab.resolver as unknown as PinnedResolver,
    txtLookup: (name) => txt(name),
    trustMissingClientIp: true,
    staticFiles: loadHostedFiles(dist),
  });
  browser = await launchChromium({ unsafeNoSandbox });
}, TIMEOUT);

afterAll(async () => {
  letGo();
  await Promise.allSettled(agents);
  api?.stop();
  await browser?.close();
  if (server)
    await new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
  await lab?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** The focused element's tag and text. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return `${el?.tagName.toLowerCase() ?? ''} ${(el?.textContent ?? '').trim()}`;
  });

/** Presses Tab until the focused control's tag and name match, at most max times. */
async function tabTo(page: Page, tag: string, name: string, max = 40): Promise<void> {
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const at = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const label = el?.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : '';
      return {
        tag: el?.tagName.toLowerCase() ?? '',
        name: (label || el?.textContent || '').trim(),
      };
    });
    if (at.tag === tag && at.name === name) return;
    seen.push(`${at.tag} ${at.name}`);
  }
  throw new Error(`Tab never reached ${tag} ${name}: ${seen.join(' | ')}`);
}

/** A page that is watched, at the start of the hosted page. */
async function open(): Promise<Awaited<ReturnType<typeof watchedPage>>> {
  const w = await watchedPage(browser);
  await w.page.goto(`${origin}/`);
  await w.page.getByRole('heading', { level: 1, name: 'Widedoor accessibility scanner' }).waitFor();
  return w;
}

/** The scan section's status line. */
const status = (page: Page) =>
  page.locator('section[aria-labelledby="scan-title"] p[role="status"]');

/**
 * Asserts nothing went wrong on the page, and closes it. expected: console lines Chromium
 * writes itself for an answer the test asked for (a 429 is logged as a failed load).
 */
async function done(
  w: Awaited<ReturnType<typeof watchedPage>>,
  expected: readonly string[] = [],
): Promise<void> {
  expect(w.errors).toEqual(expected);
  expect(w.dialogs).toEqual([]);
  expect(await w.violations()).toEqual([]);
  await w.page.context().close();
}

// Scans keep the Chromium sandbox on, as hosted scans do.
describe.skipIf(unsafeNoSandbox)('the hosted page', () => {
  it(
    'scans a URL from the keyboard to a rendered report, passing axe in every state',
    async () => {
      const w = await open();
      const { page } = w;
      await expectAxeClean(page, 'empty');
      await expectKeyboardOperable(page, 'empty');

      // URL entry, then Start scan, from the keyboard only.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await tabTo(page, 'input', 'Web page URL');
      await page.keyboard.type(`http://${SITE}/`);
      await tabTo(page, 'button', 'Start scan');
      await page.keyboard.press('Enter');

      // Following: the heading takes focus, the status says how it stands, Cancel is offered.
      await expect.poll(() => focused(page), { timeout: 30_000 }).toBe('h2 Scan in progress');
      await expect
        .poll(() => status(page).innerText(), { timeout: 30_000 })
        .toMatch(/^The scan(ner)? is (running|starting)/);
      await page.getByRole('button', { name: 'Cancel scan' }).waitFor();
      await expectAxeClean(page, 'running');

      letGo();
      await expect.poll(() => focused(page), { timeout: 180_000 }).toBe('h2 Your report');
      await expect
        .poll(() => status(page).innerText(), { timeout: 30_000 })
        .toBe('The scan finished. Its report is below.');
      await page.locator('section[aria-labelledby="manual"]').waitFor();
      await page
        .getByText(
          'This report documents the testing performed. It is not a certification of conformance.',
        )
        .first()
        .waitFor();
      // Two pages with one title: two page sections, each with its own name.
      expect(await page.locator('section[aria-labelledby^="asset-"]').count()).toBe(2);
      const links = await page
        .locator('ul.downloads a')
        .evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
      expect(links.slice(0, 2)).toEqual([
        expect.stringMatching(/^\/api\/scans\/[0-9a-f]{32}\/report\.json$/),
        expect.stringMatching(/^\/api\/scans\/[0-9a-f]{32}\/report\.html$/),
      ]);
      // The page read the JSON report and never fetched the HTML one.
      expect(requests.filter((r) => r.endsWith('/report.json'))).toHaveLength(1);
      expect(requests.filter((r) => r.endsWith('/report.html'))).toEqual([]);
      await expectAxeClean(page, 'done');

      // Reflow: 320 CSS pixels, and 200% zoom of a 1280 by 800 window, which is what the
      // page then lays out in: 640 by 400 CSS pixels (CSS zoom would leave media queries
      // seeing 1280, so it would not test what a zooming user gets).
      await page.setViewportSize({ width: 320, height: 800 });
      expect(await scrollsSideways(page), 'done at 320 px').toEqual([]);
      await page.setViewportSize({ width: 640, height: 400 });
      expect(await scrollsSideways(page), 'done at 200% zoom').toEqual([]);
      expect(lab.leaks()).toEqual(NO_LEAKS);
      await done(w);
    },
    TIMEOUT,
  );

  it(
    'cancels a running scan from the keyboard',
    async () => {
      const w = await open();
      const { page } = w;
      await page.getByLabel('Web page URL').fill(`http://${SITE}/about`);
      await page.getByRole('button', { name: 'Start scan' }).focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => focused(page), { timeout: 30_000 }).toBe('h2 Scan in progress');
      await page.getByRole('button', { name: 'Cancel scan' }).focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => focused(page), { timeout: 30_000 }).toBe('h2 Scan cancelled');
      expect(await status(page).innerText()).toBe('The scan was cancelled.');
      expect(requests.filter((r) => r.startsWith('DELETE /api/scans/'))).toHaveLength(1);
      await page.getByRole('button', { name: 'Start a new scan' }).waitFor();
      await expectAxeClean(page, 'cancelled');
      // Its machine, let go now, finds its token revoked and does nothing.
      letGo();
      await done(w);
    },
    TIMEOUT,
  );

  it(
    'uploads a PDF once though Start is pressed twice, and shows its report',
    async () => {
      const w = await open();
      const { page } = w;
      // The radio group from the keyboard: arrow to "A PDF file".
      await page.getByLabel('A web page').focus();
      await page.keyboard.press('ArrowDown');
      const file = page.getByLabel('PDF file', { exact: true });
      await file.waitFor();
      await file.setInputFiles({
        name: 'annual report.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n'),
      });
      const before = requests.filter((r) => r === 'POST /api/scans').length;
      await page.getByRole('button', { name: 'Start scan' }).focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await expect.poll(() => focused(page), { timeout: 30_000 }).toBe('h2 Scan in progress');
      expect(requests.filter((r) => r === 'POST /api/scans').length - before).toBe(1);
      letGo();
      await expect.poll(() => focused(page), { timeout: 60_000 }).toBe('h2 Your report');
      await page.locator('section[aria-labelledby="manual"]').waitFor();
      await expect.poll(() => page.locator('#asset-1').innerText()).toMatch(/\.pdf$/);
      await expectAxeClean(page, 'PDF report');
      await done(w);
    },
    TIMEOUT,
  );

  it(
    'leaves a new verification usable when the old one is dropped mid check',
    async () => {
      const w = await open();
      const { page } = w;
      await page.locator('summary', { hasText: 'Verify a host name' }).focus();
      await page.keyboard.press('Enter');
      const host = page.getByLabel('Host name');
      await host.focus();
      // An empty host is an error on the field, gone as soon as the user types.
      await page.getByRole('button', { name: 'Get a verification token' }).click();
      expect(await host.getAttribute('aria-invalid')).toBe('true');
      await host.focus();
      await page.keyboard.type(SITE);
      expect(await host.getAttribute('aria-invalid')).toBeNull();
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { level: 3, name: 'Publish the token one way' }).waitFor();

      // The check waits on DNS; meanwhile the user starts over.
      let answerTxt: (records: string[][]) => void = () => undefined;
      txt = () => new Promise((done) => (answerTxt = done));
      await page.getByRole('button', { name: 'Check now' }).click();
      await expect.poll(() => requests.filter((r) => r.endsWith('/check')).length).toBe(1);
      await page.getByRole('button', { name: 'Start a new verification' }).click();
      await host.fill(SITE);
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { level: 3, name: 'Publish the token one way' }).waitFor();
      const fresh = page.getByRole('button', { name: 'Check now' });

      // The old check's DNS misses, so the API starts a machine check and answers 202:
      // the page must not follow it.
      answerTxt([]);
      txt = () => Promise.resolve([]);
      await expect.poll(() => api.jobs.running, { timeout: 10_000 }).toBeGreaterThan(0);
      const polls = () => requests.filter((r) => /^GET \/api\/verifications\//.test(r)).length;
      const seen = polls();
      await page.waitForTimeout(7_000);
      expect(polls()).toBe(seen);
      expect(await fresh.getAttribute('aria-disabled')).toBe('false');
      expect(await page.locator('p[tabindex="-1"]').innerText()).toMatch(/Not checked yet\./);
      await expectAxeClean(page, 'new verification');
      // Only the verification, without its token, is stored.
      const stored = await page.evaluate(() => ({
        session: Object.keys(sessionStorage),
        local: localStorage.length,
        cookie: document.cookie,
      }));
      expect(stored).toEqual({ session: ['widedoor-verification'], local: 0, cookie: '' });
      await done(w);
    },
    TIMEOUT,
  );

  it(
    'says a 429 in words and holds the form until the wait ends',
    async () => {
      // Spend the rest of this network's scans: a POST is charged before its body is read.
      for (let i = 0; i < 40; i++) {
        const res = await api.publicApp.request('/api/scans', {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: '{}',
        });
        if (res.status === 429) break;
      }
      const w = await open();
      const { page } = w;
      await page.getByLabel('Web page URL').fill(`http://${SITE}/`);
      const start = page.getByRole('button', { name: 'Start scan' });
      await start.focus();
      await page.keyboard.press('Enter');
      const alert = page.locator('section[aria-labelledby="scan-title"] p[role="alert"]');
      await expect
        .poll(() => alert.innerText())
        .toMatch(/^Too many scans from your network\. Try again later\. You can try again in /);
      expect(await start.getAttribute('aria-disabled')).toBe('true');
      const sent = requests.filter((r) => r === 'POST /api/scans').length;
      await page.keyboard.press('Enter');
      await expect
        .poll(() => alert.innerText())
        .toMatch(/^You can try again in \d+ (minutes|hour)/);
      expect(requests.filter((r) => r === 'POST /api/scans').length).toBe(sent);
      await expectAxeClean(page, '429');
      // Chromium's own line for the one refused request; the page itself logged nothing.
      await done(w, [
        'Failed to load resource: the server responded with a status of 429 (Too Many Requests)',
      ]);
    },
    TIMEOUT,
  );
});
