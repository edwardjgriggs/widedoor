import Anthropic from '@anthropic-ai/sdk';
import type { FixProvider, ProviderAnswer, ProviderRequest } from '../provider.js';

/*
 * The Claude provider: one non-streaming Messages API call per request
 * (answers are small). Facts from the claude-api skill (2026-10-29):
 * Claude Opus 5.5 always thinks, so no thinking field is sent and effort is
 * the control (default medium; low here); no temperature, top_p or top_k;
 * structured output through output_config.format; the refusal fallback in
 * its "default" form with the server-side-fallback-2026-07-01 beta. The SDK
 * retries nothing (maxRetries 0): the runner owns retry and the one 429
 * wait. Every reason is fixed text plus a status code, and for a 404 the
 * model id; never the key, the request body or a response body.
 */

/** Decision 1. */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
/** The beta that gates fallbacks: "default" (the array form takes a different header; mixing them is a 400). */
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const KEY_REFUSED = 'the Anthropic API refused the key in ANTHROPIC_API_KEY';

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Default 0: the runner retries. */
  maxRetries?: number;
  /** Default 60000. */
  timeoutMs?: number;
}

/** The stop reasons the API documents; anything else is reported as "other". */
const STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'compaction',
  'refusal',
  'model_context_window_exceeded',
]);

/** A refusal category as sent ("cyber", "bio", ...), or "none"; never free text. */
const category = (value: unknown) =>
  typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : 'none';

/** retry-after in milliseconds: delay seconds or an HTTP date. */
function retryAfterMs(headers: Headers | undefined, now = Date.now()): number | undefined {
  const value = headers?.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const count = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** The usage field of an ok answer: present only when the response carries both counts. */
function usageOf(usage: { input_tokens?: unknown; output_tokens?: unknown } | null | undefined) {
  if (!usage || !count(usage.input_tokens) || !count(usage.output_tokens)) return {};
  return {
    usage: {
      inputTokens: usage.input_tokens as number,
      outputTokens: usage.output_tokens as number,
    },
  };
}

/** Typed SDK errors, most specific first; see the module comment for what a reason may hold. */
function errorAnswer(e: unknown, model: string): ProviderAnswer {
  const fail = (
    reason: string,
    fatal: boolean,
    extra: { rateLimited?: true; retryAfterMs?: number; errorClass?: 'server' | 'connection' } = {},
  ) => ({
    status: 'error' as const,
    reason,
    fatal,
    ...extra,
  });
  const server = { errorClass: 'server' as const };
  const connection = { errorClass: 'connection' as const };
  if (e instanceof Anthropic.AuthenticationError) return fail(`${KEY_REFUSED} (401)`, true);
  if (e instanceof Anthropic.PermissionDeniedError) return fail(`${KEY_REFUSED} (403)`, true);
  if (e instanceof Anthropic.NotFoundError) return fail(`model ${model} not found (404)`, true);
  if (e instanceof Anthropic.RateLimitError) {
    const wait = retryAfterMs(e.headers);
    return fail('the Anthropic API rate limit was reached (429)', false, {
      rateLimited: true,
      ...(wait !== undefined ? { retryAfterMs: wait } : {}),
    });
  }
  if (e instanceof Anthropic.BadRequestError)
    return fail('the Anthropic API rejected the request (400)', false);
  if (e instanceof Anthropic.InternalServerError)
    return fail(`the Anthropic API had a server error (${e.status})`, false, server);
  if (e instanceof Anthropic.APIUserAbortError) return fail('the request was cancelled', false);
  if (e instanceof Anthropic.APIConnectionTimeoutError)
    return fail('the request to the Anthropic API timed out', false, connection);
  if (e instanceof Anthropic.APIConnectionError)
    return fail('could not reach the Anthropic API', false, connection);
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === 'number' ? e.status : 0;
    // 402: a billing problem stops every later request too.
    return fail(`the Anthropic API returned an error (${status})`, status === 402);
  }
  return fail('the Anthropic provider failed', false);
}

