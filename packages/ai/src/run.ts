import { MODEL_ID } from '@widedoor/core';
import type { ScanReport } from '@widedoor/report';
import { ANSWER_JSON_SCHEMAS, parseAnswer } from './answer.js';
import { buildGroups, type FixGroup } from './context.js';
import {
  AI_LABEL,
  AI_SUGGESTIONS_SCHEMA_ID,
  AiLimitsSchema,
  AiSuggestionsSchema,
  ProviderIdSchema,
  toReason,
  type AiLimits,
  type AiSuggestions,
  type SuggestionEntry,
} from './model.js';
import { SYSTEM_PROMPT, buildUserMessage, newNonce } from './prompt.js';
import type { FixProvider, ProviderAnswer } from './provider.js';

/*
 * The suggestion runner: groups the report's fails (context.ts), sends each
 * group once through one provider, and returns the suggestions document. It
 * owns every cost and failure control, since providers retry nothing:
 * concurrency, a rolling one-minute request window, an input-token budget
 * that every billed call moves, one wait on a 429, a breaker after three
 * errors of one class in a row or three cut-off answers in the last five, a
 * stop on a fatal error, and abort. The report is only read (ruling 1). Log
 * lines have a fixed shape and never carry scanned text, an answer, a key or
 * a provider message.
 */

/** Longest wait on a 429, and the wait when the provider gives none. */
const RETRY_AFTER_MAX_MS = 60_000;
const RETRY_AFTER_DEFAULT_MS = 5_000;
/** Consecutive groups ending with an error of one class that stop the run. */
const BREAKER_LIMIT = 3;
/** Cut-off answers among the last CUT_OFF_WINDOW finished groups that stop the run. */
const CUT_OFF_LIMIT = 3;
const CUT_OFF_WINDOW = 5;
/** Errors of any class in a row that stop the run (a retried 429 is not one). */
const CONSECUTIVE_ERRORS_LIMIT = 6;
const WINDOW_MS = 60_000;

/** The nonce previewFixes shows: a valid nonce shape that is plainly not a real one. */
export const PREVIEW_NONCE = '0'.repeat(32);

/** The run's settings are not usable; nothing was sent. */
export class AiConfigError extends Error {}

/**
 * The input-token estimate of one request: ceil(characters / 3) of the
 * system prompt, the user message and the answer schema. It counts what is
 * sent, not cache reads and writes or refusal-fallback billing (the
 * providers report input and output tokens only).
 */
export function estimateTokens(system: string, user: string, schema: object): number {
  return Math.ceil((system.length + user.length + JSON.stringify(schema).length) / 3);
}

const schemaFor = (group: FixGroup) => ANSWER_JSON_SCHEMAS[group.request.assetKind];

/** A 429 the provider marked as worth one wait (not, for example, an empty OpenAI quota). */
const rateLimited = (answer: ProviderAnswer) =>
  answer.status === 'error' && !answer.fatal && answer.rateLimited === true;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves when the sleep ends or the signal aborts, whichever is first. */
function sleepUnlessAborted(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    sleep(ms).then(done, (e: unknown) => {
      signal.removeEventListener('abort', done);
      reject(e);
    });
  });
}

export interface SuggestFixesOptions {
  report: ScanReport;
  provider: FixProvider;
  limits: AiLimits;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Fixed-shape lines only: "ai_request group=<id> status=<s>", "ai_stop reason=<fixed text>",
   * and at the end of every run "ai_run status=<done|aborted|stopped|failed> sent=<n>
   * input_tokens=<n> output_tokens=<n>" (failed: a worker rejected or the final document failed
   * its schema, so the run returned none; neither should ever happen).
   */
  log?: (line: string) => void;
  /**
   * Gets the run's budget measure at the end, however the run ended: each request's
   * reported input tokens, else its estimate. widedoor ui adds it to its session total.
   */
  onSpent?: (inputTokens: number) => void;
  /** A fresh 128-bit hex nonce per request; tests inject a sequence. */
  nonce?: () => string;
}

