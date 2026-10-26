import { describe, expect, it } from 'vitest';
import {
  FindingSchema,
  findingId,
  getProfile,
  type Asset,
  type Finding,
  type Location,
  type ProfileId,
} from '@widedoor/core';
import {
  ReportDiffSchema,
  buildScanReport,
  diffReports,
  ordinal,
  parseJsonReport,
  serializeJson,
  type ReportDiff,
  type ScanReport,
} from '../src/index.ts';
import {
  CONTRAST,
  FIGURE,
  HERO,
  OVERRIDE,
  PAGE,
  PDF,
  reviewFixtureReport,
} from './review-fixture.ts';

/*
 * diffReports: new, fixed and unchanged records among current, not
 * overridden fail and needs-review records on assets scanned in both
 * reports, criteria levels per shared standard view, and what is not
 * compared and why (Review Focus case 5).
 */

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const A: Asset = { kind: 'web', uri: 'https://site.example/a', contentHash: hash('a') };
const B: Asset = { kind: 'web', uri: 'https://site.example/b', contentHash: hash('b') };
const C: Asset = { kind: 'web', uri: 'https://site.example/c', contentHash: hash('c') };

function record(
  asset: Asset,
  ruleId: string,
  outcome: 'fail' | 'needs-review' | 'pass',
  location: Location = { selector: `#${ruleId}` },
): Finding {
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(asset.uri, location, 'axe-core', ruleId),
    asset,
    location,
    source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId },
    criteria: { wcag: ['1.4.3'] },
    outcome,
    ...(outcome === 'fail' ? { impact: 'serious' } : {}),
  });
}

function manualFail(asset: Asset, expiresOnChangeOf: string): Finding {
  const location: Location = { selector: 'html' };
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(asset.uri, location, 'manual', 'wcag-2.1.1'),
    asset,
    location,
    source: { engine: 'manual', engineVersion: '0.2.0', ruleId: 'wcag-2.1.1' },
    criteria: { wcag: ['2.1.1'] },
    outcome: 'fail',
    review: { date: '2026-10-22', reviewer: 'Grace Hopper', expiresOnChangeOf },
  });
}

interface Web {
  assets: Asset[];
  findings: Finding[];
  errors?: { uri: string; code: string; message: string }[];
  reviews?: Finding[];
  profile?: ProfileId;
  startedAt?: string;
}

function web({
  assets,
  findings,
  errors = [],
  reviews = [],
  profile = 'wcag21aa',
  startedAt = '2026-10-23T12:00:00.000Z',
}: Web): ScanReport {
  return buildScanReport({
    profile: getProfile(profile),
    startedAt,
    finishedAt: '2026-10-23T12:01:00.000Z',
    toolVersion: '0.0.0',
    scope: {
      web: { urls: [...assets, ...errors].map((a) => a.uri), truncated: false },
    },
    web: {
      engine: { name: 'axe-core', version: '4.14.0' },
      assets,
      findings,
      errors,
      skipped: [],
      warnings: [],
      truncated: false,
    },
    reviews,
  });
}

const ids = (list: { id: string }[]) => list.map((e) => e.id);

