/// <reference lib="dom" />
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Test code only: the package index does not export the fake provider.
import { createFakeProvider } from '../../ai/src/providers/fake.ts';
import { AiConfigSchema, loadStaticFiles, startLocalServer, type UiServer } from '@widedoor/server';
import { launchChromium } from '@widedoor/web';
import { localAi } from '../src/ai.ts';
import { CORPUS, buildUi, serveHtml, type StaticServer } from './helpers.ts';
import { expectAxeClean, showScreen, watchedPage } from './ui-page.ts';

/*
 * AI fix suggestions in the viewer, keyboard only (Task 3b.8): a real scan
 * of a corpus page from the Scan screen, a finding's "Suggest a fix (AI)",
 * the confirm step with Cancel focused, Send, the suggestion with its label,
 * and the JSON download. The local server runs in process so the fake
 * provider can come in through localAi's programmatic hook; no request
 * reaches a real provider, and the fake key in the environment shows nowhere.
 */

const TIMEOUT = 240_000;
const unsafeNoSandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1';
const FAKE_KEY = 'sk-ant-api03-FAKE-VIEWER-KEY-DO-NOT-SHOW';
const LABEL =
  'AI-generated. Review before use. Suggestions do not change any result in the report.';

let tmp: string;
let dist: string;
let site: StaticServer;
let browser: Browser;
let savedKey: string | undefined;

beforeAll(async () => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = FAKE_KEY;
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-ui-ai-'));
  dist = join(tmp, 'dist');
  buildUi(dist);
  site = await serveHtml(join(CORPUS, 'web'));
  browser = await launchChromium({ unsafeNoSandbox });
}, TIMEOUT);

afterAll(async () => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  await browser?.close();
  await site?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** The focused element's text, as a screen reader would start reading it. */
const activeText = (page: Page) =>
  page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');

/** Presses Tab from where the focus is until the focused element's text passes test; returns that text. */
async function tabTo(page: Page, test: (text: string) => boolean, max = 400): Promise<string> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const text = await activeText(page);
    if (test(text)) return text;
  }
  throw new Error(`Tab never reached the control (after ${max} presses)`);
}

