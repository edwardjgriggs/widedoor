import { currentHashes, isCurrentRecord, type Finding } from '@widedoor/core/browser';
import type { Override, ScanReport } from './model.js';

/*
 * Reviewer overrides as every reporter reads them, from the roll-up: an
 * automated fail record is overridden when a current manual pass sets it
 * aside (the determination lists its id in overridden) in a criterion it
 * cites, and it is evidence of a fail in none. A fail that cites two criteria
 * and is set aside in only one still counts. Overridden fails leave the
 * counts, the cards and the exit gate; SARIF keeps them as suppressed
 * results. A determination with no overridden list (a report written before
 * overrides) sets nothing aside. No Node built-ins: the UI bundles it.
 */

/** Whether a record is an overridden automated fail. */
export type OverrideTest = (f: Finding) => boolean;

/** Sets nothing aside: for callers that have no roll-up. */
export const NO_OVERRIDES: OverrideTest = () => false;

const key = (uri: string, id: string) => `${uri}\u0000${id}`;

/** The override test for a report's roll-up. */
export function overriddenFails(report: Pick<ScanReport, 'rollup'>): OverrideTest {
  const set = new Set<string>();
  const counts = new Set<string>();
  // Product-scope items are judged across assets, so their ids are matched on any asset.
  const productSet = new Set<string>();
  const productCounts = new Set<string>();
  for (const s of report.rollup.standards)
    for (const c of s.criteria) {
      for (const d of c.assets) {
        for (const id of d.overridden ?? []) set.add(key(d.uri, id));
        for (const id of d.evidence) counts.add(key(d.uri, id));
      }
      if (c.product) {
        for (const id of c.product.overridden ?? []) productSet.add(id);
        for (const id of c.product.evidence) productCounts.add(id);
      }
    }
  if (set.size === 0 && productSet.size === 0) return NO_OVERRIDES;
  return (f) => {
    if (f.source.engine === 'manual' || f.outcome !== 'fail') return false;
    const k = key(f.asset.uri, f.id);
    return (set.has(k) || productSet.has(f.id)) && !counts.has(k) && !productCounts.has(f.id);
  };
}

const cited = (f: Finding): Override['criterion'][] => [
  ...(f.criteria.wcag ?? []).map((id) => ({ type: 'wcag' as const, id })),
  ...(f.criteria.section508 ?? []).map((id) => ({ type: 'section508' as const, id })),
];

const cites = (f: Finding, c: Override['criterion']) =>
  cited(f).some((x) => x.type === c.type && x.id === c.id);

/**
 * The overridden fails and the manual passes that set them aside, in report
 * order: one entry per fail record and current manual pass (with notes) on
 * the same asset that names its id and cites one of its criteria.
 */
export function overrideEntries(
  report: Pick<ScanReport, 'rollup' | 'findings' | 'assets'>,
): Override[] {
  const overridden = overriddenFails(report);
  if (overridden === NO_OVERRIDES) return [];
  const hashes = currentHashes(report.assets);
  const passes = report.findings.flatMap((f) =>
    f.source.engine === 'manual' &&
    f.outcome === 'pass' &&
    'review' in f &&
    f.review.notes?.trim() &&
    (f.review.overrides?.length ?? 0) > 0 &&
    isCurrentRecord(f, hashes)
      ? [{ f, review: f.review }]
      : [],
  );
  const out: Override[] = [];
  for (const f of report.findings) {
    if (!overridden(f) || f.source.engine === 'manual') continue;
    for (const { f: pass, review } of passes) {
      if (pass.asset.uri !== f.asset.uri || !review.overrides?.includes(f.id)) continue;
      const criterion = cited(pass).find((c) => cites(f, c));
      if (!criterion) continue;
      out.push({
        finding: f.id,
        uri: f.asset.uri,
        engine: f.source.engine,
        ruleId: f.source.ruleId,
        record: pass.id,
        criterion,
        reviewer: review.reviewer,
        date: review.date,
        notes: review.notes ?? '',
      });
    }
  }
  return out;
}
