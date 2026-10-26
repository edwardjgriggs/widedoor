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
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChromium } from '@widedoor/web';
import { CORPUS, buildCli, buildUi, serveHtml, type StaticServer } from './helpers.ts';
import {
  checklistItem,
  expectAxeClean,
  expectKeyboardOperable,
  navButton,
  showScreen,
  startUiAt,
  stopUi,
  watchedPage,
} from './ui-page.ts';

/*
 * The widedoor ui screens in Chromium, with web pages only (the docker suite
 * adds an uploaded PDF and a rescan): every screen and state passes axe and
 * can be used from the keyboard, with a visible focus and no trap. A scan of
 * a page that never answers is shown mid scan and cancelled; a bad URL shows
 * the server's refusal; a scan of two corpus pages finishes, a pass is
 * recorded with the keyboard only, and the Export screen shows the draft ACR
 * and downloads a file. A page whose token is refused says the session ended.
 */

const TIMEOUT = 240_000;
const unsafeNoSandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1';
const TOKEN_KEY = 'widedoor-token';
const PAYLOAD = `</style></textarea><script>alert(1)</script>"><img src=x onerror=alert(2)>`;
/** A whole 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
/** A 1x1 GIF: not an image type a review takes. */
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

let site: StaticServer;
let tmp: string;
let dist: string;
let browser: Browser;
// A page that never answers, so a scan of it is still running when it is cancelled.
const held: ServerResponse[] = [];

beforeAll(async () => {
  buildCli();
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-ui-screens-'));
  dist = join(tmp, 'dist');
  buildUi(dist);
  site = await serveHtml(join(CORPUS, 'web'), { '/hang': (res) => void held.push(res) });
  browser = await launchChromium({ unsafeNoSandbox });
}, TIMEOUT);

