import {
  currentHashes,
  isCurrentRecord,
  type Asset,
  type Finding,
  type Plain,
} from '@widedoor/core/browser';
import {
  SCOPE_ERROR_CODES,
  ordinal,
  type RunError,
  type ScanReport,
  type SkippedAsset,
} from './model.js';
import {
  IMPACT_ORDER,
  type ImpactOrUnrated,
  type NotEvaluated,
  type ReportSummary,
} from './summary.js';

/*
 * What the HTML report and the local UI show, as data: labels, the finding
 * cards, per-asset finding order, unscanned assets, exception notes and the
 * manual review records, and every fixed sentence. Both renderers build their
 * markup from these, so the two never disagree on wording, grouping or order.
 * Sentences that wrap a URI in markup are split around it. No Node built-ins:
 * the UI bundles it.
 */

export const IMPACT_LABEL: Record<ImpactOrUnrated, string> = {
  critical: 'Critical',
  serious: 'Serious',
  moderate: 'Moderate',
  minor: 'Minor',
  unrated: 'Impact not rated',
};

export const STANDARD_LABEL: Record<string, string> = {
  '508': 'Section 508',
  wcag21aa: 'WCAG 2.1 Level AA',
};

const ENGINE_LABEL: Record<string, string> = {
  'axe-core': 'axe-core',
  verapdf: 'veraPDF',
  widedoor: 'Widedoor PDF checks',
  manual: 'Manual review',
};

export const engineName = (engine: string) => ENGINE_LABEL[engine] ?? engine;
export const impactRank = (f: Finding) => IMPACT_ORDER.indexOf(f.impact ?? 'unrated');
/** Outcomes the report lists one by one: fails and needs-review. */
export const isShown = (f: Finding) => f.outcome === 'fail' || f.outcome === 'needs-review';

type AssetHashes = readonly Pick<Asset, 'uri' | 'contentHash'>[];

/**
 * The findings the report lists one by one: fails and needs-review that are
 * current (isCurrentRecord). An expired manual record is listed only under
 * the methodology, with the expired note.
 */
export function listedFindings(findings: readonly Finding[], assets: AssetHashes): Finding[] {
  const hashes = currentHashes(assets);
  return findings.filter((f) => isShown(f) && isCurrentRecord(f, hashes));
}
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Skipped pages listed one by one at most; the rest are counted (the JSON report has them all). */
export const MAX_SKIPPED_LISTED = 20;

export const moreSkippedText = (n: number) =>
  `${plural(n, 'more skipped page or file is', 'more skipped pages and files are')} listed in the JSON report.`;

/** One card per engine rule: the records it groups and how bad the worst one is. */
export interface FindingCard {
  engine: string;
  ruleId: string;
  /** The first record, which supplies the plain-language text and the rule version. */
  first: Finding;
  /** Index into IMPACT_ORDER of the worst impact. */
  worst: number;
  fails: number;
  reviews: number;
  assets: Set<string>;
  wcag: Set<string>;
  section508: Set<string>;
}

/** The "What to fix first" cards: listed findings grouped by rule, worst impact first. */
export function findingCards(findings: readonly Finding[], assets: AssetHashes): FindingCard[] {
  const byRule = new Map<string, FindingCard>();
  for (const f of listedFindings(findings, assets)) {
    const key = `${f.source.engine}\u0000${f.source.ruleId}`;
    let card = byRule.get(key);
    if (!card) {
      card = {
        engine: f.source.engine,
        ruleId: f.source.ruleId,
        first: f,
        worst: impactRank(f),
        fails: 0,
        reviews: 0,
        assets: new Set(),
        wcag: new Set(),
        section508: new Set(),
      };
      byRule.set(key, card);
    }
    card.worst = Math.min(card.worst, impactRank(f));
    if (f.outcome === 'fail') card.fails++;
    else card.reviews++;
    card.assets.add(f.asset.uri);
    for (const id of f.criteria.wcag ?? []) card.wcag.add(id);
    for (const id of f.criteria.section508 ?? []) card.section508.add(id);
  }
  return [...byRule.values()].sort(
    (a, b) =>
      a.worst - b.worst ||
      Number(b.fails > 0) - Number(a.fails > 0) ||
      b.fails + b.reviews - (a.fails + a.reviews) ||
      ordinal(a.engine, b.engine) ||
      ordinal(a.ruleId, b.ruleId),
  );
}

