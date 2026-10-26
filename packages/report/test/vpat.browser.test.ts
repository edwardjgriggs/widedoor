import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProfile, type Finding } from '@widedoor/core';
import { WebScanner, launchChromium, type PageScan } from '@widedoor/web';
import { buildAcr, buildScanReport, renderVpatHtml, type ScanReport } from '../src/index.ts';
import { HOSTILE_META, META, passEverything } from './acr-fixture.ts';

/*
 * The VPAT HTML of a real scan of corpus pages (xss.html among them), as a
 * draft and, with a manual pass recorded for every row, as a complete ACR,
 * must pass axe with zero violations in Chromium, with every rule axe runs by
 * default (the same run as the viewer's check in ui.browser.test.ts). Offline:
 * every http(s) request is blocked and file: URLs stay inside corpus/.
 */

const corpus = fileURLToPath(new URL('../../../corpus/', import.meta.url));
const PAGES = ['xss.html', 'alt-fail.html', 'labels-pass.html'].map(
  (p) => pathToFileURL(join(corpus, 'web', p)).href,
);
const unsafeNoSandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1';

let dir: string;
let browser: Browser;
let scans: PageScan[];
let engineVersion: string;

const report = (reviews: readonly Finding[] = []): ScanReport =>
  buildScanReport({
    profile: getProfile('508'),
    startedAt: '2026-10-23T12:00:00.000Z',
    finishedAt: '2026-10-23T12:01:00.000Z',
    scope: { web: { urls: PAGES, truncated: false } },
    web: {
      engine: { name: 'axe-core', version: engineVersion },
      assets: scans.flatMap((s) => (s.asset ? [s.asset] : [])),
      findings: scans.flatMap((s) => s.findings),
      errors: [],
      skipped: [],
      warnings: [],
      truncated: false,
      pages: scans,
    },
    reviews,
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'widedoor-vpat-'));
  const scanner = await WebScanner.launch({
    fileRoot: corpus,
    evidenceDir: dir,
    intercept: () => 'abort',
    unsafeNoSandbox,
  });
  try {
    scans = [];
    for (const page of PAGES) scans.push(await scanner.scanPage(page));
    engineVersion = scanner.engineVersion;
  } finally {
    await scanner.close();
  }
  browser = await launchChromium({ unsafeNoSandbox });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function violations(name: string, page: string): Promise<string[]> {
  const file = join(dir, name);
  writeFileSync(file, page);
  const context = await browser.newContext({ javaScriptEnabled: true });
  try {
    const tab = await context.newPage();
    await tab.goto(pathToFileURL(file).href);
    expect(await tab.locator('h1').count()).toBe(1);
    const results = await new AxeBuilder({ page: tab }).analyze();
    // axe ran its table and heading rules on the page, so zero violations means something.
    expect(results.passes.map((p) => p.id)).toEqual(
      expect.arrayContaining(['th-has-data-cells', 'heading-order', 'region', 'html-has-lang']),
    );
    return results.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
    );
  } finally {
    await context.close();
  }
}

describe('VPAT HTML of a corpus scan in Chromium', () => {
  it('scans the pages without errors', () => {
    expect(scans.map((s) => s.error)).toEqual(PAGES.map(() => undefined));
  });

  it('passes axe as a draft, hostile metadata included', async () => {
    const acr = buildAcr(report(), HOSTILE_META);
    expect(acr.complete).toBe(false);
    expect(await violations('draft.html', renderVpatHtml(acr))).toEqual([]);
  });

  it('passes axe as a complete ACR', async () => {
    const assets = scans.flatMap((s) => (s.asset ? [s.asset] : []));
    const acr = buildAcr(report(passEverything(assets)), META);
    expect(acr.incomplete).toEqual([]);
    expect(acr.complete).toBe(true);
    expect(await violations('complete.html', renderVpatHtml(acr))).toEqual([]);
  });
});
