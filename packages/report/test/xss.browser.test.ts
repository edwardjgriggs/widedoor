import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProfile } from '@widedoor/core';
import { WebScanner, type PageScan } from '@widedoor/web';
import { buildScanReport, renderHtml, type ScanReport } from '../src/index.ts';
import { expectInert } from './inert.ts';

/*
 * End to end: the shipped web adapter scans corpus/web/xss.html (hostile alt
 * text, titles, aria-label and content), with screenshots on, and the HTML
 * report built from that scan must be inert. Offline: every http(s) request
 * is blocked and file: URLs stay inside corpus/.
 */

const corpus = fileURLToPath(new URL('../../../corpus/', import.meta.url));
const page = pathToFileURL(join(corpus, 'web', 'xss.html')).href;
const unsafeNoSandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1';

let evidence: string;
let scan: PageScan;
let report: ScanReport;
let output: string;

beforeAll(async () => {
  evidence = mkdtempSync(join(tmpdir(), 'widedoor-xss-'));
  const scanner = await WebScanner.launch({
    fileRoot: corpus,
    evidenceDir: evidence,
    intercept: () => 'abort',
    unsafeNoSandbox,
  });
  try {
    scan = await scanner.scanPage(page);
  } finally {
    await scanner.close();
  }
  report = buildScanReport({
    profile: getProfile('508+wcag21aa'),
    startedAt: '2026-10-22T12:00:00.000Z',
    finishedAt: '2026-10-22T12:01:00.000Z',
    scope: { web: { urls: [page], truncated: false } },
    web: {
      engine: { name: 'axe-core', version: scanner.engineVersion },
      assets: scan.asset ? [scan.asset] : [],
      findings: scan.findings,
      errors: scan.error ? [scan.error] : [],
      skipped: [],
      warnings: [...scanner.warnings],
      truncated: false,
      pages: [scan],
    },
  });
  output = renderHtml(report, { evidenceDir: evidence });
}, 60_000);

afterAll(() => {
  if (evidence) rmSync(evidence, { recursive: true, force: true });
});

const textOf = (html: string) => {
  const parts: string[] = [];
  const visit = (n: DefaultTreeAdapterMap['node']) => {
    if (n.nodeName === '#text' && 'value' in n) parts.push(n.value);
    if ('tagName' in n && n.tagName === 'style') return;
    if ('childNodes' in n) n.childNodes.forEach(visit);
  };
  parse(html).childNodes.forEach(visit);
  return parts.join('');
};

describe('HTML report of a scan of corpus/web/xss.html', () => {
  it('scans the page and carries its hostile strings into the report', () => {
    expect(scan.error).toBeUndefined();
    const snippets = report.findings.map((f) => f.evidence?.snippet ?? '').join('\n');
    // axe truncates long elements to their start tag without escaping attribute values.
    expect(snippets).toContain('aria-label=""><svg onload=alert(9)>');
    expect(snippets).toContain('href="javascript:alert(5)"');
    expect(snippets).toContain(String.fromCharCode(0x202e));
    expect(report.findings.filter((f) => f.outcome === 'fail').length).toBeGreaterThanOrEqual(3);
  });

  it('is inert: no script elements, no on* attributes, no javascript: URLs, CSP first in head', () => {
    const r = expectInert(output);
    expect(r.images.length, 'embedded screenshots').toBeGreaterThan(0);
  });

  it('shows the hostile strings as visible text, with bidi and control characters marked', () => {
    const text = textOf(output);
    expect(text).toContain('aria-label=""><svg onload=alert(9)>');
    expect(text).toContain('href="javascript:alert(5)"');
    expect(text).toContain('[U+202E]gnp.exe[U+202C]');
    expect(text).toContain('[U+001B][31m[U+0007]');
    expect(text).not.toContain(String.fromCharCode(0x202e));
  });

  it('heads the page section with the crafted document title, as text', () => {
    const title = "</title><script>alert('title')</script> \"><img src=x onerror=alert('title')>";
    expect(scan.title).toBe(title);
    expect(report.titles).toEqual([{ uri: scan.asset?.uri, title }]);
    expect(textOf(output)).toContain(title);
  });
});
