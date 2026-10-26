import type { ManualCondition, ManualSteps, StandardsData } from './data.js';
import type { ProfileId, StandardId } from './profile-ids.js';
import { currentHashes, isCurrentRecord, type DeterminationReason } from './rollup.js';
import type { Asset, AssetKind, Finding } from './schema.js';
import { sha256Hex } from './sha256.js';

/*
 * The manual review checklist (spec section 3, step 4): the checks no tool
 * can make, one item per scanned asset per criterion still open after the
 * automated pass, plus one per product-scope 508 item. Built from a scan
 * report's roll-up and records, so it needs no Node built-ins and runs in
 * the browser too.
 *   - a unit decided by a deciding automated pass, the errata basis or a
 *     profile exception gets no item; one item covers a criterion on an asset
 *     for every standard view that needs it
 *   - a criterion with an errata basis (4.1.1) gets no item, whatever its
 *     records say: it needs no reviewer, and manual-steps.yaml has no steps
 *   - an unscanned asset gets no items (nothing on it can be reviewed against
 *     a hash); checklistSummary() counts it as needing a rescan
 *   - a product-scope item needs a scanned asset to anchor its review to
 *   - a review matches an item by the identity Task 2.4 writes: engine
 *     "manual", rule id wcag-<sc> or 508-<provision>, citing that criterion
 *   - status follows the roll-up unit, so it never disagrees with the
 *     report: a review the roll-up ignored (no notes on an override or an
 *     N/A) or outweighed (an automated fail it does not override) leaves the
 *     item open or failed; a caller that adds reviews re-runs the roll-up
 */

export type ChecklistItemStatus = 'open' | 'done' | 'expired' | 'failed-automated';
export const CHECKLIST_STATUSES: readonly ChecklistItemStatus[] = [
  'open',
  'done',
  'expired',
  'failed-automated',
];

export interface ChecklistItem {
  /** "ck_" + 16 hex of SHA-256 over JSON [asset uri or "product", criterion type, criterion id]. */
  id: string;
  scope: 'asset' | 'product';
  /** The asset to review; anchor is what a review of it expires on (reviewHash ?? contentHash). */
  asset?: { uri: string; kind: AssetKind; anchor: string };
  criterion: { type: 'wcag' | 'section508'; id: string; title: string };
  /** The standard views that need this item, in roll-up order. */
  standards: StandardId[];
  /** ICT Testing Baseline test ids for this asset kind. */
  baselineTests: string[];
  /** Plain-language steps, from manual-steps.yaml. */
  steps: string[];
  /**
   * manual-only: a 508 manual item, or no automated result touched the criterion on this asset;
   * needs-review: an engine asked for a human check; no-deciding-rule: automated results exist
   * but none decides. Status takes priority when reading an item: a criterion with only an
   * automated fail reads why 'no-deciding-rule' with status 'failed-automated'.
   */
  why: 'manual-only' | 'needs-review' | 'no-deciding-rule';
  /** Automated needs-review and fail finding ids on this asset and criterion, sorted. */
  related: string[];
  condition?: ManualCondition;
  /**
   * From the roll-up unit: done when a manual result decides it (manual pass, override, N/A or
   * fail), failed-automated on an automated fail, expired when only stale reviews exist, else open.
   */
  status: ChecklistItemStatus;
  /** Id of the current manual record, whenever one exists (even if the roll-up did not count it). */
  review?: string;
}

/** The roll-up fields the checklist reads; core's Rollup and a parsed report's both fit. */
export interface ChecklistRollup {
  profile: ProfileId;
  standards: readonly {
    standard: StandardId;
    criteria: readonly {
      id: string;
      title: string;
      type: 'wcag' | 'section508';
      scope: 'asset' | 'product';
      condition?: ManualCondition | undefined;
      assets: readonly { uri: string; kind: AssetKind; reason: DeterminationReason }[];
      product?: { reason: DeterminationReason } | undefined;
    }[];
  }[];
}

/** A scan report as the checklist sees it (structural, so core does not import @widedoor/report). */
export interface ChecklistInput {
  report: {
    assets: readonly Asset[];
    /** Automated findings and manual records together, as in a scan report. */
    findings: readonly Finding[];
    rollup: ChecklistRollup;
    profile: { id: ProfileId };
  };
  data: Pick<StandardsData, 'baseline' | 'manualSteps' | 'errata'>;
}

