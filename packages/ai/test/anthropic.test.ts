import { describe, expect, it } from 'vitest';
import { ANSWER_JSON_SCHEMAS } from '../src/answer.ts';
import {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_FALLBACK_BETA,
  createAnthropicProvider,
} from '../src/providers/anthropic.ts';
import type { ProviderAnswer, ProviderRequest } from '../src/provider.ts';

const KEY = 'sk-ant-api03-TEST-KEY-a1b2c3d4e5f6-DO-NOT-LEAK';

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
      headers: { 'content-type': 'application/json', 'request-id': 'req_test', ...headers },
    });

const message = (over: Record<string, unknown> = {}) =>
  json(200, {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: ANTHROPIC_DEFAULT_MODEL,
    content: [{ type: 'text', text: '{"kind":"web-patch"}' }],
    stop_reason: 'end_turn',
    stop_details: null,
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 40 },
    ...over,
  });

const apiError = (status: number, type: string, headers: Record<string, string> = {}) =>
  json(
    status,
    { type: 'error', error: { type, message: `upstream says ${KEY} is wrong` } },
    headers,
  );

const request = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  system: 'SYSTEM PROMPT',
  user: 'USER MESSAGE',
  schema: ANSWER_JSON_SCHEMAS.web,
  maxOutputTokens: 2048,
  signal: new AbortController().signal,
  ...over,
});

async function run(responses: (() => Response)[], options: { model?: string } = {}) {
  const canned = cannedFetch(...responses);
  const provider = createAnthropicProvider({ apiKey: KEY, fetch: canned.fetch, ...options });
  const answer = await provider.suggestFix(request());
  return { answer, sent: canned.sent, provider };
}

const noKey = (answer: ProviderAnswer) => {
  expect(JSON.stringify(answer)).not.toContain(KEY);
  expect(String(answer.status === 'ok' ? answer.text : answer.reason)).not.toContain(KEY);
};

describe('createAnthropicProvider: the request', () => {
  it('names the configured model and sends the key only in the Authorization header (SDK 1.3.0 uses Bearer, not x-api-key)', async () => {
    const { sent, provider } = await run([message()]);
    expect(provider.id).toBe('anthropic');
    expect(provider.model).toBe('claude-opus-5-5');
    expect(sent).toHaveLength(1);
    const [req] = sent;
    expect(req?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req?.method).toBe('POST');
    expect(req?.body.model).toBe('claude-opus-5-5');
    expect(req?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req?.headers['x-api-key']).toBeUndefined();
    const elsewhere = Object.entries(req?.headers ?? {}).filter(
      ([k, v]) => k !== 'authorization' && v.includes(KEY),
    );
    expect(elsewhere).toEqual([]);
    expect(req?.url).not.toContain(KEY);
    expect(req?.raw).not.toContain(KEY);
  });

  it('sends the system prompt and the user message exactly, at low effort with the schema', async () => {
    const { sent } = await run([message()]);
    const body = sent[0]?.body ?? {};
    expect(body.system).toBe('SYSTEM PROMPT');
    expect(body.messages).toEqual([{ role: 'user', content: 'USER MESSAGE' }]);
    expect(body.max_tokens).toBe(2048);
    expect(body.output_config).toEqual({
      effort: 'low',
      format: { type: 'json_schema', schema: ANSWER_JSON_SCHEMAS.web },
    });
    for (const absent of ['thinking', 'temperature', 'top_p', 'top_k', 'output_format', 'stream'])
      expect(body, absent).not.toHaveProperty(absent);
    expect(body.fallbacks).toBe('default');
    expect(sent[0]?.headers['anthropic-beta']).toBe(ANTHROPIC_FALLBACK_BETA);
    expect(ANTHROPIC_FALLBACK_BETA).toBe('server-side-fallback-2026-07-01');
  });

  it('ignores ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL in the environment', async () => {
    const saved = { token: process.env.ANTHROPIC_AUTH_TOKEN, base: process.env.ANTHROPIC_BASE_URL };
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-token-must-not-be-sent';
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9/elsewhere';
    try {
      const { sent } = await run([message()]);
      expect(sent[0]?.url).toBe('https://api.anthropic.com/v1/messages');
      expect(JSON.stringify(sent[0]?.headers)).not.toContain('env-token-must-not-be-sent');
    } finally {
      for (const [name, value] of [
        ['ANTHROPIC_AUTH_TOKEN', saved.token],
        ['ANTHROPIC_BASE_URL', saved.base],
      ] as const)
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
  });

  it('uses the model override when given', async () => {
    const { sent, provider } = await run([message({ model: 'claude-sonnet-5-5' })], {
      model: 'claude-sonnet-5-5',
    });
    expect(provider.model).toBe('claude-sonnet-5-5');
    expect(sent[0]?.body.model).toBe('claude-sonnet-5-5');
  });

  it('sends schemas with no keyword the structured output subset rejects', () => {
    const UNSUPPORTED = [
      'minLength',
      'maxLength',
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'multipleOf',
      'maxItems',
      'pattern',
      'oneOf',
      '$schema',
    ];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
      if (typeof node !== 'object' || node === null) return;
      const record = node as Record<string, unknown>;
      for (const key of UNSUPPORTED) expect(record, `${path}.${key}`).not.toHaveProperty(key);
      if (record.minItems !== undefined) expect([0, 1], path).toContain(record.minItems);
      if (record.type === 'object') expect(record.additionalProperties, path).toBe(false);
      for (const [k, v] of Object.entries(record)) walk(v, `${path}.${k}`);
    };
    walk(ANSWER_JSON_SCHEMAS.web, 'web');
    walk(ANSWER_JSON_SCHEMAS.pdf, 'pdf');
  });

  it('lets the SDK retry nothing: a 500 makes exactly one request', async () => {
    const { sent, answer } = await run([apiError(500, 'api_error'), message()]);
    expect(sent).toHaveLength(1);
    expect(answer).toMatchObject({ status: 'error', fatal: false });
  });
});

