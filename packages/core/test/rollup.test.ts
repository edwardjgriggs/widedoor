import { describe, expect, it } from 'vitest';
import {
  FindingSchema,
  assetsLevel,
  currentHashes,
  decidingRulesFrom,
  errataFrom,
  getProfile,
  isCurrentRecord,
  loadStandardsData,
  rollup,
  type Asset,
  type ConformanceLevel,
  type CriterionRollup,
  type DeterminationReason,
  type Finding,
  type Outcome,
  type Profile,
  type Rollup,
  type StandardId,
} from '../src/index.js';

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const CURRENT = hash('a');
const OLD = hash('0');

const web = (uri: string): Asset => ({ kind: 'web', uri, contentHash: CURRENT });
const pdf = (uri: string): Asset => ({ kind: 'pdf', uri, contentHash: CURRENT });
const A = web('https://example.com/a');
const B = web('https://example.com/b');

let seq = 0;
const nextId = () => `wd_${(seq++).toString(16).padStart(16, '0')}`;

interface Spec {
  asset?: Asset;
  outcome: Outcome;
  wcag?: string[];
  section508?: string[];
  ruleId?: string;
  /** The content hash the record was made against; defaults to the asset's current one. */
  contentHash?: string;
}

// Fixtures go through FindingSchema, so the table runs on valid records only.
function automated({
  asset = A,
  outcome,
  wcag = ['1.1.1'],
  section508,
  ruleId = 'image-alt',
  contentHash = asset.contentHash,
}: Spec): Finding {
  const location = asset.kind === 'web' ? { selector: 'img' } : { page: 1 };
  return FindingSchema.parse({
    schemaVersion: 1,
    id: nextId(),
    asset: { ...asset, contentHash },
    location,
    source: { engine: asset.kind === 'web' ? 'axe-core' : 'verapdf', engineVersion: '1', ruleId },
    criteria:
      wcag.length > 0
        ? { wcag, ...(section508 ? { section508 } : {}) }
        : { section508: section508 ?? [] },
    outcome,
  });
}

function manual(spec: Spec & { notes?: string; expiresOnChangeOf?: string }): Finding {
  const { asset = A, outcome, wcag = ['1.1.1'], section508, notes, expiresOnChangeOf } = spec;
  const location = asset.kind === 'web' ? { selector: 'body' } : { page: 1 };
  return FindingSchema.parse({
    schemaVersion: 1,
    id: nextId(),
    asset,
    location,
    source: { engine: 'manual', engineVersion: '1', ruleId: 'review' },
    criteria:
      wcag.length > 0
        ? { wcag, ...(section508 ? { section508 } : {}) }
        : { section508: section508 ?? [] },
    outcome,
    review: {
      reviewer: 'tester',
      date: '2026-10-21',
      ...(notes !== undefined ? { notes } : {}),
      expiresOnChangeOf: expiresOnChangeOf ?? asset.contentHash,
    },
  });
}

/** Deliberately invalid records, as a hand-edited or buggy import could produce. */
type Loose = Record<string, unknown>;
const invalid = (base: Finding, patch: (f: Loose) => Loose) =>
  patch(structuredClone(base) as unknown as Loose) as unknown as Finding;
const invalidAsset = (base: Asset, patch: Loose) => ({ ...base, ...patch }) as unknown as Asset;
const withoutReview = (f: Loose): Loose => {
  const copy = { ...f };
  delete copy.review;
  return copy;
};

const DECIDING = new Map([
  ['axe-core:image-alt', new Set(['1.1.1'])],
  ['verapdf:image-alt', new Set(['1.1.1'])],
]);

function criterion(result: Rollup, standard: StandardId, id: string): CriterionRollup {
  const s = result.standards.find((v) => v.standard === standard);
  const c = s?.criteria.find((r) => r.id === id);
  if (!c) throw new Error(`no ${standard} row for ${id}`);
  return c;
}

interface Case {
  name: string;
  assets: Asset[];
  findings?: Finding[];
  reviews?: Finding[];
  profile?: Profile;
  standard?: StandardId;
  id?: string;
  level: ConformanceLevel;
  /** Expected per-asset reason, in asset order. */
  reasons: DeterminationReason[];
}

const wcag21 = getProfile('wcag21aa');
const s508 = getProfile('508');
const naPdf = pdf('https://example.com/report.pdf');

const expiredFail = manual({ outcome: 'fail', expiresOnChangeOf: OLD });
const expiredPass = manual({ outcome: 'pass', expiresOnChangeOf: OLD });

