import { MODEL_ID } from '@widedoor/core';

/*
 * What both providers do the same way: the model check, the 429 wait, the
 * usage counts and building an SDK client with its custom-headers variable
 * hidden.
 */

/**
 * Refuses a model that is not a model id (MODEL_ID). Called after the key
 * check, so a missing key is always the first thing said.
 */
export function checkModel(model: string, provider: string) {
  if (!MODEL_ID.test(model)) throw new Error(`the ${provider} provider needs a valid model id`);
}

/** The model an API says served the request, kept only when it looks like a model id. */
export const answeredModel = (reported: string, model: string) =>
  MODEL_ID.test(reported) ? reported : model;

/** retry-after-ms first (milliseconds), then retry-after (seconds or an HTTP date). */
export function retryAfterMs(headers: Headers | undefined, now = Date.now()): number | undefined {
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
export function usageOf(
  usage: { input_tokens?: unknown; output_tokens?: unknown } | null | undefined,
) {
  if (!usage || !count(usage.input_tokens) || !count(usage.output_tokens)) return {};
  return {
    usage: {
      inputTokens: usage.input_tokens as number,
      outputTokens: usage.output_tokens as number,
    },
  };
}

/**
 * Runs build (an SDK constructor call) with the environment variable named
 * hidden, and restores it right after. Both SDKs read their custom-headers
 * variable once, in the constructor, and merge its headers over their own,
 * so it could replace the key or add another service's credential to every
 * request. Mapping each name to null in defaultHeaders would also remove the
 * SDK's own header of that name, so the variable is unset instead. The
 * constructor is synchronous, so nothing else runs while it is unset.
 * client.withOptions() builds a new client through the same constructor and
 * reads the variable again: any future use of it must go through here too.
 */
export function withoutEnv<T>(name: string, build: () => T): T {
  const saved = process.env[name];
  if (saved === undefined) return build();
  delete process.env[name];
  try {
    return build();
  } finally {
    process.env[name] = saved;
  }
}
