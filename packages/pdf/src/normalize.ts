import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  FindingSchema,
  findingId,
  type Asset,
  type Engine,
  type Finding,
  type Impact,
  type Outcome,
  type VerapdfMap,
  type WidedoorMap,
} from '@widedoor/core';
import type { PdfInspection } from './inspect.js';
import { VERAPDF_VERSION, type ProcessResult } from './verapdf.js';

/** Longest evidence snippet kept. Stored raw; reports escape it when rendering. */
export const SNIPPET_MAX = 300;
/** Longest structPath kept; a longer one is cut and given a hash of the full text. */
export const STRUCT_PATH_MAX = 500;
/** Default page count from which a document is long and should have bookmarks. */
export const DEFAULT_LONG_DOCUMENT_PAGES = 10;

type PdfLocation = { page?: number; structPath?: string };

/** Cuts to at most `max` UTF-16 units without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * C0 and C1 controls (except tab and newline), and the bidi embedding,
 * override and isolate marks: text from a PDF that could restyle or reorder
 * what a terminal or report shows.
 */
const range = (from: number, to: number) =>
  `${String.fromCharCode(from)}-${String.fromCharCode(to)}`;
const UNSAFE_CHARS = new RegExp(
  `[${[
    [0x00, 0x08],
    [0x0b, 0x1f],
    [0x7f, 0x9f],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
  ]
    .map(([a, b]) => range(a!, b!))
    .join('')}]`,
  'g',
);
/** U+FFFD REPLACEMENT CHARACTER. */
const REPLACEMENT = String.fromCharCode(0xfffd);

/** Makes PDF-derived text safe to store: unsafe characters become U+FFFD, then it is capped. */
export function truncateSnippet(text: string, max = SNIPPET_MAX): string {
  const clean = text.replace(UNSAFE_CHARS, REPLACEMENT);
  return clean.length <= max ? clean : `${cut(clean, max - 3)}...`;
}

const CheckSchema = z.object({
  status: z.string(),
  context: z.string(),
  errorMessage: z.string().nullish(),
});

const RuleSummarySchema = z.object({
  specification: z.string(),
  clause: z.string(),
  testNumber: z.number().int(),
  status: z.enum(['passed', 'failed']),
  passedChecks: z.number().int().min(0),
  failedChecks: z.number().int().min(0),
  checks: z.array(CheckSchema).optional(),
});
export type VerapdfRuleSummary = z.infer<typeof RuleSummarySchema>;

/** The parts of a veraPDF 1.30 JSON report (--format json --success) that Widedoor reads. */
export const VerapdfReportSchema = z.object({
  report: z.object({
    buildInformation: z.object({
      releaseDetails: z.array(z.object({ id: z.string(), version: z.string() })),
    }),
    jobs: z
      .array(
        z.object({
          validationResult: z
            .array(
              z.object({
                jobEndStatus: z.string().optional(),
                details: z.object({ ruleSummaries: z.array(RuleSummarySchema) }),
              }),
            )
            .optional(),
        }),
      )
      .min(1),
    batchSummary: z
      .object({
        failedParsingJobs: z.number().optional(),
        failedEncryptedJobs: z.number().optional(),
      })
      .optional(),
  }),
});
export type VerapdfReport = z.infer<typeof VerapdfReportSchema>;

export type VerapdfErrorCode =
  'timeout' | 'output-too-large' | 'malformed-pdf' | 'encrypted-pdf' | 'verapdf-failed';

export type ParsedVerapdfOutput =
  { ok: true; report: VerapdfReport } | { ok: false; code: VerapdfErrorCode; message: string };

/** veraPDF CLI exit codes (org.verapdf.apps.utils.ApplicationUtils): 0 compliant, 1 not compliant. */
export const VERAPDF_EXIT = {
  compliant: 0,
  notCompliant: 1,
  parseFailed: 7,
  encrypted: 8,
} as const;

/**
 * Reads one veraPDF run. The decision uses only structured signals: the exit
 * code, then the JSON report's own status fields. Report text is never
 * searched, since its messages echo names and strings from the PDF.
 */
