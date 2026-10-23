import type { AxeResults } from 'axe-core';
import { describe, expect, it } from 'vitest';
import { FindingSchema, loadStandardsData, type Asset } from '@widedoor/core';
import {
  PAGE_SELECTOR,
  SELECTOR_MAX,
  REFLOW_VIEWPORT,
  SNIPPET_MAX,
  mergeViewports,
  normalizeAxeResults,
  targetToSelector,
  truncateSnippet,
} from '../src/index.ts';

const axeMap = loadStandardsData().axe;
const asset: Asset = {
  kind: 'web',
  uri: 'https://example.com/',
  contentHash: `sha256:${'a'.repeat(64)}`,
};

const node = (target: unknown[], html = '<input>', impact: string | null = 'critical') => ({
  target,
  html,
  impact,
  any: [],
  all: [],
  none: [],
});

function results(
  parts: Partial<Record<'violations' | 'incomplete' | 'passes' | 'inapplicable', unknown[]>>,
) {
  return {
    testEngine: { name: 'axe-core', version: axeMap.meta.engineVersion },
    violations: [],
    incomplete: [],
    passes: [],
    inapplicable: [],
    ...parts,
  } as unknown as AxeResults;
}

describe('normalizeAxeResults', () => {
  const run = results({
    violations: [
      { id: 'label', impact: 'critical', nodes: [node(['#phone'], '<input id="phone">')] },
    ],
    incomplete: [
      { id: 'color-contrast', impact: 'serious', nodes: [node(['p'], '<p>x</p>', 'serious')] },
    ],
    passes: [{ id: 'image-alt', impact: null, nodes: [node(['img'], '<img alt="x">', null)] }],
    inapplicable: [{ id: 'td-headers-attr', impact: null, nodes: [] }],
  });
  const { findings, targets } = normalizeAxeResults(run, asset, axeMap);
  const by = (rule: string) => findings.find((f) => f.source.ruleId === rule);

  it('maps each axe category to its outcome', () => {
    expect(findings.map((f) => [f.source.ruleId, f.outcome])).toEqual([
      ['label', 'fail'],
      ['color-contrast', 'needs-review'],
      ['image-alt', 'pass'],
      ['td-headers-attr', 'not-applicable'],
    ]);
  });

  it('produces schema-valid records with criteria, version and asset hash from the inputs', () => {
    for (const f of findings) expect(FindingSchema.safeParse(f).success).toBe(true);
    const label = by('label');
    expect(label?.criteria.wcag).toEqual(axeMap.rules.find((r) => r.id === 'label')?.wcag);
    expect(label?.source.engineVersion).toBe(axeMap.meta.engineVersion);
    expect(label?.asset.contentHash).toBe(asset.contentHash);
    expect(label?.impact).toBe('critical');
    expect(label?.evidence?.snippet).toBe('<input id="phone">');
  });

  it('records inapplicable rules at page level, never as a pass, with no evidence', () => {
    const na = by('td-headers-attr');
    expect(na?.location).toEqual({ selector: PAGE_SELECTOR });
    expect(na?.outcome).toBe('not-applicable');
    expect(na?.evidence).toBeUndefined();
    expect(by('image-alt')?.evidence).toBeUndefined();
  });

  it('keeps targets for screenshots', () => {
    expect(targets.get(by('label')?.id ?? '')).toEqual(['#phone']);
  });

  it('rejects a rule that is not in the map and a different axe-core version', () => {
    expect(() =>
      normalizeAxeResults(
        results({ violations: [{ id: 'region', nodes: [node(['div'])] }] }),
        asset,
        axeMap,
      ),
    ).toThrow(/not in axe-map/);
    const other = {
      ...results({}),
      testEngine: { name: 'axe-core', version: '9.9.9' },
    } as AxeResults;
    expect(() => normalizeAxeResults(other, asset, axeMap)).toThrow(/pin axe-core/);
  });
});

