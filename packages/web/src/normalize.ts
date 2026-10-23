import { createHash } from 'node:crypto';
import type { AxeResults, NodeResult, Result } from 'axe-core';
import {
  FindingSchema,
  ImpactSchema,
  findingId,
  type Asset,
  type AxeMap,
  type Finding,
  type Outcome,
  type Viewport,
} from '@widedoor/core';

/** The tags Widedoor runs axe-core with: WCAG 2.0 and 2.1, levels A and AA. */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

/** Longest element snippet kept as evidence. Stored raw; reports escape it when rendering. */
export const SNIPPET_MAX = 300;

/** Location of a page-level result: a rule axe found no element to test. */
export const PAGE_SELECTOR = ':root';

/** An axe node target: one entry per frame, an array where it crosses shadow roots. */
export type AxeTarget = readonly (string | readonly string[])[];

/**
 * Longest stored selector. Selectors come from page-chosen ids and classes, so
 * a longer one is cut and given a hash of the full text, keeping ids unique.
 */
export const SELECTOR_MAX = 1000;

/** Cuts to at most `max` UTF-16 units without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * Serializes an axe target: shadow-root steps joined by " >>> ", frame steps
 * by " >> ". Stored raw like snippets; reports escape it when rendering.
 */
export function targetToSelector(target: AxeTarget): string {
  const parts = target.map((p) => (typeof p === 'string' ? p : p.join(' >>> ')));
  const selector = parts.join(' >> ') || PAGE_SELECTOR;
  if (selector.length <= SELECTOR_MAX) return selector;
  const hash = createHash('sha256').update(selector).digest('hex').slice(0, 16);
  const suffix = `... [sha256:${hash}]`;
  return `${cut(selector, SELECTOR_MAX - suffix.length)}${suffix}`;
}

export function truncateSnippet(html: string, max = SNIPPET_MAX): string {
  return html.length <= max ? html : `${cut(html, max - 3)}...`;
}

const CATEGORIES = [
  ['violations', 'fail'],
  ['incomplete', 'needs-review'],
  ['passes', 'pass'],
  ['inapplicable', 'not-applicable'],
] as const satisfies readonly (readonly [keyof AxeResults, Outcome])[];

const RANK: Record<Outcome, number> = {
  fail: 4,
  'needs-review': 3,
  pass: 2,
  'not-applicable': 1,
  'not-tested': 0,
};

export interface NormalizedPass {
  findings: Finding[];
  /** The axe target of each finding that has an element, for screenshots. */
  targets: Map<string, AxeTarget>;
}

/**
 * Turns one axe run into Finding records via axe-map.yaml: one record per
 * (rule, element), or one page-level record when a rule had no element.
 * axe "incomplete" becomes needs-review and "inapplicable" not-applicable,
 * which roll-up never counts as a pass. A rule missing from the map, or an
 * axe-core version other than the map's, is an error: the map is the only
 * source of criteria.
 */
export function normalizeAxeResults(
  results: AxeResults,
  asset: Asset,
  axeMap: AxeMap,
): NormalizedPass {
  const version = results.testEngine.version;
  if (version !== axeMap.meta.engineVersion)
    throw new Error(
      `axe-core ${version} ran, but axe-map.yaml is for ${axeMap.meta.engineVersion}; pin axe-core to the map's version`,
    );
  const rules = new Map(axeMap.rules.map((r) => [r.id, r]));
  const byId = new Map<string, Finding>();
  const targets = new Map<string, AxeTarget>();

  for (const [category, outcome] of CATEGORIES) {
    for (const rule of results[category] as Result[]) {
      const entry = rules.get(rule.id);
      if (!entry) throw new Error(`axe rule ${rule.id} is not in axe-map.yaml`);
      const nodes: (NodeResult | undefined)[] =
        outcome === 'not-applicable' || rule.nodes.length === 0 ? [undefined] : rule.nodes;
      for (const node of nodes) {
        const selector = node ? targetToSelector(node.target as AxeTarget) : PAGE_SELECTOR;
        const location = { selector };
        const id = findingId(asset.uri, location, 'axe-core', rule.id);
        const impact = ImpactSchema.safeParse(node?.impact ?? rule.impact);
        const isFinding = outcome === 'fail' || outcome === 'needs-review';
        const finding = FindingSchema.parse({
          schemaVersion: 1,
          id,
          asset,
          location,
          source: {
            engine: 'axe-core',
            engineVersion: version,
            ruleId: rule.id,
            // The schema holds one ACT rule; with several, the map is the place to look.
            ...(entry.actRules.length === 1 ? { actRuleId: entry.actRules[0] } : {}),
          },
          criteria: { wcag: [...entry.wcag] },
          outcome,
          ...(isFinding && impact.success ? { impact: impact.data } : {}),
          ...(isFinding && node ? { evidence: { snippet: truncateSnippet(node.html) } } : {}),
        });
        const prior = byId.get(id);
        if (!prior || RANK[outcome] > RANK[prior.outcome]) byId.set(id, finding);
        if (node) targets.set(id, node.target as AxeTarget);
      }
    }
  }
  return { findings: [...byId.values()], targets };
}

/**
 * Merges the desktop and reflow passes by finding id. Where both have a record
 * the more severe outcome wins (fail, needs-review, pass, not-applicable); a
 * record that wins only because of the reflow pass carries the reflow
 * viewport in its evidence. A page-level not-applicable record is dropped when
 * the same rule tested an element at either viewport, since the rule applied.
 */
export function mergeViewports(
  desktop: readonly Finding[],
  reflow: readonly Finding[],
  reflowViewport: Viewport,
): Finding[] {
  const merged = new Map<string, Finding>();
  for (const f of desktop) merged.set(f.id, f);
  for (const f of reflow) {
    const prior = merged.get(f.id);
    if (prior && RANK[f.outcome] <= RANK[prior.outcome]) continue;
    merged.set(f.id, {
      ...f,
      evidence: { ...f.evidence, viewport: { ...reflowViewport } },
    });
  }
  const applied = new Set(
    [...merged.values()].filter((f) => f.outcome !== 'not-applicable').map((f) => f.source.ruleId),
  );
  return [...merged.values()].filter(
    (f) =>
      !(
        f.outcome === 'not-applicable' &&
        'selector' in f.location &&
        f.location.selector === PAGE_SELECTOR &&
        applied.has(f.source.ruleId)
      ),
  );
}
