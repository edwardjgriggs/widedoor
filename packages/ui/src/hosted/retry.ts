import { useEffect, useState } from 'react';

/*
 * The wait a 429 or 503 asked for (Retry-After), shared by the scan form and
 * verification: while it runs, the page sends nothing and the button that
 * would send reads as disabled; it ends by itself when the time is up.
 */

export interface RetryGate {
  /** Whether the page is still waiting. */
  waiting: boolean;
  /** Seconds left (0 once the wait is over). */
  left(): number;
  /** Starts a wait of seconds. */
  wait(seconds: number): void;
}

/** until: when a wait given at first ends (render tests). */
export function useRetryGate(until?: number): RetryGate {
  const [end, setEnd] = useState(until);
  useEffect(() => {
    if (end === undefined) return;
    const timer = setTimeout(() => setEnd(undefined), Math.max(0, end - Date.now()));
    return () => clearTimeout(timer);
  }, [end]);
  return {
    waiting: end !== undefined && end > Date.now(),
    left: () => (end === undefined ? 0 : Math.max(0, (end - Date.now()) / 1000)),
    wait: (seconds) => setEnd(Date.now() + seconds * 1000),
  };
}