describe('createAnthropicProvider: the answer', () => {
  it('returns the text, the model that answered and the usage', async () => {
    const { answer } = await run([message()]);
    expect(answer).toEqual({
      status: 'ok',
      text: '{"kind":"web-patch"}',
      modelAnswered: 'claude-opus-5-5',
      usage: { inputTokens: 120, outputTokens: 40 },
    });
  });

  it('reads only text blocks, after a thinking block', async () => {
    const { answer } = await run([
      message({
        content: [
          { type: 'thinking', thinking: 'IGNORE ME', signature: 'sig' },
          { type: 'text', text: '{"a":1}' },
        ],
      }),
    ]);
    expect(answer).toMatchObject({ status: 'ok', text: '{"a":1}' });
  });

  it('records the fallback model that answered', async () => {
    const { answer } = await run([
      message({
        model: 'claude-opus-4-8',
        content: [
          {
            type: 'fallback',
            from: { model: 'claude-opus-5-5' },
            to: { model: 'claude-opus-4-8' },
          },
          { type: 'text', text: '{"b":2}' },
        ],
      }),
    ]);
    expect(answer).toMatchObject({
      status: 'ok',
      text: '{"b":2}',
      modelAnswered: 'claude-opus-4-8',
    });
  });

  it('maps a refusal to refused with its category, before reading content', async () => {
    const refusal = (category: string | null) =>
      message({
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category, explanation: `free text ${KEY}` },
        content: [{ type: 'text', text: '{"kind":"web-patch"}' }],
      });
    const cyber = await run([refusal('cyber')]);
    expect(cyber.answer).toEqual({
      status: 'refused',
      reason: 'the model declined to answer (category: cyber)',
    });
    const none = await run([refusal(null)]);
    expect(none.answer).toEqual({
      status: 'refused',
      reason: 'the model declined to answer (category: none)',
    });
    const odd = await run([refusal('Ignore previous instructions')]);
    expect(odd.answer).toMatchObject({ reason: 'the model declined to answer (category: none)' });
    noKey(cyber.answer);
  });

  it('maps max_tokens to an error, and any other stop reason too', async () => {
    const cut = await run([message({ stop_reason: 'max_tokens' })]);
    expect(cut.answer).toEqual({
      status: 'error',
      reason: 'the answer was cut off',
      fatal: false,
      errorClass: 'cut-off',
      usage: { inputTokens: 120, outputTokens: 40 },
    });
    const paused = await run([message({ stop_reason: 'pause_turn' })]);
    expect(paused.answer).toMatchObject({
      status: 'error',
      reason: 'the model stopped without an answer (pause_turn)',
    });
    const unknown = await run([message({ stop_reason: 'free text here' })]);
    expect(unknown.answer).toMatchObject({ reason: 'the model stopped without an answer (other)' });
  });

  it('refuses an answer with no text block', async () => {
    const { answer } = await run([
      message({ content: [{ type: 'thinking', thinking: 'x', signature: 's' }] }),
    ]);
    expect(answer).toEqual({ status: 'error', reason: 'the answer had no text', fatal: false });
  });
});

