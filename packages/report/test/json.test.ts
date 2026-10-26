import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { getProfile, type Asset, type Finding } from '@widedoor/core';
import {
  buildScanReport,
  DISCLAIMER,
  ScanReportSchema,
  parseJsonReport,
  serializeJson,
  serializeReportJsonSchema,
  notEvaluated,
  summarize,
} from '../src/index.ts';
import { FINDINGS, PAGE, REVIEWS, fixtureReport } from './fixture.ts';

const schemaFile = new URL('../schema/report.v1.json', import.meta.url);

function validator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats.default(ajv);
  return ajv.compile(JSON.parse(readFileSync(schemaFile, 'utf8')));
}

describe('report.v1.json', () => {
  it('matches the Zod schema byte for byte (regenerate with npm run schema -w @widedoor/report)', () => {
    expect(readFileSync(schemaFile, 'utf8')).toBe(serializeReportJsonSchema());
  });

  it('accepts the fixture report and rejects a broken one', () => {
    const validate = validator();
    const report = JSON.parse(serializeJson(fixtureReport()));
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...report, findings: [{ id: 'x' }] })).toBe(false);
    expect(validate({ ...report, extra: true })).toBe(false);
    expect(validate({ ...report, startedAt: 'yesterday' })).toBe(false);
  });

  it('accepts a report written before determinations had overridden', () => {
    const report = JSON.parse(serializeJson(fixtureReport()));
    for (const s of report.rollup.standards)
      for (const c of s.criteria)
        for (const d of [...c.assets, ...(c.product ? [c.product] : [])]) delete d.overridden;
    const validate = validator();
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(() => parseJsonReport(JSON.stringify(report))).not.toThrow();
  });
});

describe('buildScanReport', () => {
  const report = fixtureReport();

  it('keeps run metadata: tool, engines, profile, timestamps and scope', () => {
    expect(report.tool).toEqual({ name: 'widedoor', version: '0.0.0' });
    expect(report.engines.map((e) => `${e.name} ${e.version}`)).toEqual([
      'axe-core 4.14.0',
      'verapdf 1.30.3',
      'widedoor 0.0.0',
    ]);
    expect(report.engines[1]?.runner).toBe('docker');
    expect(report.profile).toEqual({ id: 'wcag21aa', pdfDocumentType: 'non-web' });
    expect([report.startedAt, report.finishedAt]).toEqual([
      '2026-10-22T12:00:00.000Z',
      '2026-10-22T12:05:00.000Z',
    ]);
    expect(report.scope.web?.urls).toContain(PAGE.uri);
    expect(report.errors.map((e) => `${e.kind} ${e.code}`)).toEqual([
      'web unsupported-url',
      'pdf malformed-pdf',
    ]);
    expect(report.skipped).toHaveLength(1);
    expect(report.informational).toHaveLength(1);
    expect(report.disclaimer).toBe(DISCLAIMER);
  });

  it('keeps every record, including two that share a finding id', () => {
    expect(report.findings).toHaveLength(FINDINGS.length + REVIEWS.length);
    const ids = report.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length - 1);
  });

  it('includes the roll-up with each id listed once', () => {
    const row = report.rollup.standards[0]?.criteria.find((c) => c.id === '4.1.2');
    expect(row?.level).toBe('Does Not Support');
    expect(row?.evidence).toEqual([FINDINGS[0]?.id, FINDINGS[3]?.id]);
    for (const s of report.rollup.standards)
      for (const c of s.criteria) {
        expect(new Set(c.evidence).size, c.id).toBe(c.evidence.length);
        for (const a of c.assets)
          for (const list of [a.evidence, a.undecided, a.expired])
            expect(new Set(list).size, `${c.id} ${a.uri}`).toBe(list.length);
      }
  });

  it('uses a manual pass in the roll-up', () => {
    const row = report.rollup.standards[0]?.criteria.find((c) => c.id === '2.1.2');
    expect(row?.assets.find((a) => a.uri === PAGE.uri)?.reason).toBe('manual-pass');
  });

  it('rejects malformed input', () => {
    expect(() => ScanReportSchema.parse({ ...report, schemaVersion: 2 })).toThrow();
  });
});

