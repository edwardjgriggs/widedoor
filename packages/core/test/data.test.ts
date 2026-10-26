import { describe, expect, it } from 'vitest';
import {
  DATA_FILES,
  DataValidationError,
  PROFILE_IDS,
  getProfile,
  loadStandardsData,
  readRawStandardsData,
  validateStandardsData,
  type RawStandardsData,
} from '../src/index.js';
import { fleschKincaid } from './readability.ts';

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
      [
        'axe',
        'baseline',
        'errata',
        'manualSteps',
        'section508',
        'verapdf',
        'wcag',
        'widedoor',
      ].sort(),
    );
  });

  describe('errata basis', () => {
    it('covers 4.1.1 and no other SC', () => {
      expect(data.errata.criteria.map((c) => c.id)).toEqual(['4.1.1']);
    });

    it('cites the WCAG 2.0 and 2.1 errata with the quoted note, and the VPAT instruction', () => {
      const citations = data.errata.criteria[0]?.citations ?? [];
      const at = (url: string) => citations.find((c) => c.url === url)?.text;
      expect(at('https://www.w3.org/WAI/WCAG20/errata/')).toBe(
        'This criterion should be considered as always satisfied for any content using HTML or XML.',
      );
      expect(at('https://www.w3.org/WAI/WCAG21/errata/')).toBe(
        'This Success Criterion should be considered as always satisfied for any content using HTML or XML.',
      );
      expect(citations.map((c) => c.text)).toContain("Always answer 'Supports'");
      expect(data.errata.meta.sources).toEqual(
        expect.arrayContaining([
          'https://www.w3.org/WAI/WCAG20/errata/',
          'https://www.w3.org/WAI/WCAG21/errata/',
        ]),
      );
    });

    it('rejects an errata basis for any other SC', () => {
      const err = errorOf(() =>
        validateStandardsData(
          mutated((raw) => {
            raw.errata!.criteria.push({ ...raw.errata!.criteria[0], id: '1.1.1' });
          }),
        ),
      );
      expect(err.message).toContain('errata.yaml');
      expect(err.message).toContain('criteria.1.id');
      expect(err.message).toContain('1.1.1');
    });

    it('rejects a duplicate entry and a citation without a url', () => {
      const dup = errorOf(() =>
        validateStandardsData(
          mutated((raw) => {
            raw.errata!.criteria.push(structuredClone(raw.errata!.criteria[0]));
          }),
        ),
      );
      expect(dup.message).toContain('duplicate');
      const noUrl = errorOf(() =>
        validateStandardsData(
          mutated((raw) => {
            delete raw.errata!.criteria[0].citations[0].url;
          }),
        ),
      );
      expect(noUrl.message).toContain('errata.yaml');
    });

    it.each(['http://www.w3.org/WAI/WCAG21/errata/', 'javascript:alert(1)', 'data:text/html,x'])(
      'rejects a citation url that is not https: %s',
      (url) => {
        const err = errorOf(() =>
          validateStandardsData(
            mutated((raw) => {
              raw.errata!.criteria[0].citations[0].url = url;
            }),
          ),
        );
        expect(err.message).toContain('errata.yaml');
        expect(err.message).toContain('citations.0.url');
      },
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

  describe('manual steps', () => {
    const steps = data.manualSteps;
    const wcagEntry = (id: string) => steps.wcag.find((e) => e.id === id);
    const provisionEntry = (id: string) => steps.section508.find((e) => e.id === id);

    it('has steps for every criterion and manual item in every profile view, by asset kind', () => {
      const missing: string[] = [];
      for (const id of PROFILE_IDS) {
        for (const pdfDocumentType of ['non-web', 'web'] as const) {
          const profile = getProfile(id, { pdfDocumentType });
          for (const kind of ['web', 'pdf'] as const) {
            for (const view of profile.assets[kind].standards) {
              for (const c of view.applicable) {
                // An errata criterion always passes, so it never becomes a checklist item.
                if (data.errata.criteria.some((e) => e.id === c.id)) continue;
                if (!wcagEntry(c.id)?.[kind]) missing.push(`${view.standard} ${kind} ${c.id}`);
              }
              for (const m of view.manual) {
                const key = m.scope === 'product' ? 'product' : 'web';
                if (!provisionEntry(m.id)?.[key]) missing.push(`${view.standard} ${key} ${m.id}`);
              }
            }
          }
        }
      }
      expect(missing).toEqual([]);
    });

    it('covers the walkthroughs the plan names', () => {
      for (const sc of ['2.1.1', '2.1.2', '2.4.3', '2.4.7', '1.1.1', '1.2.1', '1.2.2', '1.2.3']) {
        expect(wcagEntry(sc)?.web?.steps.length, sc).toBeGreaterThan(1);
        expect(wcagEntry(sc)?.pdf?.steps.length, sc).toBeGreaterThan(1);
      }
      expect(wcagEntry('1.3.2')?.pdf?.steps.join(' ')).toMatch(/reading order/i);
      const manual = data.section508.provisions.filter((p) => p.manual).map((p) => p.id);
      expect(steps.section508.map((e) => e.id).sort()).toEqual([...manual].sort());
    });

    it('cites Baseline tests of the right baseline that test the criterion', () => {
      const keyboard = wcagEntry('2.1.1');
      expect(keyboard?.web?.baselineTests).toEqual(['1.A-KeyboardAccess']);
      expect(keyboard?.pdf?.baselineTests).toEqual(['1.A-KeyboardAccess']);
      expect(wcagEntry('1.3.2')?.pdf?.baselineTests).toEqual(['18.B-MeaningfulSequence']);
      expect(provisionEntry('503.4.1')?.web?.baselineTests).toEqual(['17.B-MediaPlayerCCLevel']);
    });

    it('keeps every step at Flesch-Kincaid grade 8 or lower', () => {
      const all = [
        ...steps.wcag.flatMap((e) => [e.web, e.pdf]),
        ...steps.section508.flatMap((e) => [e.web, e.product]),
      ].flatMap((s) => s?.steps ?? []);
      expect(all.length).toBeGreaterThan(200);
      const hard = all
        .map((text) => ({ text, grade: Math.round(fleschKincaid(text).grade * 10) / 10 }))
        .filter((s) => s.grade > 8);
      expect(hard).toEqual([]);
    });

    it('rejects a missing entry, naming the file and what is missing', () => {
      const err = errorOf(() =>
        validateStandardsData(
          mutated((raw) => {
            const e = raw.manualSteps!.wcag.find((x: Draft) => x.id === '2.1.1');
            delete e.pdf;
            raw.manualSteps!.section508 = raw.manualSteps!.section508.filter(
              (x: Draft) => x.id !== '302.1',
            );
          }),
        ),
      );
      expect(err.message).toContain('manual-steps.yaml');
      expect(err.message).toContain('no pdf steps for WCAG 2.1.1');
      expect(err.message).toContain('no product steps for 508 302.1');
    });

    it('rejects an unknown, foreign or unrelated Baseline test id', () => {
      const err = errorOf(() =>
        validateStandardsData(
          mutated((raw) => {
            const at = (id: string) => raw.manualSteps!.wcag.find((x: Draft) => x.id === id);
            at('2.1.1').web.baselineTests.push('99.Z-Nothing');
            // 18.A exists only in the document baseline.
            at('1.3.1').web.baselineTests.push('18.A-MeaningfulContent');
            at('1.4.3').pdf.baselineTests.push('1.A-KeyboardAccess');
            at('2.1.2').pdf.baselineTests = [];
          }),
        ),
      );
      expect(err.message).toContain('unknown web Baseline test 99.Z-Nothing');
      expect(err.message).toContain('unknown web Baseline test 18.A-MeaningfulContent');
      expect(err.message).toContain('1.A-KeyboardAccess does not test WCAG 1.4.3');
      expect(err.message).toContain('pdf steps for WCAG 2.1.2 omit 1.B-NoKeyboardTrap');
    });

    it('rejects steps for an unknown criterion, a non-manual provision or the wrong scope', () => {
      const err = errorOf(() =>
        validateStandardsData(
          mutated((raw) => {
            const one = structuredClone(raw.manualSteps!.wcag[0]);
            raw.manualSteps!.wcag.push({ ...one, id: '9.9.9' }, structuredClone(one));
            const product = structuredClone(raw.manualSteps!.section508[0]);
            raw.manualSteps!.section508.push({ ...product, id: 'E205.4' });
            const p = raw.manualSteps!.section508.find((x: Draft) => x.id === '302.2');
            p.web = p.product;
          }),
        ),
      );
      expect(err.message).toContain('unknown SC 9.9.9');
      expect(err.message).toContain('duplicate entry 1.1.1');
      expect(err.message).toContain('E205.4 is not a manual item');
      expect(err.message).toContain('302.2 is product-scope: no web steps');
    });
  });
});