export function parseVerapdfOutput(run: ProcessResult): ParsedVerapdfOutput {
  if (run.timedOut)
    return { ok: false, code: 'timeout', message: 'veraPDF did not finish in time' };
  if (run.truncated)
    return { ok: false, code: 'output-too-large', message: 'veraPDF output passed maxOutputBytes' };
  if (run.exitCode === VERAPDF_EXIT.parseFailed)
    return { ok: false, code: 'malformed-pdf', message: 'veraPDF could not parse the PDF' };
  if (run.exitCode === VERAPDF_EXIT.encrypted)
    return { ok: false, code: 'encrypted-pdf', message: 'veraPDF cannot read an encrypted PDF' };
  if (run.exitCode !== VERAPDF_EXIT.compliant && run.exitCode !== VERAPDF_EXIT.notCompliant)
    return { ok: false, code: 'verapdf-failed', message: `veraPDF exited with ${run.exitCode}` };
  let json: unknown;
  try {
    json = JSON.parse(run.stdout);
  } catch {
    return { ok: false, code: 'verapdf-failed', message: 'veraPDF did not print a JSON report' };
  }
  const parsed = VerapdfReportSchema.safeParse(json);
  if (!parsed.success)
    return { ok: false, code: 'verapdf-failed', message: 'veraPDF printed an unexpected report' };
  const report = parsed.data.report;
  const result = report.jobs[0]?.validationResult?.[0];
  if (!result) {
    if (report.batchSummary?.failedEncryptedJobs)
      return { ok: false, code: 'encrypted-pdf', message: 'veraPDF cannot read an encrypted PDF' };
    if (report.batchSummary?.failedParsingJobs)
      return { ok: false, code: 'malformed-pdf', message: 'veraPDF could not parse the PDF' };
    return { ok: false, code: 'verapdf-failed', message: 'veraPDF reported no validation result' };
  }
  if (result.jobEndStatus !== undefined && result.jobEndStatus !== 'normal')
    return { ok: false, code: 'verapdf-failed', message: 'veraPDF did not end the job normally' };
  return { ok: true, report: parsed.data };
}

/** A veraPDF rule with no WCAG relation (verapdf-map.yaml `unmapped`): run metadata, not a Finding. */
export interface InformationalResult {
  uri: string;
  engine: 'verapdf';
  ruleId: string;
  outcome: 'pass' | 'fail' | 'not-applicable';
  reason: string;
}

const checks = (n: number) => `${n} ${n === 1 ? 'check' : 'checks'}`;

const STEP = /^K\[(\d+)\](?:\([^)]*?\b(?:SE\w+)\s+([^)\s]+)\))?$/;

/**
 * Location of one veraPDF check from its context: the 1-based page for
 * content on a page, a structure path such as "Document[0]/Figure[3]" for a
 * structure element (each step is the structure type and its index among its
 * parent's kids), else the document.
 */
export function locationFromContext(context: string): PdfLocation {
  const page = /\/pages\[(\d+)\]/.exec(context);
  if (page) return { page: Number(page[1]) + 1 };
  const at = context.indexOf('StructTreeRoot[');
  if (at >= 0) {
    const steps = context
      .slice(at)
      .split('/')
      .slice(1)
      .map((s) => STEP.exec(s))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => `${(m[2] ?? 'K').replace(/[^\w:.-]/g, '_').slice(0, 64)}[${m[1]}]`);
    if (steps.length > 0) {
      const path = steps.join('/');
      if (path.length <= STRUCT_PATH_MAX) return { structPath: path };
      const hash = createHash('sha256').update(path).digest('hex').slice(0, 16);
      const suffix = `... [sha256:${hash}]`;
      return { structPath: `${cut(path, STRUCT_PATH_MAX - suffix.length)}${suffix}` };
    }
  }
  return {};
}

function build(
  asset: Asset,
  location: PdfLocation,
  engine: Exclude<Engine, 'manual' | 'axe-core'>,
  engineVersion: string,
  ruleId: string,
  rule: { wcag: readonly string[]; impact: Impact },
  outcome: Outcome,
  snippet?: string,
): Finding {
  const isFinding = outcome === 'fail' || outcome === 'needs-review';
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(asset.uri, location, engine, ruleId),
    asset,
    location,
    source: { engine, engineVersion, ruleId },
    criteria: { wcag: [...rule.wcag] },
    outcome,
    ...(isFinding ? { impact: rule.impact } : {}),
    ...(isFinding && snippet !== undefined
      ? { evidence: { snippet: truncateSnippet(snippet) } }
      : {}),
  });
}

