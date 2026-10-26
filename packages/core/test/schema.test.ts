import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FindingSchema,
  buildFindingJsonSchema,
  findingId,
  serializeFindingJsonSchema,
  type Finding,
} from '../src/index.js';

const hashA = `sha256:${'a'.repeat(64)}`;
const hashB = `sha256:${'b'.repeat(64)}`;

type Draft = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const webFinding: Draft = {
  schemaVersion: 1,
  id: 'wd_0123456789abcdef',
  asset: { kind: 'web', uri: 'https://example.com/contact', contentHash: hashA },
  location: { selector: 'form#contact > input:nth-of-type(2)' },
  source: {
    engine: 'axe-core',
    engineVersion: '4.11.0',
    ruleId: 'label',
    actRuleId: 'e086e5',
  },
  criteria: { wcag: ['1.3.1', '4.1.2'], section508: ['E205.4', '502.3.1'], baselineTest: '5.A' },
  outcome: 'fail',
  impact: 'critical',
  plain: {
    what: 'This form field has no label.',
    who: 'Screen reader users hear edit text with no idea what to type.',
    fix: 'Add a label element that matches the field id.',
  },
  evidence: { snippet: '<input id="phone" type="tel">', screenshot: 'evidence/wd_x.png' },
};

const pdfFinding: Draft = {
  schemaVersion: 1,
  id: 'wd_fedcba9876543210',
  asset: { kind: 'pdf', uri: 'docs/report.pdf', contentHash: hashA },
  location: { page: 4, structPath: 'Document/Sect[2]/Figure[1]' },
  source: { engine: 'verapdf', engineVersion: '1.28.2', ruleId: '7.1-3' },
  criteria: { section508: ['602.3'] },
  outcome: 'fail',
};

const manualFinding: Draft = {
  ...webFinding,
  source: { engine: 'manual', engineVersion: '0.1.0', ruleId: 'keyboard-trap' },
  criteria: { wcag: ['2.1.2'] },
  outcome: 'pass',
  review: {
    reviewer: 'Edward Griggs',
    date: '2026-10-21',
    notes: 'Tabbed through the whole page.',
    expiresOnChangeOf: hashB,
  },
};

function mutate(base: Draft, fn: (draft: Draft) => void): Draft {
  const draft = structuredClone(base);
  fn(draft);
  return draft;
}

describe('FindingSchema valid records', () => {
  it('accepts a web finding', () => {
    const parsed: Finding = FindingSchema.parse(webFinding);
    expect(parsed.asset.kind).toBe('web');
  });

  it('accepts a PDF finding with page and structPath', () => {
    expect(FindingSchema.safeParse(pdfFinding).success).toBe(true);
  });

  it('accepts a PDF finding with page only', () => {
    const v = mutate(pdfFinding, (d) => (d.location = { page: 1 }));
    expect(FindingSchema.safeParse(v).success).toBe(true);
  });

  it('accepts a PDF finding with an empty location (document level)', () => {
    const v = mutate(pdfFinding, (d) => (d.location = {}));
    expect(FindingSchema.safeParse(v).success).toBe(true);
  });

  it('accepts a manual finding with a review', () => {
    expect(FindingSchema.safeParse(manualFinding).success).toBe(true);
  });

  it('accepts an asset with a review hash', () => {
    const v = mutate(webFinding, (d) => (d.asset.reviewHash = hashB));
    expect(FindingSchema.safeParse(v).success).toBe(true);
  });

  it('accepts a manual pass with overrides and attachments', () => {
    const v = mutate(manualFinding, (d) => {
      d.review.overrides = ['wd_0123456789abcdef'];
      d.review.attachments = ['attachments/keyboard.png'];
    });
    expect(FindingSchema.safeParse(v).success).toBe(true);
  });

  it('accepts a finding with only wcag, or only section508', () => {
    const w = mutate(webFinding, (d) => (d.criteria = { wcag: ['1.1.1'] }));
    const s = mutate(webFinding, (d) => (d.criteria = { section508: ['302.1'] }));
    expect(FindingSchema.safeParse(w).success).toBe(true);
    expect(FindingSchema.safeParse(s).success).toBe(true);
  });
});

