import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getProfile, type Asset } from '@widedoor/core';
import { buildScanReport } from '@widedoor/report';
import { MARKER, SIGNED_IN_MARKER, prepareOut, signedInMarked } from '../src/output.ts';
import { loadReportFile } from '../src/report-file.ts';
import { writeReports } from '../src/report-files.ts';

/*
 * Every ACR format is built and validated before any report file is written,
 * so an ACR that fails validation (a bug) leaves no partial set of reports
 * (Task 2.7 fix round 1, ruling R1).
 */

const root = mkdtempSync(join(tmpdir(), 'widedoor-run-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PAGE: Asset = {
  kind: 'web',
  uri: 'https://site.example/home',
  contentHash: `sha256:${'a'.repeat(64)}`,
};

const report = buildScanReport({
  profile: getProfile('508'),
  startedAt: '2026-10-23T12:00:00.000Z',
  finishedAt: '2026-10-23T12:01:00.000Z',
  toolVersion: '0.0.0',
  scope: { web: { urls: [PAGE.uri], truncated: false } },
  web: {
    engine: { name: 'axe-core', version: '4.14.0' },
    assets: [PAGE],
    findings: [],
    errors: [],
    skipped: [],
    warnings: [],
    truncated: false,
  },
  reviews: [],
});

let n = 0;
async function folder() {
  const out = join(root, `t${n++}`);
  await prepareOut(out, false, [root]);
  return out;
}

const formats = ['html', 'json', 'openacr', 'vpat-html', 'vpat-docx'] as const;
const NAMES = {
  html: 'report.html',
  json: 'report.json',
  openacr: 'report.openacr.yaml',
  'vpat-html': 'report.vpat.html',
  'vpat-docx': 'report.vpat.docx',
};

describe('writeReports', () => {
  it('writes every format, the ACRs included, when they validate', async () => {
    const out = await folder();
    const written = await writeReports(
      report,
      { formats: [...formats], out, reviewDir: root, acr: { product: { name: 'Portal' } } },
      false,
    );
    expect(written).toEqual(formats.map((f) => join(out, NAMES[f])));
    expect(readdirSync(out).sort()).toEqual([MARKER, 'evidence', ...Object.values(NAMES)].sort());
    expect(readFileSync(join(out, NAMES['vpat-html']), 'utf8')).toContain(
      '<h1>DRAFT Unnamed vendor Accessibility Conformance Report</h1>',
    );
    // A DOCX is a zip: it starts with a local file header.
    expect(readFileSync(join(out, NAMES['vpat-docx'])).subarray(0, 4)).toEqual(
      Buffer.from('PK\u0003\u0004', 'latin1'),
    );
  });

  it('writes none of the reports when the ACR fails validation', async () => {
    const out = await folder();
    // No product name: the schema requires one (buildPlan refuses it first in a real run).
    await expect(
      writeReports(report, { formats: [...formats], out, reviewDir: root, acr: {} }, false),
    ).rejects.toThrow(/the OpenACR report failed validation \(a Widedoor bug\)/);
    expect(readdirSync(out).sort()).toEqual([MARKER, 'evidence']);
  });
});

// Phase 3b final fix round 1 items 25 and 33: a signed-in scan's reports carry a marker.
describe('the signed-in marker', () => {
  it('a signed-in scan leaves it beside the reports, and the next scan clears it', async () => {
    const out = await folder();
    await writeReports(report, { formats: ['json'], out, reviewDir: root }, true);
    expect(readdirSync(out)).toContain(SIGNED_IN_MARKER);
    expect(signedInMarked(join(out, 'report.json'))).toBe(true);
    // The report it marks reads as signed-in, on every platform.
    expect(loadReportFile(join(out, 'report.json'), root).signedIn).toBe(true);
    // A public scan into the same folder says so afresh.
    await prepareOut(out, false, [root]);
    await writeReports(report, { formats: ['json'], out, reviewDir: root }, false);
    expect(readdirSync(out)).not.toContain(SIGNED_IN_MARKER);
    expect(signedInMarked(join(out, 'report.json'))).toBe(false);
  });

  // Final fix round 2 item 1: the marker comes first, so a failed report write leaves it.
  it('is written before any report file, so a failed report write still leaves it', async () => {
    const out = await folder();
    // A folder where report.json goes: writeReport refuses it, as it would fail on a full disk.
    mkdirSync(join(out, 'report.json'));
    await expect(
      writeReports(report, { formats: ['json', 'html'], out, reviewDir: root }, true),
    ).rejects.toThrow(/is a folder, not a report file/);
    expect(readdirSync(out)).toContain(SIGNED_IN_MARKER);
    expect(readdirSync(out)).not.toContain('report.html');
  });
});
