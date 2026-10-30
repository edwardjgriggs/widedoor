import {
  HostedError,
  checkVerification,
  getScan,
  getVerification,
  isEnded,
  type ScanJob,
  type VerificationView,
} from './api.js';
import { scanPollDelay, startPolling, verifyPollDelay, type PollEnv } from './poll.js';

/*
 * What the hosted page does over time, apart from React: following a scan
 * until it ends, and checking a verification (at once, or by polling while a
 * machine checks it). Each returns a function that stops it; once stopped, no
 * poll handler is called again.
 */

/** Any failure as a HostedError (a page-side error is status 0). */
const asHosted = (e: unknown): HostedError =>
  e instanceof HostedError ? e : new HostedError(0, String(e));

const retryAfterS = (e: unknown) => (e instanceof HostedError ? e.retryAfterS : undefined);

export interface ScanHandlers {
  /** The scan's state, after each poll. */
  view(job: ScanJob): void;
  /** A poll failed; polling goes on (waiting longer) unless the scan is unknown (404). */
  error(e: HostedError): void;
}

/** Polls a scan (R48) until it ends or is unknown. */
export function followScan(id: string, on: ScanHandlers, env: PollEnv): () => void {
  return startPolling({
    fetch: () => getScan(id),
    onAnswer: (job) => {
      on.view(job);
      return !isEnded(job.status);
    },
    onError: (e) => {
      const error = asHosted(e);
      on.error(error);
      return error.status !== 404;
    },
    retryAfterS,
    delay: scanPollDelay,
    env,
  });
}

export interface CheckHandlers {
  /** The check's outcome as POST .../check answered it. */
  status(status: 'verified' | 'checking' | 'expired'): void;
  /** The verification's state, after each poll while a machine checks it. */
  view(view: VerificationView): void;
  /** Polling ran out of time with the check still going. */
  timeout(): void;
  /** A poll failed; polling goes on unless the verification is unknown (404). */
  error(e: HostedError): void;
}

/**
 * Checks a verification. A 200 or 410 settles it at once; a 202 polls (R48)
 * until it is no longer checking or polling runs out of time. Throws the
 * check's own refusal (HostedError) for the caller to show. The POST's answer
 * reaches status as soon as it arrives: the caller judges whether it still
 * matters, and stops the returned poller at once if not.
 */
export async function runCheck(id: string, on: CheckHandlers, env: PollEnv): Promise<() => void> {
  const answer = await checkVerification(id);
  on.status(answer);
  if (answer !== 'checking') return () => undefined;
  return startPolling({
    fetch: () => getVerification(id),
    onAnswer: (view) => {
      on.view(view);
      return view.status === 'checking';
    },
    onError: (e) => {
      const error = asHosted(e);
      on.error(error);
      return error.status !== 404;
    },
    retryAfterS,
    delay: verifyPollDelay,
    onTimeout: () => on.timeout(),
    env,
  });
}