describe('FindingSchema invalid records', () => {
  const cases: Array<[string, Draft]> = [
    ['bad contentHash', mutate(webFinding, (d) => (d.asset.contentHash = 'sha256:xyz'))],
    [
      'uppercase contentHash',
      mutate(webFinding, (d) => (d.asset.contentHash = `sha256:${'A'.repeat(64)}`)),
    ],
    ['empty uri', mutate(webFinding, (d) => (d.asset.uri = ''))],
    ['unknown asset kind', mutate(webFinding, (d) => (d.asset.kind = 'doc'))],
    ['unknown engine', mutate(webFinding, (d) => (d.source.engine = 'pa11y'))],
    ['empty ruleId', mutate(webFinding, (d) => (d.source.ruleId = ''))],
    ['web without selector', mutate(webFinding, (d) => (d.location = {}))],
    ['web with page', mutate(webFinding, (d) => (d.location = { selector: 'a', page: 2 }))],
    [
      'web with structPath',
      mutate(webFinding, (d) => (d.location = { selector: 'a', structPath: 'Document' })),
    ],
    ['PDF with selector', mutate(pdfFinding, (d) => (d.location = { page: 1, selector: 'a' }))],
    ['PDF page zero', mutate(pdfFinding, (d) => (d.location = { page: 0 }))],
    ['PDF fractional page', mutate(pdfFinding, (d) => (d.location = { page: 1.5 }))],
    ['manual without review', mutate(manualFinding, (d) => delete d.review)],
    ['automated with review', mutate(webFinding, (d) => (d.review = manualFinding['review']))],
    [
      'manual engine on a PDF without review',
      mutate(pdfFinding, (d) => (d.source.engine = 'manual')),
    ],
    ['empty criteria', mutate(webFinding, (d) => (d.criteria = {}))],
    [
      'empty criteria arrays',
      mutate(webFinding, (d) => (d.criteria = { wcag: [], section508: [] })),
    ],
    ['baselineTest only', mutate(webFinding, (d) => (d.criteria = { baselineTest: '5.A' }))],
    ['bad wcag id', mutate(webFinding, (d) => (d.criteria = { wcag: ['1.3'] }))],
    ['unknown extra key', mutate(webFinding, (d) => (d.extra = true))],
    ['unknown nested key', mutate(webFinding, (d) => (d.source.typo = 'x'))],
    ['bad id format', mutate(webFinding, (d) => (d.id = 'wd_xyz'))],
    ['bad id prefix', mutate(webFinding, (d) => (d.id = 'xx_0123456789abcdef'))],
    ['bad date', mutate(manualFinding, (d) => (d.review.date = '2026-13-45'))],
    ['non-ISO date', mutate(manualFinding, (d) => (d.review.date = '10/21/2026'))],
    ['bad expiresOnChangeOf', mutate(manualFinding, (d) => (d.review.expiresOnChangeOf = 'abc'))],
    ['wrong schemaVersion', mutate(webFinding, (d) => (d.schemaVersion = 2))],
    ['missing schemaVersion', mutate(webFinding, (d) => delete d.schemaVersion)],
    ['unknown outcome', mutate(webFinding, (d) => (d.outcome = 'supports'))],
    ['unknown impact', mutate(webFinding, (d) => (d.impact = 'severe'))],
    ['bad reviewHash', mutate(webFinding, (d) => (d.asset.reviewHash = 'sha256:abc'))],
    [
      'manual fail with overrides',
      mutate(manualFinding, (d) => {
        d.outcome = 'fail';
        d.review.overrides = ['wd_0123456789abcdef'];
      }),
    ],
    [
      'manual not-applicable with overrides',
      mutate(manualFinding, (d) => {
        d.outcome = 'not-applicable';
        d.review.overrides = ['wd_0123456789abcdef'];
      }),
    ],
    [
      'PDF manual fail with overrides',
      mutate(pdfFinding, (d) => {
        d.source = { engine: 'manual', engineVersion: '0.1.0', ruleId: 'r' };
        d.review = { ...manualFinding['review'], overrides: ['wd_0123456789abcdef'] };
      }),
    ],
    ['bad override id', mutate(manualFinding, (d) => (d.review.overrides = ['label']))],
    ['empty attachment', mutate(manualFinding, (d) => (d.review.attachments = ['']))],
    [
      'absolute attachment path',
      mutate(manualFinding, (d) => (d.review.attachments = ['/etc/passwd'])),
    ],
    [
      'drive letter attachment path',
      mutate(manualFinding, (d) => (d.review.attachments = ['C:/x.png'])),
    ],
    [
      'attachment path leaving the folder',
      mutate(manualFinding, (d) => (d.review.attachments = ['attachments/../../x.png'])),
    ],
  ];

  it.each(cases)('rejects %s', (_name, value) => {
    expect(FindingSchema.safeParse(value).success).toBe(false);
  });
});

