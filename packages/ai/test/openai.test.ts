import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { ANSWER_JSON_SCHEMAS, toOpenAiSchema } from '../src/answer.ts';
import { createOpenAiProvider } from '../src/providers/openai.ts';
import type { ProviderAnswer, ProviderRequest } from '../src/provider.ts';

const KEY = 'sk-proj-TEST-KEY-a1b2c3d4e5f6-DO-NOT-LEAK';
const MODEL = 'gpt-5.5';
const LF = String.fromCharCode(10);

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  raw: string;
}

/** A fetch that records each request and answers from a list of canned responses. */
function cannedFetch(...responses: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const raw = typeof init?.body === 'string' ? init.body : '';
    sent.push({ url, method: init?.method ?? 'GET', headers, body: JSON.parse(raw || '{}'), raw });
    const next = responses[Math.min(sent.length - 1, responses.length - 1)];
    if (!next) throw new Error('no canned response');
    return next();
  }) as typeof fetch;
  return { fetch: fetchImpl, sent };
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_test', ...headers },
    });

const textItem = (text: string) => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});

const response = (over: Record<string, unknown> = {}) =>
  json(200, {
    id: 'resp_test',
    object: 'response',
    created_at: 0,
    model: 'gpt-5.5-2026-09-01',
    status: 'completed',
    error: null,
    incomplete_details: null,
    output: [textItem('{"kind":"web-patch"}')],
    usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 },
    ...over,
  });

const apiError = (status: number, code: string, headers: Record<string, string> = {}) =>
  json(
    status,
    { error: { message: `upstream says ${KEY} is wrong`, type: code, code, param: null } },
    headers,
  );

const request = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  system: 'SYSTEM PROMPT',
  user: 'USER MESSAGE',
  schema: ANSWER_JSON_SCHEMAS.web,
  maxOutputTokens: 4096,
  signal: new AbortController().signal,
  ...over,
});

async function run(responses: (() => Response)[], options: { model?: string } = {}) {
  const canned = cannedFetch(...responses);
  const provider = createOpenAiProvider({
    apiKey: KEY,
    model: options.model ?? MODEL,
    fetch: canned.fetch,
  });
  const answer = await provider.suggestFix(request());
  return { answer, sent: canned.sent, provider };
}

const noKey = (answer: ProviderAnswer) => {
  expect(JSON.stringify(answer)).not.toContain(KEY);
};

