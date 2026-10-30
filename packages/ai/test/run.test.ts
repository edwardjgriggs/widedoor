import { describe, expect, it } from 'vitest';
import { FindingSchema, findingId, getProfile, type Asset, type Finding } from '@widedoor/core';
import { buildScanReport, type ScanReport } from '@widedoor/report';
import { ANSWER_JSON_SCHEMAS } from '../src/answer.ts';
import { AiSuggestionsSchema, DEFAULT_AI_LIMITS, type AiLimits } from '../src/model.ts';
import { SYSTEM_PROMPT, buildUserMessage } from '../src/prompt.ts';
import type { ProviderAnswer } from '../src/provider.ts';
import { createFakeProvider } from '../src/providers/fake.ts';
import {
  AiConfigError,
  PREVIEW_NONCE,
  estimateTokens,
  previewFixes,
  suggestFixes,
} from '../src/run.ts';

const PAGE: Asset = {
  kind: 'web',
  uri: 'https://shop.example/a',
  contentHash: `sha256:${'a'.repeat(64)}`,
};
const MARKER = 'ZQXJMARKERZQXJ';

/** One fail per index, each with its own snippet, so each is its own group. */
function finding(i: number, extra = ''): Finding {
  const location = { selector: `img.i${i}` };
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(PAGE.uri, location, 'axe-core', `image-alt`),
    asset: PAGE,
    location,
    source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId: 'image-alt' },
    criteria: { wcag: ['1.1.1'] },
    outcome: 'fail',
    impact: 'critical',
    evidence: { snippet: `<img src="/i${i}.png" class="pic n${i}"${extra}>` },
  });
}

function report(n: number, extra = ''): ScanReport {
  return buildScanReport({
    profile: getProfile('wcag21aa'),
    startedAt: '2026-10-29T12:00:00.000Z',
    finishedAt: '2026-10-29T12:05:00.000Z',
    toolVersion: '0.0.0',
    scope: { web: { urls: [PAGE.uri], truncated: false } },
    web: {
      engine: { name: 'axe-core', version: '4.14.0' },
      assets: [PAGE],
      findings: Array.from({ length: n }, (_, i) => finding(i, extra)),
      errors: [],
      skipped: [],
      warnings: [],
      truncated: false,
    },
  });
}

const limits = (over: Partial<AiLimits> = {}): AiLimits => ({
  ...DEFAULT_AI_LIMITS,
  concurrency: 1,
  maxRequestsPerMinute: 60,
  ...over,
});

const okText = JSON.stringify({
  kind: 'web-patch',
  summary: 'Add a text alternative.',
  patch: '<img src="/i0.png" alt="Product photo">',
  notes: null,
});
const ok = (over: Partial<Extract<ProviderAnswer, { status: 'ok' }>> = {}): ProviderAnswer => ({
  status: 'ok',
  text: okText,
  modelAnswered: 'claude-opus-5-5',
  usage: { inputTokens: 100, outputTokens: 20 },
  ...over,
});
const error = (reason: string, fatal = false, retryAfterMs?: number): ProviderAnswer => ({
  status: 'error',
  reason,
  fatal,
  ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
});

/** A fake clock: sleep advances now and records each wait. */
function clock() {
  let t = Date.parse('2026-10-29T13:00:00.000Z');
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => (t += ms),
    sleeps,
  };
}

/** A nonce source that hands out 1, 2, 3, ... as 32 hex digits, and remembers them. */
function nonces() {
  const issued: string[] = [];
  return {
    next: () => {
      const n = (issued.length + 1).toString(16).padStart(32, '0');
      issued.push(n);
      return n;
    },
    issued,
  };
}

async function run(
  r: ScanReport,
  script: (user: string, call: number) => ProviderAnswer | Promise<ProviderAnswer>,
  over: Partial<AiLimits> = {},
  options: { signal?: AbortSignal } = {},
) {
  let call = 0;
  const provider = createFakeProvider((user) => script(user, call++), { model: 'claude-opus-5-5' });
  const c = clock();
  const n = nonces();
  const lines: string[] = [];
  const doc = await suggestFixes({
    report: r,
    provider,
    limits: limits(over),
    now: c.now,
    sleep: c.sleep,
    log: (line) => lines.push(line),
    nonce: n.next,
    ...options,
  });
  return { doc, provider, clock: c, nonces: n, lines };
}

