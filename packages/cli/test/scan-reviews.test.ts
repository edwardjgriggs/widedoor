import { describe, expect, it } from 'vitest';
import {
  FindingSchema,
  PROFILE_IDS,
  findingId,
  getProfile,
  type Asset,
  type Finding,
  type ProfileId,
} from '@widedoor/core';
import { buildScanReport, findingCards, summarize, toSarif } from '@widedoor/report';
import { reviewWarnings, screenScanReviews } from '@widedoor/server';
import { exitDecision } from '../src/policy.ts';

/*
 * The scan's screen of manual records (scan-reviews.ts in @widedoor/server)
 * and the exit code widedoor scan gives for it. A current Level AAA manual
 * fail (2.1.3) has no row in any profile, so it decides nothing in the
 * report: it is left out with its own warning under every profile, and no
 * row, count, card, SARIF result or exit code changes. A record that fits
 * the profile is used.
 */

const PAGE: Asset = {
  kind: 'web',
  uri: 'https://site.example/home',
  contentHash: `sha256:${'a'.repeat(64)}`,
};

function manual(sc: string, outcome: 'pass' | 'fail'): Finding {
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(PAGE.uri, { selector: 'html' }, 'manual', `wcag-${sc}`),
    asset: PAGE,
    location: { selector: 'html' },
    source: { engine: 'manual', engineVersion: '0.0.0', ruleId: `wcag-${sc}` },
    criteria: { wcag: [sc] },
    outcome,
    review: { reviewer: 'Ann', date: '2026-10-23', expiresOnChangeOf: PAGE.contentHash },
  });
}

const build = (profile: ProfileId) => (applied: readonly Finding[], warnings: readonly string[]) =>
  buildScanReport({
    profile: getProfile(profile),
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
    reviews: applied,
    warnings,
  });

const scope = { assets: [PAGE], automated: [] };

describe.each(PROFILE_IDS)('a current Level AAA manual fail under profile %s', (profile) => {
  const aaa = manual('2.1.3', 'fail');
  const { report, warnings } = screenScanReviews([aaa], scope, profile, build(profile));
  const baseline = build(profile)([], []);

  it('is left out with its own warning, in the report too', () => {
    const line = `manual review record ${aaa.id} on ${PAGE.uri}: WCAG 2.1.3 is not in profile ${profile}; the record is not used`;
    expect(warnings).toEqual([line]);
    expect(report.warnings).toEqual([line]);
    expect(report.findings.some((f) => f.id === aaa.id)).toBe(false);
  });

  it('changes no row, count, card, SARIF result or exit code', () => {
    expect(report.rollup).toEqual(baseline.rollup);
    expect(summarize(report).outcomes.fail).toBe(0);
    expect(findingCards(report.findings, report.assets)).toEqual([]);
    expect((toSarif(report) as { runs: { results: unknown[] }[] }).runs[0]?.results).toEqual([]);
    expect(exitDecision(report, 'serious').code).toBe(0);
  });
});

describe('screenScanReviews', () => {
  it('uses a record that fits the profile, and a fail on it counts', () => {
    const fail = manual('2.1.1', 'fail');
    const { report, warnings } = screenScanReviews([fail], scope, 'wcag21aa', build('wcag21aa'));
    expect(warnings).toEqual([]);
    expect(report.findings.map((f) => f.id)).toEqual([fail.id]);
    expect(exitDecision(report, 'serious').code).toBe(1);
  });

  it('caps each kind of warning at 20 lines plus a count', () => {
    const records = Array.from({ length: 23 }, () => manual('2.1.1', 'pass'))
      .map((f, i) => ({ ...f, id: `wd_${i.toString(16).padStart(16, '0')}` }))
      .map((record) => ({ record, reason: 'orphaned' as const, detail: 'elsewhere' }));
    const kept = Array.from({ length: 21 }, () => manual('2.4.1', 'fail'));
    const lines = reviewWarnings(records, kept, 'wcag21aa');
    expect(lines).toHaveLength(20 + 1 + 20 + 1);
    expect(lines[20]).toBe(
      '3 more manual review records were left out; run widedoor review list for all of them',
    );
    expect(lines[41]).toBe(
      '1 more manual fail with no checklist item was kept; run widedoor review list for all of them',
    );
  });
});
