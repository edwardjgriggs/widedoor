import { describe, expect, it } from 'vitest';
import { FindingSchema, findingId, getProfile, type Asset, type Finding } from '@widedoor/core';
import {
  EXPIRED_NOTE,
  TEXT,
  assetFindings,
  buildScanReport,
  findingCards,
  listedFindings,
  manualReviews,
  parseJsonReport,
  renderHtml,
  serializeJson,
  summarize,
  toSarif,
  type ScanReport,
} from '@widedoor/report';
import { countingFails, exitDecision } from '../src/policy.ts';
import { printSummary } from '../src/summary.ts';

/*
 * One rule decides whether a manual record still counts (isCurrentRecord in
 * @widedoor/core): its review's expiresOnChangeOf must equal the asset's
 * current content hash. A report whose only fail is an expired manual review
 * must read the same way in every output: no fail in the JSON summary, the
 * console or the exit code, no card in the HTML report or the viewer's view
 * helpers, no SARIF result, and the plain-language text of the record shown
 * nowhere, while the methodology still lists it as expired. The same record
 * with a current hash shows as a fail everywhere, so the test is not vacuous.
 */

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const PAGE: Asset = { kind: 'web', uri: 'https://site.example/home', contentHash: hash('a') };
const WHAT = 'The search form cannot be used with a keyboard (manual finding).';

function manualFail(anchor: string): Finding {
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(PAGE.uri, { selector: 'form' }, 'manual', 'keyboard'),
    asset: PAGE,
    location: { selector: 'form' },
    source: { engine: 'manual', engineVersion: '0.0.0', ruleId: 'keyboard' },
    criteria: { wcag: ['2.1.1'] },
    outcome: 'fail',
    impact: 'serious',
    plain: { what: WHAT, who: 'Keyboard users.', fix: 'Make the form reachable by keyboard.' },
    review: {
      reviewer: 'Reviewer',
      date: '2026-10-20',
      notes: 'Tab skips the search field.',
      expiresOnChangeOf: anchor,
    },
  });
}

function reportWith(review: Finding): ScanReport {
  const built = buildScanReport({
    profile: getProfile('wcag21aa'),
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
    reviews: [review],
  });
  // The JSON report is what every other consumer (widedoor ui, CI) reads back.
  return parseJsonReport(serializeJson(built));
}

function outputs(report: ScanReport) {
  const lines: string[] = [];
  const decision = exitDecision(report, 'serious');
  printSummary(report, { written: [], decision, failOn: 'serious' }, { out: (l) => lines.push(l) });
  const sarif = toSarif(report) as { runs: { results: unknown[] }[] };
  const criterion = report.rollup.standards
    .flatMap((s) => s.criteria)
    .find((c) => c.id === '2.1.1');
  return {
    summary: summarize(report),
    counting: countingFails(report).length,
    exit: decision.code,
    console: lines,
    html: renderHtml(report),
    sarifResults: sarif.runs[0]?.results.length,
    cards: findingCards(report.findings, report.assets).length,
    perAsset: assetFindings(report.findings, PAGE.uri, report.assets).length,
    listed: listedFindings(report.findings, report.assets).length,
    reviews: manualReviews(report).records,
    level: criterion?.level,
  };
}

describe('an expired manual fail', () => {
  const expired = outputs(reportWith(manualFail(hash('0'))));

  it('counts as no fail in the JSON summary, the console and the exit code', () => {
    expect(expired.summary.outcomes.fail).toBe(0);
    expect(expired.summary.failsByImpact.serious).toBe(0);
    expect(expired.counting).toBe(0);
    expect(expired.exit).toBe(0);
    expect(expired.console).toContain(
      'Failed checks by impact: 0 critical, 0 serious, 0 moderate, 0 minor.',
    );
    expect(expired.console.at(-1)).toMatch(/^Exit 0: /);
  });

  it('is no SARIF result, no card in the HTML report and nothing in the viewer helpers', () => {
    expect(expired.sarifResults).toBe(0);
    expect(expired.cards).toBe(0);
    expect(expired.perAsset).toBe(0);
    expect(expired.listed).toBe(0);
    expect(expired.html).toContain(TEXT.noFindings);
    // Its plain-language text (the record's own plain block) is shown nowhere.
    expect(expired.html).not.toContain(WHAT);
  });

  it('stays listed under the methodology with the expired note, and the roll-up does not use it', () => {
    expect(expired.reviews).toHaveLength(1);
    expect(expired.reviews[0]?.expired).toBe(true);
    expect(EXPIRED_NOTE).toContain('expired: the content changed since this review');
    expect(expired.html).toContain('expired: the content changed since this review');
    expect(expired.level).toBe('Not Evaluated');
  });
});

describe('the same manual fail while current', () => {
  const current = outputs(reportWith(manualFail(PAGE.contentHash as string)));

  it('is a fail in every output', () => {
    expect(current.summary.outcomes.fail).toBe(1);
    expect(current.summary.failsByImpact.serious).toBe(1);
    expect(current.counting).toBe(1);
    expect(current.exit).toBe(1);
    expect(current.console).toContain(
      'Failed checks by impact: 0 critical, 1 serious, 0 moderate, 0 minor.',
    );
    expect(current.sarifResults).toBe(1);
    expect(current.cards).toBe(1);
    expect(current.perAsset).toBe(1);
    expect(current.listed).toBe(1);
    expect(current.html).toContain(WHAT);
    expect(current.reviews[0]?.expired).toBe(false);
    expect(current.level).toBe('Does Not Support');
  });
});
