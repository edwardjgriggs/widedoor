import { z } from 'zod';
import { safeText } from '@widedoor/core';

/*
 * The AI suggestions document (ai-suggestions.json), its own file next to the
 * report: the scan report never changes, so every outcome stays deterministic
 * (D1, spec section 9: "never change an outcome"). schema/ai-suggestions.v1.json
 * is generated from these Zod schemas. Every string a model returns is
 * untrusted text with a hard length cap; readers show it escaped and never
 * apply, run or link it.
 */

const nonEmpty = z.string().min(1);
const timestamp = z.iso.datetime();
const count = z.int().min(0);
/** Same shape as finding ids in report.v1.json. */
const findingIdSchema = z.string().regex(/^wd_[0-9a-f]{16}$/);

/** Stored once per document; renderers show it at the top and on every entry. */
export const AI_LABEL =
  'AI-generated. Review before use. Suggestions do not change any result in the report.';

export const AI_SUGGESTIONS_SCHEMA_ID = 'urn:widedoor:schema:ai-suggestions:v1';

/** Longest reason an entry may carry; see toReason. */
export const REASON_MAX = 300;
/** Ceiling of limits.maxGroups. */
export const MAX_GROUPS = 200;
/**
 * Most entries one document may list. Entries exist only for the groups the
 * run kept, and maxGroups (at most MAX_GROUPS) caps those; groups past
 * maxGroups are counted in totals.skippedGroups, never listed.
 */
export const ENTRIES_MAX = MAX_GROUPS;

const NO_REASON = 'no reason given';

/**
 * A reason that always fits the schema: safeText escapes control, bidi and
 * separator characters, then the escaped text is cut to REASON_MAX UTF-16
 * code units (never splitting a pair), stricter than the schema's code point
 * count, ending in "..." when cut.
 */
export function toReason(value: unknown): string {
  const text = safeText(value, REASON_MAX);
  if (text.length === 0) return NO_REASON;
  if (text.length <= REASON_MAX) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > REASON_MAX - 3) break;
    out += ch;
  }
  return `${out}...`;
}

