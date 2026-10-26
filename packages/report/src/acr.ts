import {
  assetsLevel,
  currentHashes,
  errataFrom,
  isCurrentRecord,
  loadStandardsData,
  plural,
  safeText,
  type ConformanceLevel,
  type Errata,
  type Finding,
  type StandardsData,
} from '@widedoor/core';
import { DISCLAIMER, type ScanReport } from './model.js';
import { loadOpenAcrCatalog, OPENACR_CATALOG_ID, type OpenAcrCatalog } from './openacr.js';
import { overriddenFails, type OverrideTest } from './overrides.js';
import { loadPlainData, plainFor, type PlainData } from './plain.js';
import {
  conditionText,
  datesText,
  engineName,
  engineText,
  exceptionNotes,
  exceptionText,
  findingHeading,
  findingPlace,
  manualReviews,
  profileText,
  reviewerText,
  unscannedAssets,
  type Criterion,
} from './view.js';

/*
 * The ACR (Accessibility Conformance Report) model, in the layout of the VPAT
 * 2.5Rev Revised Section 508 edition: WCAG 2.0 Level A and AA tables, then
 * Chapters 3, 5 and 6, with rows and ids from the vendored OpenACR catalog.
 * Every level comes from the roll-up's 508 view; buildAcr never decides one.
 * The WCAG rows split into a Web and an Electronic Documents column, each
 * levelled by the roll-up's own rule (core assetsLevel) over that kind's
 * per-asset details. As in the template, Chapter 5 opens with 501.1, and
 * 504.2 and 602.3 are answered in the WCAG tables (reference rows, never a
 * verdict), except that 504.2 shows a Not Applicable a reviewer recorded
 * because the product is not an authoring tool. Row titles are the catalog's,
 * which are the template's. Every string from a scan, a review file or the config
 * is made safe text here (core safeText), so each renderer only has to apply
 * its own escaping. complete and incomplete are decided here, once, for the
 * OpenACR, VPAT HTML and DOCX outputs alike.
 */

/**
 * An internal id for the layout the model follows. No output renders it: the
 * VPAT HTML and DOCX write the template's name themselves, as VPAT® and only
 * in a complete ACR (vpat.ts).
 */
export const ACR_EDITION = 'VPAT 2.5Rev 508';

export interface AcrMeta {
  /** name may be missing with contact set (from a config); the ACR is then a draft. */
  vendor?: { name?: string; contact?: string };
  product?: { name: string; version?: string; description?: string };
  notes?: string;
  /** YYYY-MM-DD; defaults to the date the scan finished (UTC). */
  reportDate?: string;
}

export type AcrTermId =
  'supports' | 'partially-supports' | 'does-not-support' | 'not-applicable' | 'not-evaluated';

/** Roll-up level to OpenACR catalog term id, one to one. */
export const ACR_TERM_IDS: Record<ConformanceLevel, AcrTermId> = {
  Supports: 'supports',
  'Partially Supports': 'partially-supports',
  'Does Not Support': 'does-not-support',
  'Not Applicable': 'not-applicable',
  'Not Evaluated': 'not-evaluated',
};

export interface AcrTerm {
  id: AcrTermId;
  label: ConformanceLevel;
  /** What the term means in this report. */
  definition: string;
  /** The template's definition, from the catalog. */
  template: string;
  /** Whether definition departs from the template's; the notes then say so, as the template allows. */
  deviates: boolean;
}

/** Catalog component ids: Web and Electronic Documents columns of the WCAG tables, none for Chapters 3, 5 and 6. */
export type AcrComponentId = 'web' | 'electronic-docs' | 'none';

export interface AcrComponent {
  id: AcrComponentId;
  /** The catalog label ("Web", "Electronic Documents"; empty for none). */
  label: string;
  level: ConformanceLevel;
  term: AcrTermId;
  /** Remarks and Explanations: the roll-up reason, failing findings, overrides, exceptions, the errata citation. */
  remarks: string;
}

