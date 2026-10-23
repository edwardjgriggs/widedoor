import { describe, expect, it } from 'vitest';
import {
  DATA_FILES,
  DataValidationError,
  loadStandardsData,
  readRawStandardsData,
  validateStandardsData,
  type RawStandardsData,
} from '../src/index.js';

type Draft = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function mutated(edit: (raw: Record<string, Draft>) => void): RawStandardsData {
  const raw = structuredClone(readRawStandardsData()) as unknown as Record<string, Draft>;
  edit(raw);
  return raw as unknown as RawStandardsData;
}

function errorOf(fn: () => unknown): DataValidationError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DataValidationError) return e;
    throw e;
  }
  throw new Error('expected a DataValidationError');
}

describe('standards data loader', () => {
  const data = loadStandardsData();
  const knownSc = new Set(data.wcag.criteria.map((c) => c.id));

  it('loads and validates every data file', () => {
    expect(Object.keys(DATA_FILES).sort()).toEqual(
      ['axe', 'baseline', 'section508', 'verapdf', 'wcag', 'widedoor'].sort(),
    );
  });

  it('has 38 WCAG 2.0 and 12 WCAG 2.1 A/AA success criteria', () => {
    const by = (v: string) => data.wcag.criteria.filter((c) => c.version === v).length;
    expect(by('2.0')).toBe(38);
    expect(by('2.1')).toBe(12);
    expect(data.wcag.criteria).toHaveLength(50);
  });

  it('every engine rule maps to at least one known SC', () => {
    const rules = [
      ...data.axe.rules.map((r) => ['axe-core', r.id, r.wcag] as const),
      ...data.verapdf.rules.map((r) => ['verapdf', r.id, r.wcag] as const),
      ...data.widedoor.rules.map((r) => ['widedoor', r.id, r.wcag] as const),
    ];
    expect(rules.length).toBeGreaterThan(0);
    for (const [engine, id, wcag] of rules) {
      expect(wcag.length, `${engine} ${id}`).toBeGreaterThan(0);
      for (const sc of wcag) expect(knownSc.has(sc), `${engine} ${id} -> ${sc}`).toBe(true);
    }
  });

  it('covers every rule of the pinned PDF/UA-1 profile, mapped or unmapped with a reason', () => {
    expect(data.verapdf.rules.length + data.verapdf.unmapped.length).toBe(106);
    for (const u of data.verapdf.unmapped) expect(u.reason.length).toBeGreaterThan(10);
  });

  it('keeps every decides flag false in Phase 0', () => {
    const all = [...data.axe.rules, ...data.verapdf.rules, ...data.widedoor.rules];
    expect(all.filter((r) => r.decides)).toEqual([]);
  });

  it('includes the four Widedoor PDF checks and the three PDF review items', () => {
    expect(data.widedoor.rules.map((r) => r.id).sort()).toEqual(
      [
        'pdf-alt-text-quality',
        'pdf-bookmarks',
        'pdf-image-only',
        'pdf-language',
        'pdf-reading-order',
        'pdf-table-logic',
        'pdf-title-displayed',
      ].sort(),
    );
  });

  it('records the ICT Testing Baseline commit and both baselines', () => {
    expect(data.baseline.meta.commit).toMatch(/^[0-9a-f]{40}$/);
    const count = (b: string) => data.baseline.tests.filter((t) => t.baseline === b).length;
    expect(count('web')).toBe(62);
    expect(count('document')).toBe(57);
  });

  it('records E205.4 exceptions for non-web documents', () => {
    const e2054 = data.section508.provisions.find((p) => p.id === 'E205.4');
    expect(e2054?.exceptions?.[0]?.criteria).toEqual(['2.4.1', '2.4.5', '3.2.3', '3.2.4']);
  });

  it('records 501.1 and its web application exception from 502 and 503', () => {
    const p = data.section508.provisions.find((x) => x.id === '501.1');
    const e = p?.exceptions?.[0];
    expect(e?.appliesTo).toBe('web-application-without-platform-services');
    expect(e?.provisions).toEqual(['502', '503']);
    expect(e?.text).toContain('shall not be required to conform to 502 or 503');
  });

  it('maps the veraPDF rules that block assistive technology access', () => {
    const wcagOf = (id: string) => data.verapdf.rules.find((r) => r.id === id)?.wcag;
    expect(wcagOf('7.16-1')).toEqual(['1.3.1', '4.1.2']);
    expect(wcagOf('7.21.7-1')).toEqual(['1.1.1', '1.3.1']);
    expect(wcagOf('7.21.7-2')).toEqual(['1.1.1', '1.3.1']);
    expect(wcagOf('7.15-1')).toEqual(['1.3.1', '4.1.2']);
    expect(wcagOf('7.20-1')).toEqual(['1.3.1']);
  });

  it('rejects a web-scope manual item without a condition', () => {
    const err = errorOf(() =>
      validateStandardsData(
        mutated((raw) => {
          const p = raw.section508!.provisions.find((x: Draft) => x.id === '503.2');
          delete p.manual.condition;
        }),
      ),
    );
    expect(err.message).toContain('section508.yaml');
    expect(err.message).toContain('503.2 needs a condition');
  });

  it('rejects a condition citing an unknown provision', () => {
    const err = errorOf(() =>
      validateStandardsData(
        mutated((raw) => {
          const p = raw.section508!.provisions.find((x: Draft) => x.id === '503.2');
          p.manual.condition.provision = '599.9';
        }),
      ),
    );
    expect(err.message).toContain('unknown provision 599.9');
  });

  it('rejects an unknown SC reference, naming the file and path', () => {
    const err = errorOf(() =>
      validateStandardsData(
        mutated((raw) => {
          raw.axe!.rules[0].wcag = ['9.9.9'];
        }),
      ),
    );
    expect(err.message).toContain('axe-map.yaml');
    expect(err.message).toContain('rules.0.wcag.0');
    expect(err.message).toContain('9.9.9');
  });

  it('rejects an unknown 508 provision reference', () => {
    const err = errorOf(() =>
      validateStandardsData(
        mutated((raw) => {
          raw.baseline!.tests[0].section508 = ['999.9'];
        }),
      ),
    );
    expect(err.message).toContain('baseline.yaml');
    expect(err.message).toContain('999.9');
  });

  it('rejects a bad level', () => {
    const err = errorOf(() =>
      validateStandardsData(
        mutated((raw) => {
          raw.wcag!.criteria[0].level = 'AAA';
        }),
      ),
    );
    expect(err.message).toContain('wcag.yaml');
    expect(err.message).toContain('criteria.0.level');
  });

  it('rejects an unknown key', () => {
    const err = errorOf(() =>
      validateStandardsData(
        mutated((raw) => {
          raw.widedoor!.rules[0].colour = 'red';
        }),
      ),
    );
    expect(err.message).toContain('widedoor-map.yaml');
    expect(err.message).toContain('colour');
  });

  it('rates whole-document failures critical and element-level ones serious', () => {
    const impact = (id: string) => data.verapdf.rules.find((r) => r.id === id)?.impact;
    expect(['6.2-1', '7.1-11', '7.16-1'].map(impact)).toEqual(['critical', 'critical', 'critical']);
    expect(['7.1-12', '7.20-2', '7.1-3'].map(impact)).toEqual(['serious', 'serious', 'serious']);
  });

  it('requires a valid default impact on every veraPDF and Widedoor rule', () => {
    for (const r of [...data.verapdf.rules, ...data.widedoor.rules])
      expect(['critical', 'serious', 'moderate', 'minor'], r.id).toContain(r.impact);
    const missing = errorOf(() =>
      validateStandardsData(
        mutated((raw) => {
          delete raw.verapdf!.rules[0].impact;
        }),
      ),
    );
    expect(missing.message).toContain('verapdf-map.yaml');
    const wrong = errorOf(() =>
      validateStandardsData(
        mutated((raw) => {
          raw.widedoor!.rules[0].impact = 'severe';
        }),
      ),
    );
    expect(wrong.message).toContain('widedoor-map.yaml');
  });

  it('rejects a veraPDF id that does not match clause and testNumber', () => {
    const err = errorOf(() =>
      validateStandardsData(
        mutated((raw) => {
          raw.verapdf!.rules[0].testNumber = 99;
        }),
      ),
    );
    expect(err.message).toContain('verapdf-map.yaml');
  });
});
