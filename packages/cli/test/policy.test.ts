import { describe, expect, it } from 'vitest';
import type { Asset, Finding, Impact } from '@widedoor/core';
import { countingFails, exitDecision, tripsThreshold } from '../src/policy.ts';

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const PAGE: Asset = { kind: 'web', uri: 'https://example.com/', contentHash: hash('a') };

let n = 0;
function finding(
  outcome: Finding['outcome'],
  impact?: Impact,
  manual?: { reviewedHash: string },
): Finding {
  const base = {
    schemaVersion: 1 as const,
    id: `wd_${(n++).toString(16).padStart(16, '0')}`,
    asset: PAGE,
    location: { selector: 'img' },
    criteria: { wcag: ['1.1.1'] },
    outcome,
    ...(impact ? { impact } : {}),
  };
  if (manual)
    return {
      ...base,
      source: { engine: 'manual', engineVersion: '1', ruleId: 'alt' },
      review: { reviewer: 'R', date: '2026-10-21', expiresOnChangeOf: manual.reviewedHash },
    } as Finding;
  return {
    ...base,
    source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId: 'image-alt' },
  } as Finding;
}

const report = (findings: Finding[], extra: Partial<Parameters<typeof exitDecision>[0]> = {}) => ({
  findings,
  assets: [PAGE],
  errors: [],
  skipped: [],
  ...extra,
});

describe('tripsThreshold', () => {
  it('counts impacts at or above the level, unrated always, nothing for none', () => {
    expect(tripsThreshold('serious', 'serious')).toBe(true);
    expect(tripsThreshold('critical', 'serious')).toBe(true);
    expect(tripsThreshold('moderate', 'serious')).toBe(false);
    expect(tripsThreshold('minor', 'minor')).toBe(true);
    expect(tripsThreshold(undefined, 'critical')).toBe(true);
    expect(tripsThreshold('critical', 'none')).toBe(false);
  });
});

