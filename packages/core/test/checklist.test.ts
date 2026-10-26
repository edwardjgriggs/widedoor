import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FindingSchema,
  buildChecklist,
  checklistSummary,
  decidingRulesFrom,
  errataFrom,
  findingId,
  getProfile,
  loadStandardsData,
  rollup,
  type Asset,
  type AssetKind,
  type ChecklistItem,
  type ChecklistItemStatus,
  type DecidingRules,
  type Finding,
  type Location,
  type Outcome,
  type Profile,
  type UnscannedAsset,
} from '../src/index.js';

const data = loadStandardsData();
const hash = (c: string) => `sha256:${c.repeat(64)}`;
const OLD = hash('0');

// A web page whose review anchor differs from its raw content hash (Task 2.2), and a PDF.
const A: Asset = {
  kind: 'web',
  uri: 'https://example.com/a',
  contentHash: hash('a'),
  reviewHash: hash('c'),
};
const P: Asset = { kind: 'pdf', uri: 'docs/report.pdf', contentHash: hash('b') };

const anchorOf = (asset: Asset) => asset.reviewHash ?? asset.contentHash;
const at = (asset: Asset): Location => (asset.kind === 'web' ? { selector: 'html' } : {});

interface Auto {
  asset?: Asset;
  outcome: Outcome;
  wcag: string;
  ruleId?: string;
  selector?: string;
}

function automated({ asset = A, outcome, wcag, ruleId = 'image-alt', selector }: Auto): Finding {
  const location = asset.kind === 'web' ? { selector: selector ?? `#${ruleId}` } : { page: 1 };
  const engine = asset.kind === 'web' ? 'axe-core' : 'verapdf';
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(asset.uri, location, engine, ruleId),
    asset,
    location,
    source: { engine, engineVersion: '1', ruleId },
    criteria: { wcag: [wcag] },
    outcome,
  });
}

interface Manual {
  asset?: Asset;
  outcome?: Outcome;
  type?: 'wcag' | 'section508';
  id: string;
  expiresOnChangeOf?: string;
  date?: string;
  overrides?: string[];
  /** Reviewer notes; an empty string records none. */
  notes?: string;
}

/** A manual record with the identity Task 2.4 writes (ledger ruling 2.3 / 2.4). */
function manual({
  asset = A,
  outcome = 'pass',
  type = 'wcag',
  id,
  expiresOnChangeOf = anchorOf(asset),
  date = '2026-10-22',
  overrides,
  notes = 'checked by hand',
}: Manual): Finding {
  const ruleId = type === 'wcag' ? `wcag-${id}` : `508-${id}`;
  const location = at(asset);
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(asset.uri, location, 'manual', ruleId),
    asset,
    location,
    source: { engine: 'manual', engineVersion: '0.2.0', ruleId },
    criteria: type === 'wcag' ? { wcag: [id] } : { section508: [id] },
    outcome,
    review: {
      reviewer: 'tester',
      date,
      ...(notes ? { notes } : {}),
      expiresOnChangeOf,
      ...(overrides ? { overrides } : {}),
    },
  });
}

interface Scan {
  assets: Asset[];
  findings?: Finding[];
  profile?: Profile;
  decidingRules?: DecidingRules;
  unscanned?: UnscannedAsset[];
}

function scan({
  assets,
  findings = [],
  profile = getProfile('508+wcag21aa'),
  decidingRules = new Map(),
  unscanned = [],
}: Scan) {
  const result = rollup({
    findings: findings.filter((f) => f.source.engine !== 'manual'),
    reviews: findings.filter((f) => f.source.engine === 'manual'),
    profile,
    assets,
    decidingRules,
    errata: errataFrom(data),
    unscanned,
  });
  const report = { assets, findings, rollup: result, profile: { id: profile.id } };
  return { report, items: buildChecklist({ report, data }) };
}

const ckId = (uri: string, type: string, id: string) =>
  `ck_${createHash('sha256')
    .update(JSON.stringify([uri, type, id]))
    .digest('hex')
    .slice(0, 16)}`;

function item(items: ChecklistItem[], uri: string | undefined, id: string): ChecklistItem {
  const found = items.find((i) => i.asset?.uri === uri && i.criterion.id === id);
  if (!found) throw new Error(`no checklist item for ${uri ?? 'product'} ${id}`);
  return found;
}
const has = (items: ChecklistItem[], uri: string | undefined, id: string) =>
  items.some((i) => i.asset?.uri === uri && i.criterion.id === id);

