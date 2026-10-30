import OpenAI from 'openai';
import { toOpenAiSchema } from '../answer.js';
import type { FixProvider, ProviderAnswer, ProviderRequest } from '../provider.js';

/*
 * The OpenAI provider: one non-streaming Responses API call per request
 * (client.responses.create, the API the installed SDK's README leads with,
 * whose text.format json_schema config is typed with strict: true). Facts
 * from the installed openai 7.45.1 package, listed in task-3b5-report.md.
 * The SDK retries nothing (maxRetries 0): the runner owns retry. store is
 * false, so OpenAI keeps no copy of the request. Every reason is fixed text
 * plus a status code, and for a 404 the model id; never the key, the
 * request body or a response body. The model has no default (Decision 4).
 */

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** The response format name the API requires (a-z, A-Z, 0-9, _ and -, at most 64). */
const FORMAT_NAME = 'widedoor_fix';

const KEY_REFUSED = 'the OpenAI API refused the key in OPENAI_API_KEY';

export interface OpenAiProviderOptions {
  apiKey: string;
  /** Required: there is no default OpenAI model (Decision 4). */
  model: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Default 0: the runner retries. */
  maxRetries?: number;
  /** Default 60000. */
  timeoutMs?: number;
}

/** A model id as the API reports it; anything else is not recorded. */
const MODEL_ID = /^[A-Za-z0-9._:@/-]{1,100}$/;

/** The response statuses the SDK types list; anything else is reported as "other". */
const STATUSES = new Set([
  'completed',
  'failed',
  'in_progress',
  'cancelled',
  'queued',
  'incomplete',
]);

/** retry-after-ms first (milliseconds), then retry-after (seconds or an HTTP date). */
function retryAfterMs(headers: Headers | undefined, now = Date.now()): number | undefined {
  const ms = headers?.get('retry-after-ms')?.trim();
  if (ms && /^\d+(?:\.\d+)?$/.test(ms)) return Math.round(Number(ms));
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
  if (e instanceof OpenAI.AuthenticationError) return fail(`${KEY_REFUSED} (401)`, true);
  if (e instanceof OpenAI.PermissionDeniedError) return fail(`${KEY_REFUSED} (403)`, true);
  if (e instanceof OpenAI.NotFoundError) return fail(`model ${model} not found (404)`, true);
  if (e instanceof OpenAI.RateLimitError) {
    // OpenAI's public error guide: a 429 with code insufficient_quota is an empty account, not a
    // rate limit, and waiting cannot fix it (the installed package does not document the code).
    if (e.code === 'insufficient_quota')
      return fail('the OpenAI account has no quota left (429)', true);
    const wait = retryAfterMs(e.headers);
    return fail('the OpenAI API rate limit was reached (429)', false, {
      rateLimited: true,
      ...(wait !== undefined ? { retryAfterMs: wait } : {}),
    });
  }
  if (e instanceof OpenAI.BadRequestError)
    return fail('the OpenAI API rejected the request (400)', false);
  if (e instanceof OpenAI.InternalServerError)
    return fail(`the OpenAI API had a server error (${e.status})`, false, server);
  if (e instanceof OpenAI.APIUserAbortError) return fail('the request was cancelled', false);
  if (e instanceof OpenAI.APIConnectionTimeoutError)
    return fail('the request to the OpenAI API timed out', false, connection);
  if (e instanceof OpenAI.APIConnectionError)
    return fail('could not reach the OpenAI API', false, connection);
  if (e instanceof OpenAI.APIError) {
    const status = typeof e.status === 'number' ? e.status : 0;
    // 402: a billing problem stops every later request too.
    return fail(`the OpenAI API returned an error (${status})`, status === 402);
  }
  return fail('the OpenAI provider failed', false);
}

const CUSTOM_HEADERS = 'OPENAI_CUSTOM_HEADERS';