/** A model id as the API reports it; anything else is not recorded. */
const MODEL_ID = /^[A-Za-z0-9._:@/-]{1,100}$/;

const CUSTOM_HEADERS = 'ANTHROPIC_CUSTOM_HEADERS';

/**
 * Builds the SDK client with ANTHROPIC_CUSTOM_HEADERS hidden. The SDK reads
 * that variable once, in its constructor, and merges its headers over its
 * own, so it could replace the key, the API version or add another
 * service's credential to every request. Mapping each name to null in
 * defaultHeaders would also remove the SDK's own authorization and
 * anthropic-version headers when the variable names them, so the variable
 * is unset for the synchronous constructor call and restored right after.
 * client.withOptions() builds a new client through the same constructor and
 * so reads the variable again: any future use of it must go through here too.
 */
function clientWithoutCustomHeaders(
  options: ConstructorParameters<typeof Anthropic>[0],
): Anthropic {
  const saved = process.env[CUSTOM_HEADERS];
  if (saved === undefined) return new Anthropic(options);
  delete process.env[CUSTOM_HEADERS];
  try {
    return new Anthropic(options);
  } finally {
    process.env[CUSTOM_HEADERS] = saved;
  }
}

export function createAnthropicProvider(options: AnthropicProviderOptions): FixProvider {
  // Checked before the client exists: with no key the SDK would read ANTHROPIC_API_KEY itself.
  if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '')
    throw new Error('the Anthropic provider needs a key: set ANTHROPIC_API_KEY');
  const model = options.model ?? ANTHROPIC_DEFAULT_MODEL;
  const client = clientWithoutCustomHeaders({
    apiKey: options.apiKey,
    // Explicit, so ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL in the environment change nothing.
    authToken: null,
    baseURL: options.baseUrl ?? ANTHROPIC_BASE_URL,
    maxRetries: options.maxRetries ?? 0,
    timeout: options.timeoutMs ?? 60_000,
    // No request logging (ANTHROPIC_LOG) and no tracing: spec section 8, no telemetry.
    logLevel: 'off',
    openTelemetry: false,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  async function suggestFix(request: ProviderRequest): Promise<ProviderAnswer> {
    let response: Anthropic.Beta.Messages.BetaMessage;
    try {
      response = await client.beta.messages.create(
        {
          model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          output_config: {
            effort: 'low',
            format: { type: 'json_schema', schema: request.schema as Record<string, unknown> },
          },
          fallbacks: 'default',
          betas: [ANTHROPIC_FALLBACK_BETA],
        },
        { signal: request.signal },
      );
    } catch (e) {
      return errorAnswer(e, model);
    }
    // stop_reason before content: only end_turn is an answer.
    const stop = response.stop_reason;
    if (stop === 'refusal')
      return {
        status: 'refused',
        reason: `the model declined to answer (category: ${category(response.stop_details?.category)})`,
      };
    // A cut-off answer was still billed: its usage goes to the runner's budget.
    if (stop === 'max_tokens')
      return {
        status: 'error',
        reason: 'the answer was cut off',
        fatal: false,
        errorClass: 'cut-off',
        ...usageOf(response.usage),
      };
    if (stop !== 'end_turn')
      return {
        status: 'error',
        reason: `the model stopped without an answer (${stop && STOP_REASONS.has(stop) ? stop : 'other'})`,
        fatal: false,
      };
    // Only text blocks: thinking and fallback blocks are never the answer.
    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('');
    if (!text) return { status: 'error', reason: 'the answer had no text', fatal: false };
    return {
      status: 'ok',
      text,
      // The served model (a fallback can change it), kept only when it looks like a model id.
      modelAnswered: MODEL_ID.test(response.model) ? response.model : model,
      // Input and output tokens only: cache reads and writes and refusal-fallback billing are
      // not included. Absent when the response has no counts; the runner then uses its estimate.
      ...usageOf(response.usage),
    };
  }

  return { id: 'anthropic', model, suggestFix };
}