export interface NormalizedVerapdf {
  version: string;
  findings: Finding[];
  informational: InformationalResult[];
}

/**
 * Turns a veraPDF report into Finding records via verapdf-map.yaml. A failed
 * rule gives one fail per location (page, structure element or document) among
 * the checks veraPDF listed; a passed rule gives one document-level pass, or
 * not-applicable when no object was checked. Rules in the map's `unmapped`
 * section become informational results. A rule in neither section, another
 * specification or another veraPDF version is an error: the map is the only
 * source of criteria.
 */
export function normalizeVerapdfReport(
  { report }: VerapdfReport,
  asset: Asset,
  map: VerapdfMap,
): NormalizedVerapdf {
  const version = report.buildInformation.releaseDetails.find((d) => d.id === 'core')?.version;
  if (version !== VERAPDF_VERSION)
    throw new Error(`veraPDF ${version} ran, but Widedoor is pinned to ${VERAPDF_VERSION}`);
  const mapped = new Map(map.rules.map((r) => [r.id, r]));
  const unmapped = new Map(map.unmapped.map((r) => [r.id, r]));
  const summaries = report.jobs[0]?.validationResult?.[0]?.details.ruleSummaries ?? [];
  const findings = new Map<string, Finding>();
  const informational: InformationalResult[] = [];

  for (const s of summaries) {
    if (s.specification !== map.meta.specification)
      throw new Error(
        `veraPDF rule for ${s.specification}; verapdf-map.yaml is for ${map.meta.specification}`,
      );
    const ruleId = `${s.clause}-${s.testNumber}`;
    const outcome: InformationalResult['outcome'] =
      s.status === 'failed' ? 'fail' : s.passedChecks > 0 ? 'pass' : 'not-applicable';
    const entry = mapped.get(ruleId);
    if (!entry) {
      const info = unmapped.get(ruleId);
      if (!info) throw new Error(`veraPDF rule ${ruleId} is not in verapdf-map.yaml`);
      informational.push({
        uri: asset.uri,
        engine: 'verapdf',
        ruleId,
        outcome,
        reason: info.reason,
      });
      continue;
    }
    if (outcome !== 'fail') {
      const f = build(asset, {}, 'verapdf', version, ruleId, entry, outcome);
      findings.set(f.id, f);
      continue;
    }
    const failed = (s.checks ?? []).filter((c) => c.status === 'failed');
    const groups = new Map<string, { location: PdfLocation; messages: string[] }>();
    for (const c of failed) {
      const location = locationFromContext(c.context);
      const k = JSON.stringify(location);
      const g = groups.get(k) ?? { location, messages: [] };
      g.messages.push(c.errorMessage ?? s.clause);
      groups.set(k, g);
    }
    if (groups.size === 0) groups.set('{}', { location: {}, messages: [] });
    // The count of checks veraPDF did not list belongs to the rule, so it goes on its first finding.
    let unlisted = s.failedChecks - failed.length;
    for (const { location, messages } of groups.values()) {
      const parts = [messages[0] ?? `${checks(s.failedChecks)} failed`];
      if (messages.length > 1) parts.push(`(${checks(messages.length)} failed here)`);
      if (unlisted > 0 && messages.length > 0) {
        parts.push(`(${checks(unlisted)} more failed for this rule, not listed)`);
        unlisted = 0;
      }
      const f = build(asset, location, 'verapdf', version, ruleId, entry, 'fail', parts.join(' '));
      findings.set(f.id, f);
    }
  }
  return { version, findings: [...findings.values()], informational };
}

/** Rule ids of the Widedoor PDF checks and review items (widedoor-map.yaml). */
export const WIDEDOOR_RULES = {
  title: 'pdf-title-displayed',
  language: 'pdf-language',
  imageOnly: 'pdf-image-only',
  bookmarks: 'pdf-bookmarks',
  readingOrder: 'pdf-reading-order',
  altText: 'pdf-alt-text-quality',
  tables: 'pdf-table-logic',
} as const;

/**
 * A well-formed BCP 47 tag that names a language: "und" (undetermined) and
 * private-use tags ("x-...", "qaa" to "qtz") are well formed but name none.
 */