/**
 * Builds the SDK client with OPENAI_CUSTOM_HEADERS hidden, as the Anthropic
 * provider does: the SDK reads it once, in its constructor, and merges its
 * headers over its own (authorization included), so it could replace the
 * key or add another service's credential. Mapping each name to null in
 * defaultHeaders would also remove the SDK's own header of that name. In
 * openai 7.45.1 every environment read is in the constructor (client.js,
 * lines 184 to 262), none per request; client.withOptions() builds a new
 * client through that constructor and so reads the variable again, so any
 * future use of it must go through here too.
 */
function clientWithoutCustomHeaders(options: ConstructorParameters<typeof OpenAI>[0]): OpenAI {
  const saved = process.env[CUSTOM_HEADERS];
  if (saved === undefined) return new OpenAI(options);
  delete process.env[CUSTOM_HEADERS];
  try {
    return new OpenAI(options);
  } finally {
    process.env[CUSTOM_HEADERS] = saved;
  }
}

export function createOpenAiProvider(options: OpenAiProviderOptions): FixProvider {
  // Both checked before the client exists: with no key the SDK would read OPENAI_API_KEY itself.
  if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '')
    throw new Error('the OpenAI provider needs a key: set OPENAI_API_KEY');
  if (typeof options.model !== 'string' || options.model.trim() === '')
    throw new Error('the OpenAI provider needs a model: set ai.model');
  const model = options.model;
  const client = clientWithoutCustomHeaders({
    apiKey: options.apiKey,
    // Explicit, so OPENAI_BASE_URL, OPENAI_ADMIN_KEY, OPENAI_ORG_ID, OPENAI_PROJECT_ID and
    // OPENAI_WEBHOOK_SECRET in the environment change nothing.
    baseURL: options.baseUrl ?? OPENAI_BASE_URL,
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    maxRetries: options.maxRetries ?? 0,
    timeout: options.timeoutMs ?? 60_000,
    // No request logging (OPENAI_LOG): spec section 8, no telemetry.
    logLevel: 'off',
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  async function suggestFix(request: ProviderRequest): Promise<ProviderAnswer> {
    let response: OpenAI.Responses.Response;
    try {
      response = await client.responses.create(
        {
          model,
          instructions: request.system,
          input: request.user,
          max_output_tokens: request.maxOutputTokens,
          store: false,
          text: {
            format: {
              type: 'json_schema',
              name: FORMAT_NAME,
              schema: toOpenAiSchema(request.schema as Record<string, unknown>),
              strict: true,
            },
          },
        },
        { signal: request.signal },
      );
    } catch (e) {
      return errorAnswer(e, model);
    }
    // Status before output: only completed is an answer.
    const status = response.status;
    if (status === 'incomplete') {
      const why = response.incomplete_details?.reason;
      if (why === 'content_filter')
        return { status: 'refused', reason: 'the model declined to answer (content filter)' };
      // A cut-off answer was still billed: its usage goes to the runner's budget.
      if (why === 'max_output_tokens')
        return {
          status: 'error',
          reason: 'the answer was cut off',
          fatal: false,
          errorClass: 'cut-off',
          ...usageOf(response.usage),
        };
    }
    if (status !== 'completed')
      return {
        status: 'error',
        reason: `the model stopped without an answer (${status && STATUSES.has(status) ? status : 'other'})`,
        fatal: false,
      };
    // Only message output: reasoning and other items are never the answer.
    const parts = response.output.flatMap((item) => (item.type === 'message' ? item.content : []));
    // The refusal text is the model's own words about the request; it is not kept.
    if (parts.some((part) => part.type === 'refusal'))
      return { status: 'refused', reason: 'the model declined to answer' };
    const text = parts.flatMap((part) => (part.type === 'output_text' ? [part.text] : [])).join('');
    if (!text) return { status: 'error', reason: 'the answer had no text', fatal: false };
    return {
      status: 'ok',
      text,
      // The model that served the request (a dated snapshot), kept only when it looks like a model id.
      modelAnswered: MODEL_ID.test(response.model) ? response.model : model,
      // Input and output tokens only (output includes reasoning tokens); cached input is not
      // split out. Absent when the response has no counts; the runner then uses its estimate.
      ...usageOf(response.usage),
    };
  }

  return { id: 'openai', model, suggestFix };
}