const cases: Case[] = [
  { name: 'nothing recorded', assets: [A], level: 'Not Evaluated', reasons: ['no-results'] },
  {
    name: 'automated pass (non-deciding rule) but no manual review',
    assets: [A],
    findings: [automated({ outcome: 'pass', ruleId: 'role-img-alt' })],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },
  {
    name: 'automated pass from a rule that decides a different SC',
    assets: [A],
    findings: [automated({ outcome: 'pass', wcag: ['1.1.1', '4.1.2'], ruleId: 'image-alt' })],
    id: '4.1.2',
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },
  {
    name: 'deciding automated pass',
    assets: [A],
    findings: [automated({ outcome: 'pass' })],
    level: 'Supports',
    reasons: ['deciding-automated-pass'],
  },
  {
    name: 'manual pass',
    assets: [A],
    reviews: [manual({ outcome: 'pass' })],
    level: 'Supports',
    reasons: ['manual-pass'],
  },
  {
    name: 'manual fail',
    assets: [A],
    reviews: [manual({ outcome: 'fail' })],
    level: 'Does Not Support',
    reasons: ['manual-fail'],
  },
  {
    name: 'manual pass and manual fail on the same asset',
    assets: [A],
    reviews: [manual({ outcome: 'pass' }), manual({ outcome: 'fail' })],
    level: 'Does Not Support',
    reasons: ['manual-fail'],
  },
  {
    name: 'automated fail',
    assets: [A],
    findings: [automated({ outcome: 'fail' })],
    level: 'Does Not Support',
    reasons: ['automated-fail'],
  },
  {
    name: 'automated fail beats a manual pass on the same asset',
    assets: [A],
    findings: [automated({ outcome: 'fail' })],
    reviews: [manual({ outcome: 'pass' })],
    level: 'Does Not Support',
    reasons: ['automated-fail'],
  },
  {
    name: 'automated fail beats a deciding automated pass on the same asset',
    assets: [A],
    findings: [automated({ outcome: 'pass' }), automated({ outcome: 'fail' })],
    level: 'Does Not Support',
    reasons: ['automated-fail'],
  },
  {
    name: 'one asset fails, another passes: Partially Supports',
    assets: [A, B],
    findings: [automated({ asset: B, outcome: 'fail' })],
    reviews: [manual({ asset: A, outcome: 'pass' })],
    level: 'Partially Supports',
    reasons: ['manual-pass', 'automated-fail'],
  },
  {
    name: 'one asset fails, another is unevaluated: Does Not Support',
    assets: [A, B],
    findings: [automated({ asset: A, outcome: 'fail' })],
    level: 'Does Not Support',
    reasons: ['automated-fail', 'no-results'],
  },
  {
    name: 'one asset passes, another is unevaluated: Not Evaluated',
    assets: [A, B],
    reviews: [manual({ asset: A, outcome: 'pass' })],
    level: 'Not Evaluated',
    reasons: ['manual-pass', 'no-results'],
  },
  {
    name: 'every asset passes',
    assets: [A, B],
    findings: [automated({ asset: B, outcome: 'pass' })],
    reviews: [manual({ asset: A, outcome: 'pass' })],
    level: 'Supports',
    reasons: ['manual-pass', 'deciding-automated-pass'],
  },
  {
    name: 'expired manual pass is ignored',
    assets: [A],
    reviews: [expiredPass],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },
  {
    name: 'expired manual fail is ignored',
    assets: [A],
    reviews: [expiredFail],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },
  {
    name: 'profile N/A: E205.4 exception for a non-web PDF under 508',
    profile: s508,
    standard: '508',
    id: '2.4.1',
    assets: [naPdf],
    level: 'Not Applicable',
    reasons: ['profile-not-applicable'],
  },
  {
    name: 'profile N/A holds even with an automated fail on the excepted SC',
    profile: s508,
    standard: '508',
    id: '2.4.1',
    assets: [naPdf],
    findings: [automated({ asset: naPdf, outcome: 'fail', wcag: ['2.4.1'] })],
    level: 'Not Applicable',
    reasons: ['profile-not-applicable'],
  },
  {
    name: 'profile N/A on the PDF, web page passes: Supports',
    profile: s508,
    standard: '508',
    id: '2.4.1',
    assets: [A, naPdf],
    reviews: [manual({ asset: A, outcome: 'pass', wcag: ['2.4.1'] })],
    level: 'Supports',
    reasons: ['manual-pass', 'profile-not-applicable'],
  },
  {
    name: 'manual N/A with a reason',
    assets: [A],
    reviews: [manual({ outcome: 'not-applicable', notes: 'The page has no images.' })],
    level: 'Not Applicable',
    reasons: ['manual-not-applicable'],
  },
  {
    name: 'manual N/A without a reason is not counted',
    assets: [A],
    reviews: [manual({ outcome: 'not-applicable', notes: '  ' })],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },
  {
    name: 'manual N/A on one asset, manual pass on another: Supports',
    assets: [A, B],
    reviews: [
      manual({ asset: A, outcome: 'not-applicable', notes: 'No images.' }),
      manual({ asset: B, outcome: 'pass' }),
    ],
    level: 'Supports',
    reasons: ['manual-not-applicable', 'manual-pass'],
  },
  {
    name: 'automated fail beats a manual N/A',
    assets: [A],
    findings: [automated({ outcome: 'fail' })],
    reviews: [manual({ outcome: 'not-applicable', notes: 'No images.' })],
    level: 'Does Not Support',
    reasons: ['automated-fail'],
  },
  {
    name: 'automated not-applicable never gives N/A',
    assets: [A],
    findings: [automated({ outcome: 'not-applicable' })],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },
  {
    name: 'automated needs-review only',
    assets: [A],
    findings: [automated({ outcome: 'needs-review' })],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },
  {
    name: 'manual needs-review only',
    assets: [A],
    reviews: [manual({ outcome: 'needs-review' })],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },
  {
    name: 'not-tested only',
    assets: [A],
    findings: [automated({ outcome: 'not-tested' })],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },

  // Fail closed on records that cannot be anchored to the current content.
  {
    name: 'manual pass with no review block is ignored',
    assets: [A],
    reviews: [invalid(manual({ outcome: 'pass' }), withoutReview)],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },
  {
    name: 'manual pass with a null expiresOnChangeOf is ignored',
    assets: [A],
    reviews: [
      invalid(manual({ outcome: 'pass' }), (f) => ({
        ...f,
        review: { ...(f.review as Loose), expiresOnChangeOf: null },
      })),
    ],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },
  {
    name: 'manual pass with null hashes on both sides is ignored',
    assets: [invalidAsset(A, { contentHash: null })],
    reviews: [
      invalid(manual({ outcome: 'pass' }), (f) => ({
        ...f,
        asset: { ...(f.asset as Loose), contentHash: null },
        review: { ...(f.review as Loose), expiresOnChangeOf: null },
      })),
    ],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },
  {
    name: 'manual pass with missing hashes on both sides is ignored',
    assets: [invalidAsset(A, { contentHash: undefined })],
    reviews: [
      invalid(manual({ outcome: 'pass' }), (f) => ({
        ...f,
        review: { ...(f.review as Loose), expiresOnChangeOf: undefined },
      })),
    ],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },
  {
    name: 'manual fail with no review block is ignored',
    assets: [A],
    reviews: [invalid(manual({ outcome: 'fail' }), withoutReview)],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },
  {
    name: 'stale deciding automated pass is ignored',
    assets: [A],
    findings: [automated({ outcome: 'pass', contentHash: OLD })],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },
  {
    name: 'stale automated fail still counts',
    assets: [A],
    findings: [automated({ outcome: 'fail', contentHash: OLD })],
    level: 'Does Not Support',
    reasons: ['automated-fail'],
  },
  {
    name: 'deciding automated pass with a missing finding hash is ignored',
    assets: [A],
    findings: [
      invalid(automated({ outcome: 'pass' }), (f) => ({
        ...f,
        asset: { ...(f.asset as Loose), contentHash: undefined },
      })),
    ],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },
  {
    name: 'deciding automated pass with null hashes on both sides is ignored',
    assets: [invalidAsset(A, { contentHash: null })],
    findings: [
      invalid(automated({ outcome: 'pass' }), (f) => ({
        ...f,
        asset: { ...(f.asset as Loose), contentHash: null },
      })),
    ],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },

  // Reviews that disagree, and expired next to current.
  {
    name: 'manual pass and manual N/A on the same asset: pass wins',
    assets: [A],
    reviews: [
      manual({ outcome: 'pass' }),
      manual({ outcome: 'not-applicable', notes: 'No images.' }),
    ],
    level: 'Supports',
    reasons: ['manual-pass'],
  },
  {
    name: 'expired fail next to a current pass: the pass decides',
    assets: [A],
    reviews: [expiredFail, manual({ outcome: 'pass' })],
    level: 'Supports',
    reasons: ['manual-pass'],
  },
  {
    name: 'expired pass next to a current fail: the fail decides',
    assets: [A],
    reviews: [expiredPass, manual({ outcome: 'fail' })],
    level: 'Does Not Support',
    reasons: ['manual-fail'],
  },

  // Automated passes never settle a 508 manual provision.
  {
    name: 'deciding automated pass citing a 508 manual provision does not decide it',
    profile: s508,
    standard: '508',
    id: '502.3.1',
    assets: [A],
    findings: [automated({ outcome: 'pass', section508: ['502.3.1'] })],
    level: 'Not Evaluated',
    reasons: ['no-deciding-result'],
  },

  // PDF assets under WCAG 2.1, and mixed scans.
  {
    name: 'PDF under wcag21aa: deciding automated pass',
    assets: [naPdf],
    findings: [automated({ asset: naPdf, outcome: 'pass' })],
    level: 'Supports',
    reasons: ['deciding-automated-pass'],
  },
  {
    name: 'PDF under wcag21aa: manual fail',
    assets: [naPdf],
    reviews: [manual({ asset: naPdf, outcome: 'fail' })],
    level: 'Does Not Support',
    reasons: ['manual-fail'],
  },
  {
    name: 'PDF under wcag21aa: 2.4.1 applies, nothing recorded',
    id: '2.4.1',
    assets: [naPdf],
    level: 'Not Evaluated',
    reasons: ['no-results'],
  },
  {
    name: 'web page passes, PDF fails under wcag21aa: Partially Supports',
    assets: [A, naPdf],
    findings: [automated({ asset: naPdf, outcome: 'fail' })],
    reviews: [manual({ asset: A, outcome: 'pass' })],
    level: 'Partially Supports',
    reasons: ['manual-pass', 'automated-fail'],
  },
  {
    name: 'combined profile, 508 view: the excepted SC stays N/A despite a fail',
    profile: getProfile('508+wcag21aa'),
    standard: '508',
    id: '2.4.1',
    assets: [naPdf],
    findings: [automated({ asset: naPdf, outcome: 'fail', wcag: ['2.4.1'] })],
    level: 'Not Applicable',
    reasons: ['profile-not-applicable'],
  },
  {
    name: 'combined profile, wcag21aa view: the same fail counts',
    profile: getProfile('508+wcag21aa'),
    standard: 'wcag21aa',
    id: '2.4.1',
    assets: [naPdf],
    findings: [automated({ asset: naPdf, outcome: 'fail', wcag: ['2.4.1'] })],
    level: 'Does Not Support',
    reasons: ['automated-fail'],
  },
];

