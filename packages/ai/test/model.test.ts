import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  AI_LABEL,
  AI_SUGGESTIONS_SCHEMA_ID,
  AiLimitsSchema,
  AiSuggestionsSchema,
  DEFAULT_AI_LIMITS,
  REASON_MAX,
  SuggestionEntrySchema,
  SuggestionSchema,
  serializeAiSuggestionsJsonSchema,
  toReason,
  type AiSuggestions,
  type Suggestion,
  type SuggestionEntry,
} from '../src/index.ts';

const schemaFile = new URL('../schema/ai-suggestions.v1.json', import.meta.url);

const webPatch: Suggestion = {
  kind: 'web-patch',
  summary: 'Give the image a text alternative.',
  patch: '<img src="logo.png" alt="Acme home">',
};

const pdfSteps: Suggestion = {
  kind: 'pdf-steps',
  summary: 'Tag the figure with alternate text.',
  tool: 'word',
  steps: ['Right-click the picture.', 'Choose Edit Alt Text and describe it.'],
};

const webEntry: SuggestionEntry = {
  group: '0123456789abcdef',
  findingIds: ['wd_0123456789abcdef', 'wd_fedcba9876543210'],
  request: {
    ruleId: 'image-alt',
    criteria: ['1.1.1'],
    assetKind: 'web',
    selector: 'img.logo',
    snippet: '<img src="logo.png">',
    redactions: [{ kind: 'query-string', count: 1 }],
  },
  delivered: true,
  status: 'ok',
  suggestion: webPatch,
  usage: { inputTokens: 120, outputTokens: 40 },
};

const pdfEntry: SuggestionEntry = {
  group: 'fedcba9876543210',
  findingIds: ['wd_00000000000000aa'],
  request: {
    ruleId: 'pdf-figure-alt',
    criteria: ['1.1.1'],
    assetKind: 'pdf',
    page: 3,
    structPath: 'Document/Sect/Figure',
    plain: { what: 'A figure has no alternate text.', fix: 'Add alternate text.' },
    redactions: [],
  },
  delivered: true,
  status: 'ok',
  suggestion: pdfSteps,
};

/** A copy of value without key. */
function without(value: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
}

function doc(): AiSuggestions {
  return {
    schemaVersion: 1,
    $id: AI_SUGGESTIONS_SCHEMA_ID,
    label: AI_LABEL,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    createdAt: '2026-10-29T12:00:00.000Z',
    report: { startedAt: '2026-10-29T11:00:00.000Z', findings: 3 },
    limits: { ...DEFAULT_AI_LIMITS },
    entries: [webEntry, pdfEntry],
    totals: { requests: 2, inputTokens: 120, outputTokens: 40, skippedGroups: 0 },
  };
}

describe('ai-suggestions.v1.json', () => {
  it('matches the Zod schema byte for byte (regenerate with npm run schema -w @widedoor/ai)', () => {
    expect(readFileSync(schemaFile, 'utf8')).toBe(serializeAiSuggestionsJsonSchema());
  });

  it('carries the schema id', () => {
    const schema = JSON.parse(readFileSync(schemaFile, 'utf8'));
    expect(schema.$id).toBe('urn:widedoor:schema:ai-suggestions:v1');
  });

  // The status, delivered and kind pairings are a Zod superRefine; JSON Schema cannot carry them.
  it('compiles under Ajv, accepts the fixture and rejects broken documents', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats.default(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(schemaFile, 'utf8')));
    const valid = JSON.parse(JSON.stringify(doc()));
    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...valid, extra: true })).toBe(false);
    expect(validate({ ...valid, createdAt: 'today' })).toBe(false);
    expect(validate({ ...valid, label: 'Reviewed.' })).toBe(false);
    expect(validate({ ...valid, entries: [without(webEntry, 'delivered')] })).toBe(false);
    expect(validate({ ...valid, entries: [{ ...webEntry, status: 'done' }] })).toBe(false);
    expect(validate({ ...valid, totals: without(valid.totals, 'skippedGroups') })).toBe(false);
  });
});