describe('exitDecision', () => {
  it('exits 1 for a fail at or above the threshold', () => {
    expect(exitDecision(report([finding('fail', 'serious')]), 'serious')).toEqual({
      code: 1,
      reason: '1 failed check at or above serious',
    });
  });

  it('exits 0 below the threshold and when it is off', () => {
    const r = report([finding('fail', 'moderate')]);
    expect(exitDecision(r, 'serious').code).toBe(0);
    expect(exitDecision(r, 'moderate').code).toBe(1);
    expect(exitDecision(report([finding('fail', 'critical')]), 'none')).toEqual({
      code: 0,
      reason: 'the fail threshold is off (--fail-on none)',
    });
  });

  it('never counts needs-review, whatever its impact', () => {
    expect(exitDecision(report([finding('needs-review', 'critical')]), 'minor').code).toBe(0);
  });

  it('exits 2 for any scan error, before the threshold and even with --fail-on none', () => {
    const errors = [
      { kind: 'web' as const, uri: 'https://example.com/x', code: 'timeout', message: 'slow' },
    ];
    const r = report([finding('fail', 'critical')], { errors });
    expect(exitDecision(r, 'serious')).toEqual({
      code: 2,
      reason: '1 scan error: part of the scope was not scanned',
    });
    expect(exitDecision(r, 'none').code).toBe(2);
  });

  it('exits 2 when only skipped pages remain, such as an off-origin redirect', () => {
    const skipped = [
      {
        uri: 'https://example.com/old',
        finalUri: 'https://other.example/',
        reason: 'redirect-off-origin',
      },
    ];
    expect(exitDecision(report([], { assets: [], skipped }), 'serious')).toEqual({
      code: 2,
      reason: 'nothing was scanned',
    });
  });

  it('exits 2 when nothing was scanned at all', () => {
    expect(exitDecision(report([], { assets: [] }), 'serious')).toEqual({
      code: 2,
      reason: 'nothing was scanned',
    });
  });

  it('counts a manual fail only while its review matches the current content', () => {
    const current = finding('fail', 'serious', { reviewedHash: PAGE.contentHash });
    const expired = finding('fail', 'serious', { reviewedHash: hash('b') });
    expect(countingFails(report([current, expired]))).toEqual([current]);
    expect(exitDecision(report([expired]), 'serious').code).toBe(0);
  });

  it('exits 2 when the page cap left listed pages unscanned, naming the count and the setting', () => {
    const r = report([]);
    expect(
      exitDecision(r, 'serious', {
        unscannedListed: 3,
        maxPages: 50,
        maxPagesSetting: 'default',
      }),
    ).toEqual({
      code: 2,
      reason:
        '3 listed pages were not scanned: the page limit (50) was reached; raise web.maxPages in widedoor.config.yaml',
    });
    expect(
      exitDecision(r, 'none', {
        unscannedListed: 1,
        maxPages: 7,
        maxPagesSetting: 'web.crawl.maxPages',
      }),
    ).toEqual({
      code: 2,
      reason:
        '1 listed page was not scanned: the page limit (7) was reached; raise web.crawl.maxPages in widedoor.config.yaml',
    });
  });

  it('leaves a run with every listed page scanned to the threshold', () => {
    expect(exitDecision(report([]), 'serious', { unscannedListed: 0, maxPages: 2 }).code).toBe(0);
  });

  it('ignores an automated fail the roll-up lists as overridden, and only that one', () => {
    const set = finding('fail', 'critical');
    const kept = finding('fail', 'serious');
    const unit = (overridden: string[], evidence: string[]) => ({
      uri: PAGE.uri,
      kind: 'web' as const,
      state: evidence.length > 0 ? ('fail' as const) : ('pass' as const),
      reason: evidence.length > 0 ? ('automated-fail' as const) : ('manual-override' as const),
      evidence,
      undecided: [],
      expired: [],
      overridden,
    });
    const row = (id: string, u: ReturnType<typeof unit>) => ({
      id,
      title: id,
      type: 'wcag' as const,
      scope: 'asset' as const,
      level: 'Supports' as const,
      reason: 'test',
      evidence: [],
      assets: [u],
    });
    const rollup = (units: ReturnType<typeof unit>[]) => ({
      profile: 'wcag21aa' as const,
      standards: [
        { standard: 'wcag21aa' as const, criteria: units.map((u, i) => row(`1.1.${i + 1}`, u)) },
      ],
    });
    const both = [set, kept];
    expect(countingFails({ ...report(both), rollup: rollup([unit([set.id], [])]) })).toEqual([
      kept,
    ]);
    expect(
      exitDecision({ ...report(both), rollup: rollup([unit([set.id], [])]) }, 'critical'),
    ).toEqual({ code: 0, reason: 'no failed check at or above critical' });
    // Set aside in one criterion but still a fail in another: it counts.
    expect(
      countingFails({
        ...report(both),
        rollup: rollup([unit([set.id], []), unit([], [set.id])]),
      }),
    ).toEqual(both);
    // A report without overridden lists sets nothing aside.
    expect(countingFails(report(both))).toEqual(both);
    // --ignore-overrides: the override no longer takes the fail out of the gate.
    const overriddenReport = { ...report(both), rollup: rollup([unit([set.id], [])]) };
    expect(countingFails(overriddenReport, true)).toEqual(both);
    expect(
      exitDecision(overriddenReport, 'critical', { unscannedListed: 0 }, { ignoreOverrides: true }),
    ).toEqual({
      code: 1,
      reason: '1 failed check at or above critical (review overrides ignored)',
      overridesCounted: 1,
    });
    // Only the overridden fails the gate counts: a kept fail alone is not one.
    expect(
      exitDecision(
        { ...report([kept]), rollup: rollup([unit([set.id], [])]) },
        'serious',
        { unscannedListed: 0 },
        { ignoreOverrides: true },
      ),
    ).toEqual({ code: 1, reason: '1 failed check at or above serious (review overrides ignored)' });
    // Below the threshold an overridden fail does not count, so it is not reported either.
    expect(
      exitDecision(overriddenReport, 'none', { unscannedListed: 0 }, { ignoreOverrides: true }),
    ).toEqual({ code: 0, reason: 'the fail threshold is off (--fail-on none)' });
  });
});
