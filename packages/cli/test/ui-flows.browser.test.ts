/// <reference lib="dom" />
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page, Route } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FindingSchema,
  findingId,
  reviewChecklist,
  type Asset,
  type Finding,
} from '@widedoor/core';
import { serializeJson, type ScanReport } from '@widedoor/report';
import { buildReport, itemsWithRecords, reportBodyOf } from '@widedoor/server';
import { launchChromium } from '@widedoor/web';
import { buildCli, buildUi } from './helpers.ts';
import {
  showScreen,
  startUiAt,
  stopUi,
  watchedPage,
  type UiChild,
  type Watched,
} from './ui-page.ts';

/*
 * The screens' state changes in Chromium, against a stand-in API: the page
 * comes from the real widedoor ui, and every /api call is answered by the
 * test (Playwright routes), so each answer and its timing is chosen. Covered: a scan that ends while Checklist or Export is open
 * refreshes them and is announced once; a report that cannot be loaded
 * after a scan says so; the profile is left to the config unless chosen;
 * failed polls are retried and then shown with Cancel usable; Cancel during
 * the uploads starts no scan; PDF names are made unique and a failed start
 * is retried with the same uploads; a review with storage blocked updates
 * the checklist and leaves an opened file shown; a second download is
 * refused while one runs; the Refresh buttons read again. A scan that ends
 * keeps an open review form, its notes and focus (and Export's focus); a
 * job started just after Cancel is cancelled; a late poll does not end a
 * job twice; ACR reads are shown in order; a failed reload after a review
 * shows on Checklist; Refresh shows the record the review files hold, never
 * the older one in the served report.
 */

const TIMEOUT = 120_000;
const unsafeNoSandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1';
let tmp: string;
let dist: string;
let browser: Browser;

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const PAGE: Asset = { kind: 'web', uri: 'https://site.example/form', contentHash: hash('a') };
const JOB = 'a'.repeat(32);
const UPLOAD = (n: number) => String(n).repeat(32).slice(0, 32);

/** A one-page scan with one automated fail (and these manual records), as the server would build it. */
function sampleReport(reviews: readonly Finding[] = []): ScanReport {
  const location = { selector: 'img.hero' };
  const fail = FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(PAGE.uri, location, 'axe-core', 'image-alt'),
    asset: PAGE,
    location,
    source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId: 'image-alt' },
    criteria: { wcag: ['1.1.1'] },
    outcome: 'fail',
    impact: 'critical',
  });
  return buildReport(
    {
      profile: '508+wcag21aa',
      pdfDocumentType: 'non-web',
      startedAt: new Date('2026-10-26T12:00:00.000Z'),
      finishedAt: new Date('2026-10-26T12:01:00.000Z'),
      scope: { web: { urls: [PAGE.uri], truncated: false } },
      web: {
        engine: { name: 'axe-core', version: '4.14.0' },
        assets: [PAGE],
        findings: [fail],
        errors: [],
        skipped: [],
        warnings: [],
        truncated: false,
      },
    },
    reviews,
  ).report;
}

const REPORT = sampleReport();
const REPORT_BODY = reportBodyOf(REPORT, join(tmpdir(), 'no-evidence'), undefined, 'live');
const CHECKLIST = (() => {
  const c = reviewChecklist(REPORT, []);
  return { summary: c.summary, items: c.items, notApplied: [], warnings: [] };
})();
/** The checklist after the first item was recorded. */
const RECORDED = {
  ...CHECKLIST,
  items: CHECKLIST.items.map((i, n) => (n === 0 ? { ...i, status: 'done' } : i)),
};
/** A manual record on an open item of the page, by one reviewer. */
const MANUAL_ITEM = CHECKLIST.items.find((i) => i.status === 'open' && i.criterion.type === 'wcag');
const manual = (outcome: 'pass' | 'fail', reviewer: string, date: string) => {
  const ruleId = `wcag-${MANUAL_ITEM?.criterion.id ?? ''}`;
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(PAGE.uri, { selector: 'html' }, 'manual', ruleId),
    asset: PAGE,
    location: { selector: 'html' },
    source: { engine: 'manual', engineVersion: '0.2.0', ruleId },
    criteria: { wcag: [MANUAL_ITEM?.criterion.id] },
    outcome,
    review: { reviewer, date, expiresOnChangeOf: PAGE.contentHash },
  });
};
/** Ann's pass is in the served report; Bo's fail was recorded with the CLI since (same record id). */
const ANN = manual('pass', 'Ann', '2026-10-01');
const BO = manual('fail', 'Bo', '2026-10-26');
const ANN_REPORT = sampleReport([ANN]);
/** The checklist as GET /api/checklist sends it with these records in the review files. */
const checklistWith = (record: Finding) => {
  const c = reviewChecklist(ANN_REPORT, [record]);
  return { summary: c.summary, items: itemsWithRecords(c), notApplied: [], warnings: [] };
};
const ACR = { complete: false, incomplete: ['acr.vendor.contact is not set'], undecided: 3 };

