import { plural } from '@widedoor/core';
import type { Acr, AcrRow, AcrTable } from './acr.js';
import { loadOpenAcrCatalog, type OpenAcrCatalog } from './openacr.js';

/*
 * The ACR in the layout of the ITI VPAT® 2.5Rev Revised Section 508 edition,
 * as an outline of headings, labelled fields, lists and tables that the HTML
 * (vpat-html.ts) and DOCX (vpat-docx.ts) renderers walk in order, so both
 * formats hold the same text in the same order. The order follows the
 * template's report section: title, template version line, product and
 * version, report date, description, contact, notes, evaluation methods,
 * applicable standards, terms, the WCAG 2.0 report (Tables 1 to 3), the
 * Revised Section 508 report (Chapters 3 to 6) and the legal disclaimer.
 * Headings, column labels, the WCAG 2.0 Report introduction and the "Also
 * applies to" lines under the Table 1 and 2 rows are the template's wording
 * (a hyphen where it has a dash), as is the "Electronic Docs" cell label;
 * the rest is Widedoor's own text. ITI allows the VPAT name only on a
 * report that keeps the template's Essential Requirements, so a complete
 * ACR writes it as VPAT® and a draft never writes it at all. The outline
 * only arranges the ACR: every level, remark, note and reason comes from
 * buildAcr. Its strings are not escaped; each renderer escapes for its own
 * output.
 */

/** The template's name, with the registered mark ITI requires. */
export const VPAT_NAME = 'VPAT®';

export type VpatBlock =
  | { kind: 'heading'; level: 2 | 3; id: string; text: string }
  /** "Label: text"; text may hold line breaks. */
  | { kind: 'field'; label: string; text: string }
  | { kind: 'paragraph'; text: string }
  /** Each item may hold line breaks. */
  | { kind: 'list'; items: string[] }
  /**
   * A data table, under the heading before it: column labels, then rows of a
   * header cell and data cells, each cell a list of lines. also holds the lines
   * under the header in its cell, set in normal weight.
   */
  | {
      kind: 'table';
      head: string[];
      rows: { header: string; also?: string[]; cells: string[][] }[];
    };

export interface VpatOutline {
  /** Whether the ACR is complete; a draft never names the template. */
  complete: boolean;
  title: string;
  /** The template version line: complete ACRs only. */
  version?: string;
  /** The banner a draft opens with, before the title. */
  draft?: { heading: string; lead: string; reasons: string[] };
  /** The vendor (or "Unnamed vendor"), for the DOCX author. */
  author: string;
  /** Everything after the title block, in template order. */
  blocks: VpatBlock[];
}

export const CRITERIA_COLUMNS = ['Criteria', 'Conformance Level', 'Remarks and Explanations'];
export const STANDARDS_COLUMNS = ['Standard/Guideline', 'Included In Report'];

const NOT_SET = 'Not set.';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "October 2026" for 2026-10-23: the month and year the template asks for, the same in every locale. */
export function reportMonth(date: string): string {
  const [year, month] = date.split('-');
  const name = MONTHS[Number(month) - 1];
  if (name === undefined || year === undefined) throw new Error(`bad report date ${date}`);
  return `${name} ${year}`;
}

/** The WCAG level a WCAG table reports, for its row headers and the standards table. */
const WCAG_LEVEL: Record<string, string> = {
  success_criteria_level_a: 'A',
  success_criteria_level_aa: 'AA',
  success_criteria_level_aaa: 'AAA',
};

/** The template's cell labels where they differ from the catalog's component labels. */
const COMPONENT_LABEL: Readonly<Record<string, string>> = { 'electronic-docs': 'Electronic Docs' };

/** One line per component: "Web: Supports" when the row has labelled components, the level alone otherwise. */
const lines = (row: AcrRow, of: (c: AcrRow['components'][number]) => string) =>
  row.components.map((c) =>
    c.label === '' ? of(c) : `${COMPONENT_LABEL[c.id] ?? c.label}: ${of(c)}`,
  );

/** The WCAG 2.0 Report introduction, one paragraph each, as the template words it. */
export const WCAG_REPORT_INTRO = [
  'Tables 1 and 2 also document conformance with Revised Section 508:',
  'Chapter 5 - 501.1 Scope, 504.2 Content Creation or Editing',
  'Chapter 6 - 602.3 Electronic Support Documentation',
  'Note: When reporting on conformance with the WCAG 2.0 Success Criteria, they are scoped for full pages, complete processes, and accessibility-supported ways of using technology as documented in the WCAG 2.0 Conformance Requirements.',
];

/** Level A and AA criteria the template says do not apply to non-web software and documents. */
const WEB_ONLY: ReadonlySet<string> = new Set(['2.4.1', '2.4.5', '3.2.3', '3.2.4']);

/** The template's "Also applies to" lines under a Level A or AA row. */
export function alsoAppliesTo(id: string): string[] {
  const webOnly = WEB_ONLY.has(id);
  return [
    'Also applies to:',
    ...(id === '4.1.1' ? ["WCAG 2.0 - Always answer 'Supports'"] : []),
    'Revised Section 508',
    `501 (Web)(Software)${webOnly ? ' - Does not apply to non-web software' : ''}`,
    '504.2 (Authoring Tool)',
    `602.3 (Support Docs)${webOnly ? ' - Does not apply to non-web docs' : ''}`,
  ];
}

