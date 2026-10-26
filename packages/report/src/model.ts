import { z } from 'zod';
import {
  AssetKindSchema,
  AssetSchema,
  CONFORMANCE_LEVELS,
  FindingSchema,
  PROFILE_IDS,
  STANDARD_IDS,
  type ChecklistItemStatus,
} from '@widedoor/core/browser';

/*
 * ScanReport v1: one scan, everything a reporter needs. The JSON report is
 * this object serialized as is; schema/report.v1.json is generated from these
 * Zod schemas, so the validator, the types and the published schema agree.
 * Findings hold automated and manual records alike (spec section 5).
 */

const nonEmpty = z.string().min(1);
const timestamp = z.iso.datetime();
const findingIdSchema = z.string().regex(/^wd_[0-9a-f]{16}$/);
const findingIds = z.array(findingIdSchema);
const count = z.int().min(0);

/** Spec section 10: every report states this. */
export const DISCLAIMER =
  'This report documents the testing performed. It is not a certification of conformance.';

export const EngineRunSchema = z.strictObject({
  name: z.enum(['axe-core', 'verapdf', 'widedoor']),
  version: nonEmpty,
  /** How veraPDF ran: local, docker or custom. */
  runner: nonEmpty.optional(),
  description: nonEmpty.optional(),
});
export type EngineRun = z.infer<typeof EngineRunSchema>;

export const ReportScopeSchema = z.strictObject({
  web: z
    .strictObject({
      urls: z.array(nonEmpty),
      sitemap: nonEmpty.optional(),
      crawl: z.strictObject({ sameOrigin: z.boolean(), maxPages: z.int().min(1) }).optional(),
      /** The page cap for the run (web.maxPages, or the crawl's maxPages). */
      maxPages: z.int().min(1).optional(),
      /** True when the page cap stopped the crawl with pages still queued. */
      truncated: z.boolean(),
    })
    .optional(),
  pdf: z
    .strictObject({
      files: z.array(nonEmpty),
      include: z.array(nonEmpty),
      /** PDFs fetched by URL (pdf.urls or the command line); crawled PDF links are not listed here. */
      urls: z.array(nonEmpty).optional(),
    })
    .optional(),
});
export type ReportScope = z.infer<typeof ReportScopeSchema>;

/** An asset that could not be scanned. Run metadata, never a finding. */
export const RunErrorSchema = z.strictObject({
  kind: AssetKindSchema,
  uri: z.string(),
  code: nonEmpty,
  engine: z.enum(['verapdf', 'widedoor']).optional(),
  message: z.string(),
});
export type RunError = z.infer<typeof RunErrorSchema>;

/** A page that loaded but was deliberately not scanned. */
export const SkippedAssetSchema = z.strictObject({
  uri: nonEmpty,
  finalUri: nonEmpty,
  reason: nonEmpty,
});
export type SkippedAsset = z.infer<typeof SkippedAssetSchema>;

/** A veraPDF result for a rule with no WCAG relation. */
export const InformationalSchema = z.strictObject({
  uri: nonEmpty,
  engine: z.literal('verapdf'),
  ruleId: nonEmpty,
  outcome: z.enum(['pass', 'fail', 'not-applicable']),
  reason: z.string(),
});
export type Informational = z.infer<typeof InformationalSchema>;

const determination = {
  state: z.enum(['pass', 'fail', 'not-applicable', 'not-evaluated']),
  reason: z.enum([
    'automated-fail',
    'manual-fail',
    'deciding-automated-pass',
    'manual-pass',
    'manual-override',
    'errata',
    'profile-not-applicable',
    'manual-not-applicable',
    'no-deciding-result',
    'no-results',
    'not-scanned',
  ]),
  evidence: findingIds,
  undecided: findingIds,
  expired: findingIds,
  /** Absent in reports written before overrides existed; absent means none. */
  overridden: findingIds.optional(),
  exception: z.strictObject({ provision: nonEmpty, reason: nonEmpty }).optional(),
};

export const RollupSchema = z.strictObject({
  profile: z.enum(PROFILE_IDS),
  standards: z.array(
    z.strictObject({
      standard: z.enum(STANDARD_IDS),
      criteria: z.array(
        z.strictObject({
          id: nonEmpty,
          title: nonEmpty,
          type: z.enum(['wcag', 'section508']),
          scope: z.enum(['asset', 'product']),
          condition: z.strictObject({ provision: nonEmpty, text: nonEmpty }).optional(),
          level: z.enum(CONFORMANCE_LEVELS),
          reason: nonEmpty,
          evidence: findingIds,
          assets: z.array(
            z.strictObject({ uri: nonEmpty, kind: AssetKindSchema, ...determination }),
          ),
          product: z.strictObject(determination).optional(),
        }),
      ),
    }),
  ),
});
export type ReportRollup = z.infer<typeof RollupSchema>;

/**
 * Progress of the manual review checklist when the report was built: item
 * counts by status (core checklistSummary), and how many assets in scope
 * were not scanned (they get no items and need a rescan). The items
 * themselves are not stored; widedoor review list builds them on demand.
 */
