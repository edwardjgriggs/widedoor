import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getProfile, type Asset } from '@widedoor/core';
import { buildScanReport } from '@widedoor/report';
import { MARKER, prepareOut } from '../src/output.ts';
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