/**
 * A row the template answers in the WCAG tables instead (501.1, and 504.2 and
 * 602.3, which incorporate WCAG 2.0). It is not a verdict: it never counts as
 * Supports or as undecided.
 */
export interface AcrReference {
  /** The template's Conformance Level cell. */
  conformance: string;
  /** The template's Remarks and Explanations cell, then any result a reviewer recorded for the row. */
  remarks: string;
  /** The same, for a format with no row for it (OpenACR: the catalog has no 501.1, and every criterion entry needs a level). */
  note: string;
}

export interface AcrRow {
  id: string;
  /** The catalog's title where it has the row (the template's wording), the roll-up's otherwise. */
  title: string;
  /** Empty on a reference row. */
  components: AcrComponent[];
  reference?: AcrReference;
}

export interface AcrTable {
  /** Catalog chapter id, for example success_criteria_level_a. */
  id: string;
  /** Catalog label, for example "Table 1: Success Criteria, Level A". */
  label: string;
  standard: 'wcag-2.0' | '508';
  notes: string[];
  rows: AcrRow[];
}

/** A catalog chapter the ACR leaves out, and why. */
export interface AcrOmitted {
  id: string;
  label: string;
  reason: string;
}

export interface Acr {
  /** The metadata as given, made safe, with reportDate always set. */
  meta: AcrMeta;
  edition: typeof ACR_EDITION;
  /** The OpenACR catalog the tables follow. */
  catalog: typeof OPENACR_CATALOG_ID;
  /** When the scan finished: the scan report's timestamp, not the clock. */
  generated: string;
  tool: { name: 'widedoor'; version: string };
  tables: AcrTable[];
  omitted: AcrOmitted[];
  /** True only with every reported row decided, the whole scope scanned and the metadata set. */
  complete: boolean;
  /** Why the ACR is not complete, one reason each; empty when it is. */
  incomplete: string[];
  /** Rows with a Not Evaluated cell (the VPAT draft banner counts them). */
  undecided: number;
  /** Evaluation methods used, one line each. */
  methods: string[];
  terms: AcrTerm[];
  /** Widedoor's notes: version, columns left out, term deviations, roll-up rows with no template row. */
  notes: string[];
  disclaimer: string;
}

/** Findings listed in one cell's remarks at most; the rest are counted. */
export const MAX_ACR_FINDINGS = 20;

const TERMS: Record<ConformanceLevel, { definition: string; deviates: boolean }> = {
  Supports: {
    definition:
      'Every applicable page and file passes: on a deciding automated check, a current manual review or, for 4.1.1 only, the errata basis. None fails.',
    deviates: true,
  },
  'Partially Supports': {
    definition: 'At least one applicable page or file fails and at least one passes.',
    deviates: true,
  },
  'Does Not Support': {
    definition:
      'Every applicable page and file with a deciding result fails; none passes. Widedoor does not judge "the majority" of the product.',
    deviates: true,
  },
  'Not Applicable': {
    definition:
      'The criterion applies to no page or file: a Section 508 exception in the profile (E205.4 for non-web documents) or a reviewer who recorded the reason.',
    deviates: false,
  },
  'Not Evaluated': {
    definition:
      'Nothing fails, but at least one applicable page or file has no deciding result yet (a person needs to test it), was not scanned, or the scope is incomplete. The template allows Not Evaluated only for Level AAA, so an ACR with a Not Evaluated row stays a draft.',
    deviates: true,
  },
};

const COLUMNS: { kind: 'web' | 'pdf'; id: AcrComponentId; noun: string }[] = [
  { kind: 'web', id: 'web', noun: 'web page' },
  { kind: 'pdf', id: 'electronic-docs', noun: 'PDF' },
];

/** WCAG 2.0 tables first, then the Section 508 chapters this ACR reports, in catalog order. */
const REPORTED: Record<string, 'wcag-2.0' | '508'> = {
  success_criteria_level_a: 'wcag-2.0',
  success_criteria_level_aa: 'wcag-2.0',
  functional_performance_criteria: '508',
  software: '508',
  support_documentation_and_services: '508',
};