export const ChecklistProgressSchema = z.strictObject({
  total: count,
  byStatus: z.strictObject({
    open: count,
    done: count,
    expired: count,
    'failed-automated': count,
  } satisfies Record<ChecklistItemStatus, typeof count>),
  unscanned: count,
});
export type ChecklistProgress = z.infer<typeof ChecklistProgressSchema>;

/**
 * An automated fail record a reviewer set aside as a false positive: the
 * roll-up lists it as overridden in every criterion it counts in, so it is
 * not a fail in the counts, the cards or the exit gate. One entry per fail
 * record and the current manual pass that names it. Reviewer and notes come
 * from review files: escape them on output.
 */
export const OverrideSchema = z.strictObject({
  /** The overridden fail. Not unique: two records can share a finding id. */
  finding: findingIdSchema,
  uri: nonEmpty,
  engine: z.enum(['axe-core', 'verapdf', 'widedoor']),
  ruleId: nonEmpty,
  /** The manual pass that sets it aside, and the criterion it cites. */
  record: findingIdSchema,
  criterion: z.strictObject({ type: z.enum(['wcag', 'section508']), id: nonEmpty }),
  reviewer: nonEmpty,
  date: nonEmpty,
  notes: nonEmpty,
});
export type Override = z.infer<typeof OverrideSchema>;

export const ScanReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tool: z.strictObject({ name: z.literal('widedoor'), version: nonEmpty }),
  engines: z.array(EngineRunSchema),
  profile: z.strictObject({
    id: z.enum(PROFILE_IDS),
    pdfDocumentType: z.enum(['non-web', 'web']),
  }),
  startedAt: timestamp,
  finishedAt: timestamp,
  scope: ReportScopeSchema,
  assets: z.array(AssetSchema),
  /** Document titles of scanned web pages, as loaded. Scanned content. */
  titles: z.array(z.strictObject({ uri: nonEmpty, title: z.string() })),
  findings: z.array(FindingSchema),
  informational: z.array(InformationalSchema),
  errors: z.array(RunErrorSchema),
  skipped: z.array(SkippedAssetSchema),
  warnings: z.array(z.string()),
  /**
   * Why the scope is incomplete beyond the errors and skipped pages: a crawl
   * stopped by the page cap, a sitemap read in part, links past a cap, listed
   * pages past the cap, pdf.include matching nothing. The roll-up caps levels
   * on each. Absent when there is none.
   */
  scopeGaps: z.array(nonEmpty).optional(),
  rollup: RollupSchema,
  /** Absent in reports written before the checklist existed. */
  checklist: ChecklistProgressSchema.optional(),
  /**
   * Overridden automated fails, derived from the roll-up's overridden lists and the manual
   * records. Informational: renderers and the exit gate recompute it, so an edit here changes
   * nothing. Absent in reports written before overrides existed.
   */
  overrides: z
    .array(OverrideSchema)
    .optional()
    .describe(
      'Derived and informational: the automated fails a reviewer set aside, recomputed by every renderer and the exit gate from rollup and findings. Editing it changes nothing.',
    ),
  disclaimer: z.literal(DISCLAIMER),
});

/** Scan error codes that name no asset (they leave a gap in the scope instead). */
export const SCOPE_ERROR_CODES: ReadonlySet<string> = new Set(['sitemap-failed']);

/** Byte-order comparison, so output order never depends on the host locale. */
export const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Uris the report knows about: scanned assets, assets that errored and skipped pages. */
export const knownUris = (r: Pick<ScanReport, 'assets' | 'errors' | 'skipped'>) =>
  new Set([
    ...r.assets.map((a) => a.uri),
    ...r.errors.map((e) => e.uri),
    ...r.skipped.map((s) => s.uri),
  ]);

/** The schema plus one cross-field rule: every record is for an asset the report lists. */
export const ScanReportCheckedSchema = ScanReportSchema.superRefine((r, ctx) => {
  const known = knownUris(r);
  r.findings.forEach((f, i) => {
    if (!known.has(f.asset.uri))
      ctx.addIssue({
        code: 'custom',
        path: ['findings', i, 'asset', 'uri'],
        message: 'the record is for an asset the report does not list in assets, errors or skipped',
      });
  });
});
export type ScanReport = z.infer<typeof ScanReportSchema>;

export const REPORT_SCHEMA_ID = 'urn:widedoor:schema:report:v1';

export function buildReportJsonSchema(): Record<string, unknown> {
  return {
    $id: REPORT_SCHEMA_ID,
    title: 'Widedoor Scan Report v1',
    description:
      'One Widedoor scan: run metadata, assets, findings (automated and manual) and the per-criterion roll-up. Finding ids can repeat across records; they are not unique keys.',
    ...z.toJSONSchema(ScanReportSchema),
  };
}

/** Exact bytes of schema/report.v1.json; shared by the generator script and the snapshot test. */
export function serializeReportJsonSchema(): string {
  return `${JSON.stringify(buildReportJsonSchema(), null, 2)}\n`;
}