/** Why the run stopped early, for every group not yet finished. */
interface Stop {
  status: 'not-sent' | 'skipped-budget';
  reason: string;
  /** The fixed text of the ai_stop log line. */
  log: string;
}

/** What one call came to: an answer, a group the run stopped before sending, or a message that could not be built. */
type CallResult = ProviderAnswer | 'skipped' | 'unbuilt';

/** Checks the run's settings before anything is sent; throws AiConfigError. */
function validate(provider: FixProvider, limits: AiLimits): AiLimits {
  const parsed = AiLimitsSchema.safeParse(limits);
  if (!parsed.success) throw new AiConfigError('the AI limits are not valid');
  if (!ProviderIdSchema.safeParse(provider.id).success)
    throw new AiConfigError('the AI provider is not one Widedoor knows');
  if (typeof provider.model !== 'string' || !MODEL_ID.test(provider.model))
    throw new AiConfigError('the AI model is not a valid model id');
  return parsed.data;
}

export async function suggestFixes(options: SuggestFixesOptions): Promise<AiSuggestions> {
  const { report, provider, signal } = options;
  const limits = validate(provider, options.limits);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const log = options.log ?? (() => {});
  const nonce = options.nonce ?? newNonce;
  const createdAt = new Date(now()).toISOString();
  const { groups, skipped } = buildGroups(report, limits);

  const entries: (SuggestionEntry | undefined)[] = groups.map(() => undefined);
  const answeredBy: (string | undefined)[] = groups.map(() => undefined);
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0 };
  /**
   * Tokens counted against the budget, for every call that reached the
   * provider (a 429 excepted): the reported input, plus the output of a
   * cut-off answer, or the request's estimate when nothing was reported.
   * The document's totals hold reported usage only.
   */
  let spent = 0;
  /** Estimates of requests in flight, so concurrent requests cannot together pass the budget. */
  let reserved = 0;
  const starts: number[] = [];
  let stop: Stop | undefined;
  let next = 0;
  let lastClass: string | undefined;
  let sameClass = 0;
  let errorsInRow = 0;
  /** For each finished group, in completion order: whether its answer was cut off. */
  const recent: boolean[] = [];

  const halt = (s: Stop) => {
    if (stop) return;
    stop = s;
    log(`ai_stop reason=${s.log}`);
  };
  const cancelled = () => signal?.aborted === true;

  const base = (group: FixGroup) => ({
    group: group.id,
    findingIds: group.findingIds,
    request: group.request,
  });

  /** How long until a request may start in the rolling window; 0 when one may start now. */
  function slotWait(): number {
    const t = now();
    while (starts.length > 0 && (starts[0] ?? 0) <= t - WINDOW_MS) starts.shift();
    return starts.length < limits.maxRequestsPerMinute ? 0 : (starts[0] ?? t) + WINDOW_MS - t;
  }

  /**
   * One provider call: builds the message (a fresh nonce), waits for a slot
   * in the rolling window, then records the start and calls the provider in
   * the same synchronous step, so no other request can start in between.
   * Never throws.
   */
  async function call(group: FixGroup): Promise<CallResult> {
    let user: string;
    try {
      user = buildUserMessage(group.request, nonce());
    } catch {
      return 'unbuilt';
    }
    for (let wait = slotWait(); wait > 0; wait = slotWait()) {
      await sleepUnlessAborted(sleep, wait, signal);
      if (cancelled() || stop) return 'skipped';
    }
    if (cancelled() || stop) return 'skipped';
    starts.push(now());
    totals.requests++;
    try {
      return await provider.suggestFix({
        system: SYSTEM_PROMPT,
        user,
        schema: schemaFor(group),
        maxOutputTokens: limits.maxOutputTokens,
        signal: signal ?? new AbortController().signal,
      });
    } catch {
      return { status: 'error', reason: 'the provider failed', fatal: false };
    }
  }

  /** Adds what one call was billed to the totals and the budget; see spent. */
  function bill(answer: ProviderAnswer, estimate: number): void {
    if (rateLimited(answer)) return;
    const usage = answer.status === 'refused' ? undefined : answer.usage;
    if (usage) {
      totals.inputTokens += usage.inputTokens;
      totals.outputTokens += usage.outputTokens;
    }
    const cutOff = answer.status === 'error' && answer.errorClass === 'cut-off';
    spent +=
      usage && usage.inputTokens > 0
        ? usage.inputTokens + (cutOff ? usage.outputTokens : 0)
        : estimate;
  }

  /** Records one finished group for the cut-off breaker. */
  function noteCutOff(cutOff: boolean): void {
    recent.push(cutOff);
    if (recent.length > CUT_OFF_WINDOW) recent.shift();
    if (recent.filter(Boolean).length >= CUT_OFF_LIMIT)
      halt({
        status: 'not-sent',
        reason: `stopped after ${CUT_OFF_LIMIT} cut-off answers in the last ${CUT_OFF_WINDOW}`,
        log: 'cut-offs',
      });
  }

  /** The entry for one finished call, and its effect on the breakers and the stop. */
  function settle(i: number, group: FixGroup, answer: ProviderAnswer): SuggestionEntry {
    // Billed whether or not the run was cancelled while the answer was on its way.
    if (cancelled())
      return { ...base(group), delivered: true, status: 'error', reason: 'cancelled' };
    const cutOff = answer.status === 'error' && answer.errorClass === 'cut-off';
    noteCutOff(cutOff);
    if (answer.status === 'ok') {
      // Usage counts input and output tokens only; see estimateTokens.
      const usage = answer.usage ? { usage: answer.usage } : {};
      lastClass = undefined;
      sameClass = 0;
      errorsInRow = 0;
      const parsed = parseAnswer(answer.text, group.request.assetKind, group.request.snippet);
      if (!parsed.ok)
        return {
          ...base(group),
          delivered: true,
          status: 'invalid',
          reason: toReason(parsed.reason),
          ...usage,
        };
      answeredBy[i] = answer.modelAnswered;
      return {
        ...base(group),
        delivered: true,
        status: 'ok',
        suggestion: parsed.suggestion,
        ...usage,
      };
    }
    if (answer.status === 'refused') {
      lastClass = undefined;
      sameClass = 0;
      errorsInRow = 0;
      return {
        ...base(group),
        delivered: true,
        status: 'refused',
        reason: toReason(answer.reason),
      };
    }
    const reason = toReason(answer.reason);
    if (answer.fatal)
      halt({
        status: 'not-sent',
        reason: toReason(`stopped after a fatal error: ${reason}`),
        log: 'fatal-error',
      });
    else {
      // Any 5xx is one class, any connection failure or timeout another; other reasons stand alone.
      const errorClass = answer.errorClass ?? `reason:${reason}`;
      sameClass = errorClass === lastClass ? sameClass + 1 : 1;
      lastClass = errorClass;
      errorsInRow++;
      if (sameClass >= BREAKER_LIMIT)
        halt({
          status: 'not-sent',
          reason: toReason(`stopped after ${BREAKER_LIMIT} identical errors: ${reason}`),
          log: 'identical-errors',
        });
      // The backstop for errors that keep changing class.
      else if (errorsInRow >= CONSECUTIVE_ERRORS_LIMIT)
        halt({
          status: 'not-sent',
          reason: `stopped after ${CONSECUTIVE_ERRORS_LIMIT} consecutive errors`,
          log: 'consecutive-errors',
        });
    }
    return {
      ...base(group),
      delivered: true,
      status: 'error',
      reason,
      ...(answer.usage ? { usage: answer.usage } : {}),
    };
  }

  /** The entry of a group whose request could not be built: nothing left the machine. */
  const unbuilt = (i: number, group: FixGroup) => {
    entries[i] = {
      ...base(group),
      delivered: false,
      status: 'error',
      reason: 'the request could not be built',
    };
    log(`ai_request group=${group.id} status=error`);
  };

  async function runGroup(i: number, group: FixGroup): Promise<void> {
    // Nothing the estimate throws may escape Promise.all: such a group is recorded, not sent.
    let estimate: number;
    try {
      estimate = estimateTokens(
        SYSTEM_PROMPT,
        buildUserMessage(group.request, PREVIEW_NONCE),
        schemaFor(group),
      );
    } catch {
      unbuilt(i, group);
      return;
    }
    if (spent + reserved + estimate > limits.maxInputTokensTotal) {
      halt({
        status: 'skipped-budget',
        reason: 'the input token budget would be passed',
        log: 'budget',
      });
      return;
    }
    reserved += estimate;
    try {
      let answer = await call(group);
      if (answer === 'skipped') return;
      // Kept: call builds the message again with a fresh nonce, and that build can fail too.
      if (answer === 'unbuilt') {
        unbuilt(i, group);
        return;
      }
      if (rateLimited(answer) && !cancelled()) {
        const wait = answer.status === 'error' ? answer.retryAfterMs : undefined;
        await sleepUnlessAborted(
          sleep,
          Math.min(wait ?? RETRY_AFTER_DEFAULT_MS, RETRY_AFTER_MAX_MS),
          signal,
        );
        if (!cancelled()) {
          const retry = await call(group);
          // Stopped while waiting for the window, or the retry could not be built: the 429 stands.
          if (retry !== 'skipped' && retry !== 'unbuilt') answer = retry;
        }
      }
      bill(answer, estimate);
      const entry = settle(i, group, answer);
      entries[i] = entry;
      log(`ai_request group=${group.id} status=${entry.status}`);
    } finally {
      reserved -= estimate;
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (cancelled()) halt({ status: 'not-sent', reason: 'cancelled', log: 'cancelled' });
      if (stop) return;
      const i = next++;
      const group = groups[i];
      if (!group) return;
      await runGroup(i, group);
    }
  }

  // From the first worker on: whatever ends the run (a rejected worker or a failed parse
  // included), what was spent is reported and the run line is logged. Either of those two is
  // a failed run: it returns no document.
  let failed = false;
  try {
    const workers = Math.max(1, Math.min(limits.concurrency, groups.length));
    await Promise.all(Array.from({ length: workers }, worker));
    if (cancelled()) halt({ status: 'not-sent', reason: 'cancelled', log: 'cancelled' });

    const finished = groups.map(
      (group, i): SuggestionEntry =>
        entries[i] ?? {
          ...base(group),
          delivered: false,
          status: stop?.status ?? 'not-sent',
          reason: toReason(stop?.reason ?? 'cancelled'),
        },
    );
    const modelAnswered = answeredBy.find((m) => m !== undefined);
    // Parsed, so a document this function returns always matches the schema (pairings included).
    return AiSuggestionsSchema.parse({
      schemaVersion: 1,
      $id: AI_SUGGESTIONS_SCHEMA_ID,
      label: AI_LABEL,
      provider: provider.id,
      model: provider.model,
      ...(modelAnswered !== undefined ? { modelAnswered } : {}),
      createdAt,
      report: { startedAt: report.startedAt, findings: report.findings.length },
      limits,
      entries: finished,
      totals: { ...totals, skippedGroups: skipped },
    });
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    options.onSpent?.(spent);
    // One fixed line for every run, however it ended: what was sent and what it cost.
    log(
      `ai_run status=${failed ? 'failed' : cancelled() ? 'aborted' : stop ? 'stopped' : 'done'} sent=${totals.requests} input_tokens=${totals.inputTokens} output_tokens=${totals.outputTokens}`,
    );
  }
}

/**
 * What a run would send, for --ai-dry-run: no provider, no network. The user
 * messages carry PREVIEW_NONCE; a real run uses a fresh nonce per request.
 */
export function previewFixes(
  report: ScanReport,
  limits: AiLimits,
): {
  groups: FixGroup[];
  skipped: number;
  estimatedInputTokens: number;
  system: string;
  messages: string[];
} {
  const { groups, skipped } = buildGroups(report, limits);
  const messages = groups.map((g) => buildUserMessage(g.request, PREVIEW_NONCE));
  const estimatedInputTokens = groups.reduce(
    (sum, g, i) => sum + estimateTokens(SYSTEM_PROMPT, messages[i] ?? '', schemaFor(g)),
    0,
  );
  return { groups, skipped, estimatedInputTokens, system: SYSTEM_PROMPT, messages };
}