describe('AiSuggestionsSchema', () => {
  it('accepts a document with a web patch and PDF steps', () => {
    expect(AiSuggestionsSchema.parse(doc())).toEqual(doc());
  });

  it('refuses an unknown field at every level', () => {
    expect(AiSuggestionsSchema.safeParse({ ...doc(), extra: true }).success).toBe(false);
    const entry = { ...webEntry, extra: true };
    expect(AiSuggestionsSchema.safeParse({ ...doc(), entries: [entry] }).success).toBe(false);
    const request = { ...webEntry.request, url: 'https://example.com/' };
    expect(SuggestionEntrySchema.safeParse({ ...webEntry, request }).success).toBe(false);
    expect(SuggestionSchema.safeParse({ ...webPatch, apply: true }).success).toBe(false);
  });

  it('holds the fixed label, id and version', () => {
    expect(AiSuggestionsSchema.safeParse({ ...doc(), label: 'Reviewed.' }).success).toBe(false);
    expect(AiSuggestionsSchema.safeParse({ ...doc(), $id: 'urn:x' }).success).toBe(false);
    expect(AiSuggestionsSchema.safeParse({ ...doc(), schemaVersion: 2 }).success).toBe(false);
    expect(AiSuggestionsSchema.safeParse({ ...doc(), provider: 'other' }).success).toBe(false);
    expect(AiSuggestionsSchema.safeParse({ ...doc(), createdAt: 'today' }).success).toBe(false);
  });
});

describe('SuggestionSchema', () => {
  it('refuses a web patch without a patch', () => {
    expect(SuggestionSchema.safeParse(without(webPatch, 'patch')).success).toBe(false);
  });

  it('refuses a patch of 4001 characters and accepts 4000', () => {
    expect(SuggestionSchema.safeParse({ ...webPatch, patch: 'x'.repeat(4000) }).success).toBe(true);
    expect(SuggestionSchema.safeParse({ ...webPatch, patch: 'x'.repeat(4001) }).success).toBe(
      false,
    );
  });

  it('refuses 13 steps and accepts 12', () => {
    const steps = (n: number) => Array.from({ length: n }, (_, i) => `Step ${i + 1}.`);
    expect(SuggestionSchema.safeParse({ ...pdfSteps, steps: steps(12) }).success).toBe(true);
    expect(SuggestionSchema.safeParse({ ...pdfSteps, steps: steps(13) }).success).toBe(false);
    expect(SuggestionSchema.safeParse({ ...pdfSteps, steps: [] }).success).toBe(false);
  });

  it('caps the summary, notes and each step', () => {
    const long = (n: number) => 'x'.repeat(n);
    expect(SuggestionSchema.safeParse({ ...webPatch, summary: long(401) }).success).toBe(false);
    expect(SuggestionSchema.safeParse({ ...webPatch, notes: long(1000) }).success).toBe(true);
    expect(SuggestionSchema.safeParse({ ...webPatch, notes: long(1001) }).success).toBe(false);
    expect(SuggestionSchema.safeParse({ ...pdfSteps, steps: [long(401)] }).success).toBe(false);
    expect(SuggestionSchema.safeParse({ ...pdfSteps, summary: long(401) }).success).toBe(false);
  });

  it('refuses an unknown kind or authoring tool', () => {
    expect(SuggestionSchema.safeParse({ ...webPatch, kind: 'shell' }).success).toBe(false);
    expect(SuggestionSchema.safeParse({ ...pdfSteps, tool: 'latex' }).success).toBe(false);
  });
});

describe('SuggestionEntrySchema', () => {
  it('needs a suggestion exactly when the status is ok', () => {
    const noSuggestion = without(webEntry, 'suggestion');
    expect(SuggestionEntrySchema.safeParse(noSuggestion).success).toBe(false);
    expect(
      SuggestionEntrySchema.safeParse({ ...noSuggestion, status: 'refused', reason: 'policy' })
        .success,
    ).toBe(true);
    expect(SuggestionEntrySchema.safeParse({ ...webEntry, status: 'error' }).success).toBe(false);
    expect(
      SuggestionEntrySchema.safeParse({
        ...noSuggestion,
        status: 'skipped-budget',
        delivered: false,
      }).success,
    ).toBe(true);
  });

  it('pairs each status with whether the request was delivered', () => {
    const entry = (status: string, delivered: boolean) =>
      SuggestionEntrySchema.safeParse({
        ...(status === 'ok' ? webEntry : without(webEntry, 'suggestion')),
        status,
        delivered,
      }).success;
    for (const status of ['ok', 'refused', 'invalid']) {
      expect(entry(status, true), `${status} delivered`).toBe(true);
      expect(entry(status, false), `${status} not delivered`).toBe(false);
    }
    for (const status of ['skipped-budget', 'not-sent']) {
      expect(entry(status, false), `${status} not delivered`).toBe(true);
      expect(entry(status, true), `${status} delivered`).toBe(false);
    }
    expect(entry('error', true)).toBe(true);
    expect(entry('error', false)).toBe(true);
    expect(SuggestionEntrySchema.safeParse(without(webEntry, 'delivered')).success).toBe(false);
  });

  it('matches the suggestion kind to the asset kind', () => {
    expect(SuggestionEntrySchema.safeParse({ ...webEntry, suggestion: pdfSteps }).success).toBe(
      false,
    );
    expect(SuggestionEntrySchema.safeParse({ ...pdfEntry, suggestion: webPatch }).success).toBe(
      false,
    );
  });

  it('checks the group hash, finding ids and reason length', () => {
    expect(SuggestionEntrySchema.safeParse({ ...webEntry, group: 'ABC' }).success).toBe(false);
    expect(SuggestionEntrySchema.safeParse({ ...webEntry, findingIds: [] }).success).toBe(false);
    expect(SuggestionEntrySchema.safeParse({ ...webEntry, findingIds: ['x'] }).success).toBe(false);
    const many = Array.from({ length: 20_000 }, (_, i) => `wd_${i.toString(16).padStart(16, '0')}`);
    expect(SuggestionEntrySchema.safeParse({ ...webEntry, findingIds: many }).success).toBe(true);
    const failed = without(webEntry, 'suggestion');
    const reason = (n: number) => ({ ...failed, status: 'error', reason: 'x'.repeat(n) });
    expect(SuggestionEntrySchema.safeParse(reason(300)).success).toBe(true);
    expect(SuggestionEntrySchema.safeParse(reason(301)).success).toBe(false);
  });
});

