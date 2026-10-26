import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FindingSchema, findingId, getProfile, type Asset } from '@widedoor/core';
import { buildScanReport, serializeJson, type ScanReport } from '@widedoor/report';
import { startLocalServer } from '../src/app.ts';
import { ReportFileError, loadReportFile } from '../src/report-file.ts';
import { SECURITY_HEADERS } from '../src/security.ts';
import { loadStaticFiles, uiDistDir } from '../src/static-files.ts';

/*
 * What widedoor ui serves from a report file: the validated report plus its
 * screenshots and attachments through the containment loaders; where the
 * built viewer is found; and a request Node cannot parse.
 */

const root = mkdtempSync(join(tmpdir(), 'widedoor-reportfile-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The GET /api/report body for a report file. */
const reportBody = (path: string, reviewDir?: string): string =>
  loadReportFile(path, reviewDir).body;

/** A whole 1x1 PNG: screenshots and attachments are embedded only as whole files. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const PAGE: Asset = {
  kind: 'web',
  uri: 'https://example.com/',
  contentHash: `sha256:${'a'.repeat(64)}`,
};

/** A one-page report with one failed check per screenshot path. */
function sampleReport(screenshots: string[] = []): ScanReport {
  const findings = screenshots.map((screenshot, i) => {
    const location = { selector: `img#e${i}` };
    return FindingSchema.parse({
      schemaVersion: 1,
      id: findingId(PAGE.uri, location, 'axe-core', 'image-alt'),
      asset: PAGE,
      location,
      source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId: 'image-alt' },
      criteria: { wcag: ['1.1.1'] },
      outcome: 'fail',
      impact: 'critical',
      evidence: { screenshot },
    });
  });
  return buildScanReport({
    profile: getProfile('wcag21aa'),
    startedAt: '2026-10-22T12:00:00.000Z',
    finishedAt: '2026-10-22T12:01:00.000Z',
    toolVersion: '0.0.0',
    scope: { web: { urls: [PAGE.uri], truncated: false } },
    web: {
      engine: { name: 'axe-core', version: '4.14.0' },
      assets: [PAGE],
      findings,
      errors: [],
      skipped: [],
      warnings: [],
      truncated: false,
      pages: [{ asset: PAGE, title: 'Home' }],
    },
  });
}

let n = 0;
/** A report folder as widedoor scan writes it: report.json and evidence/. */
function reportFolder(report: ScanReport = sampleReport()): string {
  const dir = join(root, `r${n++}`);
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'report.json'), serializeJson(report));
  return dir;
}

describe('uiDistDir', () => {
  it('takes an absolute WIDEDOOR_UI_DIST, refuses a relative one, else resolves @widedoor/ui', () => {
    const abs = join(root, 'other-dist');
    expect(uiDistDir({ WIDEDOOR_UI_DIST: abs })).toBe(abs);
    expect(() => uiDistDir({ WIDEDOOR_UI_DIST: 'dist' })).toThrow(/absolute/);
    expect(uiDistDir({})).toMatch(/[\\/]ui[\\/]dist$/);
  });
});

