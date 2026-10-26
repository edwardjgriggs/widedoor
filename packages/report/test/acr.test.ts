import { describe, expect, it } from 'vitest';
import type { Asset } from '@widedoor/core';
import {
  ACR_TERM_IDS,
  MAX_ACR_FINDINGS,
  SUPPORT_DOCS_NOTE,
  buildAcr,
  isAcrDate,
  type Acr,
  type AcrComponent,
  type AcrRow,
} from '../src/index.ts';
import {
  HOSTILE_META,
  NONCHARACTERS_SAFE,
  META,
  PAGE,
  PAGE2,
  PDF,
  acrReport,
  automated,
  decidedReport,
  manual,
  passEverything,
} from './acr-fixture.ts';
import { PAYLOAD } from './fixture.ts';

const rows = (acr: Acr): AcrRow[] => acr.tables.flatMap((t) => t.rows);
const row = (acr: Acr, id: string): AcrRow => {
  const found = rows(acr).find((r) => r.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};
const cell = (acr: Acr, id: string, component: string): AcrComponent => {
  const found = row(acr, id).components.find((c) => c.id === component);
  if (!found) throw new Error(`no ${component} cell in row ${id}`);
  return found;
};

describe('buildAcr layout', () => {
  const acr = buildAcr(acrReport(), META);

  it('reports WCAG 2.0 Tables 1 and 2 and Chapters 3, 5 and 6, in catalog order', () => {
    expect(acr.edition).toBe('VPAT 2.5Rev 508');
    expect(acr.catalog).toBe('2.5-edition-wcag-2.0-508-en');
    expect(acr.tables.map((t) => [t.id, t.standard])).toEqual([
      ['success_criteria_level_a', 'wcag-2.0'],
      ['success_criteria_level_aa', 'wcag-2.0'],
      ['functional_performance_criteria', '508'],
      ['software', '508'],
      ['support_documentation_and_services', '508'],
    ]);
    expect(acr.tables[0]?.label).toBe('Table 1: Success Criteria, Level A');
    expect(acr.tables[0]?.rows[0]).toMatchObject({ id: '1.1.1', title: 'Non-text Content' });
    expect(acr.tables[1]?.rows.map((r) => r.id)).toContain('1.4.3');
    // WCAG 2.1 criteria are not in the 508 edition.
    expect(rows(acr).map((r) => r.id)).not.toContain('1.3.4');
    expect(acr.tables[2]?.rows.map((r) => r.id)).toEqual([
      '302.1',
      '302.2',
      '302.3',
      '302.4',
      '302.5',
      '302.6',
      '302.7',
      '302.8',
      '302.9',
    ]);
    expect(acr.tables[4]?.rows.map((r) => r.id)).toEqual([
      '602.2',
      '602.3',
      '602.4',
      '603.2',
      '603.3',
    ]);
  });

  it('leaves out Level AAA and Chapter 4 with a reason each', () => {
    expect(acr.omitted.map((o) => o.id)).toEqual(['success_criteria_level_aaa', 'hardware']);
    expect(acr.omitted[1]?.label).toBe('Chapter 4: Hardware');
    expect(acr.omitted[1]?.reason).toMatch(/not hardware/);
    expect(acr.omitted[0]?.reason).toMatch(/Level AAA/);
  });

  it('gives WCAG rows a Web and an Electronic Documents cell, and 508 rows one cell', () => {
    expect(row(acr, '1.1.1').components.map((c) => [c.id, c.label])).toEqual([
      ['web', 'Web'],
      ['electronic-docs', 'Electronic Documents'],
    ]);
    expect(row(acr, '302.1').components.map((c) => c.id)).toEqual(['none']);
    expect(row(acr, '502.2.1').components.map((c) => c.id)).toEqual(['none']);
    expect(acr.notes.join(' ')).toMatch(/Software and Authoring Tool columns are left out/);
  });

  it('notes 502.3 and 503.4, heading rows in the template, in their chapter with the roll-up reading', () => {
    const software = acr.tables.find((t) => t.id === 'software');
    expect(rows(acr).map((r) => r.id)).not.toContain('502.3');
    const notes = software?.notes.join(' ');
    expect(notes).toMatch(
      /Section 508 502\.3 Accessibility Services is a heading row in the template \(no response required\); the roll-up reads Not Evaluated: /,
    );
    expect(notes).toMatch(/503\.4 .* is a heading row in the template \(no response required\)/);
    expect(notes).not.toMatch(/has no row/);
  });

  it('opens Chapter 5 with 501.1, answered in the WCAG tables, never a verdict', () => {
    const software = acr.tables.find((t) => t.id === 'software');
    expect(software?.rows[0]).toEqual({
      id: '501.1',
      title: 'Scope - Incorporation of WCAG 2.0 AA',
      components: [],
      reference: {
        conformance: 'See WCAG 2.x section',
        remarks: 'See information in WCAG 2.x section',
        note: `501.1 Scope - Incorporation of WCAG 2.0 AA is answered in Tables 1 and 2 (the template's cells read "See WCAG 2.x section"), so it has no criterion entry here.`,
      },
    });
    // No Chapter 5 when no web page was scanned, so no 501.1 either.
    const pdfOnly = buildAcr(acrReport({ assets: [PDF] }), META);
    expect(rows(pdfOnly).map((r) => r.id)).not.toContain('501.1');
  });

  it('answers 504.2 and 602.3 in the WCAG tables, as the template does', () => {
    for (const id of ['504.2', '602.3']) {
      const r = row(acr, id);
      expect(r.components, id).toEqual([]);
      expect(r.reference?.conformance, id).toBe('See WCAG 2.x section');
      expect(r.reference?.remarks, id).toBe('See information in WCAG 2.x section');
    }
    expect(row(acr, '504.2').title).toBe('Content Creation or Editing');
  });

  it('shows 504.2 Not Applicable when a reviewer recorded that the product is not an authoring tool', () => {
    const na = manual(PAGE, { type: 'section508', id: '504.2' }, 'not-applicable', {
      notes: 'The portal is not an authoring tool (504.1).',
    });
    const r = row(buildAcr(acrReport({ reviews: [na] }), META), '504.2');
    expect(r.reference).toBeUndefined();
    expect(r.components.map((c) => c.level)).toEqual(['Not Applicable']);
    expect(r.components[0]?.remarks).toMatch(/Condition \(504\.1\): /);
  });

  it('keeps a result a reviewer recorded for 504.2 or 602.3 in the remarks, not as the row level', () => {
    const fail = manual(PAGE, { type: 'section508', id: '602.3' }, 'fail', {
      notes: 'The help pages have no headings.',
    });
    const r = row(buildAcr(acrReport({ reviews: [fail] }), META), '602.3');
    expect(r.components).toEqual([]);
    expect(r.reference?.conformance).toBe('See WCAG 2.x section');
    expect(r.reference?.remarks).toMatch(
      /^See information in WCAG 2\.x section\. A result is also on record for this row, Does Not Support: Judged for the product as a whole: /,
    );
    expect(r.reference?.remarks).toContain(
      'A reviewer recorded a fail on https://example.com/apply: The help pages have no headings.',
    );
    expect(r.reference?.note).toContain(
      'A result is also on record for this row, Does Not Support',
    );
  });

  it('lists the records on an undecided 504.2 in its remarks, with no level', () => {
    const na = manual(PAGE, { type: 'section508', id: '504.2' }, 'not-applicable', {
      notes: 'Not an authoring tool (504.1).',
    });
    const report = acrReport({ assets: [PAGE, PAGE2, PDF], reviews: [na] });
    const view = report.rollup.standards.find((s) => s.standard === '508');
    // N/A on one page of two decides nothing for the other.
    expect(view?.criteria.find((c) => c.id === '504.2')?.level).toBe('Not Evaluated');
    const r = row(buildAcr(report, META), '504.2');
    expect(r.components).toEqual([]);
    expect(r.reference?.conformance).toBe('See WCAG 2.x section');
    const recorded =
      'Recorded for this row so far; the roll-up leaves it undecided: the 1 applicable asset has no deciding result. A reviewer recorded not applicable on https://example.com/apply: Not an authoring tool (504.1).';
    expect(r.reference?.remarks).toBe(`See information in WCAG 2.x section. ${recorded}`);
    expect(r.reference?.note.endsWith(`so it has no criterion entry here. ${recorded}`)).toBe(true);
    expect(r.reference?.remarks).not.toMatch(/Not Applicable|Supports/);
  });

  it('notes that 602.3 covers only the support documentation scanned', () => {
    expect(acr.notes).toContain(SUPPORT_DOCS_NOTE);
    expect(SUPPORT_DOCS_NOTE).toMatch(/only where it was among the pages and files scanned/);
  });

  it('takes row titles from the catalog, which has the template wording', () => {
    expect(row(acr, '1.4.4').title).toBe('Resize text');
    expect(row(acr, '1.1.1').title).toBe('Non-text Content');
    expect(row(acr, '302.1').title).toBe('Without Vision');
  });

  it('maps every level to its catalog term id', () => {
    for (const c of rows(acr).flatMap((r) => r.components))
      expect(c.term).toBe(ACR_TERM_IDS[c.level]);
    expect(Object.values(ACR_TERM_IDS)).toEqual([
      'supports',
      'partially-supports',
      'does-not-support',
      'not-applicable',
      'not-evaluated',
    ]);
  });

  it('applies the E205.4 exception to the PDF cell only', () => {
    const docs = cell(acr, '2.4.1', 'electronic-docs');
    expect(docs.level).toBe('Not Applicable');
    expect(docs.remarks).toMatch(/Not applicable to 1 PDF under E205\.4: Non-Web documents/);
    expect(cell(acr, '2.4.1', 'web').level).toBe('Not Evaluated');
  });

  it('omits the Software chapter and the Web column when no web page was in scope', () => {
    const pdfOnly = buildAcr(acrReport({ assets: [PDF] }), META);
    expect(pdfOnly.tables.map((t) => t.id)).not.toContain('software');
    expect(pdfOnly.omitted.find((o) => o.id === 'software')?.reason).toMatch(
      /a PDF is not software/,
    );
    expect(row(pdfOnly, '1.1.1').components.map((c) => c.id)).toEqual(['electronic-docs']);
    expect(pdfOnly.notes.join(' ')).toMatch(
      /No web page was in scope, so the WCAG tables have no Web column/,
    );
  });
});

describe('buildAcr levels and remarks', () => {
  it('reads 4.1.1 as Supports with the errata citation in the remarks', () => {
    const acr = buildAcr(acrReport(), META);
    for (const id of ['web', 'electronic-docs']) {
      const c = cell(acr, '4.1.1', id);
      expect(c.level).toBe('Supports');
      expect(c.term).toBe('supports');
      expect(c.remarks).toMatch(/1 asset passes on the errata basis, not on a test/);
      expect(c.remarks).toContain('https://www.w3.org/WAI/WCAG20/errata/');
      expect(c.remarks).toContain("Always answer 'Supports'");
    }
  });

  it('never reads Supports without a deciding result: an untested criterion is Not Evaluated', () => {
    const acr = buildAcr(acrReport(), META);
    expect(cell(acr, '1.3.1', 'web').level).toBe('Not Evaluated');
    expect(cell(acr, '302.1', 'none').level).toBe('Not Evaluated');
    const supports = rows(acr)
      .flatMap((r) => r.components.map((c) => [r.id, c.level]))
      .filter(([, level]) => level === 'Supports')
      .map(([id]) => id);
    expect([...new Set(supports)]).toEqual(['4.1.1']);
  });

  it('levels each column from its own assets, with the failing finding text', () => {
    const fail = automated(PAGE, { selector: 'img.hero' }, 'axe-core', 'image-alt', {
      impact: 'critical',
    });
    const acr = buildAcr(
      acrReport({
        findings: [fail],
        reviews: [manual(PDF, { type: 'wcag', id: '1.1.1' }, 'pass')],
      }),
      META,
    );
    const web = cell(acr, '1.1.1', 'web');
    expect(web.level).toBe('Does Not Support');
    expect(web.remarks).toMatch(/^The 1 applicable asset fails\./);
    expect(web.remarks).toContain(
      'Fails on https://example.com/apply (axe-core image-alt; Element: img.hero): An image has no text alternative.',
    );
    const docs = cell(acr, '1.1.1', 'electronic-docs');
    expect(docs.level).toBe('Supports');
    expect(docs.remarks).toBe('The 1 applicable asset passes.');
  });

  it('words the remarks in the singular for one asset and the plural for more', () => {
    const pdfs = ['a', 'c', 'd'].map((c): Asset => ({
      kind: 'pdf',
      uri: `docs/${c}.pdf`,
      contentHash: `sha256:${c.repeat(64)}`,
    }));
    const reviews = (assets: readonly Asset[]) =>
      assets.map((a) => manual(a, { type: 'wcag', id: '1.1.1' }, 'pass'));
    const one = buildAcr(acrReport({ assets: [PDF], reviews: reviews([PDF]) }), META);
    expect(cell(one, '1.1.1', 'electronic-docs').remarks).toBe('The 1 applicable asset passes.');
    const three = buildAcr(acrReport({ assets: pdfs, reviews: reviews(pdfs) }), META);
    expect(cell(three, '1.1.1', 'electronic-docs').remarks).toBe('All 3 applicable assets pass.');
    // A product-scope row is judged on one unit.
    expect(cell(buildAcr(decidedReport(), META), '602.2', 'none').remarks).toBe(
      'Judged for the product as a whole: the 1 applicable asset passes.',
    );
  });

  it('throws when a row level does not follow from its assets, never writing it as is', () => {
    const fail = automated(PAGE, { selector: 'img' }, 'axe-core', 'image-alt', {
      impact: 'critical',
    });
    const report = acrReport({ findings: [fail] });
    const forged = structuredClone(report);
    const row = forged.rollup.standards
      .find((s) => s.standard === '508')
      ?.criteria.find((c) => c.type === 'wcag' && c.id === '1.1.1');
    if (!row) throw new Error('no 1.1.1 row');
    expect(row.assets.some((d) => d.state === 'fail')).toBe(true);
    row.level = 'Supports';
    expect(() => buildAcr(forged, META)).toThrow(
      /criterion 1\.1\.1: the roll-up level Supports does not follow from its assets \(Does Not Support\)/,
    );
    expect(() => buildAcr(report, META)).not.toThrow();
  });

  it('caps the listed findings at 20 per cell and counts the rest', () => {
    const fails = Array.from({ length: MAX_ACR_FINDINGS + 3 }, (_, i) =>
      automated(PAGE, { selector: `img.n${i}` }, 'axe-core', 'image-alt', { impact: 'critical' }),
    );
    const remarks = cell(buildAcr(acrReport({ findings: fails }), META), '1.1.1', 'web').remarks;
    expect(remarks.match(/Fails on /g)).toHaveLength(MAX_ACR_FINDINGS);
    expect(remarks).toMatch(/And 3 more\.$/);
  });

  it('names the automated fails a reviewer set aside, and does not list them as failures', () => {
    const fail = automated(PAGE, { selector: 'img.hero' }, 'axe-core', 'image-alt', {
      impact: 'critical',
    });
    const override = manual(PAGE, { type: 'wcag', id: '1.1.1' }, 'pass', {
      notes: 'The image is decorative.',
      overrides: [fail.id],
    });
    const web = cell(
      buildAcr(acrReport({ findings: [fail], reviews: [override] }), META),
      '1.1.1',
      'web',
    );
    expect(web.level).toBe('Supports');
    expect(web.remarks).toContain(
      `Automated fails a reviewer set aside as false positives: ${fail.id}.`,
    );
    expect(web.remarks).not.toContain('Fails on');
  });

  it('lists a manual fail on a product item with the reviewer notes, made safe', () => {
    const fail = manual(PAGE, { type: 'section508', id: '602.2' }, 'fail', {
      notes: `The help pages have no headings.\u001b[2J ${PAYLOAD}`,
    });
    const c = cell(buildAcr(acrReport({ reviews: [fail] }), META), '602.2', 'none');
    expect(c.level).toBe('Does Not Support');
    expect(c.remarks).toMatch(/^Judged for the product as a whole: /);
    expect(c.remarks).toContain(
      'A reviewer recorded a fail on https://example.com/apply: The help pages have no headings.\\x1b[2J',
    );
    expect(c.remarks).not.toContain('\u001b');
  });

  it('gives Chapter 5 rows their condition', () => {
    const c = cell(buildAcr(acrReport(), META), '502.3.1', 'none');
    expect(c.remarks).toMatch(/Condition \(501\.1\): /);
  });
});

describe('buildAcr completeness', () => {
  it('is complete when every row is decided, the scope is whole and the metadata is set', () => {
    const acr = buildAcr(decidedReport(), META);
    expect(acr.incomplete).toEqual([]);
    expect(acr.complete).toBe(true);
    expect(
      rows(acr).every((r) =>
        r.components.every((c) => c.level === 'Supports' || c.level === 'Not Applicable'),
      ),
    ).toBe(true);
  });

  it('is complete with 504.2 and 602.3 left Not Evaluated: the WCAG tables answer them', () => {
    const left = new Set(['504.2', '602.3']);
    const reviews = passEverything().filter(
      (f) => !(f.criteria.section508 ?? []).some((id) => left.has(id)),
    );
    const report = acrReport({ reviews });
    const view = report.rollup.standards.find((s) => s.standard === '508');
    for (const id of left)
      expect(view?.criteria.find((c) => c.id === id)?.level, id).toBe('Not Evaluated');
    const acr = buildAcr(report, META);
    expect(acr.incomplete).toEqual([]);
    expect(acr.undecided).toBe(0);
    expect(acr.complete).toBe(true);
    for (const id of left)
      expect(row(acr, id).reference?.remarks, id).toBe('See information in WCAG 2.x section');
  });

  it('counts the Not Evaluated criteria, never a reference row', () => {
    const acr = buildAcr(acrReport(), META);
    expect(acr.complete).toBe(false);
    const n = rows(acr).filter((r) => r.components.some((c) => c.level === 'Not Evaluated')).length;
    expect(n).toBeGreaterThan(1);
    // 501.1, 504.2 and 602.3 are reference rows, with no level: none of them counts.
    expect(rows(acr).flatMap((r) => (r.reference ? [r.id] : []))).toEqual([
      '501.1',
      '504.2',
      '602.3',
    ]);
    expect(acr.undecided).toBe(n);
    expect(acr.incomplete).toEqual([`${n} criteria are Not Evaluated`]);
    expect(buildAcr(decidedReport(), META).undecided).toBe(0);
  });

  it('is not complete with a scope gap, and says so', () => {
    const gap = 'the sitemap was read in part';
    const acr = buildAcr(decidedReport({ scopeGaps: [gap] }), META);
    expect(acr.complete).toBe(false);
    expect(acr.incomplete).toContain(`the scope is incomplete: ${gap}`);
    // The gap caps every Supports of the roll-up, and so of the ACR.
    expect(cell(acr, '1.1.1', 'web').level).toBe('Not Evaluated');
    expect(cell(acr, '1.1.1', 'web').remarks).toContain(`but the scope is incomplete: ${gap}`);
  });

  it('is not complete with an unscanned page', () => {
    const acr = buildAcr(
      decidedReport({
        webErrors: [{ uri: 'https://example.com/down', code: 'http-error', message: 'HTTP 500' }],
      }),
      META,
    );
    expect(acr.complete).toBe(false);
    expect(acr.incomplete).toContain('1 page or file in scope was not scanned');
  });

  it('lists each metadata key that is not set', () => {
    const acr = buildAcr(decidedReport(), {});
    expect(acr.complete).toBe(false);
    expect(acr.incomplete).toEqual([
      'acr.vendor.name is not set',
      'acr.product.name is not set',
      'acr.product.description is not set',
      'acr.vendor.contact is not set',
    ]);
    const some = buildAcr(decidedReport(), {
      vendor: { name: 'Example Agency' },
      product: { name: 'Permit portal' },
    });
    expect(some.incomplete).toEqual([
      'acr.product.description is not set',
      'acr.vendor.contact is not set',
    ]);
  });

  it('counts a blank metadata value as not set, the same for all four keys', () => {
    const blank = buildAcr(decidedReport(), {
      vendor: { name: ' ', contact: '' },
      product: { name: '\t', description: '' },
    });
    expect(blank.complete).toBe(false);
    expect(blank.incomplete).toEqual([
      'acr.vendor.name is not set',
      'acr.product.name is not set',
      'acr.product.description is not set',
      'acr.vendor.contact is not set',
    ]);
    expect(buildAcr(decidedReport(), META).incomplete).toEqual([]);
  });
});

describe('buildAcr metadata, methods and terms', () => {
  it('takes generated and the default report date from the scan, not the clock', () => {
    const report = acrReport();
    const acr = buildAcr(report, META);
    expect(acr.generated).toBe('2026-10-23T12:05:00.000Z');
    expect(acr.meta.reportDate).toBe('2026-10-23');
    expect(buildAcr(report, { ...META, reportDate: '2026-11-01' }).meta.reportDate).toBe(
      '2026-11-01',
    );
    expect(buildAcr(report, META)).toEqual(acr);
  });

  it('refuses a report date that is not a YYYY-MM-DD date', () => {
    for (const bad of ['2026-02-30', '26-10-23', '2026-10-23T00:00:00Z', 'October 2026'])
      expect(() => buildAcr(acrReport(), { ...META, reportDate: bad }), bad).toThrow(/YYYY-MM-DD/);
    expect(isAcrDate('2028-02-29')).toBe(true);
    expect(isAcrDate('2027-02-29')).toBe(false);
  });

  it('refuses a report with no Section 508 view', () => {
    expect(() => buildAcr(acrReport({ profile: 'wcag21aa' }), META)).toThrow(
      /needs the Section 508 view; profile wcag21aa/,
    );
    expect(() => buildAcr(acrReport({ profile: '508+wcag21aa' }), META)).not.toThrow();
  });

  it('makes every metadata string safe text, keeping line breaks in notes and descriptions', () => {
    const { meta } = buildAcr(acrReport(), HOSTILE_META);
    expect(meta.vendor?.name).toBe(`Evil\\x1b[31m ${PAYLOAD}`);
    expect(meta.vendor?.contact).toBe('x@example.com\\x0akey: injected');
    expect(meta.product?.name).toBe(`Portal\\u202e ${PAYLOAD}`);
    expect(meta.product?.description).toBe(`Line one\nkey: value ${PAYLOAD}${NONCHARACTERS_SAFE}`);
    expect(meta.notes).toBe(`---\nchapters: {}\n${PAYLOAD}\\x07`);
  });

  it('lists the engines, the scope, the profile, the dates and the manual review', () => {
    const acr = buildAcr(
      acrReport({ reviews: [manual(PAGE, { type: 'wcag', id: '2.1.1' }, 'pass')] }),
      META,
    );
    expect(acr.methods).toEqual([
      'Automated checks: axe-core 4.14.0, veraPDF 1.30.3 (docker runner), Widedoor PDF checks 0.0.0.',
      'Scope: 1 web page and 1 PDF scanned.',
      'Profile: 508, with PDFs treated as non-web documents, read through its Section 508 view.',
      'Started 2026-10-23T12:00:00.000Z, finished 2026-10-23T12:05:00.000Z (UTC).',
      'Manual review: 1 current record by 1 reviewer: Ann Lee: 1 record, reviewed 2026-10-23.',
    ]);
    expect(acr.notes[0]).toBe('Generated by Widedoor 0.0.0.');
    expect(acr.disclaimer).toBe(
      'This report documents the testing performed. It is not a certification of conformance.',
    );
  });

  it("states where its terms deviate from the template's", () => {
    const acr = buildAcr(acrReport(), META);
    expect(acr.terms.map((t) => [t.id, t.label, t.deviates])).toEqual([
      ['supports', 'Supports', true],
      ['partially-supports', 'Partially Supports', true],
      ['does-not-support', 'Does Not Support', true],
      ['not-applicable', 'Not Applicable', false],
      ['not-evaluated', 'Not Evaluated', true],
    ]);
    const dns = acr.terms.find((t) => t.id === 'does-not-support');
    expect(dns?.template).toBe(
      'The majority of product functionality does not meet the criterion.',
    );
    expect(dns?.definition).toMatch(/^Every applicable page and file with a deciding result fails/);
    const notes = acr.notes.join(' ');
    expect(notes).toMatch(/terms differ from the template's definitions/);
    expect(notes).toContain(`Does Not Support: ${dns?.definition}`);
    expect(notes).toMatch(/Not Evaluated: .*only for Level AAA/);
  });
});
