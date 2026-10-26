/// <reference lib="dom" />
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerImagePresent } from '@widedoor/pdf';
import { parseJsonReport } from '@widedoor/report';
import { launchChromium } from '@widedoor/web';
import { CORPUS, buildCli, buildUi, serveHtml, type StaticServer } from './helpers.ts';
import {
  checklistItem,
  expectAxeClean,
  showScreen,
  startUiAt,
  stopUi,
  watchedPage,
} from './ui-page.ts';

/*
 * The widedoor ui screens end to end, as a user works (npm run test:docker;
 * needs Docker with verapdf/cli:v1.30.3 and Chromium): in the page, scan two
 * corpus pages and an uploaded corpus PDF, record a pass and an override on
 * the Checklist screen, export OpenACR and VPAT HTML from the Export screen
 * and check the files hold both, then rescan and see the reviews still
 * counted. No CSP violation may happen at any point, every screen passes
 * axe, and the root ends up holding only the config and widedoor-review/.
 */

const TIMEOUT = 600_000;
const unsafeNoSandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1';
const PDF = 'clean-pdfua.pdf';
const FIRST = 'Pass Reviewer';
const DONE = 'Status: Done: a current manual result decides it';

let site: StaticServer;
let tmp: string;
let dist: string;
let browser: Browser;

beforeAll(async () => {
  if (!(await dockerImagePresent()))
    throw new Error(
      'Docker or verapdf/cli:v1.30.3 is missing; run docker pull verapdf/cli:v1.30.3',
    );
  buildCli();
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-ui-e2e-'));
  dist = join(tmp, 'dist');
  buildUi(dist);
  site = await serveHtml(join(CORPUS, 'web'));
  browser = await launchChromium({ unsafeNoSandbox });
}, TIMEOUT);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Starts a scan on the Scan screen with what its fields hold, and waits for it to finish. */
async function scan(page: Page, midScanAxe: boolean): Promise<void> {
  await showScreen(page, 'Scan', 'Scan pages and PDFs');
  await page.getByRole('button', { name: 'Start scan' }).click();
  // The Scan screen's status region (the hidden screens' regions are not in the tree).
  const status = page.locator('p.progress[role="status"]');
  if (midScanAxe) {
    const seen: string[] = [];
    for (let i = 0; i < 1200 && !seen.some((s) => /^Scanning \d+ of \d+: /.test(s)); i++) {
      const text = await status.innerText();
      if (seen.at(-1) !== text) seen.push(text);
      if (/^The scan finished\./.test(text)) break;
      await page.waitForTimeout(100);
    }
    expect(
      seen.filter((s) => /^Scanning \d+ of \d+: /.test(s)),
      seen.join(' | '),
    ).not.toEqual([]);
    await expectAxeClean(page, 'Scan, mid scan');
  }
  await expect.poll(() => status.innerText(), { timeout: 300_000 }).toMatch(/^The scan finished\./);
  expect(await page.getByRole('alert').innerText()).toBe('');
}

/** Saves an export from the Export screen and returns its text. */
async function save(page: Page, button: string, file: string): Promise<string> {
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: `${button} (${file})` }).click();
  const download = await saved;
  expect(download.suggestedFilename()).toBe(file);
  await page.getByText(`Downloaded ${file}.`).waitFor();
  return readFileSync(await download.path(), 'utf8');
}