export const ProviderIdSchema = z.enum(['anthropic', 'openai']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/** Same rule as the ai.model config field: 1 to 100 characters. */
const modelId = nonEmpty.max(100);

/** Suggestion limits, shared by the schema and the system prompt. */
export const SUMMARY_MAX = 400;
export const PATCH_MAX = 4000;
export const NOTES_MAX = 1000;
export const STEPS_MAX = 12;
export const STEP_MAX = 400;

export const WebPatchSchema = z.strictObject({
  kind: z.literal('web-patch'),
  summary: nonEmpty.max(SUMMARY_MAX),
  /** Replacement markup for the flagged element, shown as escaped text only. */
  patch: nonEmpty.max(PATCH_MAX),
  notes: nonEmpty.max(NOTES_MAX).optional(),
});

export const PdfStepsSchema = z.strictObject({
  kind: z.literal('pdf-steps'),
  summary: nonEmpty.max(SUMMARY_MAX),
  /** The source authoring tool the steps are for. */
  tool: z.enum(['word', 'indesign', 'acrobat', 'other']),
  steps: z.array(nonEmpty.max(STEP_MAX)).min(1).max(STEPS_MAX),
});

export const SuggestionSchema = z.discriminatedUnion('kind', [WebPatchSchema, PdfStepsSchema]);
export type Suggestion = z.infer<typeof SuggestionSchema>;

/** What one request sent, or would send (see delivered); spec section 9: "The report lists exactly what was sent". */
export const SentRecordSchema = z.strictObject({
  ruleId: nonEmpty,
  criteria: z.array(nonEmpty),
  assetKind: z.enum(['web', 'pdf']),
  selector: nonEmpty.optional(),
  /**
   * The redacted snippet, byte for byte as sent: context.ts applies the untrusted block's tag
   * escape before it is recorded. The one difference possible is an occurrence of a request's
   * own random 128-bit nonce, escaped in the message only (prompt.ts).
   */
  snippet: nonEmpty.optional(),
  page: z.int().min(1).optional(),
  structPath: nonEmpty.optional(),
  plain: z.strictObject({ what: nonEmpty, fix: nonEmpty }).optional(),
  /**
   * The report file's rule id when it is not one Widedoor writes (ruleId is then
   * "unrecognised"), and criteria Widedoor does not know: redacted, and sent only
   * inside the untrusted block, since a report file can be crafted.
   */
  reportRule: nonEmpty.optional(),
  reportCriteria: z.array(nonEmpty).optional(),
  redactions: z.array(z.strictObject({ kind: nonEmpty, count })),
});
export type SentRecord = z.infer<typeof SentRecordSchema>;

export const UsageSchema = z.strictObject({ inputTokens: count, outputTokens: count });
export type Usage = z.infer<typeof UsageSchema>;

const SUGGESTION_KIND = { web: 'web-patch', pdf: 'pdf-steps' } as const;

/** The delivered value each status requires; error may be either (it can come before or after the bytes left). */
const DELIVERED: Record<string, boolean | undefined> = {
  ok: true,
  refused: true,
  invalid: true,
  'skipped-budget': false,
  'not-sent': false,
};

export const SuggestionEntrySchema = z
  .strictObject({
    /** First 16 hex digits of the group's SHA-256 (rule id plus redacted snippet). */
    group: z.string().regex(/^[0-9a-f]{16}$/),
    /** Every finding the answer applies to; not capped, since one template bug can repeat on many pages. */
    findingIds: z.array(findingIdSchema).min(1),
    /**
     * What was sent, or when delivered is false, what would have been sent.
     * Renderers list undelivered entries under "Not sent", never under "What was sent".
     */
    request: SentRecordSchema,
    /** Whether the request bytes left for the provider. */
    delivered: z.boolean(),
    /** not-sent: the run stopped (fatal error or abort) before this group was sent. */
    status: z.enum(['ok', 'refused', 'invalid', 'error', 'skipped-budget', 'not-sent']),
    suggestion: SuggestionSchema.optional(),
    reason: nonEmpty.max(REASON_MAX).optional(),
    usage: UsageSchema.optional(),
  })
  .superRefine((entry, ctx) => {
    if ((entry.status === 'ok') !== (entry.suggestion !== undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['suggestion'],
        message: 'an entry has a suggestion exactly when its status is ok',
      });
    const delivered = DELIVERED[entry.status];
    if (delivered !== undefined && entry.delivered !== delivered)
      ctx.addIssue({
        code: 'custom',
        path: ['delivered'],
        message: `an entry with status ${entry.status} has delivered ${delivered}`,
      });
    const kind = SUGGESTION_KIND[entry.request.assetKind];
    if (entry.suggestion && entry.suggestion.kind !== kind)
      ctx.addIssue({
        code: 'custom',
        path: ['suggestion', 'kind'],
        message: `a ${entry.request.assetKind} finding takes a ${kind} suggestion`,
      });
  });
export type SuggestionEntry = z.infer<typeof SuggestionEntrySchema>;

export const AiLimitsSchema = z.strictObject({
  maxGroups: z.int().min(1).max(MAX_GROUPS).default(25),
  maxRequestsPerMinute: z.int().min(1).max(60).default(10),
  concurrency: z.int().min(1).max(4).default(2),
  maxOutputTokens: z.int().min(256).max(16_384).default(4096),
  maxInputTokensTotal: z.int().min(1000).max(5_000_000).default(200_000),
});
export type AiLimits = z.infer<typeof AiLimitsSchema>;

export const DEFAULT_AI_LIMITS: Readonly<AiLimits> = Object.freeze(AiLimitsSchema.parse({}));

export const AiSuggestionsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  $id: z.literal(AI_SUGGESTIONS_SCHEMA_ID),
  label: z.literal(AI_LABEL),
  provider: ProviderIdSchema,
  model: modelId,
  /** The model that actually answered, when the provider reports a different one. */
  modelAnswered: modelId.optional(),
  createdAt: timestamp,
  /** The report the suggestions are for. */
  report: z.strictObject({ startedAt: timestamp, findings: count }),
  limits: AiLimitsSchema,
  entries: z.array(SuggestionEntrySchema).max(ENTRIES_MAX),
  totals: z.strictObject({
    requests: count,
    inputTokens: count,
    outputTokens: count,
    /** Groups past maxGroups: counted here, not listed in entries. */
    skippedGroups: count,
  }),
});
export type AiSuggestions = z.infer<typeof AiSuggestionsSchema>;

export function buildAiSuggestionsJsonSchema(): Record<string, unknown> {
  return {
    $id: AI_SUGGESTIONS_SCHEMA_ID,
    title: 'Widedoor AI Suggestions v1',
    description:
      'Optional AI fix suggestions for the failed findings of one Widedoor scan report, with exactly what was sent for each. AI-generated; never changes a result in the report.',
    ...z.toJSONSchema(AiSuggestionsSchema),
  };
}

/** Exact bytes of schema/ai-suggestions.v1.json; shared by the generator script and the snapshot test. */
export function serializeAiSuggestionsJsonSchema(): string {
  return `${JSON.stringify(buildAiSuggestionsJsonSchema(), null, 2)}\n`;
}