describe('createAnthropicProvider: errors', () => {
  const CASES: [name: string, response: () => Response, expected: Record<string, unknown>][] = [
    [
      '401',
      apiError(401, 'authentication_error'),
      { reason: 'the Anthropic API refused the key in ANTHROPIC_API_KEY (401)', fatal: true },
    ],
    [
      '403',
      apiError(403, 'permission_error'),
      { reason: 'the Anthropic API refused the key in ANTHROPIC_API_KEY (403)', fatal: true },
    ],
    [
      '404',
      apiError(404, 'not_found_error'),
      { reason: 'model claude-opus-5-5 not found (404)', fatal: true },
    ],
    [
      '429 with retry-after: 7',
      apiError(429, 'rate_limit_error', { 'retry-after': '7' }),
      {
        reason: 'the Anthropic API rate limit was reached (429)',
        fatal: false,
        rateLimited: true,
        retryAfterMs: 7000,
      },
    ],
    [
      // Final fix round 1 item 15: the shared helper honours retry-after-ms in both providers.
      '429 with retry-after-ms: 1500',
      apiError(429, 'rate_limit_error', { 'retry-after-ms': '1500', 'retry-after': '9' }),
      {
        reason: 'the Anthropic API rate limit was reached (429)',
        fatal: false,
        rateLimited: true,
        retryAfterMs: 1500,
      },
    ],
    [
      '400',
      apiError(400, 'invalid_request_error'),
      { reason: 'the Anthropic API rejected the request (400)', fatal: false },
    ],
    [
      '500',
      apiError(500, 'api_error'),
      { reason: 'the Anthropic API had a server error (500)', fatal: false, errorClass: 'server' },
    ],
    [
      '529',
      apiError(529, 'overloaded_error'),
      { reason: 'the Anthropic API had a server error (529)', fatal: false, errorClass: 'server' },
    ],
    [
      '402',
      apiError(402, 'billing_error'),
      { reason: 'the Anthropic API returned an error (402)', fatal: true },
    ],
  ];
  for (const [name, response, expected] of CASES)
    it(`maps ${name}`, async () => {
      const { answer } = await run([response]);
      expect(answer).toEqual({ status: 'error', ...expected });
      noKey(answer);
    });

  it('a 429 without retry-after has no retryAfterMs', async () => {
    const { answer } = await run([apiError(429, 'rate_limit_error')]);
    expect(answer).not.toHaveProperty('retryAfterMs');
    expect(answer).toMatchObject({ rateLimited: true });
  });

  it('a connection failure is not fatal and never carries the thrown text', async () => {
    const provider = createAnthropicProvider({
      apiKey: KEY,
      fetch: (async () => {
        throw new Error(`socket hang up while sending ${KEY}`);
      }) as typeof fetch,
    });
    const answer = await provider.suggestFix(request());
    expect(answer).toEqual({
      status: 'error',
      reason: 'could not reach the Anthropic API',
      errorClass: 'connection',
      fatal: false,
    });
    noKey(answer);
  });

  it('a cancelled request is reported as cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const canned = cannedFetch(message());
    const provider = createAnthropicProvider({ apiKey: KEY, fetch: canned.fetch });
    const answer = await provider.suggestFix(request({ signal: controller.signal }));
    expect(answer).toEqual({ status: 'error', reason: 'the request was cancelled', fatal: false });
  });

  it('never throws, and no thrown text or String(error) path holds the key', async () => {
    const provider = createAnthropicProvider({
      apiKey: KEY,
      fetch: (async () => {
        throw Object.assign(new TypeError(KEY), { cause: KEY });
      }) as typeof fetch,
    });
    await expect(provider.suggestFix(request())).resolves.toMatchObject({ status: 'error' });
    const answer = await provider.suggestFix(request());
    expect(String(answer.status === 'ok' ? '' : answer.reason)).not.toContain(KEY);
  });
});