export interface ChecklistSummary {
  total: number;
  byStatus: Record<ChecklistItemStatus, number>;
  /** Assets in scope that were not scanned (errors, skipped pages): they need a rescan. */
  unscanned: { uri: string; kind: AssetKind }[];
}

/** Reasons where a counted manual result decides the unit. */
const REVIEWED: ReadonlySet<DeterminationReason> = new Set([
  'manual-pass',
  'manual-override',
  'manual-not-applicable',
  'manual-fail',
]);

/** Reasons that settle a unit without a reviewer. */
const SETTLED: ReadonlySet<DeterminationReason> = new Set([
  'deciding-automated-pass',
  'errata',
  'profile-not-applicable',
]);

export const checklistItemId = (
  assetUri: string | undefined,
  type: ChecklistItem['criterion']['type'],
  criterionId: string,
): string =>
  `ck_${sha256Hex(JSON.stringify([assetUri ?? 'product', type, criterionId])).slice(0, 16)}`;

/** The rule id Task 2.4 gives a manual record for a criterion. */
export const manualRuleId = (type: ChecklistItem['criterion']['type'], criterionId: string) =>
  `${type === 'wcag' ? 'wcag' : '508'}-${criterionId}`;

const cites = (f: Finding, type: ChecklistItem['criterion']['type'], id: string) =>
  (type === 'wcag' ? (f.criteria.wcag ?? []) : (f.criteria.section508 ?? [])).includes(id);