const statuses = (doc: { entries: { status: string }[] }) => doc.entries.map((e) => e.status);

describe('suggestFixes', () => {
  it('sends maxGroups groups and counts the rest as skipped', async () => {
    const { doc, provider } = await run(report(30), () => ok(), { maxGroups: 25 });
    expect(provider.calls).toHaveLength(25);
    expect(doc.entries).toHaveLength(25);
    expect(doc.totals).toEqual({
      requests: 25,
      inputTokens: 2500,
      outputTokens: 500,
      skippedGroups: 5,
    });
    expect(doc.entries.every((e) => e.status === 'ok' && e.delivered)).toBe(true);
    expect(AiSuggestionsSchema.parse(doc)).toEqual(doc);
  });

  it('fills the document header', async () => {
    const r = report(2);
    const { doc } = await run(r, () => ok({ modelAnswered: 'claude-opus-4-8' }));
    expect(doc).toMatchObject({
      schemaVersion: 1,
      $id: 'urn:widedoor:schema:ai-suggestions:v1',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      modelAnswered: 'claude-opus-4-8',
      createdAt: '2026-10-29T13:00:00.000Z',
      report: { startedAt: r.startedAt, findings: r.findings.length },
    });
  });

  it('sends exactly the request it records, with a fresh nonce each time', async () => {
    const { doc, provider, nonces: n } = await run(report(5), () => ok());
    expect(n.issued).toHaveLength(5);
    provider.calls.forEach((call, i) => {
      expect(call.system).toBe(SYSTEM_PROMPT);
      const entry = doc.entries[i];
      expect(call.user).toBe(buildUserMessage(entry!.request, n.issued[i]!));
    });
  });

  it('uses a different random nonce for every request by default', async () => {
    const provider = createFakeProvider(() => ok());
    await suggestFixes({ report: report(6), provider, limits: limits(), sleep: async () => {} });
    const used = provider.calls.map((c) => /nonce="([0-9a-f]{32})"/.exec(c.user)?.[1]);
    expect(used.every((u) => u !== undefined)).toBe(true);
    expect(new Set(used).size).toBe(6);
  });

  it('marks an invalid answer invalid with a reason and keeps going', async () => {
    const { doc } = await run(report(3), (_, call) =>
      call === 0 ? ok({ text: 'not json' }) : ok(),
    );
    expect(statuses(doc)).toEqual(['invalid', 'ok', 'ok']);
    expect(doc.entries[0]).toMatchObject({ delivered: true, reason: 'the answer is not JSON' });
    expect(doc.entries[0]?.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it('checks each answer against its own snippet', async () => {
    const link = JSON.stringify({
      kind: 'web-patch',
      summary: 's',
      patch: '<a href="https://evil.example/x">x</a>',
      notes: null,
    });
    const { doc } = await run(report(1), () => ok({ text: link }));
    expect(doc.entries[0]).toMatchObject({
      status: 'invalid',
      reason: 'the suggestion contained a link',
    });
  });

  it('records a refusal as refused and delivered', async () => {
    const { doc } = await run(report(2), (_, call) =>
      call === 0
        ? { status: 'refused', reason: 'the model declined to answer (category: none)' }
        : ok(),
    );
    expect(doc.entries[0]).toMatchObject({
      status: 'refused',
      delivered: true,
      reason: 'the model declined to answer (category: none)',
    });
    expect(statuses(doc)).toEqual(['refused', 'ok']);
  });

  it('a provider that throws is an error, delivered', async () => {
    const { doc } = await run(report(2), (_, call) => {
      if (call === 0) throw new Error(`boom ${MARKER}`);
      return ok();
    });
    expect(doc.entries[0]).toMatchObject({
      status: 'error',
      delivered: true,
      reason: 'the provider failed',
    });
    expect(JSON.stringify(doc)).not.toContain(MARKER);
  });

  it('a fatal error on the first request stops the run: one call, the rest not sent', async () => {
    const reason = 'the Anthropic API refused the key in ANTHROPIC_API_KEY (401)';
    const { doc, provider, lines } = await run(report(4), () => error(reason, true));
    expect(provider.calls).toHaveLength(1);
    expect(doc.entries[0]).toMatchObject({ status: 'error', delivered: true, reason });
    for (const entry of doc.entries.slice(1))
      expect(entry).toMatchObject({
        status: 'not-sent',
        delivered: false,
        reason: `stopped after a fatal error: ${reason}`,
      });
    expect(lines.filter((l) => l.startsWith('ai_stop'))).toEqual(['ai_stop reason=fatal-error']);
  });

  it('three identical non-fatal errors stop the run', async () => {
    const reason = 'the Anthropic API rejected the request (400)';
    const { doc, provider, lines } = await run(report(6), () => error(reason));
    expect(provider.calls).toHaveLength(3);
    expect(statuses(doc)).toEqual(['error', 'error', 'error', 'not-sent', 'not-sent', 'not-sent']);
    expect(doc.entries.slice(0, 3).every((e) => e.delivered)).toBe(true);
    expect(doc.entries[3]).toMatchObject({
      delivered: false,
      reason: `stopped after 3 identical errors: ${reason}`,
    });
    expect(lines.filter((l) => l.startsWith('ai_stop'))).toEqual([
      'ai_stop reason=identical-errors',
    ]);
  });

  it('different errors, or a success between them, do not trip the breaker', async () => {
    const script = (_: string, call: number) =>
      [
        error('a (500)'),
        error('a (500)'),
        ok(),
        error('a (500)'),
        error('b (503)'),
        error('a (500)'),
      ][call] ?? ok();
    const { doc, provider } = await run(report(6), script);
    expect(provider.calls).toHaveLength(6);
    expect(statuses(doc)).not.toContain('not-sent');
  });

  describe('429', () => {
    const limited = (ms?: number): ProviderAnswer => ({
      status: 'error',
      reason: 'the Anthropic API rate limit was reached (429)',
      fatal: false,
      rateLimited: true,
      ...(ms !== undefined ? { retryAfterMs: ms } : {}),
    });

    it('does not wait on an error the provider did not mark as rate limited', async () => {
      const unmarked = await run(report(2), (_, call) =>
        call === 0 ? error('the Anthropic API rate limit was reached (429)', false, 1000) : ok(),
      );
      expect(unmarked.clock.sleeps).toEqual([]);
      expect(unmarked.provider.calls).toHaveLength(2);
      const quota = await run(report(2), () =>
        error('the OpenAI account has no quota left (429)', true),
      );
      expect(quota.clock.sleeps).toEqual([]);
      expect(quota.provider.calls).toHaveLength(1);
    });

    it('waits retryAfterMs once, then retries with a new nonce', async () => {
      const {
        doc,
        clock: c,
        provider,
        nonces: n,
      } = await run(report(1), (_, call) => (call === 0 ? limited(7000) : ok()));
      expect(c.sleeps).toEqual([7000]);
      expect(provider.calls).toHaveLength(2);
      expect(new Set(n.issued).size).toBe(2);
      expect(doc.entries[0]?.status).toBe('ok');
      expect(doc.totals.requests).toBe(2);
    });

    it('waits 5 s when the provider gives no retry-after, and at most 60 s', async () => {
      const none = await run(report(1), (_, call) => (call === 0 ? limited() : ok()));
      expect(none.clock.sleeps).toEqual([5000]);
      const long = await run(report(1), (_, call) => (call === 0 ? limited(600_000) : ok()));
      expect(long.clock.sleeps).toEqual([60_000]);
    });

    it('a second 429 makes the group an error, delivered', async () => {
      const { doc, provider } = await run(report(2), (_, call) =>
        call < 2 ? limited(1000) : ok(),
      );
      expect(provider.calls).toHaveLength(3);
      expect(doc.entries[0]).toMatchObject({
        status: 'error',
        delivered: true,
        reason: 'the Anthropic API rate limit was reached (429)',
      });
      expect(doc.entries[1]?.status).toBe('ok');
    });
  });

  describe('rate', () => {
    it('makes the 11th request at 10 per minute wait for the window', async () => {
      const { clock: c, provider } = await run(report(11), () => ok(), {
        maxRequestsPerMinute: 10,
      });
      expect(provider.calls).toHaveLength(11);
      expect(c.sleeps).toEqual([60_000]);
    });

    it('never starts more than maxRequestsPerMinute in any rolling minute, under bursty completion', async () => {
      const c = clock();
      const starts: number[] = [];
      const delays = [5_000, 1_000, 30_000, 2_000, 45_000, 500, 20_000, 3_000];
      let call = 0;
      const provider = createFakeProvider(async () => {
        starts.push(c.now());
        const delay = delays[call++ % delays.length] ?? 0;
        await Promise.resolve();
        c.advance(delay);
        return ok();
      });
      const doc = await suggestFixes({
        report: report(25),
        provider,
        limits: limits({ concurrency: 4, maxRequestsPerMinute: 5 }),
        now: c.now,
        sleep: c.sleep,
      });
      expect(doc.entries).toHaveLength(25);
      for (const start of starts)
        expect(starts.filter((s) => s >= start && s < start + 60_000).length).toBeLessThanOrEqual(
          5,
        );
      expect(statuses(doc).every((s) => s === 'ok')).toBe(true);
    });

    it('never has more than concurrency requests in flight, and keeps group order', async () => {
      // No timers: each call parks until the test releases it, in a fixed permuted order.
      let inFlight = 0;
      let most = 0;
      const parked: (() => void)[] = [];
      const provider = createFakeProvider(async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise<void>((resolve) => parked.push(resolve));
        inFlight--;
        return ok();
      });
      const ORDER = [2, 0, 1];
      let released = 0;
      const pump = async () => {
        for (;;) {
          await Promise.resolve();
          await Promise.resolve();
          if (parked.length === 0) {
            if (released >= 12) return;
            continue;
          }
          const pick = ORDER[released % ORDER.length]! % parked.length;
          parked.splice(pick, 1)[0]?.();
          released++;
        }
      };
      const r = report(12);
      const [doc] = await Promise.all([
        suggestFixes({
          report: r,
          provider,
          limits: limits({ concurrency: 3 }),
          sleep: async () => {},
        }),
        pump(),
      ]);
      expect(most).toBe(3);
      expect(doc.entries.every((e) => e.status === 'ok')).toBe(true);
      const again = await suggestFixes({
        report: r,
        provider: createFakeProvider(() => ok()),
        limits: limits({ concurrency: 3 }),
        sleep: async () => {},
      });
      expect(doc.entries.map((e) => e.group)).toEqual(again.entries.map((e) => e.group));
    });
  });

  describe('budget', () => {
    it('stops before the input budget would be passed; the rest are skipped-budget', async () => {
      const r = report(10);
      const { doc, provider } = await run(
        r,
        () => ok({ usage: { inputTokens: 1000, outputTokens: 50 } }),
        {
          maxInputTokensTotal: 5000,
        },
      );
      const sent = provider.calls.length;
      expect(sent).toBeGreaterThan(0);
      expect(sent).toBeLessThan(10);
      expect(statuses(doc)).toEqual([
        ...Array.from({ length: sent }, () => 'ok'),
        ...Array.from({ length: 10 - sent }, () => 'skipped-budget'),
      ]);
      const first = doc.entries[sent];
      expect(first).toMatchObject({
        delivered: false,
        reason: 'the input token budget would be passed',
      });
      const next = estimateTokens(
        SYSTEM_PROMPT,
        buildUserMessage(first!.request, PREVIEW_NONCE),
        ANSWER_JSON_SCHEMAS.web,
      );
      expect(sent * 1000 + next).toBeGreaterThan(5000);
      expect(doc.totals.inputTokens).toBe(sent * 1000);
    });

    it('counts the estimate when an answer reports zero or no usage, and for a refusal', async () => {
      const r = report(10);
      const preview = previewFixes(r, limits());
      const per = estimateTokens(SYSTEM_PROMPT, preview.messages[0]!, ANSWER_JSON_SCHEMAS.web);
      const fits = Math.floor(5000 / per);
      expect(fits).toBeGreaterThan(0);
      expect(fits).toBeLessThan(10);
      const answers: ProviderAnswer[] = [
        { status: 'ok', text: okText, modelAnswered: 'm' },
        ok({ usage: { inputTokens: 0, outputTokens: 0 } }),
        { status: 'refused', reason: 'no' },
      ];
      for (const answer of answers) {
        const { doc, provider } = await run(r, () => answer, { maxInputTokensTotal: 5000 });
        // Each sent request counted at about its estimate (estimates differ by a few characters).
        expect(provider.calls.length).toBeGreaterThanOrEqual(fits - 1);
        expect(provider.calls.length).toBeLessThanOrEqual(fits);
        expect(statuses(doc)).toContain('skipped-budget');
        expect(doc.totals.inputTokens).toBe(0);
      }
    });

    it('estimates ceil(chars / 3) over system, user and schema', () => {
      expect(estimateTokens('abcd', 'ef', { a: 1 })).toBe(
        Math.ceil((4 + 2 + JSON.stringify({ a: 1 }).length) / 3),
      );
    });
  });

  describe('abort', () => {
    it('cancels mid-run: the in-flight call is an error, the rest are not sent', async () => {
      const controller = new AbortController();
      const seen: (AbortSignal | undefined)[] = [];
      const provider = createFakeProvider(() => ok());
      const original = provider.suggestFix.bind(provider);
      let call = 0;
      provider.suggestFix = async (request) => {
        seen.push(request.signal);
        if (call++ === 1) controller.abort();
        return original(request);
      };
      const lines: string[] = [];
      const doc = await suggestFixes({
        report: report(5),
        provider,
        limits: limits(),
        signal: controller.signal,
        sleep: async () => {},
        log: (l) => lines.push(l),
      });
      expect(seen).toHaveLength(2);
      expect(seen[1]?.aborted).toBe(true);
      expect(doc.entries[0]?.status).toBe('ok');
      expect(doc.entries[1]).toMatchObject({
        status: 'error',
        delivered: true,
        reason: 'cancelled',
      });
      for (const entry of doc.entries.slice(2))
        expect(entry).toMatchObject({ status: 'not-sent', delivered: false, reason: 'cancelled' });
      expect(lines).toContain('ai_stop reason=cancelled');
    });

    it('an already aborted signal sends nothing', async () => {
      const controller = new AbortController();
      controller.abort();
      const provider = createFakeProvider(() => ok());
      const doc = await suggestFixes({
        report: report(3),
        provider,
        limits: limits(),
        signal: controller.signal,
      });
      expect(provider.calls).toHaveLength(0);
      expect(statuses(doc)).toEqual(['not-sent', 'not-sent', 'not-sent']);
    });
  });

  it('logs fixed-shape lines only, never snippet text, answers or reasons', async () => {
    const r = report(4, ` alt="${MARKER}"`);
    const { lines } = await run(r, (_, call) =>
      call === 0
        ? ok({ text: `not json ${MARKER}` })
        : call === 1
          ? error(`odd ${MARKER}`, true)
          : ok(),
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(
        /^ai_(?:request group=[0-9a-f]{16} status=[a-z-]+|stop reason=[a-z-]+)$/,
      );
      expect(line).not.toContain(MARKER);
    }
  });

  it('leaves the report unchanged', async () => {
    const r = report(4);
    const frozen = deepFreeze(structuredClone(r));
    await run(frozen, () => ok());
    expect(frozen).toEqual(r);
  });

  it('every entry pairs status and delivered as the schema requires', async () => {
    const script = (_: string, call: number) =>
      [
        ok(),
        ok({ text: 'x' }),
        { status: 'refused', reason: 'no' } as ProviderAnswer,
        error('e (500)'),
      ][call] ?? error('fatal (401)', true);
    const { doc } = await run(report(8), script);
    expect(statuses(doc)).toEqual([
      'ok',
      'invalid',
      'refused',
      'error',
      'error',
      'not-sent',
      'not-sent',
      'not-sent',
    ]);
    expect(() => AiSuggestionsSchema.parse(doc)).not.toThrow();
  });
});

// Task 3b.6 fix round 1.
describe('fix round 1', () => {
  const cutOff = (usage?: { inputTokens: number; outputTokens: number }): ProviderAnswer => ({
    status: 'error',
    reason: 'the answer was cut off',
    fatal: false,
    errorClass: 'cut-off',
    ...(usage ? { usage } : {}),
  });
  const server = (code: number): ProviderAnswer => ({
    status: 'error',
    reason: `the Anthropic API had a server error (${code})`,
    fatal: false,
    errorClass: 'server',
  });
  /** An answer with no usage reported. */
  const bare = (text: string): ProviderAnswer => ({ status: 'ok', text, modelAnswered: 'm' });
  const per = (r: ScanReport) =>
    estimateTokens(SYSTEM_PROMPT, previewFixes(r, limits()).messages[0]!, ANSWER_JSON_SCHEMAS.web);

  describe('1: every billed call moves the budget', () => {
    it("the cut-off breaker ends the security reviewer's pattern (cut-off, cut-off, invalid)", async () => {
      const r = report(60);
      const pattern = [cutOff(), cutOff(), bare('not json')];
      const { doc, provider, lines } = await run(r, (_, call) => pattern[call % 3]!, {
        maxInputTokensTotal: 5000,
        maxGroups: 60,
      });
      // cut, cut, invalid, cut: three cut-offs in the last five. The next test proves the budget.
      expect(provider.calls).toHaveLength(4);
      expect(lines).toContain('ai_stop reason=cut-offs');
      expect(doc.entries).toHaveLength(60);
      expect(statuses(doc).filter((s) => s === 'not-sent' || s === 'skipped-budget').length).toBe(
        60 - provider.calls.length,
      );
    });

    it('with the cut-off breaker out of the way, billed errors alone reach the budget', async () => {
      const r = report(60);
      const pattern = [error('a (400)'), error('b (400)'), bare('x')];
      const { doc, provider } = await run(r, (_, call) => pattern[call % 3]!, {
        maxInputTokensTotal: 5000,
      });
      expect(provider.calls.length).toBe(Math.floor(5000 / per(r)));
      expect(statuses(doc)).toContain('skipped-budget');
    });

    it('counts cut-off usage, input and output, in totals and the budget', async () => {
      const r = report(10);
      const { doc, provider } = await run(
        r,
        (_, call) => (call % 2 === 0 ? cutOff({ inputTokens: 1000, outputTokens: 1500 }) : ok()),
        { maxInputTokensTotal: 6000 },
      );
      expect(doc.entries[0]).toMatchObject({
        status: 'error',
        reason: 'the answer was cut off',
        usage: { inputTokens: 1000, outputTokens: 1500 },
      });
      const cuts = doc.entries.filter((e) => e.reason === 'the answer was cut off').length;
      const oks = doc.entries.filter((e) => e.status === 'ok').length;
      expect(doc.totals.inputTokens).toBe(cuts * 1000 + oks * 100);
      expect(doc.totals.outputTokens).toBe(cuts * 1500 + oks * 20);
      // Each cut-off counts 2500 (input and output), each ok its 100 input: replay the budget.
      let counted = 0;
      let expected = 0;
      while (expected < 10 && counted + per(r) <= 6000) {
        counted += expected % 2 === 0 ? 2500 : 100;
        expected++;
      }
      expect(provider.calls.length).toBe(expected);
      expect(provider.calls.length).toBeLessThan(10);
    });

    it('three cut-offs in the last five finished groups stop the run, interleaved with oks', async () => {
      const r = report(20);
      const { doc, provider, lines } = await run(r, (_, call) =>
        call % 2 === 0 ? ok() : cutOff(),
      );
      // ok, cut, ok, cut, ok, cut: the sixth makes three cut-offs among the last five.
      expect(provider.calls).toHaveLength(6);
      expect(doc.entries[6]).toMatchObject({
        status: 'not-sent',
        reason: 'stopped after 3 cut-off answers in the last 5',
      });
      expect(lines).toContain('ai_stop reason=cut-offs');
    });

    it('a 429 that is retried is not billed twice', async () => {
      const limited: ProviderAnswer = {
        status: 'error',
        reason: 'the Anthropic API rate limit was reached (429)',
        fatal: false,
        rateLimited: true,
        retryAfterMs: 1,
      };
      const { doc } = await run(report(1), (_, call) => (call === 0 ? limited : ok()));
      expect(doc.totals).toMatchObject({ requests: 2, inputTokens: 100 });
    });
  });

  it('2: the breaker treats every 5xx as one class', async () => {
    const codes = [500, 501, 502, 503, 504, 505];
    const { doc, provider } = await run(report(6), (_, call) => server(codes[call]!));
    expect(provider.calls).toHaveLength(3);
    expect(statuses(doc).slice(3)).toEqual(['not-sent', 'not-sent', 'not-sent']);
  });

  it('carry-over: 6 consecutive errors of any class stop the run', async () => {
    const connection: ProviderAnswer = {
      status: 'error',
      reason: 'could not reach the Anthropic API',
      fatal: false,
      errorClass: 'connection',
    };
    const { doc, provider, lines } = await run(report(10), (_, call) =>
      call % 2 === 0 ? server(500) : connection,
    );
    expect(provider.calls).toHaveLength(6);
    expect(doc.entries[6]).toMatchObject({
      status: 'not-sent',
      delivered: false,
      reason: 'stopped after 6 consecutive errors',
    });
    expect(lines).toContain('ai_stop reason=consecutive-errors');
  });

  it('3: a request that cannot be built is an error that was not delivered', async () => {
    const provider = createFakeProvider(() => ok());
    const doc = await suggestFixes({
      report: report(2),
      provider,
      limits: limits(),
      nonce: () => 'not-a-nonce',
    });
    expect(provider.calls).toHaveLength(0);
    expect(doc.entries[0]).toMatchObject({
      status: 'error',
      delivered: false,
      reason: 'the request could not be built',
    });
    expect(doc.totals.requests).toBe(0);
  });

  it('4: refuses bad limits, provider id or model before sending anything', async () => {
    const r = report(2);
    const cases = [
      { provider: createFakeProvider(() => ok()), limits: { ...limits(), concurrency: 9 } },
      { provider: createFakeProvider(() => ok(), { model: 'bad model' }), limits: limits() },
      { provider: { ...createFakeProvider(() => ok()), id: 'gemini' as never }, limits: limits() },
    ];
    for (const c of cases) {
      await expect(
        suggestFixes({ report: r, provider: c.provider, limits: c.limits }),
      ).rejects.toThrow(AiConfigError);
      expect(c.provider.calls).toHaveLength(0);
    }
  });

  describe('6: abort during a wait', () => {
    it('during the rate-window wait: that group is not sent', async () => {
      const controller = new AbortController();
      const provider = createFakeProvider(() => ok());
      const doc = await suggestFixes({
        report: report(3),
        provider,
        limits: limits({ maxRequestsPerMinute: 1 }),
        signal: controller.signal,
        now: () => 0,
        sleep: async () => controller.abort(),
      });
      expect(provider.calls).toHaveLength(1);
      expect(doc.entries[0]?.status).toBe('ok');
      expect(doc.entries[1]).toMatchObject({
        status: 'not-sent',
        delivered: false,
        reason: 'cancelled',
      });
    });

    it('during the 429 wait: that group is an error, delivered, cancelled', async () => {
      const controller = new AbortController();
      const provider = createFakeProvider(() => ({
        status: 'error',
        reason: 'the Anthropic API rate limit was reached (429)',
        fatal: false,
        rateLimited: true,
        retryAfterMs: 1000,
      }));
      const doc = await suggestFixes({
        report: report(2),
        provider,
        limits: limits(),
        signal: controller.signal,
        sleep: async () => controller.abort(),
      });
      expect(provider.calls).toHaveLength(1);
      expect(doc.entries[0]).toMatchObject({
        status: 'error',
        delivered: true,
        reason: 'cancelled',
      });
      expect(doc.entries[1]).toMatchObject({ status: 'not-sent', delivered: false });
    });
  });

  it('7: an answer that arrives after the abort still counts its usage', async () => {
    const controller = new AbortController();
    const provider = createFakeProvider(() => {
      controller.abort();
      return ok({ usage: { inputTokens: 321, outputTokens: 12 } });
    });
    const doc = await suggestFixes({
      report: report(2),
      provider,
      limits: limits(),
      signal: controller.signal,
    });
    expect(doc.entries[0]).toMatchObject({ status: 'error', reason: 'cancelled' });
    expect(doc.totals).toMatchObject({ inputTokens: 321, outputTokens: 12 });
  });
});

describe('previewFixes', () => {
  it('returns what would be sent, with a placeholder nonce, and never needs a provider', () => {
    const r = report(4);
    const preview = previewFixes(r, limits({ maxGroups: 3 }));
    expect(preview.system).toBe(SYSTEM_PROMPT);
    expect(preview.groups).toHaveLength(3);
    expect(preview.skipped).toBe(1);
    expect(preview.messages).toEqual(
      preview.groups.map((g) => buildUserMessage(g.request, PREVIEW_NONCE)),
    );
    expect(preview.estimatedInputTokens).toBe(
      preview.messages.reduce(
        (sum, user) => sum + estimateTokens(SYSTEM_PROMPT, user, ANSWER_JSON_SCHEMAS.web),
        0,
      ),
    );
    expect(PREVIEW_NONCE).toMatch(/^0{32}$/);
  });
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
