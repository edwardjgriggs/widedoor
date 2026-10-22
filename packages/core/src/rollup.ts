import type { ManualCondition, StandardsData } from './data.js';
import type { Profile, ProfileId, StandardId, StandardView } from './profiles.js';
import type { Asset, AssetKind, Finding } from './schema.js';

/*
 * Roll-up (spec section 3, step 5): automated findings plus manual reviews,
 * read through a profile, become one conformance level per criterion per
 * standard. The rules are conservative so a report never claims more than
 * was tested:
 *   - an asset passes a criterion only with a deciding automated pass or an
 *     unexpired manual pass; any fail on the asset wins over a pass
 *   - Supports needs every applicable asset to pass
 *   - Not Applicable comes only from the profile or from an unexpired manual
 *     review that gives a reason; automated "not-applicable" never counts
 *   - needs-review and not-tested leave the asset unevaluated
 */

export const CONFORMANCE_LEVELS = [
  'Supports',
  'Partially Supports',
  'Does Not Support',
  'Not Applicable',
  'Not Evaluated',
] as const;
export type ConformanceLevel = (typeof CONFORMANCE_LEVELS)[number];

export type UnitState = 'pass' | 'fail' | 'not-applicable' | 'not-evaluated';

export type DeterminationReason =
  | 'automated-fail'
  | 'manual-fail'
  | 'deciding-automated-pass'
  | 'manual-pass'
  | 'profile-not-applicable'
  | 'manual-not-applicable'
  | 'no-deciding-result'
  | 'no-results';

export interface Determination {
  state: UnitState;
  reason: DeterminationReason;
  /** Ids of the findings that decided the state (empty when nothing did). */
  evidence: string[];
  /** Records that were seen but cannot decide: non-deciding passes, needs-review, not-tested, automated not-applicable, N/A reviews without a reason. */
  undecided: string[];
  /**
   * Records ignored because the asset changed since they were recorded or a hash is missing:
   * manual reviews of any outcome and automated non-fail results. A stale automated fail still counts.
   */
  expired: string[];
  /** The profile exception, when reason is profile-not-applicable. */
  exception?: { provision: string; reason: string };
}

export interface AssetDetail extends Determination {
  uri: string;
  kind: AssetKind;
}

export interface CriterionRollup {
  id: string;
  title: string;
  /** "wcag": a WCAG success criterion; "section508": a 508 manual-only provision. */
  type: 'wcag' | 'section508';
  /** "asset": judged per asset; "product": judged once across the whole scan. */
  scope: 'asset' | 'product';
  condition?: ManualCondition;
  level: ConformanceLevel;
  reason: string;
  /** Ids of the findings behind the level. */
  evidence: string[];
  /** Per-asset detail; empty for product-scope items. */
  assets: AssetDetail[];
  /** The single determination of a product-scope item. */
  product?: Determination;
}

export interface StandardRollup {
  standard: StandardId;
  criteria: CriterionRollup[];
}

export interface Rollup {
  profile: ProfileId;
  standards: StandardRollup[];
}

/** engine:ruleId -> the SC ids a pass of that rule settles on its own. */
export type DecidingRules = ReadonlyMap<string, ReadonlySet<string>>;

export interface RollupInput {
  /** Automated findings (engine is not "manual"). */
  findings: readonly Finding[];
  /** Manual reviews: Finding records with engine "manual". */
  reviews: readonly Finding[];
  profile: Profile;
  /** Every asset in the scan, with its current content hash. */
  assets: readonly Asset[];
  /** Defaults to none: no automated pass decides anything. */
  decidingRules?: DecidingRules;
}

const ruleKey = (engine: string, ruleId: string) => `${engine}:${ruleId}`;

/** Builds DecidingRules from the mapping data (rules with decides: true). */
export function decidingRulesFrom(
  data: Pick<StandardsData, 'axe' | 'verapdf' | 'widedoor'>,
): DecidingRules {
  const out = new Map<string, Set<string>>();
  const maps = [
    ['axe-core', data.axe.rules],
    ['verapdf', data.verapdf.rules],
    ['widedoor', data.widedoor.rules],
  ] as const;
  for (const [engine, rules] of maps) {
    for (const r of rules) {
      if (!r.decides) continue;
      // decides is one flag per rule, so it can only be trusted for a rule mapped to one SC.
      if (r.wcag.length !== 1)
        throw new Error(
          `${engine} rule ${r.id} has decides: true but maps to ${r.wcag.length} SC; a deciding rule must map to exactly one`,
        );
      out.set(ruleKey(engine, r.id), new Set(r.wcag));
    }
  }
  return out;
}

interface Row {
  id: string;
  title: string;
  type: CriterionRollup['type'];
  scope: CriterionRollup['scope'];
  condition?: ManualCondition;
}

