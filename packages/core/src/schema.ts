import { createHash } from 'node:crypto';
import { z } from 'zod';

/*
 * Findings schema v1 (spec section 5). Types are inferred from the Zod
 * schemas, so the validator, the types and the exported JSON Schema share one
 * source of truth.
 *
 * Rules that JSON Schema expresses (via unions of strict objects):
 *   - web findings need location.selector and never carry page/structPath
 *   - PDF findings never carry selector
 *   - review is present if and only if source.engine is "manual"
 *   - at least one of criteria.wcag / criteria.section508 is non-empty
 * Rules that live only in Zod:
 *   - findingId() output is not checked against the recomputed hash
 */

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'expected sha256:<64 lowercase hex>');
const nonEmpty = z.string().min(1);

export const AssetKindSchema = z.enum(['web', 'pdf']);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const EngineSchema = z.enum(['axe-core', 'verapdf', 'widedoor', 'manual']);
export type Engine = z.infer<typeof EngineSchema>;

export const OutcomeSchema = z.enum([
  'pass',
  'fail',
  'needs-review',
  'not-applicable',
  'not-tested',
]);
export type Outcome = z.infer<typeof OutcomeSchema>;

export const ImpactSchema = z.enum(['critical', 'serious', 'moderate', 'minor']);
export type Impact = z.infer<typeof ImpactSchema>;

const wcagId = z
  .string()
  .regex(/^\d\.\d{1,2}\.\d{1,2}$/, 'expected a WCAG success criterion id such as 1.4.3');
const section508Id = z
  .string()
  .regex(
    /^(?:[A-Z]\d{3}|\d{3})(?:\.\d+)*$/,
    'expected a Section 508 provision id such as E205.4 or 502.3.1',
  );

export const AssetSchema = z
  .object({
    kind: AssetKindSchema,
    uri: nonEmpty,
    contentHash: sha256,
  })
  .strict();
export type Asset = z.infer<typeof AssetSchema>;

export const WebLocationSchema = z.object({ selector: nonEmpty }).strict();
export const PdfLocationSchema = z
  .object({
    page: z.number().int().min(1).optional(),
    structPath: nonEmpty.optional(),
  })
  .strict();
export const LocationSchema = z.union([WebLocationSchema, PdfLocationSchema]);
export type Location = z.infer<typeof LocationSchema>;

const AutomatedSourceSchema = z
  .object({
    engine: z.enum(['axe-core', 'verapdf', 'widedoor']),
    engineVersion: nonEmpty,
    ruleId: nonEmpty,
    actRuleId: nonEmpty.optional(),
  })
  .strict();
const ManualSourceSchema = z
  .object({
    engine: z.literal('manual'),
    engineVersion: nonEmpty,
    ruleId: nonEmpty,
    actRuleId: nonEmpty.optional(),
  })
  .strict();
export const SourceSchema = z.union([AutomatedSourceSchema, ManualSourceSchema]);
export type Source = z.infer<typeof SourceSchema>;

export const CriteriaSchema = z.union([
  z
    .object({
      wcag: z.array(wcagId).min(1),
      section508: z.array(section508Id).optional(),
      baselineTest: nonEmpty.optional(),
    })
    .strict(),
  z
    .object({
      wcag: z.array(wcagId).optional(),
      section508: z.array(section508Id).min(1),
      baselineTest: nonEmpty.optional(),
    })
    .strict(),
]);
export type Criteria = z.infer<typeof CriteriaSchema>;

export const PlainSchema = z.object({ what: nonEmpty, who: nonEmpty, fix: nonEmpty }).strict();
export type Plain = z.infer<typeof PlainSchema>;

export const EvidenceSchema = z
  .object({ snippet: z.string().optional(), screenshot: nonEmpty.optional() })
  .strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ReviewSchema = z
  .object({
    reviewer: nonEmpty,
    date: z.iso.date(),
    notes: z.string().optional(),
    expiresOnChangeOf: sha256,
  })
  .strict();
export type Review = z.infer<typeof ReviewSchema>;

const commonShape = {
  schemaVersion: z.literal(1),
  id: z.string().regex(/^wd_[0-9a-f]{16}$/, 'expected wd_ followed by 16 lowercase hex chars'),
  criteria: CriteriaSchema,
  outcome: OutcomeSchema,
  impact: ImpactSchema.optional(),
  plain: PlainSchema.optional(),
  evidence: EvidenceSchema.optional(),
};

// One strict object per (asset kind, manual or automated) pair, so the
// exported JSON Schema states the cross-field rules instead of Zod refines.
function variant<K extends AssetKind, L extends z.ZodType, S extends z.ZodType>(
  kind: K,
  location: L,
  source: S,
) {
  return z
    .object({
      ...commonShape,
      asset: AssetSchema.extend({ kind: z.literal(kind) }),
      location,
      source,
    })
    .strict();
}

const WebAutomated = variant('web', WebLocationSchema, AutomatedSourceSchema);
const WebManual = variant('web', WebLocationSchema, ManualSourceSchema).extend({
  review: ReviewSchema,
});
const PdfAutomated = variant('pdf', PdfLocationSchema, AutomatedSourceSchema);
const PdfManual = variant('pdf', PdfLocationSchema, ManualSourceSchema).extend({
  review: ReviewSchema,
});

export const FindingSchema = z.union([WebAutomated, WebManual, PdfAutomated, PdfManual]);
export type Finding = z.infer<typeof FindingSchema>;

export const FINDING_SCHEMA_ID = 'urn:widedoor:schema:finding:v1';

export function buildFindingJsonSchema(): Record<string, unknown> {
  return {
    $id: FINDING_SCHEMA_ID,
    title: 'Widedoor Finding v1',
    description:
      'One accessibility result for a web page or PDF. A review block is required exactly when source.engine is "manual".',
    ...z.toJSONSchema(FindingSchema),
  };
}

/** Exact bytes of schema/finding.v1.json; shared by the generator script and the snapshot test. */
export function serializeFindingJsonSchema(): string {
  return `${JSON.stringify(buildFindingJsonSchema(), null, 2)}\n`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** Stable finding id: wd_ + first 16 hex chars of SHA-256 over a canonical serialization. */
export function findingId(
  assetUri: string,
  location: Location,
  engine: Engine,
  ruleId: string,
): string {
  const canonical = JSON.stringify(canonicalize([assetUri, location, engine, ruleId]));
  return `wd_${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}
