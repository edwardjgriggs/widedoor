import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { describe, expect, it } from 'vitest';
import {
  DISCLAIMER,
  SUPPORT_DOCS_NOTE,
  buildAcr,
  loadOpenAcrCatalog,
  renderVpatHtml,
  vpatOutline,
} from '../src/index.ts';
import {
  HOSTILE_META,
  HOSTILE_NOTES_SAFE,
  NONCHARACTERS_SAFE,
  META,
  acrReport,
  decidedReport,
  hostileReferenceReport,
} from './acr-fixture.ts';
import { PAYLOAD } from './fixture.ts';
import { expectInert } from './inert.ts';
import { REVIEWER, reviewFixtureReport } from './review-fixture.ts';

/*
 * The ACR as HTML in the VPAT® 2.5Rev Revised Section 508 layout: the title
 * block and the VPAT® name for a complete ACR only, the draft banner, the
 * template's section order, the cells, and escaping. The axe check of the
 * same file is in vpat.browser.test.ts.
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const isElement = (n: Node): n is Element => 'tagName' in n;

function textOf(node: Node): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  if (isElement(node) && node.tagName === 'br') return '\n';
  return 'childNodes' in node ? node.childNodes.map(textOf).join('') : '';
}

function elements(node: Node, test: (e: Element) => boolean): Element[] {
  const found: Element[] = [];
  const visit = (n: Node) => {
    if (isElement(n) && test(n)) found.push(n);
    if ('childNodes' in n) n.childNodes.forEach(visit);
  };
  visit(node);
  return found;
}

const tagged = (doc: Node, ...tags: string[]) => elements(doc, (e) => tags.includes(e.tagName));
const attr = (e: Element, name: string) => e.attrs.find((a) => a.name === name)?.value;

/** Headings and field labels in document order, as "h2 Notes" or "label Report Date:". */
const outline = (doc: Node) =>
  elements(
    doc,
    (e) =>
      ['h1', 'h2', 'h3'].includes(e.tagName) ||
      (e.tagName === 'span' && attr(e, 'class') === 'label'),
  ).map((e) => `${e.tagName === 'span' ? 'label' : e.tagName} ${textOf(e)}`);

/** The row whose header cell starts with the line header (any "Also applies to" lines follow it). */
function rowOf(doc: Node, header: string): Element {
  const tr = tagged(doc, 'tr').find((r) =>
    r.childNodes.some(
      (c) => isElement(c) && c.tagName === 'th' && textOf(c).split('\n')[0] === header,
    ),
  );
  if (!tr) throw new Error(`no row ${header}`);
  return tr;
}

/** The cells of the table row headed by header, each as its text. */
const rowCells = (doc: Node, header: string): string[] =>
  rowOf(doc, header).childNodes.filter(isElement).map(textOf);

/** The lines of the row header cell of the row headed by header. */
const headerLines = (doc: Node, header: string): string[] =>
  textOf(rowOf(doc, header).childNodes.find(isElement) as Element).split('\n');

/** The paragraphs of the cells of the row headed by header (a one-line cell is its own paragraph). */
function rowLines(doc: Node, header: string): string[][] {
  return rowOf(doc, header)
    .childNodes.filter(isElement)
    .filter((c) => c.tagName === 'td')
    .map((td) => {
      const ps = tagged(td, 'p');
      return ps.length > 0 ? ps.map(textOf) : [textOf(td)];
    });
}

const complete = buildAcr(decidedReport(), META);
const draft = buildAcr(acrReport(), META);
const completeHtml = renderVpatHtml(complete);
const draftHtml = renderVpatHtml(draft);