const LEFT_OUT: Record<string, string> = {
  success_criteria_level_aaa:
    'The Revised Section 508 Standards incorporate WCAG 2.0 Level A and AA only, and Widedoor does not evaluate Level AAA.',
  hardware: 'Widedoor tests web pages and electronic documents (PDFs), not hardware.',
};

/** Where a Section 508 roll-up row with no catalog row is noted, by its chapter number. */
const CHAPTER_OF: Record<string, string> = {
  '3': 'functional_performance_criteria',
  '5': 'software',
  '6': 'support_documentation_and_services',
};

/** The template's cells on a row answered in the WCAG tables. */
export const SEE_WCAG = {
  conformance: 'See WCAG 2.x section',
  remarks: 'See information in WCAG 2.x section',
} as const;

/** The template's first Chapter 5 row, which the catalog does not have (hyphen for the template's dash). */
const SCOPE_501_1 = { id: '501.1', title: 'Scope - Incorporation of WCAG 2.0 AA' };

/** Roll-up rows the template answers in the WCAG tables, by catalog chapter. */
const SEE_WCAG_ROWS: Record<string, ReadonlySet<string>> = {
  software: new Set(['504.2']),
  support_documentation_and_services: new Set(['602.3']),
};

/**
 * Why "See WCAG 2.x section" on 602.3, and "602.3 (Support Docs)" under each
 * WCAG row, cover only the support documentation that was scanned.
 */
export const SUPPORT_DOCS_NOTE =
  'Support documentation (602.3) is covered by the WCAG tables only where it was among the pages and files scanned. Support documentation outside that scope was not assessed.';

/** Roll-up rows that are heading rows in the template, which need no response. */
const HEADING_ROWS: ReadonlySet<string> = new Set(['502.3', '503.4']);

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether value is a real calendar date written YYYY-MM-DD. */
export function isAcrDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** Multi-line text with each line made safe (line breaks kept, every other control escaped). */
const safeLines = (value: string, max: number) =>
  value
    .split(/\r?\n/)
    .map((line) => safeText(line, max))
    .join('\n');

function safeMeta(meta: AcrMeta, reportDate: string): AcrMeta {
  const { vendor, product } = meta;
  return {
    ...(vendor
      ? {
          vendor: {
            ...(vendor.name !== undefined ? { name: safeText(vendor.name, 300) } : {}),
            ...(vendor.contact !== undefined ? { contact: safeText(vendor.contact, 300) } : {}),
          },
        }
      : {}),
    ...(product
      ? {
          product: {
            name: safeText(product.name, 300),
            ...(product.version !== undefined ? { version: safeText(product.version, 100) } : {}),
            ...(product.description !== undefined
              ? { description: safeLines(product.description, 2000) }
              : {}),
          },
        }
      : {}),
    ...(meta.notes !== undefined ? { notes: safeLines(meta.notes, 2000) } : {}),
    reportDate,
  };
}

