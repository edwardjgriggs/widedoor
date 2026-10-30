import { createHash } from 'node:crypto';
import { loadStandardsData, type Finding, type Impact } from '@widedoor/core';
import {
  aiSuggestable,
  loadPlainData,
  overriddenFails,
  type PlainData,
  type ScanReport,
} from '@widedoor/report';
import { SentRecordSchema, type AiLimits, type SentRecord } from './model.js';
import { escapeUntrustedTags } from './prompt.js';
import {
  redactSelector,
  redactSnippet,
  redactText,
  toRedactions,
  type Counts,
  type RedactionKind,
} from './redact.js';

/*
 * What is sent: one request per group of identical problems (ruling 3).
 * Only current automated fails that no reviewer set aside get a group
 * (ruling 2; manual records carry a reviewer's own text and are never sent).
 * A request holds the rule, its criteria, the redacted selector and snippet
 * (web) or page and structure path (PDF, ruling 4: no document text) and
 * Widedoor's plain-language text. Never the asset URI, page URL or report
 * path (ruling 5). The report is read, never changed.
 */

export interface FixGroup {
  /** First 16 hex digits of the SHA-256 of the group preimage (see groupKey). */
  id: string;
  /** Every finding the answer applies to, sorted and without repeats. */
  findingIds: string[];
  /** What the request sends, built from the member with the lowest finding id. */
  request: SentRecord;
}

const IMPACT_RANK: Record<Impact, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const NO_IMPACT = 4;

/**
 * Standard structure types of PDF 1.7 (ISO 32000-1, 14.8.4) and PDF 2.0
 * (ISO 32000-2, 14.8.4), plus K, the path step for a kid with no type. A
 * structure path is sent outside the untrusted block as Widedoor's own text,
 * but its step names come from the document, so any other name is sent as
 * Custom (a document could name a type "Ignore_all_previous_instructions").
 */
export const STANDARD_STRUCTURE_TYPES: ReadonlySet<string> = new Set([
  'Document',
  'DocumentFragment',
  'Part',
  'Art',
  'Sect',
  'Div',
  'BlockQuote',
  'Caption',
  'TOC',
  'TOCI',
  'Index',
  'NonStruct',
  'Private',
  'Aside',
  'Title',
  'FENote',
  'Sub',
  'P',
  'H',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'L',
  'LI',
  'Lbl',
  'LBody',
  'Table',
  'TR',
  'TH',
  'TD',
  'THead',
  'TBody',
  'TFoot',
  'Span',
  'Quote',
  'Note',
  'Reference',
  'BibEntry',
  'Code',
  'Link',
  'Annot',
  'Ruby',
  'RB',
  'RT',
  'RP',
  'Warichu',
  'WT',
  'WP',
  'Figure',
  'Formula',
  'Form',
  'Em',
  'Strong',
  'Artifact',
  'K',
]);

/** Each step "Name[index]" (or a bare "Name") keeps its index; a non-standard name, or a step not of that form (a cut tail), becomes Custom. */
export function standardStructPath(path: string, counts: Counts): string {
  return path
    .split('/')
    .map((step) => {
      const m = /^([^[\]]+)(?:\[(\d+)\])?$/.exec(step);
      // PDF 2.0 allows headings past H6 (Hn).
      if (m && (STANDARD_STRUCTURE_TYPES.has(m[1] ?? '') || /^H[1-9]\d*$/.test(m[1] ?? '')))
        return step;
      const kind: RedactionKind = 'structure-type';
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      return m?.[2] !== undefined ? `Custom[${m[2]}]` : 'Custom';
    })
    .join('/');
}

/** An engine or rule id as Widedoor writes them; anything else in a report file is untrusted. */
const TRUSTED_ID = /^[\w.:-]{1,100}$/;
/** The rule id sent when the report's own is not trusted. */
export const UNRECOGNISED_RULE = 'unrecognised';

let known: { wcag: ReadonlySet<string>; section508: ReadonlySet<string> } | undefined;
/** The WCAG criteria and Section 508 provisions Widedoor knows. */
const knownCriteria = () => {
  if (!known) {
    const data = loadStandardsData();
    known = {
      wcag: new Set(data.wcag.criteria.map((c) => c.id)),
      section508: new Set(data.section508.provisions.map((p) => p.id)),
    };
  }
  return known;
};

/** The finding's criteria Widedoor knows, labelled, and the rest as written (untrusted). */
function criteriaOf(f: Finding): { trusted: string[]; other: string[] } {
  const k = knownCriteria();
  const wcag = f.criteria.wcag ?? [];
  const s508 = f.criteria.section508 ?? [];
  return {
    trusted: [
      ...wcag.filter((id) => k.wcag.has(id)).map((id) => `WCAG ${id}`),
      ...s508.filter((id) => k.section508.has(id)).map((id) => `Section 508 ${id}`),
    ],
    other: [
      ...wcag.filter((id) => !k.wcag.has(id)).map((id) => `WCAG ${id}`),
      ...s508.filter((id) => !k.section508.has(id)).map((id) => `Section 508 ${id}`),
    ],
  };
}