function table(t: AcrTable): VpatBlock {
  const level = WCAG_LEVEL[t.id];
  // Level AAA is never reported (the template's AAA rows read "Revised Section 508 - Does not apply").
  const also = level === 'A' || level === 'AA';
  return {
    kind: 'table',
    head: CRITERIA_COLUMNS,
    rows: t.rows.map((r) => ({
      header: `${r.id} ${r.title}${level ? ` (Level ${level})` : ''}`,
      ...(also ? { also: alsoAppliesTo(r.id) } : {}),
      cells: r.reference
        ? [[r.reference.conformance], [r.reference.remarks]]
        : [lines(r, (c) => c.level), lines(r, (c) => c.remarks)],
    })),
  };
}

/** The outline of an ACR in the VPAT® 2.5Rev Revised Section 508 layout. */
export function vpatOutline(acr: Acr, cat: OpenAcrCatalog = loadOpenAcrCatalog()): VpatOutline {
  const { vendor, product } = acr.meta;
  const author = vendor?.name?.trim() ? vendor.name : 'Unnamed vendor';
  const reported = new Map(acr.tables.map((t) => [t.id, t]));
  const omitted = new Map(acr.omitted.map((o) => [o.id, o]));

  const set = (value: string | undefined) => (value?.trim() ? value : NOT_SET);
  const version = product?.version?.trim() ? `, version ${product.version}` : '';
  const blocks: VpatBlock[] = [
    {
      kind: 'field',
      label: 'Name of Product/Version',
      text: product?.name.trim() ? `${product.name}${version}` : NOT_SET,
    },
    { kind: 'field', label: 'Report Date', text: reportMonth(acr.meta.reportDate ?? '') },
    { kind: 'field', label: 'Product Description', text: set(product?.description) },
    { kind: 'field', label: 'Contact Information', text: set(vendor?.contact) },
    { kind: 'heading', level: 2, id: 'notes', text: 'Notes' },
    {
      kind: 'list',
      items: [...(acr.meta.notes !== undefined ? [acr.meta.notes] : []), ...acr.notes],
    },
    { kind: 'heading', level: 2, id: 'methods', text: 'Evaluation Methods Used' },
    { kind: 'list', items: acr.methods },
    { kind: 'heading', level: 2, id: 'standards', text: 'Applicable Standards/Guidelines' },
    {
      kind: 'table',
      head: STANDARDS_COLUMNS,
      rows: cat.standards.map((s) => ({
        header: s.label,
        cells: [
          s.id === 'wcag-2.0'
            ? s.chapters.map(
                (id) => `Level ${WCAG_LEVEL[id] ?? id} (${reported.has(id) ? 'Yes' : 'No'})`,
              )
            : [`(${s.chapters.some((id) => reported.has(id)) ? 'Yes' : 'No'})`],
        ],
      })),
    },
    { kind: 'heading', level: 2, id: 'terms', text: 'Terms' },
    {
      kind: 'paragraph',
      text: 'The conformance levels in this report mean the following (the notes say where they differ from the template):',
    },
    { kind: 'list', items: acr.terms.map((t) => `${t.label}: ${t.definition}`) },
  ];
  for (const standard of cat.standards) {
    blocks.push({ kind: 'heading', level: 2, id: standard.id, text: standard.report_heading });
    if (standard.id === 'wcag-2.0')
      blocks.push(...WCAG_REPORT_INTRO.map((text): VpatBlock => ({ kind: 'paragraph', text })));
    // In the catalog's order within the standard, not the order of the file.
    const chapters = cat.chapters
      .filter((x) => standard.chapters.includes(x.id))
      .toSorted((a, b) => a.order - b.order);
    for (const c of chapters) {
      const t = reported.get(c.id);
      const left = omitted.get(c.id);
      if (!t && !left) continue;
      blocks.push({ kind: 'heading', level: 3, id: c.id, text: c.label });
      if (t) {
        if (t.notes.length > 0)
          blocks.push({ kind: 'field', label: 'Notes', text: t.notes.join('\n') });
        blocks.push(table(t));
      } else if (left) blocks.push({ kind: 'field', label: 'Notes', text: left.reason });
    }
  }
  blocks.push(
    { kind: 'heading', level: 2, id: 'disclaimer', text: 'Legal Disclaimer' },
    { kind: 'paragraph', text: acr.disclaimer },
  );

  if (acr.complete)
    return {
      complete: true,
      title: `${author} Accessibility Conformance Report, Revised Section 508 Edition`,
      version: `(Based on ${VPAT_NAME} Version 2.5Rev)`,
      author,
      blocks,
    };
  return {
    complete: false,
    title: `DRAFT ${author} Accessibility Conformance Report`,
    draft: {
      heading: 'Draft',
      lead: `${acr.undecided === 0 ? 'Every row is decided' : `${plural(acr.undecided, 'row is', 'rows are')} not decided yet (Not Evaluated)`}. This report stays a draft, and is not a conformance report in the template's format, until each of these is resolved:`,
      reasons: acr.incomplete,
    },
    author,
    blocks,
  };
}