/** Both hashes present, non-empty and equal. A missing hash on either side never matches. */
const sameHash = (a: unknown, b: unknown) => typeof a === 'string' && a !== '' && a === b;

const cites = (f: Finding, row: Row) =>
  row.type === 'wcag'
    ? (f.criteria.wcag ?? []).includes(row.id)
    : (f.criteria.section508 ?? []).includes(row.id);

function determine(
  records: readonly Finding[],
  row: Row,
  hashOf: (uri: string) => string | undefined,
  decidingRules: DecidingRules,
): Determination {
  const autoFail: string[] = [];
  const manualFail: string[] = [];
  const autoPass: { id: string; rule: string }[] = [];
  // Rules that reported needs-review or not-tested on current content; their passes cannot decide.
  const unsettledRules = new Set<string>();
  const manualPass: string[] = [];
  const manualNa: string[] = [];
  const undecided: string[] = [];
  const expired: string[] = [];

  for (const f of records) {
    const current = hashOf(f.asset.uri);
    if (f.source.engine === 'manual') {
      // Fail closed: a review counts only with a review block whose anchor matches the current hash.
      const review = 'review' in f ? f.review : undefined;
      if (!review || !sameHash(review.expiresOnChangeOf, current)) {
        expired.push(f.id);
        continue;
      }
      if (f.outcome === 'fail') manualFail.push(f.id);
      else if (f.outcome === 'pass') manualPass.push(f.id);
      else if (f.outcome === 'not-applicable' && review.notes?.trim()) manualNa.push(f.id);
      else undecided.push(f.id);
      continue;
    }
    // A finding from older content can still fail the asset, but never pass it.
    if (f.outcome === 'fail') {
      autoFail.push(f.id);
      continue;
    }
    if (!sameHash(f.asset.contentHash, current)) {
      expired.push(f.id);
      continue;
    }
    const rule = ruleKey(f.source.engine, f.source.ruleId);
    const decides = row.type === 'wcag' && (decidingRules.get(rule)?.has(row.id) ?? false);
    if (f.outcome === 'pass' && decides) autoPass.push({ id: f.id, rule });
    else {
      if (f.outcome === 'needs-review' || f.outcome === 'not-tested') unsettledRules.add(rule);
      undecided.push(f.id);
    }
  }
  for (const p of autoPass.filter((p) => unsettledRules.has(p.rule))) {
    autoPass.splice(autoPass.indexOf(p), 1);
    undecided.push(p.id);
  }

  const base = { undecided, expired };
  if (autoFail.length > 0 || manualFail.length > 0) {
    // Automated fails win over manual passes; both kinds of fail are evidence.
    return {
      state: 'fail',
      reason: autoFail.length > 0 ? 'automated-fail' : 'manual-fail',
      evidence: [...autoFail, ...manualFail],
      ...base,
    };
  }
  if (autoPass.length > 0 || manualPass.length > 0) {
    return {
      state: 'pass',
      reason: autoPass.length > 0 ? 'deciding-automated-pass' : 'manual-pass',
      evidence: [...autoPass.map((p) => p.id), ...manualPass],
      ...base,
    };
  }
  if (manualNa.length > 0) {
    return {
      state: 'not-applicable',
      reason: 'manual-not-applicable',
      evidence: manualNa,
      ...base,
    };
  }
  const seen = undecided.length > 0 || expired.length > 0;
  return {
    state: 'not-evaluated',
    reason: seen ? 'no-deciding-result' : 'no-results',
    evidence: [],
    ...base,
  };
}

function levelOf(units: readonly Determination[]): { level: ConformanceLevel; reason: string } {
  const inScope = units.filter((u) => u.state !== 'not-applicable');
  if (units.length === 0) return { level: 'Not Evaluated', reason: 'no assets in scope' };
  if (inScope.length === 0)
    return { level: 'Not Applicable', reason: 'not applicable to any asset' };
  const fails = inScope.filter((u) => u.state === 'fail').length;
  const passes = inScope.filter((u) => u.state === 'pass').length;
  if (fails > 0 && passes > 0)
    return {
      level: 'Partially Supports',
      reason: `${fails} of ${inScope.length} applicable assets fail; ${passes} pass`,
    };
  if (fails > 0)
    return {
      level: 'Does Not Support',
      reason: `${fails} of ${inScope.length} applicable assets fail; none pass`,
    };
  if (passes === inScope.length)
    return { level: 'Supports', reason: `all ${inScope.length} applicable assets pass` };
  return {
    level: 'Not Evaluated',
    reason: `${inScope.length - passes} of ${inScope.length} applicable assets have no deciding result`,
  };
}

