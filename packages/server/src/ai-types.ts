/*
 * The shapes of AI fix suggestions that the local server and the viewer pass
 * around, as plain types: no runtime code and no imports. @widedoor/server
 * never depends on @widedoor/ai (the hosted image installs the server
 * workspace, D16), and the viewer cannot load it either, so both use this
 * copy. packages/cli/test/ai-types.test.ts fails at typecheck if it and
 * @widedoor/ai's AiSuggestions stop being mutually assignable. Optional
 * properties take | undefined, as Zod's inferred types do.
 */

export type AiProviderId = 'anthropic' | 'openai';

export type AiSuggestion =
  | { kind: 'web-patch'; summary: string; patch: string; notes?: string | undefined }
  | {
      kind: 'pdf-steps';
      summary: string;
      tool: 'word' | 'indesign' | 'acrobat' | 'other';
      steps: string[];
    };

export interface AiSentRecord {
  ruleId: string;
  criteria: string[];
  assetKind: 'web' | 'pdf';
  selector?: string | undefined;
  snippet?: string | undefined;
  page?: number | undefined;
  structPath?: string | undefined;
  plain?: { what: string; fix: string } | undefined;
  redactions: { kind: string; count: number }[];
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiSuggestionEntry {
  group: string;
  findingIds: string[];
  request: AiSentRecord;
  delivered: boolean;
  status: 'ok' | 'refused' | 'invalid' | 'error' | 'skipped-budget' | 'not-sent';
  suggestion?: AiSuggestion | undefined;
  reason?: string | undefined;
  usage?: AiUsage | undefined;
}

export interface AiLimitsShape {
  maxGroups: number;
  maxRequestsPerMinute: number;
  concurrency: number;
  maxOutputTokens: number;
  maxInputTokensTotal: number;
}

/** The suggestions document (@widedoor/ai AiSuggestions). */
export interface AiSuggestionsDoc {
  schemaVersion: 1;
  $id: 'urn:widedoor:schema:ai-suggestions:v1';
  label: 'AI-generated. Review before use. Suggestions do not change any result in the report.';
  provider: AiProviderId;
  model: string;
  modelAnswered?: string | undefined;
  createdAt: string;
  report: { startedAt: string; findings: number };
  limits: AiLimitsShape;
  entries: AiSuggestionEntry[];
  totals: { requests: number; inputTokens: number; outputTokens: number; skippedGroups: number };
}

/** What a dry run would send: the system prompt, every user message and the estimate. */
export interface AiPreview {
  system: string;
  messages: string[];
  estimatedInputTokens: number;
  /** Groups past the group limit, which would not be sent. */
  skipped: number;
}

/** GET /api/ai. */
export interface AiAvailability {
  available: boolean;
  provider?: AiProviderId | undefined;
  model?: string | undefined;
  reason?: string | undefined;
}