describe('rollup decision table', () => {
  it.each(cases)('$name -> $level', (c) => {
    const result = rollup({
      findings: c.findings ?? [],
      reviews: c.reviews ?? [],
      profile: c.profile ?? wcag21,
      assets: c.assets,
      decidingRules: DECIDING,
    });
    const row = criterion(result, c.standard ?? 'wcag21aa', c.id ?? '1.1.1');
    expect(row.level).toBe(c.level);
    expect(row.assets.map((a) => a.reason)).toEqual(c.reasons);
    expect(row.assets.map((a) => a.uri)).toEqual(c.assets.map((a) => a.uri));
  });
});

describe('rollup details', () => {
  const run = (input: Partial<Parameters<typeof rollup>[0]> & { assets: Asset[] }) =>
    rollup({ findings: [], reviews: [], profile: wcag21, decidingRules: DECIDING, ...input });

  it('reports the ids that decided the level', () => {
    const fail = automated({ asset: B, outcome: 'fail' });
    const pass = manual({ asset: A, outcome: 'pass' });
    const ignored = automated({ asset: A, outcome: 'needs-review' });
    const row = criterion(
      run({ assets: [A, B], findings: [fail, ignored], reviews: [pass] }),
      'wcag21aa',
      '1.1.1',
    );
    expect(row.evidence.sort()).toEqual([fail.id, pass.id].sort());
    expect(row.assets[0]?.undecided).toEqual([ignored.id]);
    expect(row.reason).toBe('1 of 2 applicable assets fails; 1 passes');
  });

  it('words each level reason in the singular for one asset and the plural for more', () => {
    const units = (...states: ('pass' | 'fail' | 'not-evaluated')[]) =>
      states.map((state) => ({ state, reason: 'no-results' as const }));
    const reason = (...states: ('pass' | 'fail' | 'not-evaluated')[]) =>
      assetsLevel(units(...states), [], undefined).reason;
    expect(reason('pass')).toBe('the 1 applicable asset passes');
    expect(reason('pass', 'pass', 'pass')).toBe('all 3 applicable assets pass');
    expect(reason('fail')).toBe('the 1 applicable asset fails');
    expect(reason('fail', 'fail', 'not-evaluated')).toBe(
      '2 of 3 applicable assets fail; none pass',
    );
    expect(reason('fail', 'not-evaluated')).toBe('1 of 2 applicable assets fails; none pass');
    expect(reason('fail', 'fail', 'pass')).toBe('2 of 3 applicable assets fail; 1 passes');
    expect(reason('fail', 'pass', 'pass')).toBe('1 of 3 applicable assets fails; 2 pass');
    expect(reason('not-evaluated')).toBe('the 1 applicable asset has no deciding result');
    expect(reason('not-evaluated', 'not-evaluated')).toBe(
      '2 of 2 applicable assets have no deciding result',
    );
    expect(reason('pass', 'not-evaluated')).toBe('1 of 2 applicable assets has no deciding result');
  });

  it('lists expired reviews on the asset', () => {
    const row = criterion(run({ assets: [A], reviews: [expiredPass] }), 'wcag21aa', '1.1.1');
    expect(row.assets[0]?.expired).toEqual([expiredPass.id]);
    expect(row.evidence).toEqual([]);
  });

  it('a review expires against the current hash, not the hash it was recorded with', () => {
    const changed: Asset = { ...A, contentHash: hash('c') };
    const review = manual({ asset: A, outcome: 'pass' });
    expect(
      criterion(run({ assets: [changed], reviews: [review] }), 'wcag21aa', '1.1.1').level,
    ).toBe('Not Evaluated');
  });

  it('a deciding rule never settles a 508 provision, even if the map names one', () => {
    const odd = new Map([['axe-core:image-alt', new Set(['502.3.1'])]]);
    const pass = automated({ outcome: 'pass', section508: ['502.3.1'] });
    const result = run({ profile: s508, assets: [A], findings: [pass], decidingRules: odd });
    expect(criterion(result, '508', '502.3.1').level).toBe('Not Evaluated');
  });

  it('defaults to no deciding rules', () => {
    const result = rollup({
      findings: [automated({ outcome: 'pass' })],
      reviews: [],
      profile: wcag21,
      assets: [A],
    });
    expect(criterion(result, 'wcag21aa', '1.1.1').level).toBe('Not Evaluated');
  });

  it('profile N/A carries the provision and the exception text', () => {
    const row = criterion(run({ profile: s508, assets: [naPdf] }), '508', '2.4.1');
    expect(row.assets[0]?.exception?.provision).toBe('E205.4');
    expect(row.assets[0]?.exception?.reason).toContain('Non-Web documents');
  });

  it('combined profile rolls up each standard view separately', () => {
    const both = getProfile('508+wcag21aa');
    const review = manual({ asset: naPdf, outcome: 'pass', wcag: ['2.4.1'] });
    const result = run({ profile: both, assets: [naPdf], reviews: [review] });
    expect(result.standards.map((s) => s.standard)).toEqual(['508', 'wcag21aa']);
    expect(criterion(result, '508', '2.4.1').level).toBe('Not Applicable');
    expect(criterion(result, 'wcag21aa', '2.4.1').level).toBe('Supports');
    // 2.1-only SC exist only in the WCAG 2.1 view.
    expect(() => criterion(result, '508', '1.3.4')).toThrow();
    expect(criterion(result, 'wcag21aa', '1.3.4').level).toBe('Not Evaluated');
  });

  it('every criterion of a view is listed, defaulting to Not Evaluated', () => {
    const result = run({ assets: [A] });
    const rows = result.standards[0]?.criteria ?? [];
    expect(rows).toHaveLength(50);
    expect(rows.every((r) => r.level === 'Not Evaluated')).toBe(true);
  });

  it('no assets gives no rows', () => {
    expect(run({ assets: [] }).standards[0]?.criteria).toEqual([]);
  });

  it('records for assets outside the scan are ignored', () => {
    const stray = manual({ asset: B, outcome: 'pass' });
    const row = criterion(run({ assets: [A], reviews: [stray] }), 'wcag21aa', '1.1.1');
    expect(row.level).toBe('Not Evaluated');
    expect(row.assets).toHaveLength(1);
  });

  it('rejects manual records in findings, automated records in reviews and duplicate assets', () => {
    expect(() => run({ assets: [A], findings: [manual({ outcome: 'pass' })] })).toThrow(/reviews/);
    expect(() => run({ assets: [A], reviews: [automated({ outcome: 'pass' })] })).toThrow(
      /findings/,
    );
    expect(() => run({ assets: [A, A] })).toThrow(/twice/);
  });

  it('rejects a record whose asset kind differs from the listed asset', () => {
    const asPdf = pdf(A.uri);
    expect(() =>
      run({ assets: [asPdf], reviews: [manual({ asset: A, outcome: 'pass' })] }),
    ).toThrow(/is pdf/);
  });

  it('judges records that share an id on their own merits', () => {
    const old = manual({ outcome: 'fail', expiresOnChangeOf: OLD });
    const fresh = { ...manual({ outcome: 'pass' }), id: old.id };
    const reviewed = criterion(run({ assets: [A], reviews: [old, fresh] }), 'wcag21aa', '1.1.1');
    expect(reviewed.level).toBe('Supports');
    expect(reviewed.assets[0]?.expired).toEqual([old.id]);

    const doc = pdf('https://example.com/doc.pdf');
    const first = automated({ asset: doc, outcome: 'fail' });
    const second = { ...automated({ asset: doc, outcome: 'fail' }), id: first.id };
    const row = criterion(run({ assets: [doc], findings: [first, second] }), 'wcag21aa', '1.1.1');
    expect(row.level).toBe('Does Not Support');
  });

  it('a deciding pass does not count when the same rule is unsettled on the asset', () => {
    for (const outcome of ['needs-review', 'not-tested'] as const) {
      const pass = automated({ outcome: 'pass' });
      const open = automated({ outcome });
      const row = criterion(run({ assets: [A], findings: [pass, open] }), 'wcag21aa', '1.1.1');
      expect(row.level).toBe('Not Evaluated');
      expect(row.assets[0]?.undecided).toEqual(expect.arrayContaining([pass.id, open.id]));
    }
    const other = automated({ outcome: 'needs-review', ruleId: 'role-img-alt' });
    const row = criterion(
      run({ assets: [A], findings: [automated({ outcome: 'pass' }), other] }),
      'wcag21aa',
      '1.1.1',
    );
    expect(row.level).toBe('Supports');
  });

  it('lists WCAG rows in SC order even when the profile excepts some', () => {
    const ids = (r: Rollup) =>
      (r.standards[0]?.criteria ?? []).filter((c) => c.type === 'wcag').map((c) => c.id);
    const pdfOnly = ids(run({ profile: s508, assets: [naPdf] }));
    expect(pdfOnly).toEqual(ids(run({ profile: s508, assets: [A] })));
    expect(pdfOnly.indexOf('2.4.1')).toBeLessThan(pdfOnly.indexOf('2.4.2'));
    const rows = run({ profile: s508, assets: [naPdf] }).standards[0]?.criteria ?? [];
    const firstManual = rows.findIndex((c) => c.type === 'section508');
    expect(rows.slice(firstManual).every((c) => c.type === 'section508')).toBe(true);
  });

  describe('Section 508 manual items', () => {
    const chapter5 = (reviews: Finding[]) =>
      criterion(run({ profile: s508, assets: [A], reviews }), '508', '502.3.1');

    it('Chapter 5 items are never auto-marked N/A and carry their condition', () => {
      const row = chapter5([]);
      expect(row.level).toBe('Not Evaluated');
      expect(row.scope).toBe('asset');
      expect(row.type).toBe('section508');
      expect(row.condition?.provision).toBe('501.1');
    });

    it('Chapter 5 items become N/A only from a manual review with a reason', () => {
      const na = manual({
        outcome: 'not-applicable',
        wcag: [],
        section508: ['502.3.1'],
        notes: '501.1: no access to platform accessibility services.',
      });
      expect(chapter5([na]).level).toBe('Not Applicable');
      expect(chapter5([na]).evidence).toEqual([na.id]);
    });

    it('Chapter 5 items do not appear for PDFs', () => {
      const result = run({ profile: s508, assets: [naPdf] });
      expect(() => criterion(result, '508', '502.3.1')).toThrow();
    });

    it('product-scope items are judged once for the whole scan', () => {
      const pass = manual({ asset: A, outcome: 'pass', wcag: [], section508: ['302.1'] });
      const row = criterion(
        run({ profile: s508, assets: [A, B, naPdf], reviews: [pass] }),
        '508',
        '302.1',
      );
      expect(row.scope).toBe('product');
      expect(row.level).toBe('Supports');
      expect(row.assets).toEqual([]);
      expect(row.product?.reason).toBe('manual-pass');
      expect(row.evidence).toEqual([pass.id]);
    });

    const product = (
      provisionReviews: (Spec & { notes?: string; expiresOnChangeOf?: string })[],
    ): Finding[] => provisionReviews.map((s) => manual({ wcag: [], section508: ['302.1'], ...s }));

    it.each([
      {
        name: 'manual fail',
        reviews: product([{ outcome: 'fail' }]),
        level: 'Does Not Support',
        reason: 'manual-fail',
      },
      {
        name: 'pass on one asset, fail on another',
        reviews: product([
          { asset: A, outcome: 'pass' },
          { asset: B, outcome: 'fail' },
        ]),
        level: 'Does Not Support',
        reason: 'manual-fail',
      },
      {
        name: 'review expired against its own asset',
        reviews: product([{ asset: B, outcome: 'pass', expiresOnChangeOf: OLD }]),
        level: 'Not Evaluated',
        reason: 'no-deciding-result',
      },
      {
        name: 'expired review on one asset, current pass on another',
        reviews: product([
          { asset: A, outcome: 'fail', expiresOnChangeOf: OLD },
          { asset: naPdf, outcome: 'pass' },
        ]),
        level: 'Supports',
        reason: 'manual-pass',
      },
      {
        name: 'N/A with a reason',
        reviews: product([{ outcome: 'not-applicable', notes: 'No vision-only features.' }]),
        level: 'Not Applicable',
        reason: 'manual-not-applicable',
      },
      {
        name: 'N/A without a reason',
        reviews: product([{ outcome: 'not-applicable' }]),
        level: 'Not Evaluated',
        reason: 'no-deciding-result',
      },
    ] as const)('product scope: $name -> $level', ({ reviews, level, reason }) => {
      const row = criterion(
        run({ profile: s508, assets: [A, B, naPdf], reviews: [...reviews] }),
        '508',
        '302.1',
      );
      expect(row.level).toBe(level);
      expect(row.product?.reason).toBe(reason);
    });

    it('product-scope items with nothing recorded are Not Evaluated', () => {
      const row = criterion(run({ profile: s508, assets: [A] }), '508', '302.1');
      expect(row.level).toBe('Not Evaluated');
      expect(row.product?.reason).toBe('no-results');
    });
  });
});