describe('widedoor ui, scan to export in the page', () => {
  // A scan job always keeps the Chromium sandbox on, as widedoor scan does by default.
  it.skipIf(unsafeNoSandbox)(
    'scans pages and an uploaded PDF, records a pass and an override, exports and rescans',
    async () => {
      const root = join(tmp, 'project');
      mkdirSync(root);
      writeFileSync(
        join(root, 'widedoor.config.yaml'),
        'acr:\n  vendor: { name: Example Agency }\n  product: { name: Permit portal }\n',
      );
      const ui = await startUiAt(root, dist);
      const w = await watchedPage(browser);
      const { page } = w;
      const pages = ['alt-fail.html', 'labels-pass.html'].map((p) => `${site.origin}/${p}`);
      const altFail = pages[0] as string;
      try {
        await page.goto(ui.url);
        await page.getByText('widedoor ui was started without --report.').waitFor();

        // Scan: two pages and an uploaded PDF.
        await showScreen(page, 'Scan', 'Scan pages and PDFs');
        await page.getByLabel('Web page URLs, one per line').fill(pages.join('\n'));
        await page.getByLabel('PDF files').setInputFiles(join(CORPUS, 'pdf', PDF));
        await page.getByLabel('Profile').selectOption('508+wcag21aa');
        await page.getByText(`${PDF}: waiting`).waitFor();
        await scan(page, true);
        await page.getByText(`${PDF}: waiting`).waitFor();

        await showScreen(page, 'Report', 'Accessibility report');
        const byAsset = page.locator('section[aria-labelledby="by-asset"]');
        for (const uri of [...pages, PDF]) await byAsset.getByText(uri, { exact: true }).waitFor();
        await expectAxeClean(page, 'Report');

        // Checklist: a pass, then a pass that sets aside the page's automated fails.
        await showScreen(page, 'Checklist', 'Manual review checklist');
        await page.getByText(/^Showing \d+ of \d+ items\.$/).waitFor();
        await expectAxeClean(page, 'Checklist');
        const keyboard = checklistItem(page, altFail, /^WCAG 2\.1\.1 /);
        await keyboard.getByRole('button', { name: /^Record a result for / }).click();
        await keyboard.getByLabel('Pass').check();
        await keyboard.getByLabel('Reviewer name').fill(FIRST);
        await keyboard.getByLabel('Notes').fill('Reached and used every control by keyboard.');
        await expectAxeClean(page, 'Checklist, review form open');
        await keyboard.getByRole('button', { name: 'Record result' }).click();
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.textContent ?? ''))
          .toBe(DONE);

        const images = checklistItem(page, altFail, /^WCAG 1\.1\.1 /);
        expect(await images.locator('p.label').first().innerText()).toBe(
          'Status: Failed an automated check: a review is optional, and can set aside a false positive',
        );
        await images.getByRole('button', { name: /^Record a result for / }).click();
        // The name is remembered from the first record.
        expect(await images.getByLabel('Reviewer name').inputValue()).toBe(FIRST);
        await images.getByLabel('Pass').check();
        const fails = images.getByRole('checkbox');
        const failCount = await fails.count();
        expect(failCount).toBeGreaterThan(0);
        for (const box of await fails.all()) {
          expect(
            await box.evaluate((b) => (b as HTMLInputElement).labels?.[0]?.textContent ?? ''),
          ).toMatch(new RegExp(` on ${altFail.replace(/[.]/g, '\\.')}$`));
          await box.check();
        }
        await images.getByLabel('Notes').fill('The image is decorative; its empty alt is right.');
        await images.getByRole('button', { name: 'Record result' }).click();
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.textContent ?? ''))
          .toBe(DONE);
        await expectAxeClean(page, 'Checklist, after two records');

        // Export: the draft ACR and its reasons come before the buttons; the files hold both records.
        await showScreen(page, 'Export', 'Export the report');
        await page.getByText('The ACR is a draft. It is not complete because:').waitFor();
        // The hidden Report screen has the same note.
        await page
          .getByText('This report is kept only while widedoor ui runs. Export it to keep a copy.')
          .filter({ visible: true })
          .waitFor();
        await expectAxeClean(page, 'Export, draft');
        const report = parseJsonReport(await save(page, 'JSON report', 'report.json'));
        const records = report.findings.filter((f) => f.source.engine === 'manual');
        expect(records.map((f) => `${f.source.ruleId} ${f.outcome}`).sort()).toEqual([
          'wcag-1.1.1 pass',
          'wcag-2.1.1 pass',
        ]);
        const overridden = records.flatMap((f) =>
          'review' in f ? (f.review.overrides ?? []) : [],
        );
        expect(overridden).toHaveLength(failCount);
        const openacr = await save(page, 'ACR as OpenACR YAML', 'report.openacr.yaml');
        const vpat = await save(page, 'ACR as VPAT HTML', 'report.vpat.html');
        for (const [name, text] of [
          ['OpenACR', openacr],
          ['VPAT HTML', vpat],
        ] as const) {
          expect(text, name).toContain('Permit portal');
          expect(text, name).toContain(FIRST);
          expect(text, name).toContain('Automated fails a reviewer set aside as false positives');
          for (const id of overridden) expect(text, name).toContain(id);
        }

        // Rescan the same pages and PDF: both reviews still count.
        await scan(page, false);
        await showScreen(page, 'Checklist', 'Manual review checklist');
        await page.getByText(/^Showing \d+ of \d+ items\.$/).waitFor();
        for (const item of [
          checklistItem(page, altFail, /^WCAG 2\.1\.1 /),
          checklistItem(page, altFail, /^WCAG 1\.1\.1 /),
        ]) {
          expect(await item.locator('p.label').first().innerText()).toBe(DONE);
          await item.getByText(`Recorded: Pass, by ${FIRST} on `).waitFor();
        }
        // The override still sets aside every related automated fail of the new scan.
        const related = await checklistItem(page, altFail, /^WCAG 1\.1\.1 /)
          .getByText(/^axe-core \S+: fail/)
          .allInnerTexts();
        expect(related).toHaveLength(failCount);
        for (const line of related) expect(line).toMatch(/: fail \(set aside by a reviewer\)$/);
        await showScreen(page, 'Export', 'Export the report');
        const rescanned = parseJsonReport(await save(page, 'JSON report', 'report.json'));
        const stillFailing = new Set(
          rescanned.findings.filter((f) => f.outcome === 'fail').map((f) => f.id),
        );
        // The new scan found the same fails (same ids), and the record still names each of them.
        for (const id of overridden) expect(stillFailing.has(id), id).toBe(true);
        await showScreen(page, 'Report', 'Accessibility report');
        const doneRow = page
          .locator('section[aria-labelledby="manual"] tr')
          .filter({ hasText: 'Done (a current manual result decides it)' });
        expect(Number(await doneRow.locator('td').innerText())).toBeGreaterThanOrEqual(2);

        // Nothing but the config and the review records under the root; no violation, ever.
        expect(readdirSync(root).sort()).toEqual(['widedoor-review', 'widedoor.config.yaml']);
        expect(w.dialogs).toEqual([]);
        expect(w.errors).toEqual([]);
        expect(await w.violations()).toEqual([]);
      } finally {
        await page.context().close();
        await stopUi(ui);
      }
    },
    TIMEOUT,
  );
});