describe('assets that could not be scanned', () => {
  const hash = (c: string) => `sha256:${c.repeat(64)}`;
  const A: Asset = { kind: 'web', uri: 'https://example.com/a', contentHash: hash('a') };
  const pass = (asset: Asset): Finding =>
    ({
      ...(REVIEWS[0] as Finding),
      asset,
      review: { reviewer: 'R', date: '2026-10-21', expiresOnChangeOf: asset.contentHash },
    }) as Finding;
  const run = (
    errors: { uri: string; code: string; message: string }[],
    assets: Asset[],
    skipped = [] as { url: string; finalUrl: string; reason: string }[],
  ) =>
    buildScanReport({
      profile: getProfile('wcag21aa'),
      startedAt: '2026-10-22T12:00:00.000Z',
      finishedAt: '2026-10-22T12:00:01.000Z',
      scope: { web: { urls: [], truncated: false } },
      web: {
        engine: { name: 'axe-core', version: '4.14.0' },
        assets,
        findings: [],
        errors,
        skipped,
        warnings: [],
        truncated: false,
      },
      reviews: assets.map(pass),
    });
  const level = (r: ReturnType<typeof run>, id: string) =>
    r.rollup.standards[0]?.criteria.find((c) => c.id === id);

  it('keep a manual pass on one page from making the criterion Supports when another page errored', () => {
    expect(level(run([], [A]), '2.1.2')?.level).toBe('Supports');
    const r = run([{ uri: 'https://example.com/b', code: 'scan-failed', message: 'boom' }], [A]);
    const row = level(r, '2.1.2');
    expect(row?.level).toBe('Not Evaluated');
    expect(row?.assets.map((a) => a.reason)).toEqual(['manual-pass', 'not-scanned']);
  });

  it('count a skipped page as not scanned', () => {
    const r = run(
      [],
      [A],
      [
        {
          url: 'https://example.com/c',
          finalUrl: 'https://other.example/',
          reason: 'redirect-off-origin',
        },
      ],
    );
    expect(level(r, '2.1.2')?.level).toBe('Not Evaluated');
  });

  it('list every criterion as not tested when every page errored', () => {
    const r = run([{ uri: 'https://example.com/a', code: 'navigation-failed', message: 'x' }], []);
    const criteria = r.rollup.standards[0]?.criteria ?? [];
    expect(criteria.length).toBe(50);
    expect(criteria.every((c) => c.level === 'Not Evaluated')).toBe(true);
    expect(summarize(r).notTested).toBe(50);
  });

  it('cap Supports when the sitemap could not be read', () => {
    const r = run(
      [{ uri: 'https://example.com/sitemap.xml', code: 'sitemap-failed', message: 'x' }],
      [A],
    );
    expect(level(r, '2.1.2')?.level).toBe('Not Evaluated');
    expect(level(r, '2.1.2')?.reason).toMatch(/scope is incomplete/);
  });
});

describe('records for unknown assets', () => {
  it('are rejected by buildScanReport and parseJsonReport', () => {
    const stray = {
      ...(FINDINGS[0] as Finding),
      asset: { ...PAGE, uri: 'https://elsewhere.example/' },
    } as Finding;
    const report = fixtureReport();
    expect(() =>
      parseJsonReport(JSON.stringify({ ...report, findings: [...report.findings, stray] })),
    ).toThrow(/does not list/);
    expect(() =>
      buildScanReport({
        profile: getProfile('wcag21aa'),
        startedAt: '2026-10-22T12:00:00.000Z',
        finishedAt: '2026-10-22T12:00:01.000Z',
        scope: {},
        reviews: [REVIEWS[0] as Finding],
      }),
    ).toThrow(/does not list/);
  });
});

describe('summarize', () => {
  it('counts records by outcome and impact and criteria by level', () => {
    const s = summarize(fixtureReport());
    expect(s.outcomes).toEqual({
      pass: 2,
      fail: 6,
      'needs-review': 2,
      'not-applicable': 0,
      'not-tested': 0,
    });
    expect(s.failsByImpact).toEqual({ critical: 2, serious: 4, moderate: 0, minor: 0, unrated: 0 });
    expect(s.needsReviewByImpact.moderate).toBe(2);
    expect(s.assets).toBe(2);
    expect(s.errors).toBe(2);
    expect(s.criteria[0]?.levels['Does Not Support']).toBeGreaterThan(0);
    expect(s.notTested).toBeGreaterThan(0);
  });
});

describe('JSON report', () => {
  it('round-trips through parseJsonReport', () => {
    const report = fixtureReport();
    expect(parseJsonReport(serializeJson(report))).toEqual(report);
  });

  it('matches its snapshot', async () => {
    await expect(serializeJson(fixtureReport())).toMatchFileSnapshot('__snapshots__/report.json');
  });
});

describe('a criterion capped by a scope gap', () => {
  it('is listed as not tested even though every asset passed it', () => {
    const report = buildScanReport({
      profile: getProfile('wcag21aa'),
      startedAt: '2026-10-22T12:00:00.000Z',
      finishedAt: '2026-10-22T12:00:01.000Z',
      scope: {
        web: { urls: [PAGE.uri], crawl: { sameOrigin: true, maxPages: 1 }, truncated: true },
      },
      web: {
        engine: { name: 'axe-core', version: '4.14.0' },
        assets: [PAGE],
        findings: [],
        errors: [],
        skipped: [],
        warnings: [],
        truncated: true,
      },
      reviews: [REVIEWS[0] as Finding],
    });
    const row = report.rollup.standards[0]?.criteria.find((c) => c.id === '2.1.2');
    expect(row?.level).toBe('Not Evaluated');
    expect(row?.assets.map((a) => a.state)).toEqual(['pass']);
    const entry = notEvaluated(report).find((u) => u.id === '2.1.2');
    expect(entry).toMatchObject({ count: 0, total: 1 });
    expect(entry?.reason).toMatch(/scope is incomplete: the page limit stopped the crawl/);
    expect(summarize(report).notTested).toBe(50);
  });
});

describe('web scope gaps', () => {
  it('caps a criterion a manual pass would decide when the web run reports a scope gap', () => {
    const build = (scopeGaps: string[]) =>
      buildScanReport({
        profile: getProfile('wcag21aa'),
        startedAt: '2026-10-22T12:00:00.000Z',
        finishedAt: '2026-10-22T12:00:01.000Z',
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
          scopeGaps,
        },
        reviews: REVIEWS,
      });
    const level = (r: ReturnType<typeof build>) =>
      r.rollup.standards[0]!.criteria.find((c) => c.id === '2.1.2');
    expect(level(build([]))?.level).toBe('Supports');
    const gapped = level(build(['40 PDF link(s) were not listed']));
    expect(gapped?.level).toBe('Not Evaluated');
    expect(gapped?.reason).toContain('the scope is incomplete: 40 PDF link(s) were not listed');
  });
});