export const cardImpact = (c: FindingCard): ImpactOrUnrated => IMPACT_ORDER[c.worst] ?? 'unrated';

/** Listed findings for one asset: worst impact first, fails before needs-review, then report order. */
export function assetFindings(
  findings: readonly Finding[],
  uri: string,
  assets: AssetHashes,
): Finding[] {
  return listedFindings(findings, assets)
    .map((f, order) => ({ f, order }))
    .filter(({ f }) => f.asset.uri === uri)
    .sort(
      (x, y) =>
        impactRank(x.f) - impactRank(y.f) ||
        Number(y.f.outcome === 'fail') - Number(x.f.outcome === 'fail') ||
        x.order - y.order,
    )
    .map(({ f }) => f);
}

/** An asset in scope that has no scan: it errored, or it was skipped. */
export type UnscannedAsset =
  { uri: string; kind: string; error: RunError } | { uri: string; kind: 'web'; skip: SkippedAsset };

/** Assets with a section of their own but no scan, in report order; skips past the listing cap are only counted. */
export function unscannedAssets(report: ScanReport): {
  unscanned: UnscannedAsset[];
  skippedOver: number;
} {
  const scanned = new Set(report.assets.map((a) => a.uri));
  const unscanned = new Map<string, UnscannedAsset>();
  for (const e of report.errors)
    if (!SCOPE_ERROR_CODES.has(e.code) && !scanned.has(e.uri) && !unscanned.has(e.uri))
      unscanned.set(e.uri, { uri: e.uri, kind: e.kind, error: e });
  let skippedOver = 0;
  let skippedShown = 0;
  for (const s of report.skipped)
    if (!scanned.has(s.uri) && !unscanned.has(s.uri)) {
      if (skippedShown >= MAX_SKIPPED_LISTED) {
        skippedOver++;
        continue;
      }
      skippedShown++;
      unscanned.set(s.uri, { uri: s.uri, kind: 'web', skip: s });
    }
  return { unscanned: [...unscanned.values()], skippedOver };
}

/** Where in the asset a finding is, in words. */
export function findingPlace(f: Finding): string {
  const loc = f.location;
  if ('selector' in loc) return `Element: ${loc.selector}`;
  const parts = [
    ...(loc.page !== undefined ? [`page ${loc.page}`] : []),
    ...(loc.structPath !== undefined ? [`tag path ${loc.structPath}`] : []),
  ];
  return parts.length ? `In the file: ${parts.join(', ')}` : 'The whole file';
}

export type Criterion = ScanReport['rollup']['standards'][number]['criteria'][number];

export interface ExceptionNote {
  provision: string;
  reason: string;
  kind: string;
  n: number;
}

/** Profile exceptions (such as E205.4) across a criterion's assets, one note per kind, provision and reason. */
export function exceptionNotes(c: Criterion): ExceptionNote[] {
  const exceptions = new Map<string, ExceptionNote>();
  for (const d of c.assets) {
    if (!d.exception) continue;
    const key = `${d.kind}\u0000${d.exception.provision}\u0000${d.exception.reason}`;
    const seen = exceptions.get(key) ?? { ...d.exception, kind: d.kind, n: 0 };
    seen.n++;
    exceptions.set(key, seen);
  }
  return [...exceptions.values()];
}

export const exceptionAssets = (e: ExceptionNote) =>
  e.kind === 'pdf' ? plural(e.n, 'PDF', 'PDFs') : plural(e.n, 'page', 'pages');

export interface ReviewRecord {
  reviewer: string;
  date?: string;
  outcome: string;
  /** "WCAG 1.1.1, Section 508 302.1" */
  criteria: string;
  uri: string;
  /** No review data, or the asset content changed since the review. */
  expired: boolean;
  notes?: string;
}