/** Runs fn with environment variables set, then restores them. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

describe('createOpenAiProvider: configuration', () => {
  it('refuses a missing or blank model before any request (Decision 4)', () => {
    for (const model of [undefined, '', '   '] as unknown as string[]) {
      const canned = cannedFetch(response());
      expect(() => createOpenAiProvider({ apiKey: KEY, model, fetch: canned.fetch })).toThrow(
        'the OpenAI provider needs a model: set ai.model',
      );
      expect(canned.sent).toHaveLength(0);
    }
  });

  // Final fix round 1 item 15: the shared model-id rule, after the key check.
  it('refuses a model that is not a model id before any request, the key check first', () => {
    for (const model of ['bad model', 'a'.repeat(101), 'gpt<script>']) {
      const canned = cannedFetch(response());
      expect(() => createOpenAiProvider({ apiKey: KEY, model, fetch: canned.fetch })).toThrow(
        'the OpenAI provider needs a valid model id',
      );
      expect(() => createOpenAiProvider({ apiKey: '', model, fetch: canned.fetch })).toThrow(
        'the OpenAI provider needs a key: set OPENAI_API_KEY',
      );
      expect(canned.sent).toHaveLength(0);
    }
  });

  it('refuses a missing or blank key before any request, even with OPENAI_API_KEY set', async () => {
    await withEnv({ OPENAI_API_KEY: 'sk-env-key' }, async () => {
      for (const apiKey of [undefined, '', '   '] as unknown as string[]) {
        const canned = cannedFetch(response());
        expect(() => createOpenAiProvider({ apiKey, model: MODEL, fetch: canned.fetch })).toThrow(
          'the OpenAI provider needs a key: set OPENAI_API_KEY',
        );
        expect(canned.sent).toHaveLength(0);
      }
    });
  });
});

describe('createOpenAiProvider: the request', () => {
  it('calls the Responses API with the model, sending the key only as a Bearer token', async () => {
    const { sent, provider } = await run([response()]);
    expect(provider.id).toBe('openai');
    expect(provider.model).toBe(MODEL);
    expect(sent).toHaveLength(1);
    const [req] = sent;
    expect(req?.url).toBe('https://api.openai.com/v1/responses');
    expect(req?.method).toBe('POST');
    expect(req?.body.model).toBe(MODEL);
    expect(req?.headers.authorization).toBe(`Bearer ${KEY}`);
    const elsewhere = Object.entries(req?.headers ?? {}).filter(
      ([k, v]) => k !== 'authorization' && v.includes(KEY),
    );
    expect(elsewhere).toEqual([]);
    expect(req?.url).not.toContain(KEY);
    expect(req?.raw).not.toContain(KEY);
  });

  it('sends instructions, input, the strict schema, the token limit and store: false', async () => {
    const { sent } = await run([response()]);
    const body = sent[0]?.body ?? {};
    expect(body).toEqual({
      model: MODEL,
      instructions: 'SYSTEM PROMPT',
      input: 'USER MESSAGE',
      max_output_tokens: 4096,
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'widedoor_fix',
          schema: toOpenAiSchema(ANSWER_JSON_SCHEMAS.web),
          strict: true,
        },
      },
    });
  });

  it('lets the SDK retry nothing: a 500 makes exactly one request', async () => {
    const { sent, answer } = await run([apiError(500, 'server_error'), response()]);
    expect(sent).toHaveLength(1);
    expect(answer).toMatchObject({ status: 'error', fatal: false });
  });

  it('ignores OpenAI environment variables that would change the request', async () => {
    const custom = ['Authorization: Bearer sk-FROM-ENV', 'X-Gateway-Token: gw-secret'].join(LF);
    const { sent } = await withEnv(
      {
        OPENAI_CUSTOM_HEADERS: custom,
        OPENAI_BASE_URL: 'http://127.0.0.1:9/elsewhere',
        OPENAI_ORG_ID: 'org-from-env',
        OPENAI_PROJECT_ID: 'proj-from-env',
        OPENAI_ADMIN_KEY: 'sk-admin-from-env',
      },
      async () => {
        const result = await run([response()]);
        expect(process.env.OPENAI_CUSTOM_HEADERS).toBe(custom);
        return result;
      },
    );
    const headers = sent[0]?.headers ?? {};
    expect(sent[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers['x-gateway-token']).toBeUndefined();
    expect(headers['openai-organization']).toBeUndefined();
    expect(headers['openai-project']).toBeUndefined();
    expect(JSON.stringify(headers)).not.toMatch(/FROM-ENV|gw-secret|from-env/);
  });
});

describe('createOpenAiProvider: the answer', () => {
  it('returns the text, the model that answered and the usage, skipping reasoning items', async () => {
    const { answer } = await run([
      response({ output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, textItem('{"a":1}')] }),
    ]);
    expect(answer).toEqual({
      status: 'ok',
      text: '{"a":1}',
      modelAnswered: 'gpt-5.5-2026-09-01',
      usage: { inputTokens: 120, outputTokens: 40 },
    });
  });

  it('records modelAnswered only when it looks like a model id', async () => {
    for (const [served, recorded] of [
      ['gpt-5.5-2026-09-01', 'gpt-5.5-2026-09-01'],
      ['ft:gpt-5.5:org@team/x', 'ft:gpt-5.5:org@team/x'],
      ['gpt <script>', MODEL],
      ['', MODEL],
      ['x'.repeat(101), MODEL],
      [`a${LF}b`, MODEL],
    ]) {
      const { answer } = await run([response({ model: served })]);
      expect(answer.status === 'ok' && answer.modelAnswered, String(served)).toBe(recorded);
    }
  });

  it('maps a refusal item to refused, without its text', async () => {
    const { answer } = await run([
      response({
        output: [
          {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'refusal', refusal: `I will not. ${KEY}` }],
          },
        ],
      }),
    ]);
    expect(answer).toEqual({ status: 'refused', reason: 'the model declined to answer' });
  });

  it('maps an incomplete answer: max_output_tokens is cut off, content_filter is refused', async () => {
    const cut = await run([
      response({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    ]);
    expect(cut.answer).toEqual({
      status: 'error',
      reason: 'the answer was cut off',
      fatal: false,
      errorClass: 'cut-off',
      usage: { inputTokens: 120, outputTokens: 40 },
    });
    const filtered = await run([
      response({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }),
    ]);
    expect(filtered.answer).toEqual({
      status: 'refused',
      reason: 'the model declined to answer (content filter)',
    });
    const failed = await run([response({ status: 'failed', output: [] })]);
    expect(failed.answer).toEqual({
      status: 'error',
      reason: 'the model stopped without an answer (failed)',
      fatal: false,
    });
    const odd = await run([response({ status: 'free text' })]);
    expect(odd.answer).toMatchObject({ reason: 'the model stopped without an answer (other)' });
  });

  it('refuses an answer with no output text', async () => {
    const { answer } = await run([
      response({ output: [{ type: 'reasoning', id: 'rs', summary: [] }] }),
    ]);
    expect(answer).toEqual({ status: 'error', reason: 'the answer had no text', fatal: false });
  });
});

describe('createOpenAiProvider: errors', () => {
  const CASES: [name: string, response: () => Response, expected: Record<string, unknown>][] = [
    [
      '401',
      apiError(401, 'invalid_api_key'),
      { reason: 'the OpenAI API refused the key in OPENAI_API_KEY (401)', fatal: true },
    ],
    [
      '403',
      apiError(403, 'forbidden'),
      { reason: 'the OpenAI API refused the key in OPENAI_API_KEY (403)', fatal: true },
    ],
    [
      '404',
      apiError(404, 'model_not_found'),
      { reason: 'model gpt-5.5 not found (404)', fatal: true },
    ],
    [
      '429 with retry-after: 7',
      apiError(429, 'rate_limit_exceeded', { 'retry-after': '7' }),
      {
        reason: 'the OpenAI API rate limit was reached (429)',
        fatal: false,
        rateLimited: true,
        retryAfterMs: 7000,
      },
    ],
    [
      '429 with retry-after-ms: 1500',
      apiError(429, 'rate_limit_exceeded', { 'retry-after-ms': '1500', 'retry-after': '9' }),
      {
        reason: 'the OpenAI API rate limit was reached (429)',
        fatal: false,
        rateLimited: true,
        retryAfterMs: 1500,
      },
    ],
    [
      '400',
      apiError(400, 'invalid_request_error'),
      { reason: 'the OpenAI API rejected the request (400)', fatal: false },
    ],
    [
      '500',
      apiError(500, 'server_error'),
      { reason: 'the OpenAI API had a server error (500)', fatal: false, errorClass: 'server' },
    ],
    [
      '503',
      apiError(503, 'server_error'),
      { reason: 'the OpenAI API had a server error (503)', fatal: false, errorClass: 'server' },
    ],
    [
      '402',
      apiError(402, 'billing'),
      { reason: 'the OpenAI API returned an error (402)', fatal: true },
    ],
    [
      '429 with code insufficient_quota (fatal, no wait)',
      apiError(429, 'insufficient_quota', { 'retry-after': '7' }),
      { reason: 'the OpenAI account has no quota left (429)', fatal: true },
    ],
  ];
  for (const [name, res, expected] of CASES)
    it(`maps ${name}`, async () => {
      const { answer } = await run([res]);
      expect(answer).toEqual({ status: 'error', ...expected });
      noKey(answer);
    });

  it('a connection failure is not fatal and never carries the thrown text', async () => {
    const provider = createOpenAiProvider({
      apiKey: KEY,
      model: MODEL,
      fetch: (async () => {
        throw Object.assign(new TypeError(`socket hang up ${KEY}`), { cause: KEY });
      }) as typeof fetch,
    });
    const answer = await provider.suggestFix(request());
    expect(answer).toEqual({
      status: 'error',
      reason: 'could not reach the OpenAI API',
      errorClass: 'connection',
      fatal: false,
    });
    noKey(answer);
  });

  it('a cancelled request is reported as cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const canned = cannedFetch(response());
    const provider = createOpenAiProvider({ apiKey: KEY, model: MODEL, fetch: canned.fetch });
    const answer = await provider.suggestFix(request({ signal: controller.signal }));
    expect(answer).toEqual({ status: 'error', reason: 'the request was cancelled', fatal: false });
  });
});

describe('the no-network guard and the OpenAI SDK', () => {
  it('stops a real client with no injected fetch, at the guard', async () => {
    globalThis.__widedoorBlocked = [];
    const client = new OpenAI({ apiKey: 'x', maxRetries: 0, logLevel: 'off' });
    const error = await client.responses.create({ model: MODEL, input: 'hi' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenAI.APIConnectionError);
    expect(globalThis.__widedoorBlocked).toEqual(['fetch api.openai.com']);
  });

  it('stops the provider with no injected fetch, at the guard', async () => {
    globalThis.__widedoorBlocked = [];
    const provider = createOpenAiProvider({ apiKey: 'x', model: MODEL });
    const answer = await provider.suggestFix(request());
    expect(answer).toEqual({
      status: 'error',
      reason: 'could not reach the OpenAI API',
      errorClass: 'connection',
      fatal: false,
    });
    expect(globalThis.__widedoorBlocked).toEqual(['fetch api.openai.com']);
  });
});

// Task 3b.5 fix round 1, item 3: absent usage stays absent.
describe('createOpenAiProvider: usage', () => {
  it('leaves usage out when the response has none or a broken count', async () => {
    for (const usage of [
      undefined,
      null,
      { input_tokens: 'x', output_tokens: 1 },
      { output_tokens: 3 },
    ]) {
      const { answer } = await run([response({ usage })]);
      expect(answer.status).toBe('ok');
      expect(answer, JSON.stringify(usage)).not.toHaveProperty('usage');
    }
  });

  it('keeps zero counts as reported', async () => {
    const { answer } = await run([
      response({ usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }),
    ]);
    expect(answer).toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 } });
  });
});