describe('decidingRulesFrom', () => {
  it('collects only rules with decides: true (none in Phase 0)', () => {
    expect(decidingRulesFrom(loadStandardsData()).size).toBe(0);
  });

  const withDeciding = (pick: (r: { wcag: string[] }) => boolean) => {
    const data = loadStandardsData();
    const rule = data.axe.rules.find(pick);
    if (!rule) throw new Error('no matching axe rule');
    return { rule, data: { ...data, axe: { ...data.axe, rules: [{ ...rule, decides: true }] } } };
  };

  it('keys by engine and rule id and keeps the mapped SC', () => {
    const { rule, data } = withDeciding((r) => r.wcag.length === 1);
    const rules = decidingRulesFrom(data);
    expect([...(rules.get(`axe-core:${rule.id}`) ?? [])]).toEqual(rule.wcag);
  });

  it('rejects a deciding rule mapped to more than one SC', () => {
    const { data } = withDeciding((r) => r.wcag.length > 1);
    expect(() => decidingRulesFrom(data)).toThrow(/exactly one/);
  });
});

describe('rollup id lists', () => {
  it('lists a finding id once when several records share it', () => {
    const fail = automated({ outcome: 'fail' });
    const again = { ...fail, evidence: { snippet: '<img>' } };
    const review = automated({ outcome: 'needs-review' });
    const stale = automated({ outcome: 'pass', contentHash: OLD });
    const result = rollup({
      findings: [fail, again, review, { ...review }, stale, { ...stale }],
      reviews: [],
      profile: wcag21,
      assets: [A],
    });
    const row = criterion(result, 'wcag21aa', '1.1.1');
    expect(row.evidence).toEqual([fail.id]);
    expect(row.assets[0]?.evidence).toEqual([fail.id]);
    expect(row.assets[0]?.undecided).toEqual([review.id]);
    expect(row.assets[0]?.expired).toEqual([stale.id]);
  });
});