describe('diffReports', () => {
  it('reports only unchanged records for identical reports', () => {
    const report = reviewFixtureReport();
    const diff = diffReports(report, report);
    expect(diff.findings.new).toEqual([]);
    expect(diff.findings.fixed).toEqual([]);
    expect(diff.findings.notCompared).toEqual([]);
    expect(diff.criteria).toEqual({ changed: [], notCompared: [] });
    // HERO is overridden in the fixture, so it is in neither set.
    expect(ids(diff.findings.unchanged).sort()).toEqual([CONTRAST.id, FIGURE.id].sort());
    expect(diff.findings.unchanged.every((e) => e.beforeOutcome === undefined)).toBe(true);
  });

  it('finds new and fixed records on pages scanned in both', () => {
    const keep = record(A, 'color-contrast', 'fail');
    const gone = record(A, 'image-alt', 'fail');
    const added = record(B, 'label', 'needs-review');
    const before = web({ assets: [A, B], findings: [keep, gone] });
    const after = web({ assets: [A, B], findings: [keep, added] });
    const diff = diffReports(before, after);
    expect(diff.findings.new).toEqual([
      { id: added.id, uri: B.uri, ruleId: 'label', outcome: 'needs-review' },
    ]);
    expect(diff.findings.fixed).toEqual([
      { id: gone.id, uri: A.uri, ruleId: 'image-alt', outcome: 'fail' },
    ]);
    expect(ids(diff.findings.unchanged)).toEqual([keep.id]);
  });

  it('ignores pass records', () => {
    const before = web({ assets: [A], findings: [record(A, 'color-contrast', 'pass')] });
    const after = web({ assets: [A], findings: [] });
    const diff = diffReports(before, after);
    expect(diff.findings).toEqual({ new: [], fixed: [], unchanged: [], notCompared: [] });
  });

  it('keeps an outcome change unchanged, with the before outcome', () => {
    const location = { selector: '#x' };
    const before = web({
      assets: [A],
      findings: [record(A, 'color-contrast', 'needs-review', location)],
    });
    const after = web({ assets: [A], findings: [record(A, 'color-contrast', 'fail', location)] });
    const diff = diffReports(before, after);
    expect(diff.findings.unchanged).toEqual([
      {
        id: record(A, 'color-contrast', 'fail', location).id,
        uri: A.uri,
        ruleId: 'color-contrast',
        outcome: 'fail',
        beforeOutcome: 'needs-review',
      },
    ]);
    expect(diffReports(after, before).findings.unchanged[0]).toMatchObject({
      outcome: 'needs-review',
      beforeOutcome: 'fail',
    });
  });

  it('lists a key once, a fail over a needs-review with the same id and uri', () => {
    const location = { selector: '#x' };
    const twice = web({
      assets: [A],
      findings: [
        record(A, 'color-contrast', 'needs-review', location),
        record(A, 'color-contrast', 'fail', location),
      ],
    });
    const diff = diffReports(twice, twice);
    expect(diff.findings.unchanged).toHaveLength(1);
    expect(diff.findings.unchanged[0]?.outcome).toBe('fail');
  });

  it('keys by id and uri, so one id on two pages is two entries', () => {
    const shared = record(A, 'color-contrast', 'fail');
    const onB = FindingSchema.parse({ ...shared, asset: B });
    const before = web({ assets: [A, B], findings: [shared, onB] });
    const after = web({ assets: [A, B], findings: [shared] });
    const diff = diffReports(before, after);
    expect(diff.findings.fixed).toEqual([
      { id: shared.id, uri: B.uri, ruleId: 'color-contrast', outcome: 'fail' },
    ]);
    expect(diff.findings.unchanged.map((e) => e.uri)).toEqual([A.uri]);
  });

  describe('Review Focus case 5: what is not compared', () => {
    it('puts every criterion in notCompared when the profiles differ', () => {
      const before = web({ assets: [A], findings: [], profile: '508+wcag21aa' });
      const after = web({ assets: [A], findings: [], profile: 'wcag21aa' });
      const diff = diffReports(before, after);
      expect(diff.criteria.changed).toEqual([]);
      const rows = before.rollup.standards.flatMap((s) =>
        s.criteria.map((c) => `${s.standard} ${c.id}`),
      );
      expect(diff.criteria.notCompared.map((c) => `${c.standard} ${c.id}`).sort()).toEqual(
        [...new Set(rows)].sort(),
      );
      expect(diff.criteria.notCompared.every((c) => c.reason === 'profile-mismatch')).toBe(true);
    });

    it('puts every criterion in notCompared when the PDF document type differs', () => {
      const before = reviewFixtureReport();
      const after: ScanReport = {
        ...before,
        profile: { ...before.profile, pdfDocumentType: 'web' },
      };
      const diff = diffReports(before, after);
      expect(diff.criteria.changed).toEqual([]);
      expect(diff.criteria.notCompared.length).toBeGreaterThan(0);
      expect(new Set(diff.criteria.notCompared.map((c) => c.reason))).toEqual(
        new Set(['profile-mismatch']),
      );
    });

    it('does not count fails on a page missing from after as fixed', () => {
      const fail = record(B, 'color-contrast', 'fail');
      const before = web({ assets: [A, B], findings: [fail] });
      const after = web({ assets: [A], findings: [] });
      const diff = diffReports(before, after);
      expect(diff.findings.fixed).toEqual([]);
      expect(diff.findings.notCompared).toEqual([
        {
          id: fail.id,
          uri: B.uri,
          ruleId: 'color-contrast',
          outcome: 'fail',
          reason: 'missing-after',
        },
      ]);
    });

    it('does not count fails on a page that errored in after as fixed', () => {
      const fail = record(B, 'color-contrast', 'fail');
      const before = web({ assets: [A, B], findings: [fail] });
      const after = web({
        assets: [A],
        findings: [],
        errors: [{ uri: B.uri, code: 'navigation-failed', message: 'timeout' }],
      });
      const diff = diffReports(before, after);
      expect(diff.findings.fixed).toEqual([]);
      expect(diff.findings.notCompared.map((e) => [e.id, e.reason])).toEqual([
        [fail.id, 'not-scanned-after'],
      ]);
    });

    it('does not count fails on a page new in after as new', () => {
      const fail = record(C, 'color-contrast', 'fail');
      const before = web({ assets: [A], findings: [] });
      const after = web({ assets: [A, C], findings: [fail] });
      const diff = diffReports(before, after);
      expect(diff.findings.new).toEqual([]);
      expect(diff.findings.notCompared.map((e) => [e.id, e.reason])).toEqual([
        [fail.id, 'missing-before'],
      ]);
    });

    it('does not compare records on an asset that is listed and errored in the same report', () => {
      // A PDF can be listed in assets and in errors (one engine read it, another failed).
      const fail = record(A, 'color-contrast', 'fail');
      const before = web({ assets: [A], findings: [fail] });
      const after = web({
        assets: [A],
        findings: [],
        errors: [{ uri: A.uri, code: 'engine-failed', message: 'crashed' }],
      });
      const diff = diffReports(before, after);
      expect(diff.findings.fixed).toEqual([]);
      expect(diff.findings.notCompared.map((e) => e.reason)).toEqual(['not-scanned-after']);
    });

    it('lists rows of a view only one report has as view-missing', () => {
      const before = reviewFixtureReport();
      const after: ScanReport = {
        ...before,
        rollup: {
          ...before.rollup,
          standards: before.rollup.standards.filter((s) => s.standard === 'wcag21aa'),
        },
      };
      const diff = diffReports(before, after);
      const only508 = before.rollup.standards.find((s) => s.standard === '508');
      expect(diff.criteria.notCompared).toHaveLength(only508?.criteria.length ?? -1);
      expect(diff.criteria.notCompared.every((c) => c.standard === '508')).toBe(true);
      expect(diff.criteria.notCompared.every((c) => c.reason === 'view-missing')).toBe(true);
    });

    it('lists a row one shared view lacks as criterion-missing', () => {
      const before = reviewFixtureReport();
      const after: ScanReport = {
        ...before,
        rollup: {
          ...before.rollup,
          standards: before.rollup.standards.map((s) =>
            s.standard === 'wcag21aa'
              ? { ...s, criteria: s.criteria.filter((c) => c.id !== '1.4.3') }
              : s,
          ),
        },
      };
      expect(diffReports(before, after).criteria.notCompared).toEqual([
        { standard: 'wcag21aa', id: '1.4.3', reason: 'criterion-missing' },
      ]);
    });
  });

  describe('overrides and manual records', () => {
    const scan = (reviews: Finding[]) =>
      buildScanReport({
        profile: getProfile('508+wcag21aa'),
        startedAt: '2026-10-23T12:00:00.000Z',
        finishedAt: '2026-10-23T12:05:00.000Z',
        toolVersion: '0.0.0',
        scope: { web: { urls: [PAGE.uri], truncated: false } },
        web: {
          engine: { name: 'axe-core', version: '4.14.0' },
          assets: [PAGE],
          findings: [HERO, CONTRAST],
          errors: [],
          skipped: [],
          warnings: [],
          truncated: false,
        },
        reviews,
      });

    it('marks a fail overridden in after as fixed by override, and its criteria as changed', () => {
      const before = scan([]);
      const after = scan([OVERRIDE]);
      const diff = diffReports(before, after);
      expect(diff.findings.fixed).toEqual([
        { id: HERO.id, uri: PAGE.uri, ruleId: 'image-alt', outcome: 'fail', fixedBy: 'override' },
      ]);
      expect(diff.findings.new).toEqual([]);
      const level = (r: ScanReport) =>
        r.rollup.standards
          .find((s) => s.standard === 'wcag21aa')
          ?.criteria.find((c) => c.id === '1.1.1')?.level;
      expect(level(before)).toBe('Does Not Support');
      expect(diff.criteria.changed).toContainEqual({
        standard: 'wcag21aa',
        id: '1.1.1',
        before: 'Does Not Support',
        after: level(after),
      });
    });

    it('counts a fail whose override expired or was removed as new', () => {
      const diff = diffReports(scan([OVERRIDE]), scan([]));
      expect(diff.findings.new).toEqual([
        { id: HERO.id, uri: PAGE.uri, ruleId: 'image-alt', outcome: 'fail' },
      ]);
      expect(diff.findings.fixed).toEqual([]);
    });

    const expired = manualFail(PAGE, hash('9'));
    const current = manualFail(PAGE, PAGE.contentHash);
    const empty = { new: [], fixed: [], unchanged: [], notCompared: [] };

    it('leaves out a manual record expired in both reports, or expired in one and absent in the other', () => {
      expect(diffReports(scan([expired]), scan([expired])).findings).toEqual({
        ...empty,
        unchanged: diffReports(scan([]), scan([])).findings.unchanged,
      });
      expect(ids(diffReports(scan([expired]), scan([])).findings.notCompared)).toEqual([]);
      expect(ids(diffReports(scan([]), scan([expired])).findings.notCompared)).toEqual([]);
    });

    it('does not compare a manual record that went from current to expired', () => {
      const diff = diffReports(scan([current]), scan([expired]));
      expect(diff.findings.fixed).toEqual([]);
      expect(diff.findings.notCompared).toEqual([
        {
          id: current.id,
          uri: PAGE.uri,
          ruleId: 'wcag-2.1.1',
          outcome: 'fail',
          reason: 'review-expired',
        },
      ]);
    });

    it('does not compare a manual record that went from expired to current', () => {
      const diff = diffReports(scan([expired]), scan([current]));
      expect(diff.findings.new).toEqual([]);
      expect(diff.findings.notCompared).toEqual([
        {
          id: current.id,
          uri: PAGE.uri,
          ruleId: 'wcag-2.1.1',
          outcome: 'fail',
          reason: 'review-expired',
        },
      ]);
    });

    it('counts a manual record current in after and absent from before as new', () => {
      expect(diffReports(scan([]), scan([current])).findings.new).toEqual([
        { id: current.id, uri: PAGE.uri, ruleId: 'wcag-2.1.1', outcome: 'fail' },
      ]);
    });
  });

  describe('dedupe before the override test', () => {
    // HERO's needs-review twin: the same id and uri.
    const heroReview = FindingSchema.parse({ ...HERO, outcome: 'needs-review', impact: undefined });
    const scanWith = (findings: Finding[], reviews: Finding[]) =>
      buildScanReport({
        profile: getProfile('508+wcag21aa'),
        startedAt: '2026-10-23T12:00:00.000Z',
        finishedAt: '2026-10-23T12:05:00.000Z',
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
        },
        reviews,
      });

    it('keeps the overridden fail over a needs-review with its key, so a before fail is fixed by override', () => {
      const after = scanWith([HERO, heroReview], [OVERRIDE]);
      const diff = diffReports(scanWith([HERO], []), after);
      expect(diff.findings.fixed).toEqual([
        { id: HERO.id, uri: PAGE.uri, ruleId: 'image-alt', outcome: 'fail', fixedBy: 'override' },
      ]);
      expect(ids(diff.findings.unchanged)).not.toContain(HERO.id);
    });

    it('marks a before needs-review against an after overridden fail as plain fixed', () => {
      const diff = diffReports(scanWith([heroReview], []), scanWith([HERO], [OVERRIDE]));
      expect(diff.findings.fixed).toEqual([
        { id: HERO.id, uri: PAGE.uri, ruleId: 'image-alt', outcome: 'needs-review' },
      ]);
    });
  });

  it('sorts every list, so the same inputs give the same bytes', () => {
    const fails = [C, A, B].flatMap((asset) => [
      record(asset, 'label', 'fail'),
      record(asset, 'color-contrast', 'fail'),
    ]);
    const before = web({ assets: [C, A, B], findings: fails, profile: '508+wcag21aa' });
    const after = web({ assets: [B, A], findings: [], profile: 'wcag21aa' });
    const diff = diffReports(before, after);
    const sortedBy =
      <T>(...keys: ((t: T) => string)[]) =>
      (list: T[]) =>
        [...list].sort((x, y) => keys.reduce((r, k) => r || ordinal(k(x), k(y)), 0));
    const byUri = sortedBy<{ uri: string; id: string }>(
      (e) => e.uri,
      (e) => e.id,
    );
    expect(diff.findings.fixed).toEqual(byUri(diff.findings.fixed));
    expect(diff.findings.fixed).toHaveLength(4);
    expect(diff.findings.notCompared).toEqual(byUri(diff.findings.notCompared));
    expect(diff.findings.notCompared).toHaveLength(2);
    const byStandard = sortedBy<{ standard: string; id: string }>(
      (c) => c.standard,
      (c) => c.id,
    );
    expect(diff.criteria.notCompared).toEqual(byStandard(diff.criteria.notCompared));
    const reversed: ScanReport = { ...before, findings: [...before.findings].reverse() };
    expect(JSON.stringify(diffReports(reversed, after))).toBe(JSON.stringify(diff));
  });

  it('matches ReportDiffSchema and records each side', () => {
    const before = parseJsonReport(serializeJson(reviewFixtureReport()));
    const after = web({ assets: [A], findings: [], startedAt: '2026-10-24T08:00:00.000Z' });
    const diff: ReportDiff = ReportDiffSchema.parse(diffReports(before, after));
    expect(diff.schemaVersion).toBe(1);
    expect(diff.before).toEqual({
      startedAt: '2026-10-23T12:00:00.000Z',
      profile: { id: '508+wcag21aa', pdfDocumentType: 'non-web' },
    });
    expect(diff.after).toEqual({
      startedAt: '2026-10-24T08:00:00.000Z',
      profile: { id: 'wcag21aa', pdfDocumentType: 'non-web' },
    });
    expect(diff.findings.notCompared.map((e) => e.uri).sort()).toEqual([PAGE.uri, PDF.uri].sort());
  });
});