describe('reportBody', () => {
  it('returns the validated report and its screenshots, loaded only from evidence/', () => {
    const report = sampleReport(['wd_label.png', '../outside.png', 'fake.png', 'wd_label.png']);
    const dir = reportFolder(report);
    writeFileSync(join(dir, 'evidence', 'wd_label.png'), PNG);
    writeFileSync(join(dir, 'evidence', 'fake.png'), 'not a png');
    writeFileSync(join(dir, 'outside.png'), PNG);
    const body = JSON.parse(reportBody(join(dir, 'report.json')));
    expect(body.report).toEqual(JSON.parse(serializeJson(report)));
    expect(body.screenshots).toEqual({
      'wd_label.png': { ok: true, dataUri: `data:image/png;base64,${PNG.toString('base64')}` },
      '../outside.png': {
        ok: false,
        reason: 'the path is not a plain path inside the evidence folder',
      },
      'fake.png': { ok: false, reason: 'the file is not a PNG image' },
    });
  });

  it('loads the attachments review records name from widedoor-review/attachments, by their bytes', () => {
    const report = sampleReport();
    const location = { selector: 'html' };
    const record = FindingSchema.parse({
      schemaVersion: 1,
      id: findingId(PAGE.uri, location, 'manual', 'wcag-2.1.1'),
      asset: PAGE,
      location,
      source: { engine: 'manual', engineVersion: '0.0.0', ruleId: 'wcag-2.1.1' },
      criteria: { wcag: ['2.1.1'] },
      outcome: 'pass',
      review: {
        reviewer: 'Ann',
        date: '2026-10-23',
        expiresOnChangeOf: PAGE.contentHash,
        attachments: [
          'attachments/ok.png',
          'attachments/fake.png',
          'attachments/sub/x.png',
          'attachments/missing.jpg',
        ],
      },
    });
    const dir = reportFolder({ ...report, findings: [...report.findings, record] });
    const project = join(dir, 'project');
    mkdirSync(join(project, 'widedoor-review', 'attachments'), { recursive: true });
    writeFileSync(join(project, 'widedoor-review', 'attachments', 'ok.png'), PNG);
    // The PNG signature, then markup: a first-bytes check would pass it.
    writeFileSync(
      join(project, 'widedoor-review', 'attachments', 'fake.png'),
      Buffer.concat([PNG.subarray(0, 16), Buffer.from('<script>alert(1)</script>')]),
    );
    const body = JSON.parse(reportBody(join(dir, 'report.json'), project));
    expect(body.attachments).toEqual({
      'attachments/ok.png': {
        ok: true,
        dataUri: `data:image/png;base64,${PNG.toString('base64')}`,
      },
      'attachments/fake.png': { ok: false, reason: 'the file is not a whole PNG or JPEG image' },
      'attachments/sub/x.png': {
        ok: false,
        reason: 'the path is not attachments/<name>.png, .jpg or .jpeg',
      },
      'attachments/missing.jpg': {
        ok: false,
        reason: 'the file is not in the attachments folder',
      },
    });
    // Without a review folder nothing is read.
    expect(JSON.parse(reportBody(join(dir, 'report.json'))).attachments).toMatchObject({
      'attachments/ok.png': { ok: false, reason: 'no attachments folder was given' },
    });
  });

  it.each([
    ['not JSON', '{"schemaVersion":', /not valid JSON/],
    ['another JSON file', '{"name":"x"}', /not a Widedoor JSON report at schemaVersion/],
  ])('refuses %s', (_, text, message) => {
    const dir = reportFolder();
    writeFileSync(join(dir, 'report.json'), text);
    expect(() => reportBody(join(dir, 'report.json'))).toThrow(ReportFileError);
    expect(() => reportBody(join(dir, 'report.json'))).toThrow(message);
  });

  it('refuses a folder and a missing file', () => {
    expect(() => reportBody(root)).toThrow(/not a file/);
    expect(() => reportBody(join(root, 'nope.json'))).toThrow(/cannot be read/);
  });
});

describe('malformed requests', () => {
  it('answer 400 with the security headers', async () => {
    const dir = join(root, 'dist');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const server = await startLocalServer({ files: loadStaticFiles(dir), root: { dir: root } });
    try {
      const reply = await new Promise<string>((done, fail) => {
        const socket = connect(server.port, '127.0.0.1', () => socket.write('NOT HTTP\r\n\r\n'));
        let text = '';
        socket.setEncoding('utf8');
        socket.on('data', (c: string) => (text += c));
        socket.on('end', () => done(text));
        socket.once('error', fail);
      });
      expect(reply).toMatch(/^HTTP\/1\.1 400 /);
      for (const [name, value] of Object.entries(SECURITY_HEADERS))
        expect(reply).toContain(`${name}: ${value}\r\n`);
    } finally {
      await server.close();
    }
  });
});
