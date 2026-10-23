import { z } from 'zod';
import {
  AssetKindSchema,
  AssetSchema,
  CONFORMANCE_LEVELS,
  FindingSchema,
  PROFILE_IDS,
} from '@widedoor/core/browser';

/*
 * ScanReport v1: one scan, everything a reporter needs. The JSON report is
 * this object serialized as is; schema/report.v1.json is generated from these
 * Zod schemas, so the validator, the types and the published schema agree.
 * Findings hold automated and manual records alike (spec section 5).
 */

const nonEmpty = z.string().min(1);
const timestamp = z.iso.datetime();
const findingIds = z.array(z.string().regex(/^wd_[0-9a-f]{16}$/));

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
    'profile-not-applicable',
    'manual-not-applicable',
    'no-deciding-result',
    'no-results',
    'not-scanned',
  ]),
  evidence: findingIds,
  undecided: findingIds,
  expired: findingIds,
  exception: z.strictObject({ provision: nonEmpty, reason: nonEmpty }).optional(),
};

export const RollupSchema = z.strictObject({
  profile: z.enum(PROFILE_IDS),
  standards: z.array(
    z.strictObject({
      standard: z.enum(['508', 'wcag21aa']),
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