describe('findingId', () => {
  const loc = { page: 4, structPath: 'Document/Sect[2]' };

  it('is stable across calls', () => {
    expect(findingId('a.pdf', loc, 'verapdf', 'r')).toBe(findingId('a.pdf', loc, 'verapdf', 'r'));
  });

  it('ignores key order and undefined fields', () => {
    const reordered = { structPath: 'Document/Sect[2]', page: 4 };
    expect(findingId('a.pdf', reordered, 'verapdf', 'r')).toBe(
      findingId('a.pdf', loc, 'verapdf', 'r'),
    );
    expect(findingId('a.pdf', { ...loc, selector: undefined }, 'verapdf', 'r')).toBe(
      findingId('a.pdf', loc, 'verapdf', 'r'),
    );
  });

  it('differs when any input differs', () => {
    const base = findingId('a.pdf', loc, 'verapdf', 'r');
    expect(findingId('a.pdf', loc, 'verapdf', 'r2')).not.toBe(base);
    expect(findingId('a.pdf', loc, 'widedoor', 'r')).not.toBe(base);
    expect(findingId('b.pdf', loc, 'verapdf', 'r')).not.toBe(base);
    expect(findingId('a.pdf', { page: 5 }, 'verapdf', 'r')).not.toBe(base);
  });

  it('matches a pinned value so the hashing scheme cannot change silently', () => {
    expect(
      findingId(
        'https://example.com/contact',
        { selector: 'form#contact > input' },
        'axe-core',
        'label',
      ),
    ).toBe('wd_542cfcf46ca3f2c5');
  });

  it('produces ids the schema accepts', () => {
    const id = findingId('https://example.com/contact', { selector: 'a' }, 'axe-core', 'label');
    expect(FindingSchema.safeParse({ ...webFinding, id }).success).toBe(true);
  });
});

describe('JSON Schema export', () => {
  it('matches the committed schema/finding.v1.json byte for byte', () => {
    const committed = readFileSync(new URL('../schema/finding.v1.json', import.meta.url), 'utf8');
    expect(serializeFindingJsonSchema()).toBe(committed);
  });

  it('carries an id and title', () => {
    const s = buildFindingJsonSchema();
    expect(s['$id']).toBe('urn:widedoor:schema:finding:v1');
    expect(s['title']).toBe('Widedoor Finding v1');
  });

  it('states that only a manual pass may carry overrides', () => {
    const descriptions: string[] = [];
    const walk = (node: unknown, key?: string): void => {
      if (Array.isArray(node)) node.forEach((n) => walk(n));
      else if (node && typeof node === 'object') {
        const o = node as Record<string, unknown>;
        if (key === 'overrides' && typeof o['description'] === 'string')
          descriptions.push(o['description']);
        for (const [k, v] of Object.entries(o)) walk(v, k);
      }
    };
    walk(buildFindingJsonSchema());
    expect(descriptions.length).toBeGreaterThan(0);
    for (const d of descriptions) expect(d).toMatch(/only on a manual pass/);
  });
});
