import {
  CONFORMANCE_LEVELS,
  currentHashes,
  isCurrentRecord,
  type ConformanceLevel,
  type Impact,
  type Outcome,
} from '@widedoor/core/browser';
import type { ScanReport } from './model.js';

/*
 * Counts by outcome, impact and conformance level. These are the numbers the
 * HTML summary shows and a CLI exit policy can read; this module sets no
 * policy of its own. Every count is over records, so two records that share a
 * finding id count twice. Expired manual records (isCurrentRecord) are not
 * counted: they no longer describe the asset.
 */

export type ImpactOrUnrated = Impact | 'unrated';

export interface ReportSummary {
  assets: number;
  errors: number;
  skipped: number;
  /** Every current finding record by outcome. */
  outcomes: Record<Outcome, number>;
  /** Fail records by impact. */
  failsByImpact: Record<ImpactOrUnrated, number>;
  /** Needs-review records by impact. */
  needsReviewByImpact: Record<ImpactOrUnrated, number>;
  /** Criteria per conformance level, per standard. */
  criteria: { standard: string; levels: Record<ConformanceLevel, number> }[];
  /** Distinct criterion ids with at least one asset (or the product) not evaluated, under any standard. */
  notTested: number;
}

export const IMPACT_ORDER: readonly ImpactOrUnrated[] = [
  'critical',
  'serious',
  'moderate',
  'minor',
  'unrated',
];

const zeroImpacts = (): Record<ImpactOrUnrated, number> => ({
  critical: 0,
  serious: 0,
  moderate: 0,
  minor: 0,
  unrated: 0,
});

export function summarize(report: ScanReport): ReportSummary {
  const outcomes: Record<Outcome, number> = {
    pass: 0,
    fail: 0,
    'needs-review': 0,
    'not-applicable': 0,
    'not-tested': 0,
  };
  const failsByImpact = zeroImpacts();
  const needsReviewByImpact = zeroImpacts();
  const hashes = currentHashes(report.assets);
  for (const f of report.findings) {
    if (!isCurrentRecord(f, hashes)) continue;
    outcomes[f.outcome]++;
    const impact = f.impact ?? 'unrated';
    if (f.outcome === 'fail') failsByImpact[impact]++;
    if (f.outcome === 'needs-review') needsReviewByImpact[impact]++;
  }
  const criteria = report.rollup.standards.map((s) => {
    const levels = Object.fromEntries(CONFORMANCE_LEVELS.map((l) => [l, 0])) as Record<
      ConformanceLevel,
      number
    >;
    for (const c of s.criteria) {
      levels[c.level]++;
    }
    return { standard: s.standard, levels };
  });
  return {
    assets: report.assets.length,
    errors: report.errors.length,
    skipped: report.skipped.length,
    outcomes,
    failsByImpact,
    needsReviewByImpact,
    criteria,
    notTested: notEvaluated(report).length,
  };
}

export interface NotEvaluated {
  id: string;
  title: string;
  /** True for a product-scope item (judged once, not per asset). */
  product: boolean;
  /** Assets not evaluated, out of those the criterion applies to. */
  count: number;
  total: number;
  /** The level reason; it explains a criterion capped by a scope gap, where count can be 0. */
  reason: string;
}

/**
 * Criteria with a gap: any asset detail (or the product determination) in the
 * not-evaluated state, or a level of Not Evaluated (a scope gap can cap a
 * criterion whose every asset passed), under any standard. One entry per criterion id,
 * keeping the standard with the most unevaluated assets.
 */
export function notEvaluated(report: ScanReport): NotEvaluated[] {
  const out = new Map<string, NotEvaluated>();
  for (const s of report.rollup.standards)
    for (const c of s.criteria) {
      const units = c.product ? [c.product] : c.assets;
      const applicable = units.filter((u) => u.state !== 'not-applicable');
      const count = applicable.filter((u) => u.state === 'not-evaluated').length;
      if (count === 0 && c.level !== 'Not Evaluated') continue;
      const prior = out.get(c.id);
      if (prior && prior.count >= count) continue;
      out.set(c.id, {
        id: c.id,
        title: c.title,
        product: c.scope === 'product',
        count,
        total: applicable.length,
        reason: c.reason,
      });
    }
  return [...out.values()];
}