describe('AiSuggestionsSchema caps', () => {
  it('lists at most 200 entries and counts skipped groups', () => {
    const entries = (n: number) => Array.from({ length: n }, () => webEntry);
    expect(AiSuggestionsSchema.safeParse({ ...doc(), entries: entries(200) }).success).toBe(true);
    expect(AiSuggestionsSchema.safeParse({ ...doc(), entries: entries(201) }).success).toBe(false);
    const totals = (skippedGroups: number) => ({ ...doc().totals, skippedGroups });
    expect(AiSuggestionsSchema.safeParse({ ...doc(), totals: totals(5) }).success).toBe(true);
    expect(AiSuggestionsSchema.safeParse({ ...doc(), totals: totals(-1) }).success).toBe(false);
  });
});

describe('toReason', () => {
  const fits = (reason: string) =>
    SuggestionEntrySchema.safeParse({
      ...without(webEntry, 'suggestion'),
      status: 'error',
      reason,
    }).success;

  it('escapes control and bidi characters', () => {
    const reason = toReason('bad\x1b[31mkey\u202edone\n');
    expect(reason).toBe('bad\\x1b[31mkey\\u202edone\\x0a');
    expect(fits(reason)).toBe(true);
  });

  it('cuts a long input to REASON_MAX and still parses', () => {
    for (const input of ['x'.repeat(5000), '\x07'.repeat(400), '\u{1F600}'.repeat(400)]) {
      const reason = toReason(input);
      expect(reason.length).toBeLessThanOrEqual(REASON_MAX);
      expect(reason.endsWith('...')).toBe(true);
      expect(fits(reason)).toBe(true);
    }
  });

  it('keeps a short reason as is and never returns an empty one', () => {
    expect(toReason('the provider timed out')).toBe('the provider timed out');
    expect(fits(toReason(''))).toBe(true);
    expect(fits(toReason(new Error('boom')))).toBe(true);
  });
});

describe('AiLimitsSchema', () => {
  it('fills the defaults', () => {
    expect(AiLimitsSchema.parse({})).toEqual({
      maxGroups: 25,
      maxRequestsPerMinute: 10,
      concurrency: 2,
      maxOutputTokens: 4096,
      maxInputTokensTotal: 200000,
    });
    expect(DEFAULT_AI_LIMITS).toEqual(AiLimitsSchema.parse({}));
  });

  it('holds each limit to its range', () => {
    const ok = (limits: object) => AiLimitsSchema.safeParse(limits).success;
    expect(ok({ maxGroups: 1 })).toBe(true);
    expect(ok({ maxGroups: 200 })).toBe(true);
    expect(ok({ maxGroups: 0 })).toBe(false);
    expect(ok({ maxGroups: 201 })).toBe(false);
    expect(ok({ maxRequestsPerMinute: 60 })).toBe(true);
    expect(ok({ maxRequestsPerMinute: 61 })).toBe(false);
    expect(ok({ concurrency: 4 })).toBe(true);
    expect(ok({ concurrency: 5 })).toBe(false);
    expect(ok({ concurrency: 1.5 })).toBe(false);
    expect(ok({ maxOutputTokens: 0 })).toBe(false);
    expect(ok({ maxInputTokensTotal: -1 })).toBe(false);
    expect(ok({ extra: 1 })).toBe(false);
  });
});