export function isValidLanguageTag(tag: string): boolean {
  if (!/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(tag)) return false;
  const primary = tag.split('-')[0]!.toLowerCase();
  if (primary === 'und' || primary === 'x' || /^q[a-t][a-z]$/.test(primary)) return false;
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
}

export interface WidedoorCheckOptions {
  /** Page count from which bookmarks are expected. Default 10. */
  longDocumentPages?: number;
}

/**
 * Widedoor's own PDF checks, from what pdf.js read:
 *   pdf-title-displayed  fail unless a title is set and DisplayDocTitle is true
 *   pdf-language         fail unless the catalog /Lang names a language
 *   pdf-image-only       one fail per page that draws an image and has no text; else a pass
 *   pdf-bookmarks        not-applicable under longDocumentPages; else pass with an outline,
 *                        needs-review without (PDF2 is advisory for 2.4.5)
 * and the review items automation cannot decide, once per document:
 *   pdf-reading-order    needs-review for every tagged PDF
 *   pdf-alt-text-quality needs-review when the structure has a Figure (or was too large to read)
 *   pdf-table-logic      needs-review when the structure has a Table (or was too large to read)
 * Every fail and needs-review carries the rule's default impact from the map.
 */
export function widedoorFindings(
  info: PdfInspection,
  asset: Asset,
  map: WidedoorMap,
  engineVersion: string,
  options: WidedoorCheckOptions = {},
): Finding[] {
  const long = options.longDocumentPages ?? DEFAULT_LONG_DOCUMENT_PAGES;
  const rules = new Map(map.rules.map((r) => [r.id, r]));
  const out: Finding[] = [];
  const add = (ruleId: string, outcome: Outcome, snippet?: string, location: PdfLocation = {}) => {
    const rule = rules.get(ruleId);
    if (!rule) throw new Error(`Widedoor rule ${ruleId} is not in widedoor-map.yaml`);
    out.push(build(asset, location, 'widedoor', engineVersion, ruleId, rule, outcome, snippet));
  };

  if (info.title === null)
    add(WIDEDOOR_RULES.title, 'fail', 'No document title (Info Title or XMP dc:title).');
  else if (!info.displayDocTitle)
    add(
      WIDEDOOR_RULES.title,
      'fail',
      `Title "${info.title}" is set, but DisplayDocTitle is not true, so viewers show the file name.`,
    );
  else add(WIDEDOOR_RULES.title, 'pass');

  if (info.lang === null)
    add(
      WIDEDOOR_RULES.language,
      'fail',
      'No /Lang entry in the document catalog (the only place this check reads; a /Lang on a structure element does not set the document language).',
    );
  else if (!isValidLanguageTag(info.lang))
    add(
      WIDEDOOR_RULES.language,
      'fail',
      `Catalog /Lang "${info.lang}" does not name a language (malformed, undetermined or private use).`,
    );
  else add(WIDEDOOR_RULES.language, 'pass');

  for (const page of info.imageOnlyPages)
    add(WIDEDOOR_RULES.imageOnly, 'fail', 'The page is an image with no text layer.', { page });
  if (info.imageOnlyPages.length === 0) add(WIDEDOOR_RULES.imageOnly, 'pass');

  if (info.pages < long) add(WIDEDOOR_RULES.bookmarks, 'not-applicable');
  else if (info.outlineItems > 0) add(WIDEDOOR_RULES.bookmarks, 'pass');
  else
    add(
      WIDEDOOR_RULES.bookmarks,
      'needs-review',
      `${info.pages} pages and no bookmarks; check that readers can move through the document another way.`,
    );

  if (info.tagged)
    add(
      WIDEDOOR_RULES.readingOrder,
      'needs-review',
      'Check that the tag order matches the visual reading order.',
    );
  // A structure tree too large to read in full may hold Figures and Tables past the budget.
  const maybe = (type: string) => info.structureTypes.includes(type) || info.structureTruncated;
  if (maybe('Figure'))
    add(
      WIDEDOOR_RULES.altText,
      'needs-review',
      'Check that each Figure has alt text that serves the same purpose as the image.',
    );
  if (maybe('Table'))
    add(
      WIDEDOOR_RULES.tables,
      'needs-review',
      'Check that table header cells are tagged TH and that rows and columns read in a logical order.',
    );
  return out;
}