describe('assets in scope that were not scanned', () => {
  it('keep a criterion from Supports when another asset passes it', () => {
    const pass = manual({ outcome: 'pass', wcag: ['2.1.2'] });
    const result = rollup({
      findings: [],
      reviews: [pass],
      profile: wcag21,
      assets: [A],
      unscanned: [{ uri: B.uri, kind: 'web' }],
    });
    const row = criterion(result, 'wcag21aa', '2.1.2');
    expect(row.level).toBe('Not Evaluated');
    expect(row.assets.map((a) => [a.uri, a.reason])).toEqual([
      [A.uri, 'manual-pass'],
      [B.uri, 'not-scanned'],
    ]);
  });

  it('list every criterion as Not Evaluated when nothing could be scanned', () => {
    const result = rollup({
      findings: [],
      reviews: [],
      profile: getProfile('508+wcag21aa'),
      assets: [],
      unscanned: [
        { uri: A.uri, kind: 'web' },
        { uri: naPdf.uri, kind: 'pdf' },
      ],
    });
    for (const s of result.standards) {
      expect(s.criteria.length, s.standard).toBeGreaterThan(0);
      for (const c of s.criteria.filter((c) => c.scope === 'asset'))
        expect(['Not Evaluated', 'Not Applicable'], `${s.standard} ${c.id}`).toContain(c.level);
    }
    expect(criterion(result, 'wcag21aa', '1.1.1').level).toBe('Not Evaluated');
    // The E205.4 exception is a profile decision; it holds whether or not the PDF was scanned.
    const bypass = criterion(result, '508', '2.4.1');
    expect(bypass.assets.find((a) => a.uri === naPdf.uri)?.reason).toBe('profile-not-applicable');
  });

  it('ignore an unscanned entry for an asset that was scanned', () => {
    const result = rollup({
      findings: [],
      reviews: [manual({ outcome: 'pass', wcag: ['2.1.2'] })],
      profile: wcag21,
      assets: [A],
      unscanned: [{ uri: A.uri, kind: 'web' }],
    });
    expect(criterion(result, 'wcag21aa', '2.1.2').level).toBe('Supports');
  });

  it('cap Supports when the scope has a gap that names no asset', () => {
    const result = rollup({
      findings: [],
      reviews: [manual({ outcome: 'pass', wcag: ['2.1.2'] })],
      profile: wcag21,
      assets: [A],
      scopeGaps: ['the sitemap could not be read'],
    });
    const row = criterion(result, 'wcag21aa', '2.1.2');
    expect(row.level).toBe('Not Evaluated');
    expect(row.reason).toMatch(/scope is incomplete: the sitemap could not be read/);
  });
});

