import type { ProviderId } from './model.js';

/*
 * One provider call: a system prompt, one user message and the answer
 * schema in, one answer out. A provider never retries (the runner owns retry
 * and the single 429 wait), never logs, and never puts the API key, the
 * request body or a response body into a reason.
 */

export interface ProviderRequest {
  system: string;
  user: string;
  /** The strict answer schema for the request's asset kind (ANSWER_JSON_SCHEMAS). */
  schema: object;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export type ProviderAnswer =
  | {
      status: 'ok';
      /** The answer text, for parseAnswer; never shown as is. */
      text: string;
      /** The model that actually answered (a refusal fallback can change it). */
      modelAnswered: string;
      usage: { inputTokens: number; outputTokens: number };
    }
  | { status: 'refused'; reason: string }
  | {
      status: 'error';
      reason: string;
      /** From retry-after on a 429. */
      retryAfterMs?: number;
      /** True when every later request would fail the same way (bad key, unknown model): stop the run. */
      fatal: boolean;
    };

export interface FixProvider {
  id: ProviderId;
  model: string;
  suggestFix(request: ProviderRequest): Promise<ProviderAnswer>;
}