describe('targetToSelector and truncateSnippet', () => {
  it('joins frame and shadow steps', () => {
    expect(targetToSelector(['#a'])).toBe('#a');
    expect(targetToSelector(['iframe', ['#host', 'button']])).toBe('iframe >> #host >>> button');
    expect(targetToSelector([])).toBe(PAGE_SELECTOR);
  });

  it('caps snippets at SNIPPET_MAX characters', () => {
    expect(truncateSnippet('x'.repeat(SNIPPET_MAX))).toHaveLength(SNIPPET_MAX);
    const long = truncateSnippet('x'.repeat(SNIPPET_MAX + 50));
    expect(long).toHaveLength(SNIPPET_MAX);
    expect(long.endsWith('...')).toBe(true);
  });

  it('never splits a surrogate pair when cutting', () => {
    const emoji = '😀';
    const cutAt = truncateSnippet('x'.repeat(SNIPPET_MAX - 4) + emoji.repeat(10));
    expect(cutAt.endsWith('...')).toBe(true);
    expect(/[�-�](?![�-�])/.test(cutAt)).toBe(false);
  });

  it('caps long selectors and keeps them distinct with a hash', () => {
    const a = targetToSelector(['#' + 'a'.repeat(5000)]);
    const b = targetToSelector(['#' + 'a'.repeat(5000) + 'b']);
    expect(a).toHaveLength(SELECTOR_MAX);
    expect(a.endsWith(`... [sha256:${a.slice(-17, -1)}]`)).toBe(true);
    expect(a.slice(-17, -1)).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});

describe('untrusted page strings', () => {
  // Stored raw by contract; the Task 1.3 report must escape these. This fixture is for its tests.
  it('keeps snippet and selector exactly as the page wrote them', () => {
    const html = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const target = ['div[title="\\"><img src=x onerror=alert(3)>"]'];
    const run = results({
      violations: [{ id: 'image-alt', impact: 'critical', nodes: [node(target, html)] }],
    });
    const [f] = normalizeAxeResults(run, asset, axeMap).findings;
    expect(f?.evidence?.snippet).toBe(html);
    expect(f?.location).toEqual({ selector: target[0] });
  });
});

describe('mergeViewports', () => {
  const pass = (parts: Parameters<typeof results>[0]) =>
    normalizeAxeResults(results(parts), asset, axeMap).findings;
  const contrast = (cat: 'violations' | 'passes') => ({
    [cat]: [
      { id: 'color-contrast', impact: 'serious', nodes: [node(['p'], '<p>x</p>', 'serious')] },
    ],
  });

  it('keeps one record per id, the more severe outcome winning', () => {
    const merged = mergeViewports(
      pass(contrast('violations')),
      pass(contrast('passes')),
      REFLOW_VIEWPORT,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.outcome).toBe('fail');
    expect(merged[0]?.evidence?.viewport).toBeUndefined();
  });

  it('marks a record that only the reflow pass produced with the reflow viewport', () => {
    const merged = mergeViewports(
      pass(contrast('passes')),
      pass(contrast('violations')),
      REFLOW_VIEWPORT,
    );
    expect(merged[0]?.outcome).toBe('fail');
    expect(merged[0]?.evidence?.viewport).toEqual({ width: 320, height: 256 });
    expect(FindingSchema.safeParse(merged[0]).success).toBe(true);
  });

  it('drops a page-level not-applicable when the rule applied at the other viewport', () => {
    const na = pass({ inapplicable: [{ id: 'color-contrast', nodes: [] }] });
    const merged = mergeViewports(na, pass(contrast('violations')), REFLOW_VIEWPORT);
    expect(merged.map((f) => f.outcome)).toEqual(['fail']);
    expect(mergeViewports(na, na, REFLOW_VIEWPORT).map((f) => f.outcome)).toEqual([
      'not-applicable',
    ]);
  });
});