type Reply = { status: number; body?: unknown; hold?: Promise<void> };
type Handler = (route: Route, body: string) => Reply | Promise<Reply>;

interface Api {
  /** METHOD /path of every call the test answered, with its body. */
  calls: { call: string; body: string }[];
  on(method: string, path: string | RegExp, handler: Handler): void;
}

/**
 * Answers every /api call but the session trade from the handlers set with on(); 404 otherwise.
 * GET /api/ai always answers on the real server: here it says AI is off unless a test says otherwise.
 */
async function standIn(page: Page): Promise<Api> {
  const handlers: { method: string; path: string | RegExp; handler: Handler }[] = [
    {
      method: 'GET',
      path: '/api/ai',
      handler: () => ({ status: 200, body: { available: false, reason: 'off' } }),
    },
  ];
  const api: Api = {
    calls: [],
    on: (method, path, handler) => void handlers.unshift({ method, path, handler }),
  };
  await page.route(
    (url) => url.pathname.startsWith('/api/') && url.pathname !== '/api/session',
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const body = req.postData() ?? '';
      api.calls.push({ call: `${req.method()} ${path}${new URL(req.url()).search}`, body });
      const h = handlers.find(
        (x) =>
          x.method === req.method() &&
          (typeof x.path === 'string' ? x.path === path : x.path.test(path)),
      );
      const reply = h ? await h.handler(route, body) : { status: 404, body: 'Not found.' };
      await reply.hold;
      await route
        .fulfill({
          status: reply.status,
          contentType:
            typeof reply.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
          body:
            reply.body === undefined
              ? ''
              : typeof reply.body === 'string'
                ? reply.body
                : JSON.stringify(reply.body),
        })
        .catch(() => undefined);
    },
  );
  return api;
}

const job = (status: string, extra: object = {}) => ({
  id: JOB,
  status,
  progress: { done: 0, known: 1, current: PAGE.uri },
  startedAt: '2026-10-26T12:00:00.000Z',
  ...extra,
});