describe('VPAT HTML, complete', () => {
  const doc = parse(completeHtml);

  it('is the complete fixture', () => {
    expect(complete.complete).toBe(true);
  });

  it('is titled as an ACR based on VPAT® 2.5Rev, with lang en', () => {
    const title = 'Example Agency Accessibility Conformance Report, Revised Section 508 Edition';
    expect(tagged(doc, 'h1').map(textOf)).toEqual([title]);
    expect(tagged(doc, 'title').map(textOf)).toEqual([title]);
    expect(attr(tagged(doc, 'html')[0] as Element, 'lang')).toBe('en');
    const header = tagged(doc, 'header')[0] as Element;
    expect(tagged(header, 'p').map(textOf)).toEqual(['(Based on VPAT® Version 2.5Rev)']);
    expect(completeHtml).not.toContain('id="draft"');
  });

  it('writes the VPAT name only as VPAT®', () => {
    const uses = completeHtml.match(/VPAT/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    expect(completeHtml.match(/VPAT®/g)?.length).toBe(uses.length);
    expect(completeHtml).not.toMatch(/Voluntary Product Accessibility Template/i);
  });

  it('follows the order of the template report section', () => {
    expect(outline(doc)).toEqual([
      'h1 Example Agency Accessibility Conformance Report, Revised Section 508 Edition',
      'label Name of Product/Version:',
      'label Report Date:',
      'label Product Description:',
      'label Contact Information:',
      'h2 Notes',
      'h2 Evaluation Methods Used',
      'h2 Applicable Standards/Guidelines',
      'h2 Terms',
      'h2 WCAG 2.0 Report',
      'h3 Table 1: Success Criteria, Level A',
      'h3 Table 2: Success Criteria, Level AA',
      'h3 Table 3: Success Criteria, Level AAA',
      'label Notes:',
      'h2 Revised Section 508 Report',
      'h3 Chapter 3: Functional Performance Criteria (FPC)',
      'h3 Chapter 4: Hardware',
      'label Notes:',
      'h3 Chapter 5: Software',
      'label Notes:',
      'h3 Chapter 6: Support Documentation and Services',
      'h2 Legal Disclaimer',
    ]);
  });

  it('orders the chapters by the catalog order field, not by their place in the file', () => {
    const headingsOf = (cat = loadOpenAcrCatalog()) =>
      vpatOutline(complete, cat).blocks.flatMap((b) => (b.kind === 'heading' ? [b.text] : []));
    const reversed = structuredClone(loadOpenAcrCatalog());
    reversed.chapters.reverse();
    expect(headingsOf(reversed)).toEqual(headingsOf());
    // The order field decides: swapping it swaps the sections.
    const swapped = structuredClone(loadOpenAcrCatalog());
    for (const c of swapped.chapters) {
      if (c.id === 'success_criteria_level_a') c.order = 2;
      else if (c.id === 'success_criteria_level_aa') c.order = 1;
    }
    const h = headingsOf(swapped);
    expect(h.indexOf('Table 2: Success Criteria, Level AA')).toBeLessThan(
      h.indexOf('Table 1: Success Criteria, Level A'),
    );
  });

  it('puts each table and note in the section of its heading', () => {
    for (const id of ['standards', 'success_criteria_level_a', 'software', 'hardware']) {
      const section = tagged(doc, 'section').find((s) => attr(s, 'aria-labelledby') === id);
      expect(section, id).toBeDefined();
      const heading = tagged(section as Element, 'h2', 'h3')[0];
      expect(heading && attr(heading, 'id')).toBe(id);
    }
    const aaa = tagged(doc, 'section').find(
      (s) => attr(s, 'aria-labelledby') === 'success_criteria_level_aaa',
    );
    expect(textOf(aaa as Element)).toContain(complete.omitted[0]?.reason);
    const software = tagged(doc, 'section').find((s) => attr(s, 'aria-labelledby') === 'software');
    expect(tagged(software as Element, 'table')).toHaveLength(1);
    expect(textOf(software as Element)).toContain(
      '502.3 Accessibility Services is a heading row in the template (no response required)',
    );
  });

  it('opens the WCAG 2.0 Report with the template introduction', () => {
    const section = tagged(doc, 'section').find((s) => attr(s, 'aria-labelledby') === 'wcag-2.0');
    const intro = (section as Element).childNodes
      .filter(isElement)
      .filter((e) => e.tagName === 'p')
      .map(textOf);
    expect(intro).toEqual([
      'Tables 1 and 2 also document conformance with Revised Section 508:',
      'Chapter 5 - 501.1 Scope, 504.2 Content Creation or Editing',
      'Chapter 6 - 602.3 Electronic Support Documentation',
      'Note: When reporting on conformance with the WCAG 2.0 Success Criteria, they are scoped for full pages, complete processes, and accessibility-supported ways of using technology as documented in the WCAG 2.0 Conformance Requirements.',
    ]);
  });

  it('writes the template "Also applies to" lines under each Table 1 and 2 row', () => {
    expect(headerLines(doc, '1.1.1 Non-text Content (Level A)')).toEqual([
      '1.1.1 Non-text Content (Level A)',
      'Also applies to:',
      'Revised Section 508',
      '501 (Web)(Software)',
      '504.2 (Authoring Tool)',
      '602.3 (Support Docs)',
    ]);
    for (const header of [
      '2.4.1 Bypass Blocks (Level A)',
      '2.4.5 Multiple Ways (Level AA)',
      '3.2.3 Consistent Navigation (Level AA)',
      '3.2.4 Consistent Identification (Level AA)',
    ])
      expect(headerLines(doc, header).slice(1), header).toEqual([
        'Also applies to:',
        'Revised Section 508',
        '501 (Web)(Software) - Does not apply to non-web software',
        '504.2 (Authoring Tool)',
        '602.3 (Support Docs) - Does not apply to non-web docs',
      ]);
    expect(headerLines(doc, '4.1.1 Parsing (Level A)').slice(1, 3)).toEqual([
      'Also applies to:',
      "WCAG 2.0 - Always answer 'Supports'",
    ]);
    // The lines sit in the row header, in normal weight; Chapter rows have none.
    expect(completeHtml).toContain('th .also { font-weight: normal; }');
    expect(headerLines(doc, '302.1 Without Vision')).toEqual(['302.1 Without Vision']);
  });

  it('takes the row titles from the catalog (the template wording)', () => {
    expect(rowCells(doc, '1.4.4 Resize text (Level AA)')[0]).toMatch(/^1\.4\.4 Resize text/);
  });

  it('writes 501.1 first in Chapter 5, and 504.2 and 602.3, as the template does', () => {
    const software = tagged(doc, 'section').find((s) => attr(s, 'aria-labelledby') === 'software');
    const first = tagged(software as Element, 'tbody')
      .flatMap((b) => tagged(b, 'tr'))
      .map((tr) => tr.childNodes.filter(isElement).map(textOf))[0];
    expect(first).toEqual([
      '501.1 Scope - Incorporation of WCAG 2.0 AA',
      'See WCAG 2.x section',
      'See information in WCAG 2.x section',
    ]);
    // The complete fixture records a pass on 504.2 and 602.3: kept in the remarks, not as the level.
    for (const header of [
      '504.2 Content Creation or Editing',
      '602.3 Electronic Support Documentation',
    ]) {
      const [level, remarks] = rowLines(doc, header);
      expect(level, header).toEqual(['See WCAG 2.x section']);
      expect(remarks?.[0], header).toMatch(
        /^See information in WCAG 2\.x section\. A result is also on record for this row, Supports: /,
      );
    }
  });

  it('writes the metadata fields, notes, methods, terms and disclaimer', () => {
    const fields = tagged(doc, 'p')
      .filter((p) => tagged(p, 'span').some((s) => attr(s, 'class') === 'label'))
      .map(textOf);
    expect(fields.slice(0, 4)).toEqual([
      'Name of Product/Version: Permit portal, version 2.1',
      'Report Date: October 2026',
      'Product Description: Online permit applications.',
      'Contact Information: accessibility@example.gov',
    ]);
    const lists = tagged(doc, 'ul').map((ul) => tagged(ul, 'li').map(textOf));
    expect(lists[0]).toEqual(['Tested on the staging site.', ...complete.notes]);
    expect(lists[0]).toContain('Generated by Widedoor 0.0.0.');
    expect(lists[0]).toContain(SUPPORT_DOCS_NOTE);
    expect(lists[1]).toEqual(complete.methods);
    expect(lists[1]?.[0]).toMatch(/^Automated checks: .*axe-core 4\.14\.0.*veraPDF 1\.30\.3/);
    expect(lists[1]?.at(-1)).toMatch(/^Manual review: \d+ current records by 1 reviewer: Ann Lee/);
    expect(lists[2]).toEqual(complete.terms.map((t) => `${t.label}: ${t.definition}`));
    const disclaimer = tagged(doc, 'section').find(
      (s) => attr(s, 'aria-labelledby') === 'disclaimer',
    );
    expect(tagged(disclaimer as Element, 'p').map(textOf)).toEqual([DISCLAIMER]);
  });

  it('says which standards and levels the report includes', () => {
    expect(rowCells(doc, 'Web Content Accessibility Guidelines 2.0')).toEqual([
      'Web Content Accessibility Guidelines 2.0',
      'Level A (Yes)Level AA (Yes)Level AAA (No)',
    ]);
    expect(rowLines(doc, 'Web Content Accessibility Guidelines 2.0')).toEqual([
      ['Level A (Yes)', 'Level AA (Yes)', 'Level AAA (No)'],
    ]);
    expect(
      rowLines(
        doc,
        'Revised Section 508 standards published January 18, 2017 and corrected January 22, 2018',
      ),
    ).toEqual([['(Yes)']]);
  });

  it('heads the criteria tables with the template columns', () => {
    const heads = tagged(doc, 'thead').map((h) => tagged(h, 'th').map(textOf));
    expect(heads[0]).toEqual(['Standard/Guideline', 'Included In Report']);
    expect(heads.slice(1)).toEqual(
      complete.tables.map(() => ['Criteria', 'Conformance Level', 'Remarks and Explanations']),
    );
    for (const th of tagged(doc, 'th')) expect(['col', 'row']).toContain(attr(th, 'scope'));
  });

  it('lists the Web and Electronic Docs cells of a row on their own lines, labelled as the template does', () => {
    const c111 = complete.tables[0]?.rows[0];
    const [levels, remarks] = rowLines(doc, '1.1.1 Non-text Content (Level A)');
    expect(levels).toEqual(['Web: Supports', 'Electronic Docs: Supports']);
    expect(remarks).toEqual(
      c111?.components.map((c, i) => `${i === 0 ? 'Web' : 'Electronic Docs'}: ${c.remarks}`),
    );
    // A Chapter 3 row has one cell and no component label.
    const [level, remark] = rowLines(doc, '302.1 Without Vision');
    expect(level).toEqual(['Supports']);
    expect(remark?.[0]).toMatch(/^Judged for the product as a whole/);
  });

  it('is inert, under the report CSP', () => {
    expectInert(completeHtml);
  });

  it('is the same text for the same ACR', () => {
    expect(renderVpatHtml(complete)).toBe(completeHtml);
  });
});

describe('VPAT HTML, draft', () => {
  const doc = parse(draftHtml);

  it('is titled DRAFT and never names the template', () => {
    const title = 'DRAFT Example Agency Accessibility Conformance Report';
    expect(tagged(doc, 'h1').map(textOf)).toEqual([title]);
    expect(tagged(doc, 'title').map(textOf)).toEqual([title]);
    expect(draftHtml).not.toContain('VPAT');
  });

  it('opens with a banner that counts the undecided rows and lists every reason', () => {
    expect(draft.undecided).toBeGreaterThan(1);
    const header = tagged(doc, 'header')[0] as Element;
    const first = header.childNodes.find(isElement) as Element;
    expect(first.tagName).toBe('section');
    expect(attr(first, 'aria-labelledby')).toBe('draft');
    expect(attr(first, 'role')).toBeUndefined();
    expect(tagged(first, 'h2').map(textOf)).toEqual(['Draft']);
    expect(textOf(tagged(first, 'p')[0] as Element)).toMatch(
      new RegExp(
        `^${draft.undecided} rows are not decided yet \\(Not Evaluated\\)\\. This report stays a draft`,
      ),
    );
    expect(tagged(first, 'li').map(textOf)).toEqual(draft.incomplete);
    // The banner comes before the title.
    expect(outline(doc).slice(0, 2)).toEqual([
      'h2 Draft',
      `h1 ${tagged(doc, 'h1').map(textOf)[0]}`,
    ]);
  });

  it('keeps the layout of the complete report after the title', () => {
    const body = (lines: string[]) => lines.filter((l) => !l.startsWith('h1 '));
    expect(body(outline(doc))).toEqual(['h2 Draft', ...body(outline(parse(completeHtml)))]);
  });

  it('says every row is decided when only the metadata is missing, and names an unnamed vendor', () => {
    const acr = buildAcr(decidedReport(), {});
    const page = renderVpatHtml(acr);
    const d = parse(page);
    expect(tagged(d, 'h1').map(textOf)).toEqual([
      'DRAFT Unnamed vendor Accessibility Conformance Report',
    ]);
    const banner = tagged(d, 'section').find(
      (s) => attr(s, 'aria-labelledby') === 'draft',
    ) as Element;
    expect(textOf(tagged(banner, 'p')[0] as Element)).toMatch(/^Every row is decided\. /);
    expect(tagged(banner, 'li').map(textOf)).toEqual(acr.incomplete);
    expect(page).toContain('Name of Product/Version:</span> Not set.');
    expect(page).toContain('Contact Information:</span> Not set.');
    expect(page).not.toContain('VPAT');
  });

  it('carries the disclaimer, the Widedoor version and the methods', () => {
    const text = textOf(doc);
    expect(text).toContain(DISCLAIMER);
    expect(text).toContain('Generated by Widedoor 0.0.0.');
    for (const m of draft.methods) expect(text).toContain(m);
  });

  it('is inert, under the report CSP', () => {
    expectInert(draftHtml);
  });
});

describe('VPAT HTML escaping', () => {
  it('shows hostile vendor, product and notes as text', () => {
    const acr = buildAcr(acrReport(), HOSTILE_META);
    const page = renderVpatHtml(acr);
    expectInert(page);
    expect(page).not.toContain(PAYLOAD);
    expect(page).not.toMatch(/<script|<img/i);
    const text = textOf(parse(page));
    expect(text).toContain(`DRAFT Evil\\x1b[31m ${PAYLOAD} Accessibility Conformance Report`);
    expect(text).toContain(`Name of Product/Version: Portal\\u202e ${PAYLOAD}`);
    // Line breaks are kept, as <br>.
    expect(text).toContain(
      `Product Description: Line one\nkey: value ${PAYLOAD}${NONCHARACTERS_SAFE}`,
    );
    expect(text).toContain(`---\nchapters: {}\n${PAYLOAD}\\x07`);
    expect(text).toContain('Contact Information: x@example.com\\x0akey: injected');
  });

  it('shows hostile reviewer notes on 504.2 and 602.3 as text, creating no element', () => {
    const acr = buildAcr(hostileReferenceReport(), META);
    const page = renderVpatHtml(acr);
    expectInert(page);
    expect(page).not.toContain(PAYLOAD);
    expect(page).not.toMatch(/<b>|<a |<script|<img/i);
    for (const code of [0x202e, 0x07]) expect(page).not.toContain(String.fromCharCode(code));
    const d = parse(page);
    // The notes add no element: every a, b, script and img in the page is absent.
    expect(tagged(d, 'a', 'b', 'script', 'img')).toEqual([]);
    for (const header of [
      '504.2 Content Creation or Editing',
      '602.3 Electronic Support Documentation',
    ]) {
      const [level, remarks] = rowLines(d, header);
      expect(level, header).toEqual(['See WCAG 2.x section']);
      expect(remarks?.[0], header).toContain(`${HOSTILE_NOTES_SAFE}.`);
    }
  });

  it('shows hostile reviewer names in the methods as text', () => {
    const acr = buildAcr(reviewFixtureReport(), META);
    const page = renderVpatHtml(acr);
    expectInert(page);
    expect(page).not.toContain(PAYLOAD);
    const methods = acr.methods.find((m) => m.startsWith('Manual review:'));
    expect(methods).toContain(REVIEWER);
    expect(textOf(parse(page))).toContain(methods);
  });
});