describe('buildChecklist', () => {
  it('turns a needs-review finding into a needs-review item that lists it', () => {
    const review = automated({ outcome: 'needs-review', wcag: '1.1.1' });
    const pass = automated({ outcome: 'pass', wcag: '1.1.1', ruleId: 'role-img-alt' });
    const { items } = scan({ assets: [A], findings: [review, pass] });
    const i = item(items, A.uri, '1.1.1');
    expect(i).toMatchObject({
      scope: 'asset',
      asset: { uri: A.uri, kind: 'web', anchor: hash('c') },
      criterion: { type: 'wcag', id: '1.1.1', title: 'Non-text Content' },
      standards: ['508', 'wcag21aa'],
      why: 'needs-review',
      related: [review.id],
      status: 'open',
    });
    expect(i.review).toBeUndefined();
    expect(i.baselineTests).toContain('6.A-MeaningfulImage');
    expect(i.steps.length).toBeGreaterThan(0);
  });

  it('says why: manual-only with no automated result, no-deciding-rule with one', () => {
    const na = automated({ outcome: 'not-applicable', wcag: '1.4.3', ruleId: 'color-contrast' });
    const { items } = scan({ assets: [A], findings: [na] });
    expect(item(items, A.uri, '2.1.1').why).toBe('manual-only');
    expect(item(items, A.uri, '1.4.3')).toMatchObject({ why: 'no-deciding-rule', related: [] });
    expect(item(items, A.uri, '502.2.2').why).toBe('manual-only');
    expect(item(items, undefined, '302.1').why).toBe('manual-only');
  });

  it('flips an item to done with a current review and to expired with a stale one', () => {
    const done = manual({ id: '2.1.1' });
    const stale = manual({ id: '2.4.7', expiresOnChangeOf: OLD });
    // A review anchored to the raw content hash is stale once a review hash exists.
    const raw = manual({ id: '2.4.3', expiresOnChangeOf: A.contentHash });
    const { items } = scan({ assets: [A], findings: [done, stale, raw] });
    expect(item(items, A.uri, '2.1.1')).toMatchObject({ status: 'done', review: done.id });
    expect(item(items, A.uri, '2.4.7').status).toBe('expired');
    expect(item(items, A.uri, '2.4.7').review).toBeUndefined();
    expect(item(items, A.uri, '2.4.3').status).toBe('expired');
    expect(item(items, A.uri, '1.1.1').status).toBe('open');
  });

  it('marks an automated fail failed-automated, and done once a reviewer records a result', () => {
    const fail = automated({ outcome: 'fail', wcag: '1.4.3', ruleId: 'color-contrast' });
    const before = scan({ assets: [A], findings: [fail] }).items;
    expect(item(before, A.uri, '1.4.3')).toMatchObject({
      status: 'failed-automated',
      related: [fail.id],
    });
    const override = manual({ id: '1.4.3', overrides: [fail.id] });
    const after = scan({ assets: [A], findings: [fail, override] }).items;
    expect(item(after, A.uri, '1.4.3')).toMatchObject({ status: 'done', review: override.id });
    // An expired review does not hide the fail.
    const stale = manual({ id: '1.4.3', expiresOnChangeOf: OLD });
    const expired = scan({ assets: [A], findings: [fail, stale] }).items;
    expect(item(expired, A.uri, '1.4.3').status).toBe('failed-automated');
  });

  it('names as its review only a record with its identity: rule id and the criterion cited', () => {
    const other = manual({ id: '2.1.1' });
    const wrongRule = { ...other, source: { ...other.source, ruleId: 'review' } } as Finding;
    const wrongCriterion = { ...other, criteria: { wcag: ['2.1.2'] } } as Finding;
    const { items } = scan({ assets: [A], findings: [wrongRule, wrongCriterion] });
    // The roll-up counts any manual record citing a criterion, so status follows it either way.
    for (const id of ['2.1.1', '2.1.2']) {
      expect(item(items, A.uri, id).status, id).toBe('done');
      expect(item(items, A.uri, id).review, id).toBeUndefined();
    }
  });

  describe('takes status from the roll-up unit, not from the presence of a review', () => {
    const fail = automated({ outcome: 'fail', wcag: '1.4.3', ruleId: 'color-contrast' });

    it('(a) a manual pass that does not override an automated fail leaves it failed', () => {
      const pass = manual({ id: '1.4.3' });
      const { items } = scan({ assets: [A], findings: [fail, pass] });
      expect(item(items, A.uri, '1.4.3')).toMatchObject({
        status: 'failed-automated',
        review: pass.id,
      });
    });

    it('(b) an override without notes is ignored, so the fail stands', () => {
      const pass = manual({ id: '1.4.3', overrides: [fail.id], notes: '' });
      const { items } = scan({ assets: [A], findings: [fail, pass] });
      expect(item(items, A.uri, '1.4.3')).toMatchObject({
        status: 'failed-automated',
        review: pass.id,
      });
    });

    it('(c) an N/A without notes is ignored, so the item stays open', () => {
      const na = manual({ id: '2.1.1', outcome: 'not-applicable', notes: '' });
      const { items } = scan({ assets: [A], findings: [na] });
      expect(item(items, A.uri, '2.1.1')).toMatchObject({ status: 'open', review: na.id });
      const withNotes = manual({ id: '2.1.1', outcome: 'not-applicable' });
      const counted = scan({ assets: [A], findings: [withNotes] }).items;
      expect(item(counted, A.uri, '2.1.1')).toMatchObject({ status: 'done', review: withNotes.id });
    });

    it('(d) a manual fail decides the unit, so the item is done', () => {
      const failed = manual({ id: '2.1.1', outcome: 'fail' });
      const { items } = scan({ assets: [A], findings: [failed] });
      expect(item(items, A.uri, '2.1.1')).toMatchObject({ status: 'done', review: failed.id });
      // An automated fail on the same unit outranks it.
      const both = scan({
        assets: [A],
        findings: [fail, manual({ id: '1.4.3', outcome: 'fail' })],
      });
      expect(item(both.items, A.uri, '1.4.3').status).toBe('failed-automated');
    });

    it('a product item follows its product determination', () => {
      const na = manual({ type: 'section508', id: '302.1', outcome: 'not-applicable', notes: '' });
      const { items } = scan({ assets: [A], findings: [na] });
      expect(item(items, undefined, '302.1')).toMatchObject({ status: 'open', review: na.id });
    });
  });

  it('uses the newest current review when two exist', () => {
    const older = manual({ id: '2.1.1', date: '2026-10-01' });
    const newer = { ...manual({ id: '2.1.1', date: '2026-10-20' }), id: 'wd_ffffffffffffffff' };
    const { items } = scan({ assets: [A], findings: [newer, older] });
    expect(item(items, A.uri, '2.1.1').review).toBe('wd_ffffffffffffffff');
  });

  it('gives no item for a unit decided by a deciding pass, the errata basis or a profile N/A', () => {
    const title = automated({ outcome: 'pass', wcag: '2.4.2', ruleId: 'document-title' });
    const { items } = scan({
      assets: [A, P],
      findings: [title],
      decidingRules: new Map([['axe-core:document-title', new Set(['2.4.2'])]]),
    });
    expect(has(items, A.uri, '2.4.2')).toBe(false);
    expect(has(items, P.uri, '2.4.2')).toBe(true);
    expect(has(items, A.uri, '4.1.1')).toBe(false);
    expect(has(items, P.uri, '4.1.1')).toBe(false);
    // E205.4 excepts 2.4.1 for a non-web PDF under 508 only; WCAG 2.1 AA still needs it.
    expect(item(items, P.uri, '2.4.1').standards).toEqual(['wcag21aa']);
    expect(item(items, A.uri, '2.4.1').standards).toEqual(['508', 'wcag21aa']);
    const only508 = scan({ assets: [P], profile: getProfile('508') }).items;
    expect(has(only508, P.uri, '2.4.1')).toBe(false);
    // WCAG 2.1 criteria come from the wcag21aa view only.
    expect(item(items, A.uri, '1.4.10').standards).toEqual(['wcag21aa']);
  });

  it('builds one item per asset and criterion, with steps for the asset kind', () => {
    const { items } = scan({ assets: [A, P] });
    const keys = items.map((i) => `${i.asset?.uri ?? 'product'} ${i.criterion.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    const web = item(items, A.uri, '1.3.2');
    const doc = item(items, P.uri, '1.3.2');
    expect(web.baselineTests).toEqual(['18.B-CSSPositionedContent']);
    expect(doc.baselineTests).toEqual(['18.B-MeaningfulSequence']);
    expect(doc.steps.join(' ')).toMatch(/reading order/i);
    expect(doc.asset).toEqual({ uri: P.uri, kind: 'pdf', anchor: P.contentHash });
    // Chapter 5 items are per web asset and carry their condition; none for a PDF.
    expect(item(items, A.uri, '502.2.2')).toMatchObject({
      scope: 'asset',
      criterion: { type: 'section508' },
      standards: ['508'],
      condition: { provision: '501.1' },
    });
    expect(has(items, P.uri, '502.2.2')).toBe(false);
    expect(item(items, A.uri, '503.4').baselineTests).toEqual(['17.A-MediaPlayerCCADControls']);
  });

  it('builds product items once, with no asset, done by a review on any scanned asset', () => {
    const onPdf = manual({ asset: P, type: 'section508', id: '302.1' });
    const stale = manual({ asset: A, type: 'section508', id: '302.2', expiresOnChangeOf: OLD });
    const { items } = scan({ assets: [A, P], findings: [onPdf, stale] });
    const product = items.filter((i) => i.scope === 'product');
    expect(product.map((i) => i.criterion.id)).toEqual([
      '302.1',
      '302.2',
      '302.3',
      '302.4',
      '302.5',
      '302.6',
      '302.7',
      '302.8',
      '302.9',
      '602.2',
      '602.3',
      '602.4',
      '603.2',
      '603.3',
    ]);
    const p = item(items, undefined, '302.1');
    expect(p).toMatchObject({ standards: ['508'], status: 'done', review: onPdf.id, related: [] });
    expect('asset' in p).toBe(false);
    expect(item(items, undefined, '302.2').status).toBe('expired');
    expect(p.steps.length).toBeGreaterThan(0);
  });

  it('has no product items without a scanned asset to anchor a review to', () => {
    const down = { uri: 'https://example.com/down', kind: 'web' as const };
    expect(scan({ assets: [], unscanned: [down] }).items).toEqual([]);
  });

  it('makes no items for unscanned assets and counts them in the summary', () => {
    const down = { uri: 'https://example.com/down', kind: 'web' as const };
    const broken = { uri: 'docs/broken.pdf', kind: 'pdf' as const };
    const { report, items } = scan({
      assets: [A],
      findings: [automated({ outcome: 'fail', wcag: '1.4.3', ruleId: 'color-contrast' })],
      unscanned: [down, broken],
    });
    expect(items.some((i) => i.asset?.uri === down.uri)).toBe(false);
    const summary = checklistSummary({ report, data });
    expect(summary.unscanned).toEqual([down, broken]);
    expect(summary.total).toBe(items.length);
    expect(summary.byStatus['failed-automated']).toBe(1);
    expect(summary.byStatus.open).toBe(items.length - 1);
    expect(summary.byStatus.done + summary.byStatus.expired).toBe(0);
  });

  it('gives ids that hash the asset uri (or "product"), criterion type and id', () => {
    const { items } = scan({ assets: [A] });
    expect(item(items, A.uri, '1.1.1').id).toBe(ckId(A.uri, 'wcag', '1.1.1'));
    expect(item(items, A.uri, '502.2.2').id).toBe(ckId(A.uri, 'section508', '502.2.2'));
    expect(item(items, undefined, '302.1').id).toBe(ckId('product', 'section508', '302.1'));
    for (const i of items) expect(i.id).toMatch(/^ck_[0-9a-f]{16}$/);
  });

  it('is stable across runs and across finding order', () => {
    const findings = [
      automated({ outcome: 'needs-review', wcag: '1.1.1' }),
      automated({ outcome: 'fail', wcag: '1.1.1', ruleId: 'role-img-alt' }),
      automated({ outcome: 'fail', wcag: '1.4.3', ruleId: 'color-contrast' }),
      manual({ id: '2.1.1' }),
      manual({ asset: P, id: '1.3.2', expiresOnChangeOf: OLD }),
    ];
    const first = scan({ assets: [A, P], findings }).items;
    const again = scan({ assets: [A, P], findings }).items;
    const reversed = scan({ assets: [A, P], findings: [...findings].reverse() }).items;
    expect(again).toEqual(first);
    expect(reversed).toEqual(first);
  });

  it('refuses a roll-up made for a different profile than the report names', () => {
    const { report } = scan({ assets: [A] });
    expect(() => buildChecklist({ report: { ...report, profile: { id: '508' } }, data })).toThrow(
      /profile/,
    );
  });
});

/*
 * The corpus as a scan report, offline: one asset per corpus item (hashed
 * from its bytes), one finding per expected engine result that maps to a WCAG
 * SC, and the malformed PDF as an unscanned asset. The roll-up uses the
 * shipped deciding rules and errata, so the counts move when the data does.
 */
const corpusDir = new URL('../../../corpus/', import.meta.url);
const mapped = new Map<string, string[]>([
  ...data.axe.rules.map((r) => [`axe-core:${r.id}`, r.wcag] as const),
  ...data.verapdf.rules.map((r) => [`verapdf:${r.id}`, r.wcag] as const),
  ...data.widedoor.rules.map((r) => [`widedoor:${r.id}`, r.wcag] as const),
]);

interface Expected {
  item: string;
  kind: AssetKind;
  expected: { engine: 'axe-core' | 'verapdf' | 'widedoor'; ruleId: string; outcome: Outcome }[];
  error?: { code: string };
}

function corpusReport(kind: AssetKind) {
  const dir = new URL(`expected/${kind}/`, corpusDir);
  const assets: Asset[] = [];
  const findings: Finding[] = [];
  const unscanned: UnscannedAsset[] = [];
  for (const file of readdirSync(dir).sort()) {
    const e = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Expected;
    if (e.error) {
      unscanned.push({ uri: e.item, kind });
      continue;
    }
    const bytes = readFileSync(new URL(e.item, corpusDir));
    const asset: Asset = {
      kind,
      uri: e.item,
      contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
    assets.push(asset);
    e.expected.forEach((r, n) => {
      const wcag = mapped.get(`${r.engine}:${r.ruleId}`);
      if (!wcag) return; // informational veraPDF rule with no WCAG relation
      const location = kind === 'web' ? { selector: `#r${n}` } : { page: 1, structPath: `/${n}` };
      findings.push(
        FindingSchema.parse({
          schemaVersion: 1,
          id: findingId(asset.uri, location, r.engine, r.ruleId),
          asset,
          location,
          source: { engine: r.engine, engineVersion: '1', ruleId: r.ruleId },
          criteria: { wcag },
          outcome: r.outcome,
        }),
      );
    });
  }
  const profile = getProfile('508+wcag21aa');
  const result = rollup({
    findings,
    reviews: [],
    profile,
    assets,
    decidingRules: decidingRulesFrom(data),
    errata: errataFrom(data),
    unscanned,
  });
  return { assets, findings, rollup: result, profile: { id: profile.id } };
}

function counts(report: ReturnType<typeof corpusReport>) {
  const items = buildChecklist({ report, data });
  const tally = <K extends string>(key: (i: ChecklistItem) => K) =>
    Object.fromEntries(
      [...new Set(items.map(key))].sort().map((k) => [k, items.filter((i) => key(i) === k).length]),
    );
  const summary = checklistSummary({ report, data });
  return {
    items: items.length,
    assets: report.assets.length,
    unscanned: summary.unscanned.length,
    byStatus: summary.byStatus,
    byWhy: tally((i) => i.why),
    byScope: tally((i) => i.scope),
    byStandards: tally((i) => i.standards.join('+')),
  };
}

describe('corpus checklists', () => {
  it('web report', () => {
    expect(counts(corpusReport('web'))).toMatchInlineSnapshot(`
      {
        "assets": 21,
        "byScope": {
          "asset": 1617,
          "product": 14,
        },
        "byStandards": {
          "508": 602,
          "508+wcag21aa": 777,
          "wcag21aa": 252,
        },
        "byStatus": {
          "done": 0,
          "expired": 0,
          "failed-automated": 12,
          "open": 1619,
        },
        "byWhy": {
          "manual-only": 1603,
          "needs-review": 1,
          "no-deciding-rule": 27,
        },
        "items": 1631,
        "unscanned": 0,
      }
    `);
  });

  it('PDF report', () => {
    expect(counts(corpusReport('pdf'))).toMatchInlineSnapshot(`
      {
        "assets": 4,
        "byScope": {
          "asset": 196,
          "product": 14,
        },
        "byStandards": {
          "508": 14,
          "508+wcag21aa": 132,
          "wcag21aa": 64,
        },
        "byStatus": {
          "done": 0,
          "expired": 0,
          "failed-automated": 12,
          "open": 198,
        },
        "byWhy": {
          "manual-only": 181,
          "needs-review": 6,
          "no-deciding-rule": 23,
        },
        "items": 210,
        "unscanned": 1,
      }
    `);
  });

  it('every status in the summary is one of the four', () => {
    const statuses: ChecklistItemStatus[] = ['open', 'done', 'expired', 'failed-automated'];
    const summary = checklistSummary({ report: corpusReport('pdf'), data });
    expect(Object.keys(summary.byStatus).sort()).toEqual([...statuses].sort());
  });
});