describe('review hash', () => {
  const REVIEW = hash('b');
  const CHANGED = hash('c');
  const run = (asset: Asset, review: Finding) =>
    criterion(
      rollup({ findings: [], reviews: [review], profile: wcag21, assets: [asset] }),
      'wcag21aa',
      '1.1.1',
    );

  it('currentHashes gives the content hash and the review anchor per uri', () => {
    const hashes = currentHashes([A, { ...B, reviewHash: REVIEW }]);
    expect(hashes.get(A.uri)).toEqual({ content: CURRENT, review: CURRENT });
    expect(hashes.get(B.uri)).toEqual({ content: CURRENT, review: REVIEW });
  });

  it('a review anchored to the review hash stays current when the content hash changes', () => {
    const review = manual({ outcome: 'pass', expiresOnChangeOf: REVIEW });
    const asset: Asset = { ...A, contentHash: CHANGED, reviewHash: REVIEW };
    expect(isCurrentRecord(review, currentHashes([asset]))).toBe(true);
    const row = run(asset, review);
    expect(row.level).toBe('Supports');
    expect(row.assets[0]?.reason).toBe('manual-pass');
  });

  it('a review anchored to the content hash expires when a different review hash is present', () => {
    const review = manual({ outcome: 'pass', expiresOnChangeOf: CURRENT });
    const asset: Asset = { ...A, reviewHash: REVIEW };
    expect(isCurrentRecord(review, currentHashes([asset]))).toBe(false);
    const row = run(asset, review);
    expect(row.level).toBe('Not Evaluated');
    expect(row.assets[0]?.expired).toEqual([review.id]);
  });

  it('automated passes are still judged against the content hash', () => {
    const pass = automated({ outcome: 'pass' });
    const row = criterion(
      rollup({
        findings: [pass],
        reviews: [],
        profile: wcag21,
        assets: [{ ...A, reviewHash: REVIEW }],
        decidingRules: DECIDING,
      }),
      'wcag21aa',
      '1.1.1',
    );
    expect(row.level).toBe('Supports');
  });
});