/** The request for one finding, with every scanned string redacted. */
function requestFor(f: Finding, plain: PlainData): SentRecord {
  const counts: Counts = new Map();
  // A report file can be crafted (security M1): the rule id is trusted only as an id
  // Widedoor writes for one of its engines, and the plain text comes from Widedoor's own
  // data by it, never from finding.plain. The rest is sent only as untrusted data.
  const engine = f.source.engine;
  // Trusted only as an id that exists: the id shape, a known engine, and a rule in its data
  // (an id-shaped "SYSTEM:override" under axe-core is not one).
  const rules =
    engine !== 'manual' && Object.hasOwn(plain, engine)
      ? plain[engine as keyof PlainData]
      : undefined;
  const trusted =
    TRUSTED_ID.test(f.source.ruleId) && rules !== undefined && rules.has(f.source.ruleId);
  const text = trusted ? rules?.get(f.source.ruleId) : undefined;
  const criteria = criteriaOf(f);
  // Everything bound for the untrusted block is recorded with its tag escape already applied,
  // so the record matches the bytes sent (prompt.ts escapeUntrustedTags is idempotent).
  const reportRule = trusted
    ? undefined
    : escapeUntrustedTags(redactText(f.source.ruleId, counts).slice(0, 300));
  const reportCriteria = criteria.other.map((c) =>
    escapeUntrustedTags(redactText(c, counts).slice(0, 100)),
  );
  const base = {
    ruleId: trusted ? f.source.ruleId : UNRECOGNISED_RULE,
    criteria: criteria.trusted,
    assetKind: f.asset.kind,
    ...(reportRule ? { reportRule } : {}),
    ...(reportCriteria.length > 0 ? { reportCriteria } : {}),
  };
  const plainText = text
    ? { plain: { what: redactText(text.what, counts), fix: redactText(text.fix, counts) } }
    : {};
  let located: Partial<SentRecord>;
  if ('selector' in f.location) {
    const selector = escapeUntrustedTags(redactSelector(f.location.selector, counts));
    let snippet = '';
    if (f.evidence?.snippet) {
      const redacted = redactSnippet(f.evidence.snippet);
      snippet = escapeUntrustedTags(redacted.html);
      for (const r of redacted.redactions) counts.set(r.kind, (counts.get(r.kind) ?? 0) + r.count);
    }
    located = { ...(selector ? { selector } : {}), ...(snippet ? { snippet } : {}) };
  } else {
    const { page, structPath } = f.location;
    const path = structPath === undefined ? '' : standardStructPath(structPath, counts);
    located = { ...(page !== undefined ? { page } : {}), ...(path ? { structPath: path } : {}) };
  }
  return SentRecordSchema.parse({
    ...base,
    ...located,
    ...plainText,
    redactions: toRedactions(counts),
  });
}

/**
 * The group preimage, exactly: for web findings the rule id, a NUL and the
 * redacted snippet; when that snippet is empty or was cut (its redactions
 * include unparsed or truncated), a second NUL and the redacted selector
 * follow, so two different cut-off elements of one rule stay apart. For PDF
 * findings: the rule id, a NUL and the redacted structure path. A missing
 * part is an empty string. NUL cannot occur in a rule id.
 */
function groupKey(r: SentRecord): string {
  // An unrecognised rule keeps its own groups: its report text is part of the key.
  if (r.reportRule !== undefined)
    return `${r.ruleId}\u0000${r.reportRule}\u0000${r.snippet ?? ''}\u0000${r.selector ?? ''}\u0000${r.structPath ?? ''}`;
  if (r.assetKind === 'pdf') return `${r.ruleId}\u0000${r.structPath ?? ''}`;
  const cut = r.redactions.some((x) => x.kind === 'unparsed' || x.kind === 'truncated');
  if (r.snippet && !cut) return `${r.ruleId}\u0000${r.snippet}`;
  return `${r.ruleId}\u0000${r.snippet ?? ''}\u0000${r.selector ?? ''}`;
}

const sha16 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Groups the report's fails for sending: critical first, then larger groups,
 * then by group id, capped at limits.maxGroups. The same report gives the
 * same groups in the same order whatever its finding order.
 */
export function buildGroups(
  report: ScanReport,
  limits: AiLimits,
  options: { plain?: PlainData } = {},
): { groups: FixGroup[]; skipped: number } {
  const plain = options.plain ?? loadPlainData();
  const wanted = aiSuggestable(overriddenFails(report));
  const groups = new Map<
    string,
    { lead: Finding; request: SentRecord; ids: Set<string>; rank: number }
  >();
  for (const f of report.findings) {
    if (!wanted(f)) continue;
    const request = requestFor(f, plain);
    const id = sha16(groupKey(request));
    const rank = f.impact ? IMPACT_RANK[f.impact] : NO_IMPACT;
    const group = groups.get(id);
    if (!group) {
      groups.set(id, { lead: f, request, ids: new Set([f.id]), rank });
      continue;
    }
    group.ids.add(f.id);
    group.rank = Math.min(group.rank, rank);
    if (f.id < group.lead.id) Object.assign(group, { lead: f, request });
  }
  const sorted = [...groups]
    .map(([id, g]) => ({ id, rank: g.rank, findingIds: [...g.ids].sort(), request: g.request }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        b.findingIds.length - a.findingIds.length ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map(({ id, findingIds, request }) => ({ id, findingIds, request }));
  return {
    groups: sorted.slice(0, limits.maxGroups),
    skipped: Math.max(0, sorted.length - limits.maxGroups),
  };
}