const sentence = (text: string) => (/[.!?"']$/.test(text) ? text : `${text}.`);

/** A roll-up reason as the first sentence of a remark. */
const lead = (text: string) => sentence(text.charAt(0).toUpperCase() + text.slice(1));

interface Context {
  report: ScanReport;
  plain: PlainData;
  overridden: OverrideTest;
  current: (f: Finding) => boolean;
  errata: Errata;
}

/** "Fails on <uri> (<rule>; <place>): <what>" for each current, not overridden fail record behind ids, capped. */
function failuresText(ctx: Context, ids: readonly string[], uris?: ReadonlySet<string>): string {
  const wanted = new Set(ids);
  const items = [
    ...new Set(
      ctx.report.findings
        .filter(
          (f) =>
            f.outcome === 'fail' &&
            wanted.has(f.id) &&
            (uris === undefined || uris.has(f.asset.uri)) &&
            ctx.current(f) &&
            !ctx.overridden(f),
        )
        .map((f) => {
          const uri = safeText(f.asset.uri, 500);
          if (f.source.engine === 'manual') {
            const notes = 'review' in f ? f.review.notes?.trim() : undefined;
            return `A reviewer recorded a fail on ${uri}${notes ? `: ${sentence(safeText(notes, 500))}` : '.'}`;
          }
          const what = safeText(findingHeading(f, plainFor(f, ctx.plain)), 500);
          const place = safeText(findingPlace(f), 300);
          return `Fails on ${uri} (${engineName(f.source.engine)} ${safeText(f.source.ruleId, 100)}; ${place}): ${sentence(what)}`;
        }),
    ),
  ];
  if (items.length === 0) return '';
  const shown = items.slice(0, MAX_ACR_FINDINGS);
  const more = items.length - shown.length;
  return [...shown, ...(more > 0 ? [`And ${more} more.`] : [])].join(' ');
}

function overridesText(units: readonly { overridden?: readonly string[] | undefined }[]): string {
  const ids = [...new Set(units.flatMap((u) => u.overridden ?? []))];
  return ids.length === 0
    ? ''
    : `Automated fails a reviewer set aside as false positives: ${ids.join(', ')}.`;
}

const join = (parts: readonly string[]) => parts.filter((p) => p !== '').join(' ');

function component(
  id: AcrComponentId,
  label: string,
  level: ConformanceLevel,
  remarks: string,
): AcrComponent {
  return { id, label, level, term: ACR_TERM_IDS[level], remarks };
}

/** The Web and Electronic Documents cells of a WCAG row, for the asset kinds the row has. */
function wcagComponents(ctx: Context, c: Criterion, cat: OpenAcrCatalog): AcrComponent[] {
  const gaps = ctx.report.scopeGaps ?? [];
  const basis = ctx.errata.get(c.id);
  // The roll-up's own rule over all the details must give the level the report holds.
  const whole = assetsLevel(c.assets, gaps, basis);
  if (whole.level !== c.level)
    throw new Error(
      `criterion ${c.id}: the roll-up level ${c.level} does not follow from its assets (${whole.level})`,
    );
  return COLUMNS.flatMap((col) => {
    const details = c.assets.filter((d) => d.kind === col.kind);
    if (details.length === 0) return [];
    const { level, reason } = assetsLevel(details, gaps, basis);
    const exceptions = exceptionNotes({ ...c, assets: details }).map((e) => `${exceptionText(e)}.`);
    const failing = details.filter((d) => d.state === 'fail');
    const remarks = join([
      lead(safeText(reason, 4000)),
      ...exceptions,
      failuresText(
        ctx,
        failing.flatMap((d) => d.evidence),
        new Set(failing.map((d) => d.uri)),
      ),
      overridesText(details),
    ]);
    const catalogLabel = cat.components.find((x) => x.id === col.id)?.label ?? col.id;
    return [component(col.id, catalogLabel, level, remarks)];
  });
}

/** The single cell of a Chapter 3, 5 or 6 row: the roll-up's level for the product, or for the web pages it applies to. */
function section508Component(ctx: Context, c: Criterion): AcrComponent {
  const units = c.product ? [c.product] : c.assets;
  const failing = c.product
    ? c.product.state === 'fail'
      ? c.product.evidence
      : []
    : c.assets.filter((d) => d.state === 'fail').flatMap((d) => d.evidence);
  const uris = c.product
    ? undefined
    : new Set(c.assets.filter((d) => d.state === 'fail').map((d) => d.uri));
  const remarks = join([
    lead(safeText(c.product ? `Judged for the product as a whole: ${c.reason}` : c.reason, 4000)),
    failuresText(ctx, failing, uris),
    overridesText(units),
    c.condition ? sentence(conditionText(c.condition)) : '',
  ]);
  return component('none', '', c.level, remarks);
}

const OUTCOME_TEXT: Record<Finding['outcome'], string> = {
  pass: 'a pass',
  fail: 'a fail',
  'not-applicable': 'not applicable',
  'needs-review': 'needs review',
  'not-tested': 'not tested',
};

/**
 * What reviewers recorded for a row answered in the WCAG tables: the roll-up's
 * reading when it decides the row, otherwise each current manual record
 * citing it, with no level (a record on some pages decides nothing for the
 * rest). Empty when there is nothing on record.
 */
function recordedText(ctx: Context, c: Criterion): string {
  if (c.level !== 'Not Evaluated') {
    const decided = section508Component(ctx, c);
    return `A result is also on record for this row, ${decided.level}: ${decided.remarks}`;
  }
  const items = ctx.report.findings
    .filter(
      (f) =>
        f.source.engine === 'manual' &&
        (f.criteria.section508 ?? []).includes(c.id) &&
        ctx.current(f),
    )
    .map((f) => {
      const notes = 'review' in f ? f.review.notes?.trim() : undefined;
      return `A reviewer recorded ${OUTCOME_TEXT[f.outcome]} on ${safeText(f.asset.uri, 500)}${notes ? `: ${sentence(safeText(notes, 500))}` : '.'}`;
    });
  if (items.length === 0) return '';
  const shown = items.slice(0, MAX_ACR_FINDINGS);
  const more = items.length - shown.length;
  return join([
    `Recorded for this row so far; the roll-up leaves it undecided: ${sentence(safeText(c.reason, 500))}`,
    ...shown,
    more > 0 ? `And ${more} more.` : '',
  ]);
}

/** A row answered in the WCAG tables, with what reviewers recorded for it, if anything, after the template's remark. */
function referenceRow(id: string, title: string, recorded = ''): AcrRow {
  const also = recorded === '' ? '' : ` ${recorded}`;
  return {
    id,
    title,
    components: [],
    reference: {
      conformance: SEE_WCAG.conformance,
      remarks: recorded === '' ? SEE_WCAG.remarks : `${SEE_WCAG.remarks}.${also}`,
      note: `${id} ${title} is answered in Tables 1 and 2 (the template's cells read "${SEE_WCAG.conformance}"), so it has no criterion entry here.${also}`,
    },
  };
}

function methodsOf(report: ScanReport): string[] {
  const web = report.assets.filter((a) => a.kind === 'web').length;
  const pdf = report.assets.length - web;
  const { unscanned, skippedOver } = unscannedAssets(report);
  const notScanned = unscanned.length + skippedOver;
  const { reviewers, records } = manualReviews(report);
  const expired = records.filter((r) => r.expired).length;
  return [
    `Automated checks: ${report.engines.length > 0 ? report.engines.map((e) => safeText(engineText(e), 200)).join(', ') : 'none'}.`,
    `Scope: ${plural(web, 'web page', 'web pages')} and ${plural(pdf, 'PDF', 'PDFs')} scanned${notScanned > 0 ? `; ${plural(notScanned, 'page or file', 'pages and files')} in scope not scanned` : ''}.`,
    `Profile: ${profileText(report)}, read through its Section 508 view.`,
    `${datesText(report)}.`,
    records.length === 0
      ? 'Manual review: none. Every result comes from automated checks.'
      : `Manual review: ${plural(records.length - expired, 'current record', 'current records')}${expired > 0 ? ` (and ${expired} expired, not used)` : ''} by ${plural(reviewers.length, 'reviewer', 'reviewers')}: ${reviewers.map((p) => safeText(reviewerText(p), 500)).join('; ')}.`,
  ];
}

/** Rows with a Not Evaluated cell. */
function undecidedRows(tables: readonly AcrTable[]): number {
  const rows = tables.flatMap((t) => t.rows);
  return rows.filter((r) => r.components.some((c) => c.level === 'Not Evaluated')).length;
}

function incompleteOf(report: ScanReport, meta: AcrMeta, tables: readonly AcrTable[]): string[] {
  const reasons: string[] = [];
  if (tables.every((t) => t.rows.length === 0)) reasons.push('no page or file was scanned');
  const undecided = undecidedRows(tables);
  if (undecided > 0)
    reasons.push(`${plural(undecided, 'criterion is', 'criteria are')} Not Evaluated`);
  const { unscanned, skippedOver } = unscannedAssets(report);
  const notScanned = unscanned.length + skippedOver;
  if (notScanned > 0)
    reasons.push(
      `${plural(notScanned, 'page or file in scope was', 'pages or files in scope were')} not scanned`,
    );
  for (const gap of report.scopeGaps ?? [])
    reasons.push(`the scope is incomplete: ${safeText(gap, 1000)}`);
  // One rule for every key: missing, or blank after trimming (a library caller may pass '').
  const isSet = (value: string | undefined) => value !== undefined && value.trim() !== '';
  if (!isSet(meta.vendor?.name)) reasons.push('acr.vendor.name is not set');
  if (!isSet(meta.product?.name)) reasons.push('acr.product.name is not set');
  if (!isSet(meta.product?.description)) reasons.push('acr.product.description is not set');
  if (!isSet(meta.vendor?.contact)) reasons.push('acr.vendor.contact is not set');
  return reasons;
}

export interface BuildAcrOptions {
  /** Defaults to the data shipped in @widedoor/core (for the 4.1.1 errata basis). */
  data?: Pick<StandardsData, 'errata'>;
  /** Defaults to data/plain.yaml. */
  plain?: PlainData;
}

/**
 * Builds the ACR for a scan report. Throws when the report's profile has no
 * Section 508 view (wcag21aa alone), or when meta.reportDate is not a
 * YYYY-MM-DD date.
 */
export function buildAcr(report: ScanReport, meta: AcrMeta, options: BuildAcrOptions = {}): Acr {
  const view = report.rollup.standards.find((s) => s.standard === '508');
  if (!view)
    throw new Error(
      `an ACR needs the Section 508 view; profile ${report.rollup.profile} does not have it`,
    );
  if (meta.reportDate !== undefined && !isAcrDate(meta.reportDate))
    throw new Error(
      `acr.reportDate must be a date written YYYY-MM-DD; got "${safeText(meta.reportDate, 50)}"`,
    );
  const cat = loadOpenAcrCatalog();
  const hashes = currentHashes(report.assets);
  const ctx: Context = {
    report,
    plain: options.plain ?? loadPlainData(),
    overridden: overriddenFails(report),
    current: (f) => isCurrentRecord(f, hashes),
    errata: errataFrom(options.data ?? loadStandardsData()),
  };

  const placed = new Set<string>();
  const tableNotes = new Map<string, string[]>();
  const tables: AcrTable[] = [];
  const omitted: AcrOmitted[] = [];
  for (const chapter of cat.chapters) {
    const standard = REPORTED[chapter.id];
    if (!standard) {
      omitted.push({
        id: chapter.id,
        label: chapter.label,
        reason: LEFT_OUT[chapter.id] ?? 'Widedoor does not report this chapter.',
      });
      continue;
    }
    const type = standard === 'wcag-2.0' ? 'wcag' : 'section508';
    const rows = chapter.criteria.flatMap((row): AcrRow[] => {
      const c = view.criteria.find((x) => x.type === type && x.id === row.id);
      if (!c) return [];
      placed.add(`${type}:${c.id}`);
      const title = row.handle ?? c.title;
      // 504.2 keeps a Not Applicable a reviewer recorded under 504.1 (not an authoring tool), as the template asks.
      if (
        type === 'section508' &&
        SEE_WCAG_ROWS[chapter.id]?.has(c.id) &&
        !(c.id === '504.2' && c.level === 'Not Applicable')
      )
        return [referenceRow(c.id, title, recordedText(ctx, c))];
      return [
        {
          id: c.id,
          title,
          components: type === 'wcag' ? wcagComponents(ctx, c, cat) : [section508Component(ctx, c)],
        },
      ];
    });
    if (rows.length === 0) {
      omitted.push({
        id: chapter.id,
        label: chapter.label,
        reason: `No row of it applies to the pages and files scanned under profile ${report.profile.id}${chapter.id === 'software' ? ' (Widedoor applies Chapter 5 to web pages only: a PDF is not software)' : ''}.`,
      });
      continue;
    }
    if (chapter.id === 'software') rows.unshift(referenceRow(SCOPE_501_1.id, SCOPE_501_1.title));
    const notes: string[] = [];
    tableNotes.set(chapter.id, notes);
    tables.push({ id: chapter.id, label: chapter.label, standard, notes, rows });
  }

  const notes = [`Generated by Widedoor ${safeText(report.tool.version, 50)}.`];
  // Roll-up rows the catalog has no row for (502.3 and 503.4 are heading rows in the template).
  for (const c of view.criteria) {
    if (placed.has(`${c.type}:${c.id}`)) continue;
    const name = `${c.type === 'wcag' ? 'WCAG' : 'Section 508'} ${c.id} ${c.title}`;
    const where =
      c.type === 'section508' && HEADING_ROWS.has(c.id)
        ? 'is a heading row in the template (no response required)'
        : 'has no row of its own in the template';
    const text = `${name} ${where}; the roll-up reads ${c.level}: ${sentence(safeText(c.reason, 2000))}`;
    const at =
      c.type === 'section508' ? tableNotes.get(CHAPTER_OF[c.id[0] ?? ''] ?? '') : undefined;
    if (at) at.push(text);
    else notes.push(text);
  }
  const wcagRows = tables.filter((t) => t.standard === 'wcag-2.0').flatMap((t) => t.rows);
  const columns = new Set(wcagRows.flatMap((r) => r.components.map((c) => c.id)));
  for (const col of COLUMNS)
    if (wcagRows.length > 0 && !columns.has(col.id))
      notes.push(
        `No ${col.noun} was in scope, so the WCAG tables have no ${cat.components.find((x) => x.id === col.id)?.label ?? col.id} column.`,
      );
  notes.push(
    'The Software and Authoring Tool columns are left out: Widedoor tests web pages and PDFs, not software or authoring tools. Chapter 5 rows are reported for the web pages scanned, each with the condition under which it applies; a reviewer marks a row Not Applicable when its condition does not hold.',
  );
  if (wcagRows.length > 0) notes.push(SUPPORT_DOCS_NOTE);
  const terms = (Object.keys(TERMS) as ConformanceLevel[]).map((level): AcrTerm => {
    const t = cat.terms.find((x) => x.id === ACR_TERM_IDS[level]);
    if (!t) throw new Error(`the OpenACR catalog has no term ${ACR_TERM_IDS[level]}`);
    return { id: ACR_TERM_IDS[level], label: level, template: t.description, ...TERMS[level] };
  });
  notes.push(
    `Widedoor's terms differ from the template's definitions, as the template allows when the notes say so. ${terms
      .filter((t) => t.deviates)
      .map((t) => `${t.label}: ${t.definition}`)
      .join(' ')}`,
  );

  const safe = safeMeta(meta, meta.reportDate ?? report.finishedAt.slice(0, 10));
  // The metadata as given: safe text turns a tab into "\x09", which is not blank.
  const incomplete = incompleteOf(report, meta, tables);
  return {
    meta: safe,
    edition: ACR_EDITION,
    catalog: OPENACR_CATALOG_ID,
    generated: report.finishedAt,
    tool: { name: 'widedoor', version: report.tool.version },
    tables,
    omitted,
    complete: incomplete.length === 0,
    incomplete,
    undecided: undecidedRows(tables),
    methods: methodsOf(report),
    terms,
    notes,
    disclaimer: DISCLAIMER,
  };
}
