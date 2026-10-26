import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import {
  FindingSchema,
  findingId,
  type AssetKind,
  type Finding,
  type Location,
} from '@widedoor/core';
import { checkOpenAcrCatalog, parseJsonReport } from '@widedoor/report';
import {
  CORPUS,
  alive,
  buildCli,
  descendants,
  envWithoutTools,
  interrupt,
  openAcrValidator,
  runCli,
  serveHtml,
  waitFor,
  type StaticServer,
} from './helpers.ts';

/*
 * The built bin as a child process, zero-config (no widedoor.config.yaml):
 * corpus pages served over HTTP on 127.0.0.1, never the internet. No Docker:
 * the PDF case here is the one where veraPDF is missing.
 */

const TIMEOUT = 120_000;
const PDF_BYTES = readFileSync(join(CORPUS, 'pdf', 'untagged.pdf'));
const sandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1' ? ['--unsafe-no-sandbox'] : [];
let site: StaticServer;
let other: StaticServer;
let otherHits = 0;
let tmp: string;
let hangs = 0;
let docHits = 0;
let pdfHangs = 0;

beforeAll(async () => {
  buildCli();
  other = await serveHtml(join(CORPUS, 'web'), {
    '/x.pdf': (res) => {
      otherHits++;
      res.writeHead(200, { 'content-type': 'application/pdf' }).end(PDF_BYTES);
    },
  });
  site = await serveHtml(join(CORPUS, 'web'), {
    '/doc.pdf': (res) => {
      docHits++;
      res.writeHead(200, { 'content-type': 'application/pdf' }).end(PDF_BYTES);
    },
    // Starts a PDF and never finishes it, so the fetch is in its temp file when the interrupt comes.
    '/hang.pdf': (res) => {
      pdfHangs++;
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.write(PDF_BYTES.subarray(0, 1024));
    },
    // An HTML page with a PDF name and type: only the bytes decide.
    '/fake.pdf': (res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' }).end('<!doctype html><p>no</p>');
    },
    '/away.pdf': (res) => {
      res.writeHead(302, { location: `${other.origin}/x.pdf` }).end();
    },
    '/pdf-links.html': (res) => {
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          '<!doctype html><html lang="en"><head><title>PDF links</title></head><body><main><h1>PDF links</h1><a href="/doc.pdf">doc</a> <a href="/away.pdf">away</a></main></body></html>',
        );
    },
    // Sends headers and never finishes the body, so the browser is busy when the interrupt comes.
    '/hang.html': (res) => {
      hangs++;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<!doctype html><html lang="en"><head><title>Hang</title>');
    },
    // Thousands of PDF links, hidden so axe has little to check.
    '/many-pdfs.html': (res) => {
      const links = Array.from({ length: 3_000 }, (_, i) => `<a href="/f/${i}.pdf">f${i}</a>`);
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          `<!doctype html><html lang="en"><head><title>PDFs</title></head><body><main><h1>PDFs</h1><div hidden>${links.join(' ')}</div></main></body></html>`,
        );
    },
  });
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-cli-'));
}, TIMEOUT);