const scOrder = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/** WCAG rows in SC order (applicable and excepted merged), then 508 manual items in profile order. */
function rowsFor(view: StandardView): Row[] {
  const wcag = [...view.applicable, ...view.notApplicable].sort((a, b) => scOrder(a.id, b.id));
  return [
    ...wcag.map((c): Row => ({ id: c.id, title: c.title, type: 'wcag', scope: 'asset' })),
    ...view.manual.map((m): Row => ({
      id: m.id,
      title: m.title,
      type: 'section508',
      scope: m.scope === 'product' ? 'product' : 'asset',
      ...(m.condition ? { condition: { ...m.condition } } : {}),
    })),
  ];
}

function assertInputs(input: RollupInput): void {
  for (const f of input.findings)
    if (f.source.engine === 'manual')
      throw new Error(`finding ${f.id} has engine "manual"; pass it in reviews`);
  for (const r of input.reviews)
    if (r.source.engine !== 'manual')
      throw new Error(`review ${r.id} has engine "${r.source.engine}"; pass it in findings`);
  const kinds = new Map<string, AssetKind>();
  for (const a of input.assets) {
    if (kinds.has(a.uri)) throw new Error(`asset ${a.uri} is listed twice`);
    kinds.set(a.uri, a.kind);
  }
  // Ids may repeat: findingId ignores outcome, date and hash, so each record is judged on its own.
  for (const f of [...input.findings, ...input.reviews]) {
    const kind = kinds.get(f.asset.uri);
    if (kind !== undefined && kind !== f.asset.kind)
      throw new Error(
        `record ${f.id} is for a ${f.asset.kind} asset but ${f.asset.uri} is ${kind}`,
      );
  }
}

/** Rolls findings and reviews up to one level per criterion, per standard view of the profile. */
export function rollup(input: RollupInput): Rollup {
  assertInputs(input);
  const { profile, assets } = input;
  const decidingRules = input.decidingRules ?? new Map();
  const hashes = new Map(assets.map((a) => [a.uri, a.contentHash]));
  const hashOf = (uri: string) => hashes.get(uri);
  // Records for assets outside the scan are ignored.
  const records = [...input.findings, ...input.reviews].filter((f) => hashes.has(f.asset.uri));

  const standardIds = profile.assets.web.standards.map((s) => s.standard);
  const standards = standardIds.map((standard): StandardRollup => {
    const viewOf = (kind: AssetKind) => {
      const v = profile.assets[kind].standards.find((s) => s.standard === standard);
      if (!v) throw new Error(`profile ${profile.id} has no ${standard} view for ${kind}`);
      return v;
    };

    // Rows from the views of the asset kinds present; WCAG rows in SC order, then manual items.
    const kinds = [...new Set(assets.map((a) => a.kind))].sort((a, b) =>
      a === b ? 0 : a === 'web' ? -1 : 1,
    );
    const rows = new Map<string, Row>();
    for (const kind of kinds)
      for (const row of rowsFor(viewOf(kind))) if (!rows.has(row.id)) rows.set(row.id, row);

    const ordered = [
      ...[...rows.values()].filter((r) => r.type === 'wcag').sort((a, b) => scOrder(a.id, b.id)),
      ...[...rows.values()].filter((r) => r.type !== 'wcag'),
    ];
    const criteria = ordered.map((row): CriterionRollup => {
      const head = {
        id: row.id,
        title: row.title,
        type: row.type,
        scope: row.scope,
        ...(row.condition ? { condition: row.condition } : {}),
      };
      const cited = records.filter((f) => cites(f, row));

      if (row.scope === 'product') {
        const product = determine(cited, row, hashOf, decidingRules);
        const { level, reason } = levelOf([product]);
        return { ...head, level, reason, evidence: product.evidence, assets: [], product };
      }

      const details = assets.flatMap((asset): AssetDetail[] => {
        const view = viewOf(asset.kind);
        const exception = view.notApplicable.find((c) => c.id === row.id);
        if (exception) {
          return [
            {
              uri: asset.uri,
              kind: asset.kind,
              state: 'not-applicable',
              reason: 'profile-not-applicable',
              evidence: [],
              undecided: [],
              expired: [],
              exception: { provision: exception.provision, reason: exception.reason },
            },
          ];
        }
        const inView =
          row.type === 'wcag'
            ? view.applicable.some((c) => c.id === row.id)
            : view.manual.some((m) => m.id === row.id);
        if (!inView) return [];
        const own = cited.filter((f) => f.asset.uri === asset.uri);
        return [
          { uri: asset.uri, kind: asset.kind, ...determine(own, row, hashOf, decidingRules) },
        ];
      });

      const { level, reason } = levelOf(details);
      const deciding = (d: AssetDetail) =>
        level === 'Not Applicable' ? d.state === 'not-applicable' : d.state !== 'not-applicable';
      const evidence = details.filter(deciding).flatMap((d) => d.evidence);
      return { ...head, level, reason, evidence, assets: details };
    });
    return { standard, criteria };
  });
  return { profile: profile.id, standards };
}