/** Records every non-empty text the app-level announcer takes. */
async function recordAnnouncements(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const said: string[] = [];
    let last = '';
    (window as unknown as { __said: string[] }).__said = said;
    new MutationObserver(() => {
      const text = document.querySelector('p.visually-hidden[role="status"]')?.textContent ?? '';
      if (text === last) return;
      last = text;
      if (text !== '') said.push(text);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  return () => page.evaluate(() => (window as unknown as { __said: string[] }).__said);
}

let ui: UiChild;

beforeAll(async () => {
  buildCli();
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-ui-flows-'));
  dist = join(tmp, 'dist');
  buildUi(dist);
  const root = join(tmp, 'root');
  mkdirSync(root);
  ui = await startUiAt(root, dist);
  browser = await launchChromium({ unsafeNoSandbox });
}, TIMEOUT);

afterAll(async () => {
  await browser?.close();
  if (ui) await stopUi(ui);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** A fresh page on the stand-in API: the real server serves the page, the test answers /api. */
async function open(): Promise<{ w: Watched; api: Api }> {
  const w = await watchedPage(browser);
  const api = await standIn(w.page);
  // No code to trade: the stand-in API takes any token.
  await w.page.addInitScript(() => sessionStorage.setItem('widedoor-token', 'stand-in-token'));
  return { w, api };
}

const status = (page: Page) => page.locator('p.progress[role="status"]');
/** expect.poll with room for the page's one-second poll interval. */
const poll = <T>(check: () => T | Promise<T>, options: { timeout: number } = { timeout: 15_000 }) =>
  expect.poll(check, options);

describe('the screens against a stand-in API', () => {
  it(
    'refresh Checklist and Export when a scan ends, announce it once, and say when its report cannot be loaded',
    async () => {
      const { w, api } = await open();
      const { page } = w;
      const said = await recordAnnouncements(page);
      let state = 'running';
      let report: Reply = { status: 204 };
      api.on('GET', '/api/report', () => report);
      api.on('POST', '/api/scans', () => ({ status: 202, body: job('queued') }));
      api.on('GET', `/api/scans/${JOB}`, () => ({ status: 200, body: job(state) }));
      api.on('GET', '/api/checklist', () =>
        report.status === 200
          ? { status: 200, body: CHECKLIST }
          : { status: 409, body: 'there is no report yet; scan or open one first' },
      );
      api.on('GET', '/api/acr', () =>
        report.status === 200
          ? { status: 200, body: ACR }
          : { status: 409, body: 'there is no report yet; scan or open one first' },
      );
      try {
        await page.goto(`http://127.0.0.1:${ui.port}/`);
        await page.getByText('widedoor ui was started without --report.').waitFor();

        // Scan 1, profile left to the config; Checklist is open when it ends.
        await showScreen(page, 'Scan', 'Scan pages and PDFs');
        await page.getByLabel('Web page URLs, one per line').fill(PAGE.uri);
        await page.getByRole('button', { name: 'Start scan' }).click();
        await poll(() => status(page).innerText()).toBe(`Scanning 1 of 1: ${PAGE.uri}`);
        const start = api.calls.find((c) => c.call === 'POST /api/scans');
        expect(JSON.parse(start?.body ?? '{}')).toEqual({ urls: [PAGE.uri] });
        await showScreen(page, 'Checklist', 'Manual review checklist');
        await page
          .getByText(
            'The checklist could not be loaded: there is no report yet; scan or open one first.',
          )
          .waitFor();
        report = { status: 200, body: REPORT_BODY };
        state = 'done';
        await page.getByText(`Showing ${CHECKLIST.items.length} of`).waitFor();
        expect(await page.getByRole('alert').filter({ hasText: /\S/ }).count()).toBe(0);
        await poll(said).toEqual(['Scan finished.']);

        // Scan 2 with a chosen profile; Export is open when it ends.
        state = 'running';
        await showScreen(page, 'Scan', 'Scan pages and PDFs');
        await page.getByLabel('Profile').selectOption('508');
        await page.getByRole('button', { name: 'Start scan' }).click();
        await poll(() => status(page).innerText()).toMatch(/^Scanning /);
        const starts = api.calls.filter((c) => c.call === 'POST /api/scans');
        expect(JSON.parse(starts[1]?.body ?? '{}')).toEqual({ urls: [PAGE.uri], profile: '508' });
        await showScreen(page, 'Export', 'Export the report');
        await page.getByText('The ACR is a draft. It is not complete because:').waitFor();
        const before = api.calls.filter((c) => c.call === 'GET /api/acr').length;
        state = 'done';
        await poll(() => api.calls.filter((c) => c.call === 'GET /api/acr').length).toBe(
          before + 1,
        );
        await poll(said).toEqual(['Scan finished.', 'Scan finished.']);

        // Scan 3: its report cannot be loaded (500). Scan and Report say so; nothing claims otherwise.
        state = 'running';
        await showScreen(page, 'Scan', 'Scan pages and PDFs');
        await page.getByRole('button', { name: 'Start scan' }).click();
        await poll(() => status(page).innerText()).toMatch(/^Scanning /);
        report = { status: 500, body: 'Server error. The widedoor ui terminal shows the cause.' };
        state = 'done';
        await poll(() => status(page).innerText()).toBe(
          'The scan finished, but its report could not be loaded. The Report screen says why.',
        );
        await showScreen(page, 'Report', 'Accessibility report');
        expect(await page.getByRole('alert').innerText()).toBe(
          'The report widedoor ui holds could not be loaded again. Server error. The widedoor ui terminal shows the cause.',
        );
        // Announced only off the Scan screen: the third scan ended on it.
        expect(await said()).toEqual(['Scan finished.', 'Scan finished.']);
        expect(await w.violations()).toEqual([]);
      } finally {
        await page.context().close();
      }
    },
    TIMEOUT,
  );

  it(
    'retry failed polls, then keep Cancel usable; cancel uploads before a scan; name PDFs uniquely and retry a failed start',
    async () => {
      const { w, api } = await open();
      const { page } = w;
      let next = 0;
      let release: () => void = () => undefined;
      let holdUploads = true;
      api.on('GET', '/api/report', () => ({ status: 204 }));
      api.on('POST', '/api/uploads', () => {
        if (holdUploads) return { status: 201, hold: new Promise((done) => (release = done)) };
        next++;
        return { status: 201, body: { id: UPLOAD(next), kind: 'pdf', bytes: 9 } };
      });
      let refuseStart = true;
      api.on('POST', '/api/scans', () => {
        if (refuseStart) {
          refuseStart = false;
          return {
            status: 400,
            body: 'the request is not valid: urls.0: expected an http or https URL',
          };
        }
        return { status: 202, body: job('queued') };
      });
      let polls = 0;
      let cancelled = false;
      api.on('GET', `/api/scans/${JOB}`, () =>
        cancelled
          ? { status: 200, body: job('cancelled') }
          : ++polls <= 1 + 4
            ? polls === 1
              ? { status: 200, body: job('running') }
              : { status: 503, body: 'busy' }
            : { status: 200, body: job('running') },
      );
      api.on('DELETE', `/api/scans/${JOB}`, () => {
        cancelled = true;
        return { status: 202, body: job('running', { cancelling: true }) };
      });
      try {
        await page.goto(`http://127.0.0.1:${ui.port}/`);
        await showScreen(page, 'Scan', 'Scan pages and PDFs');
        const files = [
          { name: 'Report 1.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n') },
          { name: 'Report-1.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n') },
        ];
        await page.getByLabel('PDF files').setInputFiles(files);

        // Cancel while the first upload is in flight: no scan is started.
        await page.getByRole('button', { name: 'Start scan' }).click();
        await poll(() => status(page).innerText()).toBe('Uploading PDF 1 of 2: Report 1.pdf');
        await page.getByRole('button', { name: 'Cancel scan' }).click();
        await poll(() => status(page).innerText()).toBe(
          'The scan was cancelled before it started.',
        );
        release();
        expect(api.calls.some((c) => c.call === 'POST /api/scans')).toBe(false);

        // Unique names; the refused start is retried with the same uploads.
        holdUploads = false;
        await page.getByRole('button', { name: 'Start scan' }).click();
        await poll(() => page.getByRole('alert').filter({ hasText: /\S/ }).innerText()).toMatch(
          /^The scan could not start: the request is not valid/,
        );
        const uploads = api.calls.filter((c) => c.call.startsWith('POST /api/uploads')).slice(1);
        expect(uploads.map((c) => c.call)).toEqual([
          'POST /api/uploads?kind=pdf&name=Report-1.pdf',
          'POST /api/uploads?kind=pdf&name=Report-1-2.pdf',
        ]);
        await page.getByRole('button', { name: 'Start scan' }).click();
        await poll(() => status(page).innerText()).toMatch(/^Scanning 1 of 1: /);
        expect(api.calls.filter((c) => c.call.startsWith('POST /api/uploads'))).toHaveLength(3);
        const starts = api.calls.filter((c) => c.call === 'POST /api/scans');
        expect(JSON.parse(starts[1]?.body ?? '{}')).toEqual({ pdfs: [UPLOAD(1), UPLOAD(2)] });

        // Four failed polls: three retries (1, 2 and 4 s), then the screen says so; Cancel still works.
        const alert = page.getByRole('alert').filter({ hasText: /\S/ });
        await poll(() => alert.innerText(), { timeout: 20_000 }).toBe(
          'The scan could not be followed: Server error. The widedoor ui terminal shows the cause. Cancel it, or reload the page to see how it ended.',
        );
        const cancel = page.getByRole('button', { name: 'Cancel scan' });
        expect(await cancel.getAttribute('aria-disabled')).toBe('false');
        await cancel.click();
        await poll(() => status(page).innerText()).toBe('The scan was cancelled.');
        expect(await w.violations()).toEqual([]);
      } finally {
        await page.context().close();
      }
    },
    TIMEOUT,
  );

  it(
    'record a review with storage blocked, update the checklist, keep an opened file shown; refuse a second download; refresh',
    async () => {
      const { w, api } = await open();
      const { page } = w;
      // localStorage refuses every write.
      await page.addInitScript(() => {
        Storage.prototype.setItem = () => {
          throw new DOMException('blocked', 'SecurityError');
        };
      });
      let recorded = false;
      let releaseDownload: () => void = () => undefined;
      api.on('GET', '/api/report', () => ({ status: 200, body: REPORT_BODY }));
      api.on('GET', '/api/checklist', () => ({
        status: 200,
        body: recorded ? RECORDED : CHECKLIST,
      }));
      api.on('POST', '/api/reviews', () => {
        recorded = true;
        return {
          status: 201,
          body: {
            file: 'widedoor-review/x.yaml',
            id: 'wd_0123456789abcdef',
            asset: PAGE,
            overrides: [],
          },
        };
      });
      api.on('GET', '/api/acr', () => ({ status: 200, body: ACR }));
      api.on('GET', '/api/export/json', () => ({
        status: 200,
        body: '{}',
        hold: new Promise<void>((done) => (releaseDownload = done)),
      }));
      try {
        await page.goto(`http://127.0.0.1:${ui.port}/`);
        await page.getByText('Showing the report given to widedoor ui.').waitFor();
        // Open the same report as a file: Report now shows the file.
        await page.getByLabel('Widedoor JSON report (report.json)').setInputFiles({
          name: 'mine.json',
          mimeType: 'application/json',
          buffer: Buffer.from(serializeJson(REPORT)),
        });
        await page.getByText('Showing the file mine.json.').waitFor();

        await showScreen(page, 'Checklist', 'Manual review checklist');
        await page
          .getByText('The Report screen shows a file you opened. The checklist is of the report')
          .waitFor();
        const loads = () => api.calls.filter((c) => c.call === 'GET /api/checklist').length;
        const first = loads();
        await page.getByRole('button', { name: 'Refresh the checklist' }).click();
        await poll(loads).toBe(first + 1);
        const item = page.locator('li.item').first();
        await item
          .getByRole('button', {
            name: /^Record a result for .* on https:\/\/site\.example\/form$/,
          })
          .click();
        await item.getByLabel('Pass').check();
        await item.getByLabel('Reviewer name').fill('Blocked Storage');
        await item.getByRole('button', { name: 'Record result' }).click();
        await poll(() => page.evaluate(() => document.activeElement?.textContent ?? '')).toBe(
          'Status: Done: a current manual result decides it',
        );
        const sent = api.calls.find((c) => c.call === 'POST /api/reviews');
        expect(JSON.parse(sent?.body ?? '{}')).toMatchObject({
          outcome: 'pass',
          reviewer: 'Blocked Storage',
        });

        // The opened file stays shown, with a note; a button brings the served report back.
        await showScreen(page, 'Report', 'Accessibility report');
        await page
          .getByText(
            'Showing the file mine.json. The report widedoor ui holds was updated with the review. The Report screen still shows the file you opened.',
          )
          .waitFor();
        await page.getByRole('button', { name: 'Show the report widedoor ui holds' }).click();
        await page.getByText('Showing the report given to widedoor ui.').waitFor();
        // The button went away with the file: focus is on the heading, not the body.
        expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1');

        // Export: the live note, Check again, and a second download while one runs.
        await showScreen(page, 'Export', 'Export the report');
        await page
          .getByText('This report is kept only while widedoor ui runs. Export it to keep a copy.')
          .filter({ visible: true })
          .waitFor();
        const checks = () => api.calls.filter((c) => c.call === 'GET /api/acr').length;
        const checked = checks();
        await page.getByRole('button', { name: 'Check the ACR again' }).click();
        await poll(checks).toBe(checked + 1);
        const json = page.getByRole('button', { name: 'JSON report (report.json)' });
        await json.click();
        await page.getByText('Preparing report.json.').waitFor();
        await json.click();
        await page.getByText('Already downloading report.json. Wait for it to finish.').waitFor();
        const saved = page.waitForEvent('download');
        releaseDownload();
        expect((await saved).suggestedFilename()).toBe('report.json');
        await page.getByText('Downloaded report.json.').waitFor();
        expect(api.calls.filter((c) => c.call === 'GET /api/export/json')).toHaveLength(1);
        expect(w.errors).toEqual([]);
        expect(await w.violations()).toEqual([]);
      } finally {
        await page.context().close();
      }
    },
    TIMEOUT,
  );

  it(
    'show the record the review files hold after Refresh, not the older one in the served report',
    async () => {
      const { w, api } = await open();
      const { page } = w;
      // widedoor review record wrote Bo's fail while the page was open.
      let cliRecorded = false;
      api.on('GET', '/api/report', () => ({
        status: 200,
        body: reportBodyOf(ANN_REPORT, join(tmpdir(), 'no-evidence'), undefined, 'live'),
      }));
      api.on('GET', '/api/checklist', () => ({
        status: 200,
        body: checklistWith(cliRecorded ? BO : ANN),
      }));
      try {
        expect(MANUAL_ITEM).toBeDefined();
        await page.goto(`http://127.0.0.1:${ui.port}/`);
        await page.getByText('Showing the report given to widedoor ui.').waitFor();
        await showScreen(page, 'Checklist', 'Manual review checklist');
        // The Report screen's copy of the note is hidden.
        await page
          .getByText('This report is kept only while widedoor ui runs. Export it to keep a copy.')
          .filter({ visible: true })
          .waitFor();
        await page.getByText('Recorded: Pass, by Ann on 2026-10-01.').waitFor();
        cliRecorded = true;
        await page.getByRole('button', { name: 'Refresh the checklist' }).click();
        await page.getByText('Recorded: Fail, by Bo on 2026-10-26.').waitFor();
        // The served report still holds Ann's pass under the same record id; it is not shown.
        expect(await page.getByText('Recorded: Pass, by Ann').count()).toBe(0);
        expect(api.calls.filter((c) => c.call === 'GET /api/report')).toHaveLength(1);
        expect(w.errors).toEqual([]);
        expect(await w.violations()).toEqual([]);
      } finally {
        await page.context().close();
      }
    },
    TIMEOUT,
  );

  it(
    'keep an open review form, its typed notes and focus when a scan ends, and Export its focus; Refresh then shows the new items',
    async () => {
      const { w, api } = await open();
      const { page } = w;
      let state = 'running';
      let scans = 0;
      // The second scan's checklist has one item fewer.
      const NEW = { ...CHECKLIST, items: CHECKLIST.items.slice(1) };
      api.on('GET', '/api/report', () => ({ status: 200, body: REPORT_BODY }));
      api.on('POST', '/api/scans', () => {
        scans++;
        state = 'running';
        return { status: 202, body: job('queued') };
      });
      api.on('GET', `/api/scans/${JOB}`, () => ({ status: 200, body: job(state) }));
      api.on('GET', '/api/checklist', () => ({
        status: 200,
        body: scans >= 2 && state === 'done' ? NEW : CHECKLIST,
      }));
      api.on('GET', '/api/acr', () => ({ status: 200, body: ACR }));
      const active = () =>
        page.evaluate(() => {
          const el = document.activeElement as HTMLTextAreaElement | null;
          return `${el?.tagName} ${el?.value ?? el?.textContent ?? ''}`;
        });
      try {
        await page.goto(`http://127.0.0.1:${ui.port}/`);
        await page.getByText('Showing the report given to widedoor ui.').waitFor();

        // Export: a scan ends while a download button has focus; the state is read again in place.
        await showScreen(page, 'Scan', 'Scan pages and PDFs');
        await page.getByLabel('Web page URLs, one per line').fill(PAGE.uri);
        await page.getByRole('button', { name: 'Start scan' }).click();
        await poll(() => status(page).innerText()).toMatch(/^Scanning /);
        await showScreen(page, 'Export', 'Export the report');
        await page.getByText('The ACR is a draft. It is not complete because:').waitFor();
        const checks = () => api.calls.filter((c) => c.call === 'GET /api/acr').length;
        const before = checks();
        const download = page.getByRole('button', { name: 'JSON report (report.json)' });
        await download.focus();
        state = 'done';
        await poll(checks).toBe(before + 1);
        await page.getByText('The ACR is a draft. It is not complete because:').waitFor();
        expect(await download.evaluate((b) => b === document.activeElement)).toBe(true);

        // Checklist: a scan ends while a review form is open with notes typed.
        await showScreen(page, 'Scan', 'Scan pages and PDFs');
        await page.getByRole('button', { name: 'Start scan' }).click();
        await poll(() => status(page).innerText()).toMatch(/^Scanning /);
        await showScreen(page, 'Checklist', 'Manual review checklist');
        await page.getByText(`Showing ${CHECKLIST.items.length} of`).waitFor();
        const item = page.locator('li.item').first();
        await item.getByRole('button', { name: /^Record a result for / }).click();
        const notes = item.getByLabel('Notes');
        await notes.fill('Half written');
        await notes.focus();
        const loads = () => api.calls.filter((c) => c.call === 'GET /api/checklist').length;
        const loaded = loads();
        state = 'done';
        const note = 'A new scan finished. Refresh the checklist to see its items.';
        await page.getByText(note).waitFor();
        expect(loads()).toBe(loaded);
        expect(await notes.inputValue()).toBe('Half written');
        expect(await active()).toBe('TEXTAREA Half written');
        await page.getByText(`Showing ${CHECKLIST.items.length} of`).waitFor();
        await page.getByRole('button', { name: 'Refresh the checklist' }).click();
        const n = NEW.items.length;
        await page.getByText(`Showing ${n} of ${n} ${n === 1 ? 'item' : 'items'}.`).waitFor();
        expect(await page.getByText(note).count()).toBe(0);
        expect(await w.violations()).toEqual([]);
      } finally {
        await page.context().close();
      }
    },
    TIMEOUT,
  );

  it(
    'cancel a job whose start answer comes after Cancel, end a job once, read the ACR state in order, and show a failed reload on Checklist',
    async () => {
      const { w, api } = await open();
      const { page } = w;
      let state = 'running';
      let releaseStart: () => void = () => undefined;
      let holdStart = true;
      let cancelled = false;
      let report: Reply = { status: 200, body: REPORT_BODY };
      api.on('GET', '/api/report', () => report);
      api.on('POST', '/api/scans', () =>
        holdStart
          ? {
              status: 202,
              body: job('queued'),
              hold: new Promise<void>((done) => (releaseStart = done)),
            }
          : { status: 202, body: job('queued') },
      );
      let releasePoll: (() => void) | undefined;
      let holdNextPoll = false;
      api.on('GET', `/api/scans/${JOB}`, () => {
        if (holdNextPoll) {
          holdNextPoll = false;
          // Answers "done" late, after a second poll has already said so.
          return {
            status: 200,
            body: job('done'),
            hold: new Promise<void>((done) => (releasePoll = done)),
          };
        }
        return { status: 200, body: job(cancelled ? 'cancelled' : state) };
      });
      api.on('DELETE', `/api/scans/${JOB}`, () => {
        if (state === 'done') return { status: 409, body: 'the scan has already ended' };
        cancelled = true;
        return { status: 202, body: job('running', { cancelling: true }) };
      });
      let acrReads = 0;
      api.on('GET', '/api/acr', () => {
        acrReads++;
        // The first Check again answers late with another state; the second at once.
        return acrReads === 2
          ? {
              status: 200,
              body: { complete: true, incomplete: [], undecided: 0 },
              hold: new Promise<void>((done) => setTimeout(done, 1500)),
            }
          : { status: 200, body: ACR };
      });
      api.on('GET', '/api/checklist', () => ({ status: 200, body: CHECKLIST }));
      api.on('POST', '/api/reviews', () => ({
        status: 201,
        body: {
          file: 'widedoor-review/x.yaml',
          id: 'wd_0123456789abcdef',
          asset: PAGE,
          overrides: [],
        },
      }));
      const reports = () => api.calls.filter((c) => c.call === 'GET /api/report').length;
      try {
        await page.goto(`http://127.0.0.1:${ui.port}/`);
        await page.getByText('Showing the report given to widedoor ui.').waitFor();

        // Cancel while the start request is on its way: the job it starts is cancelled at once.
        await showScreen(page, 'Scan', 'Scan pages and PDFs');
        await page.getByLabel('Web page URLs, one per line').fill(PAGE.uri);
        await page.getByRole('button', { name: 'Start scan' }).click();
        await poll(() => api.calls.some((c) => c.call === 'POST /api/scans')).toBe(true);
        await page.getByRole('button', { name: 'Cancel scan' }).click();
        releaseStart();
        await poll(() => status(page).innerText()).toBe('The scan was cancelled.');
        expect(api.calls.filter((c) => c.call === `DELETE /api/scans/${JOB}`)).toHaveLength(1);

        // A poll that answers late for a job that already ended does not end it twice.
        holdStart = false;
        cancelled = false;
        state = 'running';
        await page.getByRole('button', { name: 'Start scan' }).click();
        await poll(() => status(page).innerText()).toMatch(/^Scanning /);
        const reportsBefore = reports();
        holdNextPoll = true;
        await poll(() => releasePoll !== undefined).toBe(true);
        state = 'done';
        // Cancel answers 409 (ended) and follows again: that poll says done first.
        await page.getByRole('button', { name: 'Cancel scan' }).click();
        await poll(() => status(page).innerText()).toMatch(/^The scan finished\./);
        releasePoll?.();
        await page.waitForTimeout(500);
        expect(reports()).toBe(reportsBefore + 1);

        // Two quick Check again clicks: only the latest answer is shown, whatever order they come in.
        await showScreen(page, 'Export', 'Export the report');
        await page.getByText('The ACR is a draft. It is not complete because:').waitFor();
        const again = page.getByRole('button', { name: 'Check the ACR again' });
        await again.click();
        await again.click();
        await poll(() => acrReads).toBe(3);
        await page.waitForTimeout(2000);
        await page.getByText('The ACR is a draft. It is not complete because:').waitFor();
        expect(await page.getByText('The ACR is complete.').count()).toBe(0);

        // The review is recorded, but the report cannot be read again: Checklist says so.
        await showScreen(page, 'Checklist', 'Manual review checklist');
        const item = page.locator('li.item').first();
        await item.getByRole('button', { name: /^Record a result for / }).click();
        await item.getByLabel('Pass').check();
        await item.getByLabel('Reviewer name').fill('Ann');
        report = { status: 500, body: 'Server error. The widedoor ui terminal shows the cause.' };
        await item.getByRole('button', { name: 'Record result' }).click();
        await poll(() => page.getByRole('alert').filter({ hasText: /\S/ }).innerText()).toBe(
          'The report widedoor ui holds could not be loaded again. Server error. The widedoor ui terminal shows the cause.',
        );
        expect(await w.violations()).toEqual([]);
      } finally {
        await page.context().close();
      }
    },
    TIMEOUT,
  );
  // 3b.8 fix round 1 item 1: a failed run moves the focus to its error (WCAG 2.4.3).
  it(
    'move the focus to the error when AI suggestions fail, and re-enable the finding buttons',
    async () => {
      const { w, api } = await open();
      const { page } = w;
      api.on('GET', '/api/ai', () => ({
        status: 200,
        body: { available: true, provider: 'anthropic', model: 'fake-model' },
      }));
      api.on('GET', '/api/report', () => ({ status: 200, body: REPORT_BODY }));
      api.on('POST', '/api/suggestions', (_route, body) =>
        (JSON.parse(body) as { dryRun?: boolean }).dryRun
          ? {
              status: 200,
              body: {
                dryRun: true,
                provider: 'anthropic',
                model: 'fake-model',
                system: 'SYSTEM',
                messages: ['MESSAGE'],
                estimatedInputTokens: 10,
                skipped: 0,
              },
            }
          : { status: 502, body: 'The provider could not be reached.' },
      );
      try {
        await page.goto(`http://127.0.0.1:${ui.port}/`);
        await page.getByText('Showing the report given to widedoor ui.').waitFor();
        const suggest = page.getByRole('button', { name: /^Suggest a fix \(AI\)/ }).first();
        await suggest.focus();
        await page.keyboard.press('Enter');
        await page.locator('section.confirm').waitFor();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
        const alert = page.locator('p.error[role="alert"]').filter({ hasText: /suggestions/ });
        // The page words a 5xx itself; the server's text stays in its terminal.
        await poll(() => alert.innerText()).toMatch(/^The suggestions could not be made: \S/);
        await poll(() =>
          page.evaluate(() => document.activeElement?.getAttribute('role') ?? ''),
        ).toBe('alert');
        expect(await page.evaluate(() => document.activeElement?.textContent ?? '')).toBe(
          await alert.innerText(),
        );
        expect(await suggest.isDisabled()).toBe(false);
        expect(api.calls.filter((c) => c.call === 'POST /api/suggestions')).toHaveLength(2);
        expect(await w.violations()).toEqual([]);
      } finally {
        await page.context().close();
      }
    },
    TIMEOUT,
  );
});