/** Newest review date first, then the larger id, so the pick does not depend on record order. */
const newest = (a: Finding, b: Finding) => {
  const da = 'review' in a ? a.review.date : '';
  const db = 'review' in b ? b.review.date : '';
  return da !== db ? (da < db ? 1 : -1) : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

type ChecklistCriterion = ChecklistRollup['standards'][number]['criteria'][number];

const rowOf = (c: ChecklistCriterion) => ({
  type: c.type,
  id: c.id,
  title: c.title,
  ...(c.condition ? { condition: c.condition } : {}),
});

interface Draft {
  uri: string | undefined;
  kind: AssetKind | undefined;
  type: ChecklistItem['criterion']['type'];
  id: string;
  title: string;
  condition?: ManualCondition | undefined;
  standards: StandardId[];
  /** The roll-up reason of the unit in each of those views. */
  reasons: DeterminationReason[];
}

/** One checklist item per open unit of the report's roll-up, asset items first in report order. */
export function buildChecklist(input: ChecklistInput): ChecklistItem[] {
  const { report, data } = input;
  if (report.rollup.profile !== report.profile.id)
    throw new Error(
      `the roll-up is for profile ${report.rollup.profile} but the report names ${report.profile.id}`,
    );
  const assets = new Map(report.assets.map((a) => [a.uri, a]));
  const hashes = currentHashes(report.assets);

  // Open units by asset (report order), then product items; merging views keeps first-seen order.
  const drafts = new Map<string, Draft>();
  const errata = new Set(data.errata.criteria.map((c) => c.id));
  const add = (
    d: Omit<Draft, 'standards' | 'reasons'>,
    standard: StandardId,
    reason: DeterminationReason,
  ) => {
    if (d.type === 'wcag' && errata.has(d.id)) return;
    const key = JSON.stringify([d.uri ?? null, d.type, d.id]);
    const seen = drafts.get(key);
    if (seen) {
      if (!seen.standards.includes(standard)) seen.standards.push(standard);
      seen.reasons.push(reason);
    } else drafts.set(key, { ...d, standards: [standard], reasons: [reason] });
  };
  const open = new Map<
    string,
    { standard: StandardId; c: ChecklistCriterion; reason: DeterminationReason }[]
  >();
  for (const view of report.rollup.standards)
    for (const c of view.criteria)
      for (const unit of c.assets) {
        if (c.scope !== 'asset' || !assets.has(unit.uri) || SETTLED.has(unit.reason)) continue;
        const list = open.get(unit.uri) ?? [];
        list.push({ standard: view.standard, c, reason: unit.reason });
        open.set(unit.uri, list);
      }
  for (const asset of report.assets)
    for (const { standard, c, reason } of open.get(asset.uri) ?? [])
      add({ uri: asset.uri, kind: asset.kind, ...rowOf(c) }, standard, reason);
  if (report.assets.length > 0)
    for (const view of report.rollup.standards)
      for (const c of view.criteria)
        if (c.scope === 'product')
          add(
            { uri: undefined, kind: undefined, ...rowOf(c) },
            view.standard,
            c.product?.reason ?? 'no-results',
          );

  const wcagSteps = new Map(data.manualSteps.wcag.map((e) => [e.id, e]));
  const provisionSteps = new Map(data.manualSteps.section508.map((e) => [e.id, e]));
  const stepsFor = (d: Draft): ManualSteps => {
    const key = d.kind ?? 'product';
    const steps =
      d.type === 'wcag'
        ? key === 'product'
          ? undefined
          : wcagSteps.get(d.id)?.[key]
        : key === 'pdf'
          ? undefined
          : provisionSteps.get(d.id)?.[key];
    if (!steps)
      throw new Error(
        `manual-steps.yaml has no ${key} steps for ${d.type === 'wcag' ? 'WCAG' : '508'} ${d.id}`,
      );
    return steps;
  };

  // Records for scanned assets only, by asset uri.
  const byAsset = new Map<string, Finding[]>();
  for (const f of report.findings) {
    if (!assets.has(f.asset.uri)) continue;
    const list = byAsset.get(f.asset.uri) ?? [];
    list.push(f);
    byAsset.set(f.asset.uri, list);
  }

  return [...drafts.values()].map((d): ChecklistItem => {
    // Records on this asset (on any scanned asset for a product item) that cite the criterion.
    const records = (
      d.uri === undefined ? [...byAsset.values()].flat() : (byAsset.get(d.uri) ?? [])
    ).filter((f) => cites(f, d.type, d.id));
    const automated = records.filter((f) => f.source.engine !== 'manual');
    const reviews = records.filter(
      (f) => f.source.engine === 'manual' && f.source.ruleId === manualRuleId(d.type, d.id),
    );
    const current = reviews.filter((f) => isCurrentRecord(f, hashes)).sort(newest)[0];

    const related = [
      ...new Set(
        automated
          .filter((f) => f.outcome === 'needs-review' || f.outcome === 'fail')
          .map((f) => f.id),
      ),
    ].sort();
    const why: ChecklistItem['why'] =
      d.type === 'section508' || automated.length === 0
        ? 'manual-only'
        : automated.some((f) => f.outcome === 'needs-review')
          ? 'needs-review'
          : 'no-deciding-rule';
    // The views share their records, so their reasons agree; if not, the less settled one wins.
    const status: ChecklistItemStatus = d.reasons.includes('automated-fail')
      ? 'failed-automated'
      : d.reasons.every((r) => REVIEWED.has(r))
        ? 'done'
        : reviews.length > 0 && !current
          ? 'expired'
          : 'open';

    const { baselineTests, steps } = stepsFor(d);
    const asset = d.uri === undefined ? undefined : assets.get(d.uri);
    return {
      id: checklistItemId(d.uri, d.type, d.id),
      scope: asset ? 'asset' : 'product',
      ...(asset
        ? {
            asset: {
              uri: asset.uri,
              kind: asset.kind,
              anchor: asset.reviewHash ?? asset.contentHash,
            },
          }
        : {}),
      criterion: { type: d.type, id: d.id, title: d.title },
      standards: d.standards,
      baselineTests: [...baselineTests],
      steps: [...steps],
      why,
      related,
      ...(d.condition ? { condition: { ...d.condition } } : {}),
      status,
      ...(current ? { review: current.id } : {}),
    };
  });
}

/** Item counts by status, and the unscanned assets in the roll-up (they get no items). */
export function checklistSummary(input: ChecklistInput): ChecklistSummary {
  const items = buildChecklist(input);
  const byStatus = Object.fromEntries(CHECKLIST_STATUSES.map((s) => [s, 0])) as Record<
    ChecklistItemStatus,
    number
  >;
  for (const i of items) byStatus[i.status] += 1;
  const scanned = new Set(input.report.assets.map((a) => a.uri));
  const unscanned = new Map<string, { uri: string; kind: AssetKind }>();
  for (const view of input.report.rollup.standards)
    for (const c of view.criteria)
      for (const u of c.assets)
        if (u.reason === 'not-scanned' && !scanned.has(u.uri) && !unscanned.has(u.uri))
          unscanned.set(u.uri, { uri: u.uri, kind: u.kind });
  return { total: items.length, byStatus, unscanned: [...unscanned.values()] };
}