describe('4.1.1 errata basis', () => {
  const errata = errataFrom(loadStandardsData());
  const parsing = (input: Partial<Parameters<typeof rollup>[0]> & { assets: Asset[] }) =>
    rollup({ findings: [], reviews: [], profile: wcag21, errata, ...input });

  it('comes from the data and names only 4.1.1', () => {
    expect([...errata.keys()]).toEqual(['4.1.1']);
  });

  it.each(['508', 'wcag21aa', '508+wcag21aa'] as const)(
    'passes 4.1.1 on every scanned web page and PDF with nothing recorded (%s profile)',
    (profileId) => {
      const result = parsing({ profile: getProfile(profileId), assets: [A, naPdf] });
      for (const s of result.standards) {
        const row = criterion(result, s.standard, '4.1.1');
        expect(row.level, s.standard).toBe('Supports');
        expect(row.assets.map((a) => [a.state, a.reason])).toEqual([
          ['pass', 'errata'],
          ['pass', 'errata'],
        ]);
        expect(row.evidence).toEqual([]);
        expect(row.reason).toContain('https://www.w3.org/WAI/WCAG20/errata/');
        expect(row.reason).toContain('https://www.w3.org/WAI/WCAG21/errata/');
        expect(row.reason).toContain(
          'This criterion should be considered as always satisfied for any content using HTML or XML.',
        );
        expect(row.reason).toContain(
          'This Success Criterion should be considered as always satisfied for any content using HTML or XML.',
        );
        expect(row.reason).toContain("Always answer 'Supports'");
      }
    },
  );

  it('no other criterion passes on the errata basis', () => {
    const result = parsing({ profile: getProfile('508+wcag21aa'), assets: [A, naPdf] });
    for (const s of result.standards)
      for (const c of s.criteria.filter((c) => c.id !== '4.1.1')) {
        expect(c.level, `${s.standard} ${c.id}`).not.toBe('Supports');
        expect([...c.assets, ...(c.product ? [c.product] : [])].map((a) => a.reason)).not.toContain(
          'errata',
        );
      }
  });

  it('without errata data 4.1.1 is Not Evaluated', () => {
    const row = criterion(
      rollup({ findings: [], reviews: [], profile: wcag21, assets: [A] }),
      'wcag21aa',
      '4.1.1',
    );
    expect(row.level).toBe('Not Evaluated');
  });

  it('an automated fail on 4.1.1 still wins', () => {
    const fail = automated({ outcome: 'fail', wcag: ['4.1.1'], ruleId: 'duplicate-id' });
    const row = criterion(parsing({ assets: [A, B], findings: [fail] }), 'wcag21aa', '4.1.1');
    expect(row.level).toBe('Partially Supports');
    expect(row.assets.map((a) => a.reason)).toEqual(['automated-fail', 'errata']);
    expect(row.evidence).toEqual([fail.id]);
  });

  it('a PDF that fails 4.1.1 next to a web page that passes on the errata', () => {
    const fail = automated({ asset: naPdf, outcome: 'fail', wcag: ['4.1.1'], ruleId: 'r' });
    const row = criterion(parsing({ assets: [A, naPdf], findings: [fail] }), 'wcag21aa', '4.1.1');
    expect(row.level).toBe('Partially Supports');
    expect(row.assets.map((a) => [a.uri, a.state, a.reason])).toEqual([
      [A.uri, 'pass', 'errata'],
      [naPdf.uri, 'fail', 'automated-fail'],
    ]);
    expect(row.evidence).toEqual([fail.id]);
    expect(row.reason).toContain(
      '. 1 asset passes on the errata basis, not on a test: WCAG 2.0 errata (',
    );
  });

  it('a manual N/A on 4.1.1 is listed as undecided when the errata pass wins', () => {
    const na = manual({
      asset: naPdf,
      outcome: 'not-applicable',
      wcag: ['4.1.1'],
      notes: 'The PDF is not HTML or XML.',
    });
    const row = criterion(parsing({ assets: [naPdf], reviews: [na] }), 'wcag21aa', '4.1.1');
    expect(row.level).toBe('Supports');
    expect(row.assets[0]).toMatchObject({ state: 'pass', reason: 'errata', undecided: [na.id] });
  });

  it('a manual N/A is listed as undecided when a fail wins', () => {
    const na = manual({ outcome: 'not-applicable', notes: 'No images.' });
    const row = criterion(
      parsing({ assets: [A], findings: [automated({ outcome: 'fail' })], reviews: [na] }),
      'wcag21aa',
      '1.1.1',
    );
    expect(row.assets[0]).toMatchObject({ state: 'fail', undecided: [na.id] });
  });

  it('a manual fail on 4.1.1 still wins', () => {
    const fail = manual({ outcome: 'fail', wcag: ['4.1.1'] });
    const row = criterion(parsing({ assets: [A], reviews: [fail] }), 'wcag21aa', '4.1.1');
    expect(row.level).toBe('Does Not Support');
    expect(row.assets[0]?.reason).toBe('manual-fail');
  });

  it('an unscanned asset still caps it', () => {
    const row = criterion(
      parsing({ assets: [A], unscanned: [{ uri: B.uri, kind: 'web' }] }),
      'wcag21aa',
      '4.1.1',
    );
    expect(row.level).toBe('Not Evaluated');
    expect(row.assets.map((a) => a.reason)).toEqual(['errata', 'not-scanned']);
  });

  it('a scope gap still caps it', () => {
    const row = criterion(
      parsing({ assets: [A], scopeGaps: ['the sitemap could not be read'] }),
      'wcag21aa',
      '4.1.1',
    );
    expect(row.level).toBe('Not Evaluated');
    // The cap comes first and the errata citation is a sentence of its own after it.
    expect(row.reason).toMatch(
      /^the 1 applicable asset passes, but the scope is incomplete: the sitemap could not be read\. 1 asset passes on the errata basis, not on a test: WCAG 2\.0 errata \(/,
    );
  });
});

describe('manual overrides', () => {
  const run = (findings: Finding[], reviews: Finding[], assets: Asset[] = [A]) =>
    criterion(
      rollup({ findings, reviews, profile: wcag21, assets, decidingRules: DECIDING }),
      'wcag21aa',
      '1.1.1',
    );
  const override = (
    ids: string[],
    spec: Partial<Spec> & { notes?: string; expiresOnChangeOf?: string } = {},
  ) =>
    invalid(
      manual({ outcome: 'pass', notes: 'False positive: the image is decorative.', ...spec }),
      (f) => ({
        ...f,
        review: { ...(f.review as Loose), overrides: ids },
      }),
    );

  it('a current pass that overrides an automated fail sets it aside', () => {
    const fail = automated({ outcome: 'fail' });
    const review = override([fail.id]);
    expect(FindingSchema.safeParse(review).success).toBe(true);
    const row = run([fail], [review]);
    expect(row.level).toBe('Supports');
    expect(row.assets[0]).toMatchObject({
      state: 'pass',
      reason: 'manual-override',
      overridden: [fail.id],
      evidence: [review.id],
    });
    expect(row.evidence).toEqual([review.id]);
  });

  it('sets aside every record with the overridden id on that asset', () => {
    const fail = automated({ outcome: 'fail' });
    const again = { ...automated({ outcome: 'fail' }), id: fail.id };
    const row = run([fail, again], [override([fail.id])]);
    expect(row.assets[0]?.reason).toBe('manual-override');
    expect(row.assets[0]?.overridden).toEqual([fail.id]);
  });

  it('a stale automated fail can be overridden', () => {
    const fail = automated({ outcome: 'fail', contentHash: OLD });
    expect(run([fail], [override([fail.id])]).assets[0]?.reason).toBe('manual-override');
  });

  it('other current fails keep the state at fail', () => {
    const named = automated({ outcome: 'fail' });
    const other = automated({ outcome: 'fail', ruleId: 'role-img-alt' });
    const manualFail = manual({ outcome: 'fail' });
    const row = run([named, other], [override([named.id])]);
    expect(row.level).toBe('Does Not Support');
    expect(row.assets[0]).toMatchObject({
      state: 'fail',
      reason: 'automated-fail',
      evidence: [other.id],
      overridden: [named.id],
    });
    const withManual = run([named], [override([named.id]), manualFail]);
    expect(withManual.assets[0]).toMatchObject({
      state: 'fail',
      reason: 'manual-fail',
      evidence: [manualFail.id],
      overridden: [named.id],
    });
  });

  it('an override without notes is ignored and listed in undecided', () => {
    const fail = automated({ outcome: 'fail' });
    for (const notes of [undefined, '   ']) {
      const review = invalid(override([fail.id]), (f) => {
        const r = { ...(f.review as Loose) };
        if (notes === undefined) delete r.notes;
        else r.notes = notes;
        return { ...f, review: r };
      });
      const row = run([fail], [review]);
      expect(row.level).toBe('Does Not Support');
      expect(row.assets[0]).toMatchObject({
        reason: 'automated-fail',
        overridden: [],
        undecided: [review.id],
      });
      // With no fail to set aside, the record still does not count as a pass.
      expect(run([], [review]).level).toBe('Not Evaluated');
    }
  });

  it('an override naming a fail on another asset is ignored', () => {
    const elsewhere = automated({ asset: B, outcome: 'fail' });
    const row = run([elsewhere], [override([elsewhere.id], { asset: A })], [A, B]);
    expect(row.level).toBe('Partially Supports');
    expect(row.assets.map((a) => [a.reason, a.overridden])).toEqual([
      ['manual-pass', []],
      ['automated-fail', []],
    ]);
  });

  it('an override naming a fail on another criterion is ignored', () => {
    const contrast = automated({ outcome: 'fail', wcag: ['1.4.3'], ruleId: 'color-contrast' });
    const result = rollup({
      findings: [contrast],
      reviews: [override([contrast.id])],
      profile: wcag21,
      assets: [A],
    });
    expect(criterion(result, 'wcag21aa', '1.4.3').assets[0]?.reason).toBe('automated-fail');
    expect(criterion(result, 'wcag21aa', '1.1.1').assets[0]?.reason).toBe('manual-pass');
  });

  it('an override naming a manual fail or a non-fail is ignored', () => {
    const manualFail = manual({ outcome: 'fail' });
    const review = automated({ outcome: 'needs-review' });
    const row = run([review], [manualFail, override([manualFail.id, review.id])]);
    expect(row.assets[0]).toMatchObject({ reason: 'manual-fail', overridden: [] });
  });

  it('an expired override counts for nothing', () => {
    const fail = automated({ outcome: 'fail' });
    const stale = override([fail.id], { expiresOnChangeOf: OLD });
    const row = run([fail], [stale]);
    expect(row.level).toBe('Does Not Support');
    expect(row.assets[0]).toMatchObject({
      reason: 'automated-fail',
      overridden: [],
      expired: [stale.id],
    });
  });

  it('an override record on a manual fail is ignored', () => {
    const fail = automated({ outcome: 'fail' });
    const bad = invalid(manual({ outcome: 'fail', notes: 'x' }), (f) => ({
      ...f,
      review: { ...(f.review as Loose), overrides: [fail.id] },
    }));
    expect(FindingSchema.safeParse(bad).success).toBe(false);
    const row = run([fail], [bad]);
    expect(row.assets[0]).toMatchObject({ reason: 'automated-fail', overridden: [] });
  });

  it('an override sets aside a fail on 4.1.1 the errata basis would otherwise lose to', () => {
    const fail = automated({ outcome: 'fail', wcag: ['4.1.1'], ruleId: 'duplicate-id' });
    const review = override([fail.id], { wcag: ['4.1.1'] });
    const row = criterion(
      rollup({
        findings: [fail],
        reviews: [review],
        profile: wcag21,
        assets: [A],
        errata: errataFrom(loadStandardsData()),
      }),
      'wcag21aa',
      '4.1.1',
    );
    expect(row.level).toBe('Supports');
    expect(row.assets[0]?.reason).toBe('manual-override');
  });

  it('every determination lists overridden, empty by default', () => {
    const result = rollup({ findings: [], reviews: [], profile: s508, assets: [A, naPdf] });
    for (const s of result.standards)
      for (const c of s.criteria)
        for (const d of [...c.assets, ...(c.product ? [c.product] : [])])
          expect(d.overridden, `${s.standard} ${c.id}`).toEqual([]);
  });
});

describe('product-scope items next to an unscanned asset', () => {
  it('stay Not Evaluated even with a manual pass', () => {
    const reviews = [
      manual({ outcome: 'pass', wcag: ['2.1.2'] }),
      manual({ outcome: 'pass', wcag: [], section508: ['302.1'] }),
    ];
    const run = (unscanned: { uri: string; kind: 'web' }[]) =>
      rollup({ findings: [], reviews, profile: s508, assets: [A], unscanned });
    expect(criterion(run([]), '508', '2.1.2').level).toBe('Supports');
    expect(criterion(run([]), '508', '302.1').level).toBe('Supports');
    const result = run([{ uri: B.uri, kind: 'web' }]);
    expect(criterion(result, '508', '2.1.2').level).toBe('Not Evaluated');
    const product = criterion(result, '508', '302.1');
    expect(product.level).toBe('Not Evaluated');
    expect(product.reason).toMatch(/1 page or file in scope was not scanned/);
    expect(product.evidence).toEqual([reviews[1]?.id]);
  });
});