export interface Reviewer {
  name: string;
  records: number;
  /** Review dates, sorted. */
  dates: string[];
}

export const EXPIRED_NOTE =
  ' (expired: the content changed since this review, so the roll-up does not use it)';

/** Manual review records in report order, and the people who made them. */
export function manualReviews(report: ScanReport): {
  reviewers: Reviewer[];
  records: ReviewRecord[];
} {
  const hashes = currentHashes(report.assets);
  const people = new Map<string, { n: number; dates: Set<string> }>();
  const records = report.findings
    .filter((f) => f.source.engine === 'manual')
    .map((f): ReviewRecord => {
      const r = 'review' in f ? f.review : undefined;
      const name = r?.reviewer ?? 'Unknown reviewer';
      const entry = people.get(name) ?? { n: 0, dates: new Set<string>() };
      entry.n++;
      if (r) entry.dates.add(r.date);
      people.set(name, entry);
      return {
        reviewer: name,
        ...(r ? { date: r.date } : {}),
        outcome: f.outcome,
        criteria: [
          ...(f.criteria.wcag ?? []).map((id) => `WCAG ${id}`),
          ...(f.criteria.section508 ?? []).map((id) => `Section 508 ${id}`),
        ].join(', '),
        uri: f.asset.uri,
        expired: !isCurrentRecord(f, hashes),
        ...(r?.notes ? { notes: r.notes } : {}),
      };
    });
  const reviewers = [...people].map(([name, e]) => ({
    name,
    records: e.n,
    dates: [...e.dates].sort(ordinal),
  }));
  return { reviewers, records };
}

/** Fixed wording of the report. */
export const TEXT = {
  heading: {
    fix: 'What to fix first',
    byAsset: 'Results by page and file',
    summary: 'Summary',
    rollup: 'Results by criterion',
    method: 'How this was tested',
    disclaimer: 'About this report',
  },
  noFindings:
    'The automated checks found no problems and nothing to check by hand. That does not mean the content conforms: see the results by criterion and what was not tested below.',
  nothingScanned:
    'Nothing was scanned, so there are no results to show. See the scan errors and skipped pages below, and what was not tested.',
  nothingHere:
    'The automated checks found nothing here. Some criteria still need a person to test them.',
  noAssets: 'No page or file was in scope.',
  pdfUrlSkip:
    'Not scanned: PDFs linked by URL are not fetched yet. Download the file and scan it as a local PDF (pdf-url).',
  pdfUrlItem: ': a PDF link, not fetched (pdf-url)',
  emptyTitle: '(empty page title)',
  standardsAndRule: 'Standards and rule',
  whoAffects: 'Who this affects:',
  howToFix: 'How to fix it:',
  problem: 'Problem',
  checkByHand: 'Check by hand',
  screenshotAlt: 'Screenshot of the element this finding is about',
  truncated: 'The page limit was reached before every page was scanned.',
  notTestedLead:
    'Automated checks find only some accessibility problems. These criteria have no deciding result for at least one page or file and need a person to test them:',
  noReviewers: 'None. Every result in this report comes from automated checks.',
  none: 'None.',
  method: {
    tool: 'Tool',
    engines: 'Test engines',
    profile: 'Profile',
    dates: 'Dates',
    scope: 'Scope',
    notTested: 'What was not tested',
    reviewers: 'Reviewers',
    records: 'Manual review records',
    errors: 'Pages and files that could not be scanned',
    skipped: 'Pages skipped',
    warnings: 'Warnings',
    informational: 'Other PDF checks',
  },
  summary: {
    counts: 'Counts',
    what: 'What',
    number: 'Number',
    byImpact: 'Problems by impact',
    impact: 'Impact',
    problems: 'Problems',
    toCheck: 'To check by hand',
  },
  rollupColumns: ['Criterion', 'Name', 'Result', 'Why'],
} as const;