describe('AI fix suggestions in widedoor ui', () => {
  it(
    'scans, confirms with Cancel first, shows the labelled suggestion and downloads the JSON',
    async () => {
      // The provider answers when the test says, so the focus can be seen while it works.
      let release: () => void = () => undefined;
      const answered = new Promise<void>((done) => (release = done));
      const provider = createFakeProvider(async () => {
        await answered;
        return {
          status: 'ok',
          text: JSON.stringify({
            kind: 'web-patch',
            summary: 'Give the image a text alternative.',
            patch: '<img src="logo.png" alt="Example Co">',
            notes: null,
          }),
          modelAnswered: 'fake-model',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      });
      const made = await localAi(AiConfigSchema.parse({ enabled: true }), {
        provider: () => provider,
      });
      if (!('ai' in made)) throw new Error(made.unavailable);
      const root = join(tmp, 'root');
      mkdirSync(root);
      const logs: string[] = [];
      let server: UiServer | undefined;
      const w = await watchedPage(browser);
      const { page } = w;
      try {
        server = await startLocalServer({
          files: loadStaticFiles(dist),
          root: { dir: root },
          ai: made.ai,
          log: (line) => void logs.push(line),
        });
        await page.goto(server.url);
        await page.getByText('widedoor ui was started without --report.').waitFor();
        // Without a report there is nothing to suggest for yet.
        expect(await page.getByRole('button', { name: /Suggest/ }).count()).toBe(0);

        // A real scan of the corpus page, typed and started with the keyboard.
        await showScreen(page, 'Scan', 'Scan pages and PDFs');
        await page.getByLabel('Web page URLs, one per line').focus();
        await page.keyboard.type(`${site.origin}/alt-fail.html`);
        await page.getByRole('button', { name: 'Start scan' }).focus();
        await page.keyboard.press('Enter');
        await expect
          .poll(() => page.locator('p.progress[role="status"]').innerText(), { timeout: 180_000 })
          .toMatch(/^The scan finished\./);
        await showScreen(page, 'Report', 'Accessibility report');

        // From the page heading, Tab to the first finding's button (3b.8 fix round 1 item 4).
        const opener = await tabTo(page, (text) => text.startsWith('Suggest a fix (AI)'));
        await page.keyboard.press('Enter');
        const confirm = page.locator('section.confirm');
        await confirm.waitFor();
        expect(await confirm.getByRole('heading', { level: 3 }).innerText()).toBe(
          'Send to anthropic (fake-model)?',
        );
        await expect.poll(() => activeText(page)).toBe('Cancel');
        // Every per-finding button is disabled while the step is open (item 2).
        const others = page.getByRole('button', { name: /^Suggest a fix \(AI\)/ });
        for (let i = 0; i < (await others.count()); i++)
          expect(await others.nth(i).isDisabled()).toBe(true);
        await expectAxeClean(page, 'Report, AI confirm');
        // Cancel sends nothing and gives the focus back to the button that opened the step (item 1).
        await page.keyboard.press('Enter');
        await page.getByText('Cancelled; nothing was sent.').waitFor();
        await expect.poll(() => activeText(page)).toBe(opener);
        expect(await others.first().isDisabled()).toBe(false);
        expect(provider.calls).toHaveLength(0);

        // Again from the same button, still focused: open what will be sent, then Tab to Send.
        await page.keyboard.press('Enter');
        await confirm.waitFor();
        await expect.poll(() => activeText(page)).toBe('Cancel');
        await page.keyboard.press('Shift+Tab');
        expect(await activeText(page)).toBe('Exactly what will be sent');
        await page.keyboard.press('Enter');
        const shown = await confirm.locator('pre').nth(1).innerText();
        await page.keyboard.press('Tab');
        expect(await activeText(page)).toBe('Cancel');
        await page.keyboard.press('Tab');
        expect(await activeText(page)).toBe('Send 1 request');
        await page.keyboard.press('Enter');
        // While the provider works, the focus is on the status line; then on the results heading.
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.getAttribute('role')))
          .toBe('status');
        expect(await activeText(page)).toBe('Asking for suggestions. This can take a minute.');
        release();
        const results = page.locator('section[aria-labelledby="ai-results"]');
        await results.waitFor({ timeout: 60_000 });
        await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('ai-results');
        expect(provider.calls).toHaveLength(1);
        expect(provider.calls[0]!.user.replace(/nonce="[0-9a-f]{32}"/g, '')).toBe(
          shown.replace(/nonce="0{32}"/g, ''),
        );
        expect(shown).not.toContain('alt-fail.html');

        // The suggestion is text, labelled, with the patch in <pre>; no link and no apply.
        const entry = results.locator('li.finding').first();
        expect(await entry.locator('p.label').innerText()).toBe(LABEL);
        expect(await entry.locator('pre').first().innerText()).toBe(
          '<img src="logo.png" alt="Example Co">',
        );
        expect(await results.locator('a').count()).toBe(0);
        expect(await results.getByRole('button', { name: /apply/i }).count()).toBe(0);
        await page.getByText(/^Suggestions ready: 1 of 1 groups got one\.$/).waitFor();
        await expectAxeClean(page, 'Report, AI results');

        // The JSON download: Tab from the results heading, then Enter.
        const saved = page.waitForEvent('download');
        await tabTo(page, (text) => text === 'Download ai-suggestions.json');
        await page.keyboard.press('Enter');
        const file = await saved;
        expect(file.suggestedFilename()).toBe('ai-suggestions.json');
        const json = readFileSync(await file.path(), 'utf8');
        const doc = JSON.parse(json) as { label: string; entries: { status: string }[] };
        expect(doc.label).toBe(LABEL);
        expect(doc.entries.map((e) => e.status)).toEqual(['ok']);

        expect(w.dialogs).toEqual([]);
        expect(w.errors).toEqual([]);
        expect(await w.violations()).toEqual([]);
        const everything = [json, await page.content(), ...logs].join('\n');
        expect(everything).not.toContain(FAKE_KEY);
      } finally {
        await page.context().close();
        await server?.close();
      }
    },
    TIMEOUT,
  );
});
