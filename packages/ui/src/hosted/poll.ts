/*
 * Polling for the hosted page (ledger R48). A scan is asked for its state
 * every 2 s for its first minute, then every 5 s, until it ends. A
 * verification being checked is asked every 3 s for at most 3 minutes. Both
 * wait while the tab is hidden and poll at once when it is shown again, so a
 * check that ran out of time while hidden gets one last look. A failed poll
 * waits at least the server's Retry-After, and failures in a row double the
 * wait up to ERROR_WAIT_MAX_MS; a good answer resets it. Once stopped, nothing
 * is called again, not even for a poll already on its way. The clock, the
 * timers and the page's visibility come in through PollEnv, so tests can
 * drive them.
 */

export const SCAN_POLL_FAST_MS = 2_000;
export const SCAN_POLL_SLOW_MS = 5_000;
/** How long a scan is polled at the fast rate. */
export const SCAN_POLL_FAST_FOR_MS = 60_000;
export const VERIFY_POLL_MS = 3_000;
/** How long a verification is polled before the page gives up on it. */
export const VERIFY_POLL_FOR_MS = 3 * 60_000;
/** Longest wait after failed polls in a row (unless the server asked for longer). */
export const ERROR_WAIT_MAX_MS = 60_000;

/** The wait before the next scan poll, from the time since the scan started. */
export const scanPollDelay = (elapsedMs: number): number =>
  elapsedMs < SCAN_POLL_FAST_FOR_MS ? SCAN_POLL_FAST_MS : SCAN_POLL_SLOW_MS;

/** The wait before the next verification poll; undefined once it has been polled long enough. */
export const verifyPollDelay = (elapsedMs: number): number | undefined =>
  elapsedMs < VERIFY_POLL_FOR_MS ? VERIFY_POLL_MS : undefined;

/**
 * The wait after `failures` failed polls in a row: the usual delay or the server's
 * Retry-After, whichever is longer, doubled for each failure after the first, at most
 * ERROR_WAIT_MAX_MS (or the Retry-After itself, if that is longer).
 */
export function errorWait(delayMs: number, failures: number, retryAfterS?: number): number {
  const asked = (retryAfterS ?? 0) * 1000;
  const doubled = Math.max(delayMs, asked) * 2 ** Math.max(0, failures - 1);
  return Math.max(asked, Math.min(ERROR_WAIT_MAX_MS, doubled));
}

export interface PollEnv {
  now(): number;
  setTimer(fire: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  /** Whether the page is hidden now. */
  hidden(): boolean;
  /** Listens for the page being hidden or shown; the returned function stops listening. */
  onVisibility(listener: () => void): () => void;
}

/** The page's own clock, timers and visibility. */
export const browserEnv = (): PollEnv => ({
  now: () => Date.now(),
  setTimer: (fire, ms) => setTimeout(fire, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  hidden: () => document.visibilityState === 'hidden',
  onVisibility: (listener) => {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
});

export interface PollOptions<T> {
  /** One poll's request. */
  fetch: () => Promise<T>;
  /** Hears an answer while polling goes on; returns false to stop. */
  onAnswer: (value: T) => boolean;
  /** Hears a failed poll while polling goes on; returns false to stop. */
  onError: (error: unknown) => boolean;
  /** The server's Retry-After of a failure, in seconds, if it gave one. */
  retryAfterS?: (error: unknown) => number | undefined;
  /** The wait before the next poll, from the time since polling began; undefined: out of time. */
  delay: (elapsedMs: number) => number | undefined;
  /** Polling ran out of time. */
  onTimeout?: () => void;
  env: PollEnv;
}

/**
 * Polls until a handler says stop, delay runs out, or the returned function is
 * called. The first poll comes after the first delay. A poll that falls due
 * while the page is hidden waits for it to be shown.
 */
export function startPolling<T>(options: PollOptions<T>): () => void {
  const { env } = options;
  const began = env.now();
  let timer: unknown;
  let stopped = false;
  let due = false;
  let inFlight = false;
  let failures = 0;
  let retryAfter: number | undefined;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) env.clearTimer(timer);
    timer = undefined;
    unlisten();
  };

  const schedule = () => {
    if (stopped) return;
    const wait = options.delay(env.now() - began);
    if (wait === undefined) {
      stop();
      options.onTimeout?.();
      return;
    }
    timer = env.setTimer(fire, failures > 0 ? errorWait(wait, failures, retryAfter) : wait);
  };

  const run = async () => {
    inFlight = true;
    let go: boolean;
    try {
      const value = await options.fetch();
      // Stopped while the request was out: its answer goes nowhere.
      if (stopped) return;
      failures = 0;
      retryAfter = undefined;
      go = options.onAnswer(value);
    } catch (error) {
      if (stopped) return;
      failures++;
      retryAfter = options.retryAfterS?.(error);
      go = options.onError(error);
    } finally {
      inFlight = false;
    }
    if (!go) stop();
    else schedule();
  };

  function fire() {
    timer = undefined;
    if (stopped) return;
    if (env.hidden()) due = true;
    else void run();
  }

  const unlisten = env.onVisibility(() => {
    if (stopped || inFlight || !due || env.hidden()) return;
    due = false;
    void run();
  });

  schedule();
  return stop;
}