/** The rows of the Counts table. */
export const summaryRows = (s: ReportSummary): [string, number][] => [
  ['Problems found (fail)', s.outcomes.fail],
  ['Items to check by hand (needs review)', s.outcomes['needs-review']],
  ['Criteria not tested (no deciding result)', s.notTested],
  ['Pages and files scanned', s.assets],
  ['Pages and files that could not be scanned', s.errors],
  ['Pages skipped', s.skipped],
];

/** The lead line under the page heading. */
export const leadText = (report: ScanReport) =>
  `Profile ${report.profile.id}. ${plural(report.assets.length, 'page or file', 'pages and files')} scanned, finished ${report.finishedAt}.`;

export const cardHeading = (c: FindingCard, p: Plain | undefined) =>
  p?.what ?? `${engineName(c.engine)} rule ${c.ruleId} reported a problem.`;

/** The badges of a card: impact, problem count, check-by-hand count (each only when not zero), assets. */
export const cardBadges = (c: FindingCard) => ({
  impact: IMPACT_LABEL[cardImpact(c)],
  fails: c.fails > 0 ? plural(c.fails, 'problem', 'problems') : undefined,
  reviews: c.reviews > 0 ? `${plural(c.reviews, 'item', 'items')} to check by hand` : undefined,
  assets: plural(c.assets.size, 'page or file', 'pages or files'),
});

export const findingHeading = (f: Finding, p: Plain | undefined) =>
  p?.what ?? `${engineName(f.source.engine)} rule ${f.source.ruleId}`;

export const smallScreenText = (v: { width: number; height: number }) =>
  `Seen only on a small screen (${v.width} by ${v.height} pixels).`;

/** "2 problems, 1 item to check by hand." for one asset's shown findings. */
export function assetCounts(found: readonly Finding[]): string {
  const fails = found.filter((f) => f.outcome === 'fail').length;
  return `${plural(fails, 'problem', 'problems')}, ${plural(found.length - fails, 'item', 'items')} to check by hand.`;
}

export const assetKindText = (kind: string) => (kind === 'web' ? 'Web page' : 'PDF');

export const crawlText = (crawl: { sameOrigin: boolean; maxPages: number }) =>
  `Followed links ${crawl.sameOrigin ? 'on the same site' : 'to any site'}, up to ${crawl.maxPages} pages`;

export function notTestedText(u: NotEvaluated): string {
  if (u.product)
    return `${u.id} ${u.title}: judged for the product as a whole, not evaluated (${u.reason})`;
  if (u.count === 0) return `${u.id} ${u.title}: not evaluated (${u.reason})`;
  return `${u.id} ${u.title}: ${u.count} of ${plural(u.total, 'page or file', 'pages and files')} not evaluated`;
}

export const reviewerText = (p: Reviewer) =>
  `${p.name}: ${plural(p.records, 'record', 'records')}, reviewed ${p.dates.join(', ')}`;

/** The part of a review record before its URI. */
export const recordText = (r: ReviewRecord) =>
  `${r.reviewer}, ${r.date ?? 'no date'}: ${r.outcome} for ${r.criteria} on `;

export const engineText = (e: ScanReport['engines'][number]) =>
  `${engineName(e.name)} ${e.version}${e.runner ? ` (${e.runner} runner)` : ''}`;

/** The part of a scan error after its URI. */
export const errorText = (e: RunError) =>
  `: ${e.code}${e.engine ? ` (${engineName(e.engine)})` : ''}, ${e.message}`;

export const profileText = (report: ScanReport) =>
  `${report.profile.id}, with PDFs treated as ${report.profile.pdfDocumentType === 'non-web' ? 'non-web documents' : 'web content'}`;

export const datesText = (report: ScanReport) =>
  `Started ${report.startedAt}, finished ${report.finishedAt} (UTC)`;

export const informationalText = (n: number) =>
  `veraPDF results for rules with no WCAG link: ${n}. The JSON report lists them.`;

export const exceptionText = (e: ExceptionNote) =>
  `Not applicable to ${exceptionAssets(e)} under ${e.provision}: ${e.reason}`;

export const conditionText = (c: NonNullable<Criterion['condition']>) =>
  `Condition (${c.provision}): ${c.text}`;