afterAll(async () => {
  for (const res of held) res.destroy();
  await browser?.close();
  await site?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('the widedoor ui screens', () => {
  // A scan job always keeps the Chromium sandbox on, as widedoor scan does by default.
  it.skipIf(unsafeNoSandbox)(
    'pass axe and work from the keyboard on every screen and state',
    async () => {
      const root = join(tmp, 'screens');
      mkdirSync(root);
      writeFileSync(
        join(root, 'widedoor.config.yaml'),
        'acr:\n  vendor: { name: Example Agency }\n  product: { name: Test portal }\n',
      );
      const ui = await startUiAt(root, dist);
      const w = await watchedPage(browser);
      const { page } = w;
      try {
        await page.goto(ui.url);
        await page.getByText('widedoor ui was started without --report.').waitFor();
        await expectAxeClean(page, 'Report, no report');
        await expectKeyboardOperable(page, 'Report, no report');

        // Scan: a refused request shows the server's message in the alert region.
        await showScreen(page, 'Scan', 'Scan pages and PDFs');
        await expectAxeClean(page, 'Scan, idle');
        await expectKeyboardOperable(page, 'Scan, idle');
        const urls = page.getByLabel('Web page URLs, one per line');
        await urls.fill('ftp://site.example/\n');
        await page.getByText('1 URL listed.').waitFor();
        await page.getByRole('button', { name: 'Start scan' }).click();
        const alert = page.getByRole('alert');
        await expect
          .poll(() => alert.innerText())
          .toMatch(/^The scan could not start: the request is not valid: .*http or https URL/);
        await expectAxeClean(page, 'Scan, error shown');

        // Mid scan: progress in the status region, then a keyboard cancel.
        const hang = `${site.origin}/hang`;
        await urls.fill(`  ${hang}  \n\n`);
        await page.getByRole('button', { name: 'Start scan' }).click();
        const status = page.locator('p.progress[role="status"]');
        await expect
          .poll(() => status.innerText(), { timeout: 60_000 })
          .toBe(`Scanning 1 of 1: ${hang}`);
        expect(await alert.innerText()).toBe('');
        expect(await urls.isDisabled()).toBe(true);
        await expectAxeClean(page, 'Scan, mid scan');
        const cancel = page.getByRole('button', { name: 'Cancel scan' });
        await cancel.focus();
        await page.keyboard.press('Enter');
        await expect
          .poll(() => status.innerText(), { timeout: 60_000 })
          .toBe('The scan was cancelled.');

        // A real scan of two corpus pages; the Report screen gets its report.
        const pages = ['alt-fail.html', 'labels-pass.html'].map((p) => `${site.origin}/${p}`);
        await urls.fill(pages.join('\n'));
        await page.getByRole('button', { name: 'Start scan' }).click();
        await expect
          .poll(() => status.innerText(), { timeout: 180_000 })
          .toMatch(/^The scan finished\./);
        await showScreen(page, 'Report', 'Accessibility report');
        await page.getByText('Showing the report given to widedoor ui.').waitFor();
        await page
          .getByText('This report is kept only while widedoor ui runs. Export it to keep a copy.')
          .waitFor();
        await expectAxeClean(page, 'Report, after a scan');

        // Checklist: record a pass with the keyboard only.
        await showScreen(page, 'Checklist', 'Manual review checklist');
        await page.getByText(/^Showing \d+ of \d+ items\.$/).waitFor();
        await expectAxeClean(page, 'Checklist');
        await page.getByLabel('Status').selectOption('open');
        await expectKeyboardOperable(page, 'Checklist, open items');
        await page.getByLabel('Status').selectOption('all');
        const item = checklistItem(page, pages[0] as string, /^WCAG 2\.1\.1 /);
        const toggle = item.getByRole('button', { name: /^Record a result for / });
        await toggle.focus();
        await page.keyboard.press('Enter');
        expect(await toggle.getAttribute('aria-expanded')).toBe('true');
        await expectAxeClean(page, 'Checklist, review form open');
        await expectKeyboardOperable(page, 'Checklist, review form open');
        // Record with nothing chosen: the form says what is missing.
        await item.getByRole('button', { name: 'Record result' }).focus();
        await page.keyboard.press('Enter');
        await expect.poll(() => item.getByRole('alert').innerText()).toBe('Choose an outcome.');
        await expectAxeClean(page, 'Checklist, review error shown');
        await item.getByLabel('Pass').focus();
        await page.keyboard.press('Space');
        await item.getByLabel('Notes').focus();
        await page.keyboard.type('Tabbed through every control.');
        await item.getByLabel('Reviewer name').focus();
        await page.keyboard.type('Keyboard Reviewer');
        await item.getByRole('button', { name: 'Record result' }).focus();
        await page.keyboard.press('Enter');
        // Focus moves to the item's new status.
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.textContent ?? ''))
          .toBe('Status: Done: a current manual result decides it');
        expect(await toggle.getAttribute('aria-expanded')).toBe('false');
        expect(await page.evaluate((k) => localStorage.getItem(k), 'widedoor-reviewer')).toBe(
          'Keyboard Reviewer',
        );

        // Images: a GIF is refused with the server's own text and nothing is written; a PNG is recorded.
        const attachments = join(root, 'widedoor-review', 'attachments');
        const second = checklistItem(page, pages[1] as string, /^WCAG 2\.1\.1 /);
        await second.getByRole('button', { name: /^Record a result for / }).click();
        expect(await second.getByLabel('Reviewer name').inputValue()).toBe('Keyboard Reviewer');
        await second.getByLabel('Pass').check();
        await second
          .getByLabel('Notes')
          .fill('Every control works by keyboard; a photo is attached.');
        const images = second.getByLabel('Images to attach (PNG or JPEG, optional)');
        await images.setInputFiles([
          { name: 'focus.png', mimeType: 'image/png', buffer: PNG },
          { name: 'anim.gif', mimeType: 'image/gif', buffer: GIF },
        ]);
        await second.getByRole('button', { name: 'Record result' }).click();
        await expect
          .poll(() => second.getByRole('alert').innerText())
          .toMatch(/^anim\.gif could not be attached: an upload must be sent as .*image\/png/);
        await second.getByText('anim.gif: refused (see the message below)').waitFor();
        await second.getByText('focus.png: uploaded').waitFor();
        expect(existsSync(attachments)).toBe(false);
        await expectAxeClean(page, 'Checklist, attachment refused');
        await images.setInputFiles([{ name: 'focus.png', mimeType: 'image/png', buffer: PNG }]);
        await second.getByRole('button', { name: 'Record result' }).click();
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.textContent ?? ''))
          .toBe('Status: Done: a current manual result decides it');
        expect(readdirSync(attachments).filter((f) => f.endsWith('.png'))).toHaveLength(1);
        await second.getByText(/1 image attached\.$/).waitFor();

        // Export: the draft ACR and its reasons, then a download.
        await showScreen(page, 'Export', 'Export the report');
        await page.getByText('The ACR is a draft. It is not complete because:').waitFor();
        expect(await page.getByText('acr.vendor.contact is not set').count()).toBe(1);
        await expectAxeClean(page, 'Export, draft');
        await expectKeyboardOperable(page, 'Export, draft');
        const saved = page.waitForEvent('download');
        await page.getByRole('button', { name: 'ACR as VPAT HTML (report.vpat.html)' }).click();
        const file = await saved;
        expect(file.suggestedFilename()).toBe('report.vpat.html');
        expect(readFileSync(await file.path(), 'utf8')).toContain('Keyboard Reviewer');
        await page.getByText('Downloaded report.vpat.html.').waitFor();
        // The HTML report embeds the attached image.
        const html = page.waitForEvent('download');
        await page.getByRole('button', { name: 'HTML report (report.html)' }).click();
        expect(readFileSync(await (await html).path(), 'utf8')).toContain(
          `data:image/png;base64,${PNG.toString('base64')}`,
        );

        // Only the reviews were written under the root.
        expect(readdirSync(root).sort()).toEqual(['widedoor-review', 'widedoor.config.yaml']);
        expect(w.dialogs).toEqual([]);
        // The console errors are Chromium's own lines for the refused ftp: scan and GIF.
        expect(w.errors).toEqual([
          'Failed to load resource: the server responded with a status of 400 (Bad Request)',
          'Failed to load resource: the server responded with a status of 415 (Unsupported Media Type)',
        ]);
        expect(await w.violations()).toEqual([]);
      } finally {
        await page.context().close();
        await stopUi(ui);
      }
    },
    TIMEOUT,
  );

  it(
    'say the session has ended when the token is refused, and stop',
    async () => {
      const root = join(tmp, 'ended');
      mkdirSync(root);
      const ui = await startUiAt(root, dist);
      const w = await watchedPage(browser);
      const { page } = w;
      try {
        await page.addInitScript((key) => sessionStorage.setItem(key, 'not-the-token'), TOKEN_KEY);
        await page.goto(`http://127.0.0.1:${ui.port}/`);
        const ended = "This page's session has ended. Run widedoor ui again.";
        await page.locator('p.lead', { hasText: ended }).waitFor();
        await showScreen(page, 'Scan', 'Scan pages and PDFs');
        // A 401 at the first call ends the session for every screen: none of them asks again.
        expect(await page.getByRole('alert').innerText()).toBe(ended);
        expect(await page.getByLabel('Web page URLs, one per line').count()).toBe(0);
        await showScreen(page, 'Export', 'Export the report');
        expect(await page.getByRole('button', { name: /report\.json/ }).count()).toBe(0);
        await expectAxeClean(page, 'Session ended');
        expect(await navButton(page, 'Report').isVisible()).toBe(true);
        expect(w.errors.filter((e) => !/401/.test(e))).toEqual([]);
        expect(await w.violations()).toEqual([]);
      } finally {
        await page.context().close();
        await stopUi(ui);
      }
    },
    TIMEOUT,
  );

  it(
    'record a CSP violation when one happens, so the empty lists above mean something',
    async () => {
      const root = join(tmp, 'control');
      mkdirSync(root);
      const ui = await startUiAt(root, dist);
      const w = await watchedPage(browser);
      try {
        await w.page.goto(ui.url);
        await w.page.getByText('widedoor ui was started without --report.').waitFor();
        expect(await w.violations()).toEqual([]);
        // Trusted Types with no policy: a string to innerHTML throws and is reported.
        const threw = await w.page.evaluate(() => {
          try {
            document.createElement('div').innerHTML = '<b>x</b>';
            return false;
          } catch {
            return true;
          }
        });
        expect(threw).toBe(true);
        await expect.poll(() => w.violations()).toHaveLength(1);
        expect((await w.violations())[0]).toMatch(/^require-trusted-types-for /);
      } finally {
        await w.page.context().close();
        await stopUi(ui);
      }
    },
    TIMEOUT,
  );

  it.skipIf(unsafeNoSandbox)(
    'show hostile scanned and review strings on every screen as text only, under the CSP',
    async () => {
      const root = join(tmp, 'hostile');
      mkdirSync(root);
      const ui = await startUiAt(root, dist);
      const w = await watchedPage(browser);
      const { page } = w;
      const MARK = String.fromCharCode(0x202e);
      const BELL = String.fromCharCode(0x7);
      /** Nothing from content became markup, a link, an image or a handler; axe still passes. */
      const expectInert = async (state: string) => {
        const dom = await page.evaluate(() => ({
          scripts: document.scripts.length,
          handlers: [...document.querySelectorAll('*')].flatMap((e) =>
            [...e.attributes].filter((a) => a.name.startsWith('on')).map((a) => a.name),
          ),
          hrefs: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
          images: [...document.querySelectorAll('img')].map((i) => i.getAttribute('src')),
          frames: document.querySelectorAll('iframe, object, embed, svg, base, form').length,
        }));
        expect(dom.scripts, state).toBe(1);
        expect(dom.handlers, state).toEqual([]);
        expect(
          dom.hrefs.filter((h) => !/^https:\/\//.test(h ?? '')),
          state,
        ).toEqual([]);
        expect(
          dom.images.filter((i) => !/^data:image\//.test(i ?? '')),
          state,
        ).toEqual([]);
        expect(dom.frames, state).toBe(0);
        expect(await page.locator('body').innerText(), state).not.toContain(MARK);
        await expectAxeClean(page, state);
      };
      try {
        await page.goto(ui.url);
        await page.getByText('widedoor ui was started without --report.').waitFor();

        // A URL whose query is markup, in the status region mid scan.
        await showScreen(page, 'Scan', 'Scan pages and PDFs');
        const urls = page.getByLabel('Web page URLs, one per line');
        const status = page.locator('p.progress[role="status"]');
        await urls.fill(`${site.origin}/hang?q="><img src=x onerror=alert(1)>${MARK}`);
        await page.getByRole('button', { name: 'Start scan' }).click();
        await expect
          .poll(() => status.innerText(), { timeout: 60_000 })
          .toMatch(/^Scanning 1 of 1: .*onerror/);
        await expectInert('Scan, mid scan');
        await page.getByRole('button', { name: 'Cancel scan' }).click();
        await expect
          .poll(() => status.innerText(), { timeout: 60_000 })
          .toBe('The scan was cancelled.');

        // The corpus XSS page under a URL that is markup itself: its title, snippets and links are hostile.
        const xss = `${site.origin}/xss.html?q="><script>alert(3)</script>`;
        await urls.fill(`${xss}\n${site.origin}/alt-fail.html`);
        await page.getByRole('button', { name: 'Start scan' }).click();
        await expect
          .poll(() => status.innerText(), { timeout: 180_000 })
          .toMatch(/^The scan finished\./);

        // A review whose name and notes are hostile, recorded and shown on the Checklist and Report.
        await showScreen(page, 'Checklist', 'Manual review checklist');
        await page.getByText(/^Showing \d+ of \d+ items\.$/).waitFor();
        // The page's URI as the scan recorded it (the server's URL parser encodes the query).
        const item = page
          .locator('section[aria-labelledby^="ck-group-"]', {
            has: page.getByRole('heading', { level: 3, name: /\/xss\.html\?q=/ }),
          })
          .locator('li.item', {
            has: page.getByRole('heading', { level: 4, name: /^WCAG 2\.1\.1 / }),
          });
        await item.getByRole('button', { name: /^Record a result for / }).click();
        await expectInert('Checklist, form open');
        await item.getByLabel('Pass').check();
        await item.getByLabel('Reviewer name').fill(`Ada ${PAYLOAD}${MARK}`);
        await item.getByLabel('Notes').fill(`javascript:alert(4) ${PAYLOAD}${BELL}`);
        await item.getByRole('button', { name: 'Record result' }).click();
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.textContent ?? ''))
          .toBe('Status: Done: a current manual result decides it');
        const record = await item.getByText(/^Recorded: Pass, by Ada /).innerText();
        expect(record).toContain(`${PAYLOAD}[U+202E]`);
        expect(record).toContain(`javascript:alert(4) ${PAYLOAD}[U+0007]`);
        await expectInert('Checklist, after a hostile record');

        await showScreen(page, 'Report', 'Accessibility report');
        const body = await page.locator('body').innerText();
        expect(body).toContain(`Ada ${PAYLOAD}[U+202E]`);
        expect(body).toContain('[U+202E]gnp.exe[U+202C]');
        await expectInert('Report');

        await showScreen(page, 'Export', 'Export the report');
        await page.getByText(/^An ACR cannot be exported: /).waitFor();
        await expectInert('Export');

        expect(w.dialogs).toEqual([]);
        // Chromium's own line for the ACR state with no config (422), and nothing else.
        expect(w.errors).toEqual([
          'Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)',
        ]);
        expect(await w.violations()).toEqual([]);
      } finally {
        await page.context().close();
        await stopUi(ui);
      }
    },
    TIMEOUT,
  );
});