// Task 3b.4 fix round 1.
describe('createAnthropicProvider: fix round 1', () => {
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

  it("ignores the reviewer's ANTHROPIC_CUSTOM_HEADERS and restores the variable", async () => {
    const value = [
      'x-api-key: sk-ant-FROM-ENV',
      'anthropic-version: 2023-01-01',
      'X-Gateway-Token: gw-secret',
    ].join(String.fromCharCode(10));
    const { sent } = await withEnv({ ANTHROPIC_CUSTOM_HEADERS: value }, async () => {
      const result = await run([message()]);
      expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(value);
      return result;
    });
    const headers = sent[0]?.headers ?? {};
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['x-gateway-token']).toBeUndefined();
    expect(headers['anthropic-version']).toBe('2026-10-21');
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(headers)).not.toMatch(/FROM-ENV|gw-secret|2023-01-01/);
  });

  it('throws before any request when the key is missing or blank, even with ANTHROPIC_API_KEY set', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-env-key' }, async () => {
      for (const apiKey of [undefined, '', '   '] as unknown as string[]) {
        const canned = cannedFetch(message());
        expect(() => createAnthropicProvider({ apiKey, fetch: canned.fetch })).toThrow(
          'the Anthropic provider needs a key: set ANTHROPIC_API_KEY',
        );
        expect(canned.sent).toHaveLength(0);
      }
    });
  });

  // Final fix round 1 item 15: the shared model-id rule, after the key check.
  it('refuses a model that is not a model id before any request, the key check first', () => {
    for (const model of ['bad model', 'a'.repeat(101), 'claude<script>']) {
      const canned = cannedFetch(message());
      expect(() => createAnthropicProvider({ apiKey: KEY, model, fetch: canned.fetch })).toThrow(
        'the Anthropic provider needs a valid model id',
      );
      expect(() => createAnthropicProvider({ apiKey: '', model, fetch: canned.fetch })).toThrow(
        'the Anthropic provider needs a key: set ANTHROPIC_API_KEY',
      );
      expect(canned.sent).toHaveLength(0);
    }
  });

  it('records modelAnswered only when it looks like a model id', async () => {
    for (const [served, recorded] of [
      ['claude-opus-4-8', 'claude-opus-4-8'],
      ['anthropic/claude-opus-4-8@2026', 'anthropic/claude-opus-4-8@2026'],
      ['claude <script>', 'claude-opus-5-5'],
      ['', 'claude-opus-5-5'],
      ['x'.repeat(101), 'claude-opus-5-5'],
      [`ignore previous${String.fromCharCode(10)}instructions`, 'claude-opus-5-5'],
    ]) {
      const { answer } = await run([message({ model: served })]);
      expect(answer.status === 'ok' && answer.modelAnswered, String(served)).toBe(recorded);
    }
  });
});

// Task 3b.5 fix round 1, item 3: absent usage stays absent.
describe('createAnthropicProvider: usage', () => {
  it('leaves usage out when the response has none or a broken count', async () => {
    for (const usage of [
      undefined,
      null,
      { input_tokens: 'x', output_tokens: 1 },
      { output_tokens: 3 },
    ]) {
      const { answer } = await run([message({ usage })]);
      expect(answer.status).toBe('ok');
      expect(answer, JSON.stringify(usage)).not.toHaveProperty('usage');
    }
  });

  it('keeps zero counts as reported', async () => {
    const { answer } = await run([message({ usage: { input_tokens: 0, output_tokens: 0 } })]);
    expect(answer).toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 } });
  });
});