afterAll(async () => {
  await site?.close();
  await other?.close();
  // Windows can hold a just-closed file for a moment (antivirus, indexer): retry the cleanup.
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const out = (name: string) => join(tmp, name);
const scan = (args: string[], cwd = tmp) => runCli(['scan', ...args, ...sandbox], { cwd });

/** An environment with no veraPDF and its own temp folder, so leftover temp files show. */
const noVerapdf = (temp: string): NodeJS.ProcessEnv => {
  mkdirSync(temp, { recursive: true });
  return {
    ...envWithoutTools(),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH !== undefined
      ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
      : {}),
  };
};

describe('zero-config scans', () => {
  it(
    'exits 1 on a failed check at or above the threshold and writes every format',
    async () => {
      const r = await scan([`${site.origin}/alt-fail.html`, '--out', out('fail')]);
      expect(r.code, r.stderr).toBe(1);
      expect(r.stdout).toMatch(/Exit 1: \d+ failed checks? at or above serious\./);
      for (const ext of ['html', 'json', 'sarif'])
        expect(existsSync(join(out('fail'), `report.${ext}`))).toBe(true);
      // JUnit is opt-in.
      expect(existsSync(join(out('fail'), 'report.junit.xml'))).toBe(false);
      const report = parseJsonReport(readFileSync(join(out('fail'), 'report.json'), 'utf8'));
      expect(report.assets.map((a) => a.uri)).toEqual([`${site.origin}/alt-fail.html`]);
      expect(report.profile.id).toBe('508+wcag21aa');
    },
    TIMEOUT,
  );

  it(
    'writes report.junit.xml with --format junit',
    async () => {
      const page = `${site.origin}/alt-fail.html`;
      const r = await scan([page, '--out', out('junit'), '--format', 'junit']);
      expect(r.code, r.stderr).toBe(1);
      expect(readdirSync(out('junit')).sort()).toEqual([
        '.widedoor-report',
        'evidence',
        'report.junit.xml',
      ]);
      const xml = readFileSync(join(out('junit'), 'report.junit.xml'), 'utf8');
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites ')).toBe(true);
      expect(xml).toContain(`<testsuite name="${page}" `);
      expect(xml).toMatch(
        /<testcase classname="Section 508" name="1\.1\.1 Non-text Content">\n\s+<failure /,
      );
      expect(r.stdout).toContain(join(out('junit'), 'report.junit.xml'));
    },
    TIMEOUT,
  );

  it(
    'writes report.openacr.yaml, report.vpat.html and report.vpat.docx for corpus pages, the YAML valid under the OpenACR schema and catalog',
    async () => {
      const dir = mkdtempSync(join(tmp, 'acr-'));
      writeFileSync(
        join(dir, 'widedoor.config.yaml'),
        [
          `web:\n  urls: [${site.origin}/alt-fail.html, ${site.origin}/alt-pass.html, ${site.origin}/title-pass.html]`,
          'acr:',
          '  vendor: { name: Example Agency, contact: accessibility@example.gov }',
          '  product: { name: Permit portal, version: "2.10", description: Online permits. }',
          '  reportDate: 2026-10-23',
          '',
        ].join('\n'),
      );
      const r = await scan(
        ['--out', join(dir, 'out'), '--format', 'openacr,vpat-html,vpat-docx,json'],
        dir,
      );
      expect(r.code, r.stderr).toBe(1);
      expect(readdirSync(join(dir, 'out')).sort()).toEqual([
        '.widedoor-report',
        'evidence',
        'report.json',
        'report.openacr.yaml',
        'report.vpat.docx',
        'report.vpat.html',
      ]);
      expect(r.stdout).toContain(join(dir, 'out', 'report.openacr.yaml'));
      expect(r.stdout).toContain(join(dir, 'out', 'report.vpat.html'));
      expect(r.stdout).toContain(join(dir, 'out', 'report.vpat.docx'));
      // The same draft ACR in the VPAT layout, without the VPAT name.
      const vpat = readFileSync(join(dir, 'out', 'report.vpat.html'), 'utf8');
      expect(vpat).toContain('<h1>DRAFT Example Agency Accessibility Conformance Report</h1>');
      expect(vpat).toContain('Name of Product/Version:</span> Permit portal, version 2.10');
      expect(vpat).not.toContain('VPAT');
      const docx = readFileSync(join(dir, 'out', 'report.vpat.docx'));
      expect(docx.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
      const text = readFileSync(join(dir, 'out', 'report.openacr.yaml'), 'utf8');
      const doc = parse(text);
      const validate = openAcrValidator();
      expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
      expect(checkOpenAcrCatalog(doc)).toEqual([]);
      expect(doc.title).toBe('DRAFT Example Agency Accessibility Conformance Report');
      expect(doc.product).toEqual({
        name: 'Permit portal',
        version: '2.10',
        description: 'Online permits.',
      });
      expect(doc.report_date).toBe('2026-10-23');
      const table1 = doc.chapters.success_criteria_level_a.criteria;
      const c111 = table1.find((c: { num: string }) => c.num === '1.1.1');
      expect(c111.components[0].name).toBe('web');
      expect(['does-not-support', 'partially-supports']).toContain(
        c111.components[0].adherence.level,
      );
      expect(c111.components[0].adherence.notes).toContain(`Fails on ${site.origin}/alt-fail.html`);
      const c411 = table1.find((c: { num: string }) => c.num === '4.1.1');
      expect(c411.components[0].adherence.level).toBe('supports');
      expect(c411.components[0].adherence.notes).toMatch(/on the errata basis/);
      // The same scan as the JSON report: generated from its timestamp.
      const report = parseJsonReport(readFileSync(join(dir, 'out', 'report.json'), 'utf8'));
      expect(report.profile.id).toBe('508+wcag21aa');
    },
    TIMEOUT,
  );

  it('exits 2 before scanning for an ACR format without acr.product.name or a 508 profile', async () => {
    const page = `${site.origin}/alt-pass.html`;
    const noName = await scan([page, '--out', out('acr-no-name'), '--format', 'openacr']);
    expect(noName.code).toBe(2);
    expect(noName.stderr).toContain(
      'the openacr format needs acr.product.name in a config file (none was given or found)',
    );
    const dir = mkdtempSync(join(tmp, 'acr-wcag-'));
    writeFileSync(join(dir, 'widedoor.config.yaml'), 'acr:\n  product: { name: Portal }\n');
    const wcag = await scan(
      [page, '--out', join(dir, 'out'), '--format', 'openacr', '--profile', 'wcag21aa'],
      dir,
    );
    expect(wcag.code).toBe(2);
    expect(wcag.stderr).toContain(
      'which profile wcag21aa does not have; use --profile 508 or 508+wcag21aa',
    );
    const docxNoName = await scan([page, '--out', out('acr-no-name'), '--format', 'vpat-docx']);
    expect(docxNoName.code).toBe(2);
    expect(docxNoName.stderr).toContain('the vpat-docx format needs acr.product.name');
    expect(existsSync(out('acr-no-name'))).toBe(false);
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });

  it(
    'exits 0 when the fails are below --fail-on, and with --fail-on none',
    async () => {
      // contrast-fail fails color-contrast, which axe rates serious: below --fail-on critical.
      const below = await scan([
        `${site.origin}/contrast-fail.html`,
        '--out',
        out('c'),
        '--fail-on',
        'critical',
        '--format',
        'json',
      ]);
      const report = parseJsonReport(readFileSync(join(out('c'), 'report.json'), 'utf8'));
      const impacts = report.findings.filter((f) => f.outcome === 'fail').map((f) => f.impact);
      expect(impacts.length).toBeGreaterThan(0);
      expect(impacts).not.toContain('critical');
      expect(below.code, below.stdout).toBe(0);
      expect(below.stdout).toContain('Exit 0: no failed check at or above critical.');
      const none = await scan([
        `${site.origin}/alt-fail.html`,
        '--out',
        out('n'),
        '--fail-on',
        'none',
        '--format',
        'json',
      ]);
      expect(none.code).toBe(0);
      expect(none.stdout).toContain('Exit 0: the fail threshold is off');
      expect(existsSync(join(out('n'), 'report.html'))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'exits 0 for a clean page and for a page with needs-review results only',
    async () => {
      const r = await scan([
        `${site.origin}/alt-pass.html`,
        `${site.origin}/landmarks-fail.html`,
        '--out',
        out('clean'),
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const report = parseJsonReport(readFileSync(join(out('clean'), 'report.json'), 'utf8'));
      expect(report.findings.some((f) => f.outcome === 'needs-review')).toBe(true);
      expect(report.findings.some((f) => f.outcome === 'fail')).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'exits 2 when a page cannot be scanned, after writing the reports',
    async () => {
      const r = await scan([
        `${site.origin}/alt-pass.html`,
        `${site.origin}/missing.html`,
        '--out',
        out('err'),
      ]);
      expect(r.code).toBe(2);
      expect(r.stdout).toContain('Exit 2: 1 scan error');
      const report = parseJsonReport(readFileSync(join(out('err'), 'report.json'), 'utf8'));
      expect(report.errors.map((e) => e.uri)).toEqual([`${site.origin}/missing.html`]);
    },
    TIMEOUT,
  );

  it(
    'fetches the PDF links a page carries, at most 100 from one page, and counts the rest',
    async () => {
      const dir = mkdtempSync(join(tmp, 'many-'));
      writeFileSync(
        join(dir, 'widedoor.config.yaml'),
        `web:\n  urls: [${site.origin}/many-pdfs.html]\n  crawl: { maxPages: 3 }\n`,
      );
      const r = await runCli(['scan', '--out', join(dir, 'out'), ...sandbox], {
        cwd: dir,
        env: noVerapdf(join(dir, 'temp')),
      });
      // The links lead nowhere (404): each fetched one is a scan error.
      expect(r.code, r.stderr).toBe(2);
      expect(r.stdout).toContain(
        `Scan error: ${site.origin}/f/0.pdf (and 99 others): pdf-fetch-failed: the server answered 404`,
      );
      expect(r.stdout).toContain(
        'Warning: 2900 PDF link(s) were not scanned: at most 100 are taken from one page',
      );
      const report = parseJsonReport(readFileSync(join(dir, 'out', 'report.json'), 'utf8'));
      expect(report.errors.filter((e) => e.kind === 'pdf')).toHaveLength(100);
      expect(report.skipped).toEqual([]);
      expect(report.scopeGaps).toContain(
        '2900 PDF link(s) were not scanned: at most 100 are taken from one page',
      );
    },
    TIMEOUT,
  );
});

describe('PDFs by URL', () => {
  it(
    'fetches a PDF given by URL and records it under the URL; an HTML page served as x.pdf is an error',
    async () => {
      const temp = join(tmp, 'pdfurl-temp');
      const r = await runCli(
        [
          'scan',
          `${site.origin}/alt-pass.html`,
          `${site.origin}/doc.pdf`,
          `${site.origin}/fake.pdf`,
          `${site.origin}/missing.pdf`,
          `${site.origin}/away.pdf`,
          '--out',
          out('pdfurl'),
          ...sandbox,
        ],
        { cwd: tmp, env: noVerapdf(temp) },
      );
      expect(r.code, r.stderr).toBe(2);
      const report = parseJsonReport(readFileSync(join(out('pdfurl'), 'report.json'), 'utf8'));
      expect(report.skipped).toEqual([]);
      expect(report.assets.map((a) => a.uri)).toEqual([`${site.origin}/alt-pass.html`]);
      // The real PDF reached the scanner under its URL (which then had no veraPDF to run).
      expect(report.errors).toMatchObject([
        { kind: 'pdf', uri: `${site.origin}/doc.pdf`, code: 'verapdf-unavailable' },
        {
          kind: 'pdf',
          uri: `${site.origin}/fake.pdf`,
          code: 'not-a-pdf',
          message: 'the response is not a PDF (it does not start with %PDF-)',
        },
        {
          kind: 'pdf',
          uri: `${site.origin}/missing.pdf`,
          code: 'pdf-fetch-failed',
          message: 'the server answered 404',
        },
        // Listed by name, so a redirect off its origin is an error, not a scope gap.
        {
          kind: 'pdf',
          uri: `${site.origin}/away.pdf`,
          code: 'pdf-redirect-off-origin',
          message: `redirect to ${other.origin} leaves ${site.origin}`,
        },
      ]);
      expect(otherHits).toBe(0);
      expect(report.scope.pdf?.urls).toEqual([
        `${site.origin}/doc.pdf`,
        `${site.origin}/fake.pdf`,
        `${site.origin}/missing.pdf`,
        `${site.origin}/away.pdf`,
      ]);
      expect(r.stdout).toContain(`Scan error: ${site.origin}/fake.pdf: not-a-pdf:`);
      const page = readFileSync(join(out('pdfurl'), 'report.html'), 'utf8');
      expect(page).toContain(`PDF by URL: <span class="uri">${site.origin}/doc.pdf</span>`);
      // The temp folder is gone once the scan is done.
      expect(readdirSync(temp).filter((f) => f.startsWith('widedoor-pdf-'))).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'fetches PDF links a crawl finds, and refuses one whose redirect leaves the origin as a scope gap',
    async () => {
      const dir = mkdtempSync(join(tmp, 'crawl-pdf-'));
      writeFileSync(
        join(dir, 'widedoor.config.yaml'),
        `web:\n  urls: [${site.origin}/pdf-links.html]\n  crawl: { maxPages: 2 }\n`,
      );
      const r = await runCli(['scan', '--out', join(dir, 'out'), ...sandbox], {
        cwd: dir,
        env: noVerapdf(join(dir, 'temp')),
      });
      expect(r.code, r.stderr).toBe(2);
      const report = parseJsonReport(readFileSync(join(dir, 'out', 'report.json'), 'utf8'));
      expect(report.errors).toMatchObject([
        { kind: 'pdf', uri: `${site.origin}/doc.pdf`, code: 'verapdf-unavailable' },
      ]);
      const gap = `${site.origin}/away.pdf was not fetched: redirect to ${other.origin} leaves ${site.origin}`;
      expect(report.scopeGaps).toContain(gap);
      expect(r.stdout).toContain(`Warning: ${gap}`);
      expect(otherHits).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'stops a PDF at the pdf.maxBytes the config sets, and notes a signed-in scan fetches without its session',
    async () => {
      const dir = mkdtempSync(join(tmp, 'cap-pdf-'));
      writeFileSync(join(dir, 'state.json'), '{"cookies":[],"origins":[]}');
      writeFileSync(
        join(dir, 'widedoor.config.yaml'),
        `web:\n  urls: [${site.origin}/alt-pass.html]\npdf:\n  urls: [${site.origin}/doc.pdf]\n  maxBytes: 1000\n`,
      );
      const r = await runCli(
        ['scan', '--out', join(dir, 'out'), '--storage-state', 'state.json', ...sandbox],
        { cwd: dir, env: noVerapdf(join(dir, 'temp')) },
      );
      expect(r.code, r.stderr).toBe(2);
      const report = parseJsonReport(readFileSync(join(dir, 'out', 'report.json'), 'utf8'));
      expect(report.errors).toEqual([
        {
          kind: 'pdf',
          uri: `${site.origin}/doc.pdf`,
          code: 'pdf-too-large',
          message:
            'the PDF is over the 1000 bytes limit (pdf.maxBytes) (PDFs are fetched without the signed-in session)',
        },
      ]);
    },
    TIMEOUT,
  );

  it(
    'removes the temp folder when an interrupt comes during a PDF fetch',
    async () => {
      const dir = mkdtempSync(join(tmp, 'int-pdf-'));
      const temp = join(dir, 'temp');
      const before = pdfHangs;
      const r = await runCli(
        ['scan', `${site.origin}/hang.pdf`, '--out', join(dir, 'out'), ...sandbox],
        {
          cwd: dir,
          env: noVerapdf(temp),
          onStart: (child) => {
            void waitFor(() => pdfHangs > before, 60_000, 'the PDF fetch').then(
              // Let the first bytes reach the temp file before stopping.
              () => setTimeout(() => interrupt(child), 500),
            );
          },
        },
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('interrupted');
      expect(readdirSync(temp).filter((f) => f.startsWith('widedoor-pdf-'))).toEqual([]);
    },
    TIMEOUT,
  );
});

/**
 * A stand-in veraPDF 1.30.3 on PATH (it only prints its version), so the CLI
 * picks the local runner: with WIDEDOOR_ISOLATED_HOST=1, the runner of the
 * Widedoor image.
 */
function fakeVerapdfEnv(dir: string, inImage: boolean): NodeJS.ProcessEnv {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32')
    writeFileSync(join(bin, 'verapdf.cmd'), '@echo veraPDF 1.30.3\r\n');
  else writeFileSync(join(bin, 'verapdf'), '#!/bin/sh\necho "veraPDF 1.30.3"\n', { mode: 0o755 });
  const env = noVerapdf(join(dir, 'temp'));
  // cmd.exe runs the .cmd launcher; Docker is still not on PATH.
  env.PATH =
    process.platform === 'win32'
      ? [bin, join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';')
      : bin;
  if (process.platform === 'win32' && process.env.ComSpec) env.ComSpec = process.env.ComSpec;
  if (inImage) env.WIDEDOOR_ISOLATED_HOST = '1';
  return env;
}

describe('pdf.fetch', () => {
  const config = (extra = '') =>
    `web:\n  urls: [${site.origin}/pdf-links.html]\n  crawl: { maxPages: 2 }\npdf:\n  urls: [${site.origin}/doc.pdf]\n${extra}`;

  it(
    'does not fetch listed or crawled PDFs with the image runner: each is a scope gap',
    async () => {
      const dir = mkdtempSync(join(tmp, 'fetch-off-'));
      writeFileSync(join(dir, 'widedoor.config.yaml'), config());
      const before = docHits;
      const r = await runCli(['scan', '--out', join(dir, 'out'), ...sandbox], {
        cwd: dir,
        env: fakeVerapdfEnv(dir, true),
      });
      const report = parseJsonReport(readFileSync(join(dir, 'out', 'report.json'), 'utf8'));
      expect(r.stdout).not.toContain('Scan error');
      expect(report.errors).toEqual([]);
      expect(report.assets.map((a) => a.kind)).toEqual(['web']);
      expect(docHits).toBe(before);
      expect(otherHits).toBe(0);
      const off = (u: string) =>
        `${u} was not fetched: PDF fetching is off in this run (pdf.fetch); download the file and scan it in a PDF run`;
      expect(report.scopeGaps).toEqual(
        expect.arrayContaining([off(`${site.origin}/doc.pdf`), off(`${site.origin}/away.pdf`)]),
      );
      expect(r.stdout).toContain(`Warning: ${off(`${site.origin}/doc.pdf`)}`);
      // A scope gap never reads as a pass: no criterion Supports with PDFs left out.
      expect(
        report.rollup.standards.flatMap((x) => x.criteria).some((c) => c.level === 'Supports'),
      ).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'fetches with the image runner when pdf.fetch is true, with a warning naming the trade-off',
    async () => {
      const dir = mkdtempSync(join(tmp, 'fetch-on-'));
      writeFileSync(join(dir, 'widedoor.config.yaml'), config('  fetch: true\n'));
      const before = docHits;
      const r = await runCli(['scan', '--out', join(dir, 'out'), ...sandbox], {
        cwd: dir,
        env: fakeVerapdfEnv(dir, true),
      });
      expect(docHits).toBeGreaterThan(before);
      expect(r.stdout).toContain(
        'Warning: pdf.fetch is on inside the Widedoor image: PDFs fetched from the network are parsed by veraPDF in this container',
      );
      // The existing in-container warning is there too.
      expect(r.stdout).toContain('veraPDF ran inside the Widedoor container');
    },
    TIMEOUT,
  );

  it.each([
    ['pdf.fetch: false', '  fetch: false\n', false],
    ['the image runner', '', true],
  ])(
    'exits 2 "nothing was scanned" for a pdf.urls-only config with fetching off (%s), each URL a gap',
    async (_name, extra, inImage) => {
      const dir = mkdtempSync(join(tmp, 'fetch-only-off-'));
      const urls = [`${site.origin}/doc.pdf`, `${site.origin}/fake.pdf`];
      writeFileSync(
        join(dir, 'widedoor.config.yaml'),
        `pdf:\n  urls:\n${urls.map((u) => `    - ${u}\n`).join('')}${extra}`,
      );
      const before = docHits;
      const r = await runCli(['scan', '--out', join(dir, 'out')], {
        cwd: dir,
        env: inImage ? fakeVerapdfEnv(dir, true) : noVerapdf(join(dir, 'temp')),
      });
      expect(r.code, r.stderr).toBe(2);
      expect(r.stdout).toContain('Exit 2: nothing was scanned.');
      expect(docHits).toBe(before);
      const report = parseJsonReport(readFileSync(join(dir, 'out', 'report.json'), 'utf8'));
      expect(report.assets).toEqual([]);
      expect(report.errors).toEqual([]);
      for (const u of urls)
        expect(report.scopeGaps).toContain(
          `${u} was not fetched: PDF fetching is off in this run (pdf.fetch); download the file and scan it in a PDF run`,
        );
    },
    TIMEOUT,
  );

  it(
    'fetches by default on the host, with a local veraPDF',
    async () => {
      const dir = mkdtempSync(join(tmp, 'fetch-host-'));
      writeFileSync(join(dir, 'widedoor.config.yaml'), config());
      const before = docHits;
      const r = await runCli(['scan', '--out', join(dir, 'out'), ...sandbox], {
        cwd: dir,
        env: fakeVerapdfEnv(dir, false),
      });
      expect(docHits).toBeGreaterThan(before);
      expect(r.stdout).not.toContain('PDF fetching is off');
      const report = parseJsonReport(readFileSync(join(dir, 'out', 'report.json'), 'utf8'));
      // One fetch for the listed and the crawled form of doc.pdf.
      expect(docHits - before).toBe(1);
      expect(
        [...report.errors.map((e) => e.uri), ...report.assets.map((a) => a.uri)].filter(
          (u) => u === `${site.origin}/doc.pdf`,
        ),
      ).toHaveLength(1);
    },
    TIMEOUT,
  );
});

describe('page cap', () => {
  it(
    'writes the reports, then exits 2 when web.maxPages leaves listed pages unscanned',
    async () => {
      const project = join(tmp, 'cap');
      mkdirSync(project);
      writeFileSync(
        join(project, 'widedoor.config.yaml'),
        [
          'web:',
          '  maxPages: 1',
          '  urls:',
          `    - ${site.origin}/alt-pass.html`,
          `    - ${site.origin}/title-pass.html`,
          `    - ${site.origin}/language-pass.html`,
          '',
        ].join('\n'),
      );
      const r = await scan(['--out', 'reports'], project);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.stdout).toContain(
        'Exit 2: 2 listed pages were not scanned: the page limit (1) was reached; raise web.maxPages in widedoor.config.yaml.',
      );
      const dir = join(project, 'reports');
      for (const ext of ['html', 'json', 'sarif'])
        expect(existsSync(join(dir, `report.${ext}`))).toBe(true);
      const report = parseJsonReport(readFileSync(join(dir, 'report.json'), 'utf8'));
      expect(report.assets).toHaveLength(1);
      expect(report.scope.web?.maxPages).toBe(1);
      expect(report.scopeGaps).toContain(
        '2 listed page(s) were not scanned: at most 1 pages are scanned per run',
      );
      const sarif = JSON.parse(readFileSync(join(dir, 'report.sarif'), 'utf8'));
      expect(sarif.runs[0].properties.scopeComplete).toBe(false);
    },
    TIMEOUT,
  );
});

describe('manual review records', () => {
  /**
   * A manual record in the shape widedoor review record writes, filed where loadReviews wants
   * it, anchored to anchor (the page's review hash makes it current).
   */
  const plant = (
    dir: string,
    kind: AssetKind,
    uri: string,
    sc: string,
    outcome: 'pass' | 'fail',
    anchor = `sha256:${'0'.repeat(64)}`,
  ): Finding => {
    const location: Location = kind === 'web' ? { selector: 'html' } : {};
    const record = FindingSchema.parse({
      schemaVersion: 1,
      id: findingId(uri, location, 'manual', `wcag-${sc}`),
      asset: { kind, uri, contentHash: anchor },
      location,
      source: { engine: 'manual', engineVersion: '0.0.0', ruleId: `wcag-${sc}` },
      criteria: { wcag: [sc] },
      outcome,
      review: { reviewer: 'Ann', date: '2026-10-23', expiresOnChangeOf: anchor },
    });
    const name = `${kind}-${createHash('sha256').update(uri).digest('hex').slice(0, 16)}.yaml`;
    const file = join(dir, 'widedoor-review', name);
    mkdirSync(join(dir, 'widedoor-review'), { recursive: true });
    // Records for the same asset share its file.
    const earlier = existsSync(file) ? (parse(readFileSync(file, 'utf8')) as unknown[]) : [];
    writeFileSync(file, stringify([...earlier, record]));
    return record;
  };

  it(
    'uses current records that fit, and leaves out the rest with a warning in the report too',
    async () => {
      const dir = mkdtempSync(join(tmp, 'reviews-'));
      const page = `${site.origin}/alt-pass.html`;
      // A first scan gives the page's review hash, so the records below are current.
      const first = await scan([page, '--out', join(dir, 'first'), '--format', 'json'], dir);
      expect(first.code, first.stderr).toBe(0);
      const asset = parseJsonReport(readFileSync(join(dir, 'first', 'report.json'), 'utf8'))
        .assets[0];
      const anchor = asset?.reviewHash ?? asset?.contentHash ?? '';
      const kept = plant(dir, 'web', page, '2.1.1', 'pass', anchor);
      // 2.1.3 and 2.4.9 are Level AAA: no profile row, so they decide nothing in this report
      // and are left out whatever their outcome, the fail too (fix round 1, I1).
      const aaaFail = plant(dir, 'web', page, '2.1.3', 'fail', anchor);
      const aaaPass = plant(dir, 'web', page, '2.4.9', 'pass', anchor);
      const orphan = plant(dir, 'web', `${site.origin}/not-scanned.html`, '2.1.1', 'fail');
      // A PDF record for the page's uri used to make the roll-up throw.
      const wrongKind = plant(dir, 'pdf', page, '1.3.1', 'fail');
      const out = join(dir, 'out');
      const r = await scan([page, '--out', out, '--format', 'json,sarif,html'], dir);
      expect(r.code, r.stderr).toBe(0);
      const notInProfile = (f: Finding, sc: string) =>
        `manual review record ${f.id} on ${page}: WCAG ${sc} is not in profile 508+wcag21aa; the record is not used`;
      const lines = [
        `manual review record ${orphan.id} (wcag-2.1.1) was left out: orphaned`,
        `manual review record ${wrongKind.id} (wcag-1.3.1) was left out: kind-mismatch`,
        notInProfile(aaaFail, '2.1.3'),
        notInProfile(aaaPass, '2.4.9'),
      ];
      for (const line of lines) expect(r.stderr).toContain(`widedoor: ${line}`);
      const report = parseJsonReport(readFileSync(join(out, 'report.json'), 'utf8'));
      for (const line of lines) expect(report.warnings.some((w) => w.startsWith(line))).toBe(true);
      const manual = report.findings.filter((f) => f.source.engine === 'manual').map((f) => f.id);
      expect(manual).toEqual([kept.id]);
      expect(report.checklist?.byStatus.done).toBe(1);
      expect(report.checklist?.byStatus.expired).toBe(0);
      // The current AAA fail is nowhere: no fail count, no SARIF result, no card.
      expect(r.stdout).toMatch(/^Results: 0 fail, /m);
      const sarif = JSON.parse(readFileSync(join(out, 'report.sarif'), 'utf8'));
      expect(sarif.runs[0].results).toEqual([]);
      expect(readFileSync(join(out, 'report.html'), 'utf8')).not.toContain('for WCAG 2.1.3 on');
    },
    TIMEOUT,
  );
});

describe('report folder', () => {
  /** A link to victim/keep.txt at path: a file symlink where allowed, else a junction to victim. */
  const plantLink = (victim: string, path: string) => {
    try {
      symlinkSync(join(victim, 'keep.txt'), path, 'file');
    } catch {
      symlinkSync(victim, path, 'junction');
    }
  };
  const setup = () => {
    const dir = mkdtempSync(join(tmp, 'links-'));
    const victim = join(dir, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'original');
    return { dir, victim, report: join(dir, 'widedoor-report') };
  };
  const untouched = (victim: string) => {
    expect(readdirSync(victim)).toEqual(['keep.txt']);
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('original');
  };

  it(
    'refuses a link planted at report.json or at evidence/, and leaves the target untouched',
    async () => {
      type Setup = ReturnType<typeof setup>;
      const plants: ((t: Setup) => void)[] = [
        (t) => {
          mkdirSync(t.report);
          plantLink(t.victim, join(t.report, 'report.json'));
        },
        (t) => {
          mkdirSync(t.report);
          symlinkSync(t.victim, join(t.report, 'evidence'), 'junction');
        },
        (t) => symlinkSync(t.victim, t.report, 'junction'),
      ];
      for (const plant of plants) {
        const t = setup();
        plant(t);
        const r = await runCli(['scan', `${site.origin}/alt-fail.html`, ...sandbox], {
          cwd: t.dir,
        });
        expect(r.code).toBe(2);
        expect(r.stderr).toContain('the report folder cannot be used');
        expect(r.stderr).toContain('symbolic link or junction');
        untouched(t.victim);
      }
    },
    TIMEOUT,
  );

  it(
    'exits 2 when the report folder is a file or a report name is a folder',
    async () => {
      const t = setup();
      writeFileSync(t.report, 'a file');
      const file = await runCli(['scan', `${site.origin}/alt-pass.html`, ...sandbox], {
        cwd: t.dir,
      });
      expect(file.code).toBe(2);
      expect(file.stderr).toContain('is not a folder');
      rmSync(t.report);
      mkdirSync(join(t.report, 'report.json'), { recursive: true });
      const folder = await runCli(['scan', `${site.origin}/alt-pass.html`, ...sandbox], {
        cwd: t.dir,
      });
      expect(folder.code).toBe(2);
      expect(folder.stderr).toContain('is a folder, not a report file');
    },
    TIMEOUT,
  );

  it(
    'leaves a user folder alone: --out . next to their own report.html is refused, nothing deleted',
    async () => {
      const t = setup();
      writeFileSync(join(t.dir, 'report.html'), 'my own report');
      const r = await runCli(
        ['scan', `${site.origin}/alt-pass.html`, '--out', '.', '--format', 'json', ...sandbox],
        { cwd: t.dir },
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('has no .widedoor-report marker');
      expect(readFileSync(join(t.dir, 'report.html'), 'utf8')).toBe('my own report');
      expect(existsSync(join(t.dir, '.widedoor-report'))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'clears its own folder on the next run, so no report of an earlier run survives',
    async () => {
      const t = setup();
      const first = await runCli(['scan', `${site.origin}/alt-pass.html`, ...sandbox], {
        cwd: t.dir,
      });
      expect(first.code).toBe(0);
      expect(existsSync(join(t.report, '.widedoor-report'))).toBe(true);
      writeFileSync(join(t.report, '.report.json.0123456789ab.tmp'), 'stale');
      const second = await runCli(
        ['scan', `${site.origin}/alt-pass.html`, '--format', 'json', ...sandbox],
        { cwd: t.dir },
      );
      expect(second.code).toBe(0);
      expect(readdirSync(t.report).sort()).toEqual(['.widedoor-report', 'evidence', 'report.json']);
    },
    TIMEOUT,
  );
});

describe('tool errors', () => {
  it(
    'turns PDFs into scan errors that name the Docker image when no veraPDF exists, and exits 2',
    async () => {
      const r = await runCli(['scan', 'pdf/untagged.pdf', '--out', out('nopdf')], {
        cwd: CORPUS,
        env: envWithoutTools(),
      });
      expect(r.code).toBe(2);
      expect(r.stdout).toContain('verapdf-unavailable');
      expect(r.stdout).toContain('docker pull verapdf/cli:v1.30.3');
      expect(r.stdout).toContain('Start Docker');
      const report = parseJsonReport(readFileSync(join(out('nopdf'), 'report.json'), 'utf8'));
      expect(report.errors).toMatchObject([
        { kind: 'pdf', uri: 'pdf/untagged.pdf', code: 'verapdf-unavailable' },
      ]);
    },
    TIMEOUT,
  );

  it(
    'names the fix when Chromium is not installed',
    async () => {
      const empty = mkdtempSync(join(tmp, 'no-browsers-'));
      const r = await runCli(['scan', `${site.origin}/alt-pass.html`, '--out', out('nochrome')], {
        cwd: tmp,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty },
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(
        'Chromium is not installed. Run "npx playwright install chromium"',
      );
    },
    TIMEOUT,
  );

  it('exits 2 with usage when there is neither a config nor a target', async () => {
    const r = await runCli(['scan'], { cwd: tmp });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Usage: widedoor scan');
  });

  it('exits 2 on a bad config and names the problem', async () => {
    const dir = mkdtempSync(join(tmp, 'cfg-'));
    writeFileSync(
      join(dir, 'widedoor.config.yaml'),
      'web:\n  urls: [ftp://example.com/]\n  craw: {}\n',
    );
    const r = await runCli(['scan'], { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('web.urls[0]: expected an http or https URL');
    expect(r.stderr).toContain('web: unknown key "craw"');
  });
});

describe('interrupt', () => {
  it(
    'closes the browser and exits 2 on an interrupt, leaving no child process behind',
    async () => {
      let children: number[] = [];
      const r = await runCli(
        ['scan', `${site.origin}/hang.html`, '--out', out('int'), ...sandbox],
        {
          cwd: tmp,
          onStart: (child) => {
            void (async () => {
              await waitFor(() => hangs > 0, 60_000, 'the page request');
              children = descendants(child.pid as number);
              interrupt(child);
            })();
          },
        },
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('interrupted');
      expect(children.length).toBeGreaterThan(0);
      await waitFor(() => children.every((pid) => !alive(pid)), 10_000, 'child processes to exit');
      expect(existsSync(join(out('int'), 'report.json'))).toBe(false);
    },
    TIMEOUT,
  );
});
