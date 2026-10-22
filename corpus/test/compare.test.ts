import { describe, expect, it } from 'vitest';
import {
  actAgreement,
  aggregate,
  compareExact,
  type ExpectedEntry,
  type Outcome,
} from '../scripts/lib/corpus.ts';

const axe = (ruleId: string, outcome: Outcome): ExpectedEntry => ({
  engine: 'axe-core',
  ruleId,
  outcome,
});

describe('compareExact', () => {
  const expected = [axe('label', 'fail'), axe('image-alt', 'pass')];

  it('matches when findings are equal and expected passes are present', () => {
    const actual = [axe('label', 'fail'), axe('image-alt', 'pass'), axe('region', 'pass')];
    expect(compareExact('axe-core', expected, actual)).toEqual({ missing: [], unexpected: [] });
  });

  it('reports an extra fail and an extra needs-review as unexpected', () => {
    const actual = [...expected, axe('bypass', 'fail'), axe('color-contrast', 'needs-review')];
    expect(compareExact('axe-core', expected, actual).unexpected).toEqual([
      'axe-core bypass fail',
      'axe-core color-contrast needs-review',
    ]);
  });

  it('ignores extra passes and not-applicable results', () => {
    const actual = [...expected, axe('bypass', 'pass'), axe('list', 'not-applicable')];
    expect(compareExact('axe-core', expected, actual)).toEqual({ missing: [], unexpected: [] });
  });

  it('reports a missing expected fail and a missing expected pass', () => {
    expect(compareExact('axe-core', expected, [])).toEqual({
      missing: ['axe-core label fail', 'axe-core image-alt pass'],
      unexpected: [],
    });
  });

  it('treats needs-review and fail as different outcomes', () => {
    const actual = [axe('label', 'needs-review'), axe('image-alt', 'pass')];
    expect(compareExact('axe-core', expected, actual)).toEqual({
      missing: ['axe-core label fail'],
      unexpected: ['axe-core label needs-review'],
    });
  });

  it('flags a fail on a rule that is expected only to pass', () => {
    const actual = [axe('label', 'fail'), axe('image-alt', 'pass'), axe('image-alt', 'fail')];
    expect(compareExact('axe-core', expected, actual).unexpected).toEqual([
      'axe-core image-alt fail',
    ]);
  });

  it('reports a duplicated unexpected result once', () => {
    const actual = [...expected, axe('bypass', 'fail'), axe('bypass', 'fail')];
    expect(compareExact('axe-core', expected, actual).unexpected).toEqual(['axe-core bypass fail']);
  });

  it('skips provisional entries and other engines', () => {
    const mixed: ExpectedEntry[] = [
      ...expected,
      { engine: 'widedoor', ruleId: 'pdf-language', outcome: 'fail', provisional: true },
      { engine: 'verapdf', ruleId: '7.1-8', outcome: 'fail' },
    ];
    const actual = [
      ...expected,
      { engine: 'verapdf' as const, ruleId: '7.3-1', outcome: 'fail' as const },
    ];
    expect(compareExact('axe-core', mixed, actual)).toEqual({ missing: [], unexpected: [] });
  });

  it('treats empty lists as a match', () => {
    expect(compareExact('axe-core', [], [])).toEqual({ missing: [], unexpected: [] });
  });
});

describe('aggregate', () => {
  it('ranks fail over needs-review over pass over not-applicable', () => {
    expect(aggregate(['not-applicable', 'pass', 'needs-review', 'fail'])).toBe('fail');
    expect(aggregate(['not-applicable', 'pass', 'needs-review'])).toBe('needs-review');
    expect(aggregate(['not-applicable', 'pass'])).toBe('pass');
    expect(aggregate(['not-applicable'])).toBe('not-applicable');
  });

  it('gives not-tested for no results', () => {
    expect(aggregate([])).toBe('not-tested');
  });
});

describe('actAgreement', () => {
  const inapplicable = [axe('label', 'not-applicable'), axe('select-name', 'not-applicable')];

  it('agrees when every mapped rule ran and the aggregate matches', () => {
    const actual = [axe('label', 'not-applicable'), axe('select-name', 'not-applicable')];
    expect(actAgreement(inapplicable, actual).ok).toBe(true);
  });

  it('never agrees when a mapped rule did not run', () => {
    const result = actAgreement(inapplicable, [axe('label', 'not-applicable')]);
    expect(result).toMatchObject({ ok: false, got: 'not-tested', notRun: ['select-name'] });
  });

  it('never agrees when no mapped rule ran, even for an inapplicable case', () => {
    const result = actAgreement([axe('audio-caption', 'not-applicable')], [axe('label', 'pass')]);
    expect(result).toMatchObject({ ok: false, got: 'not-tested', notRun: ['audio-caption'] });
  });

  it('uses the aggregate across mapped rules', () => {
    const failed = [axe('label', 'fail'), axe('select-name', 'fail')];
    const actual = [axe('label', 'not-applicable'), axe('select-name', 'fail')];
    expect(actAgreement(failed, actual)).toMatchObject({ ok: true, got: 'fail' });
    expect(actAgreement(inapplicable, actual)).toMatchObject({ ok: false, got: 'fail' });
  });
});
