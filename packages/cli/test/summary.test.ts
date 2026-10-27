import { describe, expect, it } from 'vitest';
import { FindingSchema, findingId, getProfile, type Asset, type Finding } from '@widedoor/core';
import { buildScanReport } from '@widedoor/report';
import { exitDecision } from '../src/policy.ts';
import { printSummary } from '../src/summary.ts';

/*
 * The console summary with manual reviews: an automated fail a reviewer set
 * aside is counted on its own line and not as a fail (nor in the exit
 * code), the levels per standard say which Supports rest on the errata
 * basis, and the checklist progress is printed. Reviewer text never reaches
 * the console unescaped.
 */

const PAGE: Asset = {
  kind: 'web',
  uri: 'https://site.example/home',
  contentHash: `sha256:${'a'.repeat(64)}`,
};

const fail: Finding = FindingSchema.parse({
  schemaVersion: 1,
  id: findingId(PAGE.uri, { selector: 'img' }, 'axe-core', 'image-alt'),
  asset: PAGE,
  location: { selector: 'img' },
  source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId: 'image-alt' },
  criteria: { wcag: ['1.1.1'] },
  outcome: 'fail',
  impact: 'critical',
});

const override: Finding = FindingSchema.parse({
  schemaVersion: 1,
  id: findingId(PAGE.uri, { selector: 'html' }, 'manual', 'wcag-1.1.1'),
  asset: PAGE,
  location: { selector: 'html' },
  source: { engine: 'manual', engineVersion: '0.0.0', ruleId: 'wcag-1.1.1' },
  criteria: { wcag: ['1.1.1'] },
  outcome: 'pass',
  review: {
    reviewer: 'Ann \u001b[31m',
    date: '2026-10-23',
    notes: 'Decorative image.',
    expiresOnChangeOf: PAGE.contentHash,
    overrides: [fail.id],
  },
});

const report = buildScanReport({
  profile: getProfile('wcag21aa'),
  startedAt: '2026-10-23T12:00:00.000Z',
  finishedAt: '2026-10-23T12:01:00.000Z',
  toolVersion: '0.0.0',
  scope: { web: { urls: [PAGE.uri], truncated: false } },
  web: {
    engine: { name: 'axe-core', version: '4.14.0' },
    assets: [PAGE],
    findings: [fail],
    errors: [],
    skipped: [],
    warnings: [],
    truncated: false,
  },
  reviews: [override],
});

describe('printSummary with manual reviews', () => {
  const decision = exitDecision(report, 'serious');
  const lines: string[] = [];
  printSummary(report, { written: [], decision, failOn: 'serious' }, { out: (l) => lines.push(l) });

  it('counts the overridden fail on its own line, not as a fail, and exits 0', () => {
    expect(lines).toContain(
      'Set aside by a reviewer: 1 automated fail (overridden as false positives; not counted as fails).',
    );
    expect(lines.find((l) => l.startsWith('Results: '))).toMatch(/^Results: 0 fail, /);
    expect(decision.code).toBe(0);
  });

  it('says Supports for 4.1.1 rests on the errata basis', () => {
    expect(lines.find((l) => l.startsWith('Criteria, WCAG 2.1 Level AA: '))).toMatch(
      /: 2 Supports \(4\.1\.1 on the errata basis, not on a test\), /,
    );
  });

  it('prints the checklist progress, and nothing from the review unescaped', () => {
    const c = report.checklist!;
    expect(lines).toContain(
      `Manual review checklist: ${c.total} items (${c.byStatus.open} open, ${c.byStatus.done} done, 0 expired, 0 failed-automated); widedoor review list shows them.`,
    );
    expect(lines.join('\n')).not.toContain('\u001b');
  });

  it('has no line for overrides counted when the run takes the overrides', () => {
    expect(lines.join('\n')).not.toContain('--ignore-overrides');
  });
});

describe('printSummary with --ignore-overrides', () => {
  const summary = (failOn: 'serious' | 'none') => {
    const decision = exitDecision(report, failOn, undefined, { ignoreOverrides: true });
    const lines: string[] = [];
    printSummary(
      report,
      { written: [], decision, failOn, ignoreOverrides: true },
      { out: (l) => lines.push(l) },
    );
    return { decision, lines };
  };

  it('says how many counted failed checks a reviewer overrode, before the exit line', () => {
    const { decision, lines } = summary('serious');
    expect(decision.code).toBe(1);
    expect(lines.slice(-2)).toEqual([
      '1 failed check counted that a reviewer overrode (--ignore-overrides).',
      'Exit 1: 1 failed check at or above serious (review overrides ignored).',
    ]);
  });

  it('says the overridden fails count toward the exit code, not that they do not count', () => {
    const { lines } = summary('serious');
    expect(lines).toContain(
      'Set aside by a reviewer: 1 automated fail (listed as overridden in the report, but counted toward the exit code: --ignore-overrides).',
    );
    expect(lines.join('\n')).not.toContain('not counted as fails');
  });

  it('says nothing when no overridden fail counts', () => {
    const { decision, lines } = summary('none');
    expect(decision.code).toBe(0);
    expect(lines.join('\n')).not.toContain('counted that a reviewer overrode');
  });
});
