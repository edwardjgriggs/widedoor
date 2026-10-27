/*
 * Counts of the requests the widedoor ui server refused, by the check that
 * refused them, for the terminal log. A burst of refusals (a page on another
 * origin probing the port, a local process guessing the token) shows as one
 * line per REFUSAL_LOG_MS with the count of each kind, never as a line per
 * request, and never with anything the request carried.
 */

/** The checks, in the order the server runs them (rate is the uploads-in-flight 429). */
export const REFUSAL_KINDS = ['host', 'token', 'origin', 'type', 'size', 'schema', 'rate'] as const;
export type RefusalKind = (typeof REFUSAL_KINDS)[number];

/** Refusals are logged at most once in this long; the next line counts the rest. */
export const REFUSAL_LOG_MS = 10_000;

/** How the log line names each kind. */
const LABELS: Readonly<Record<RefusalKind, string>> = {
  host: 'Host',
  token: 'token',
  origin: 'Origin',
  type: 'content type',
  size: 'size',
  schema: 'schema',
  rate: 'rate (429)',
};

export class Refusals {
  private readonly counts = new Map<RefusalKind, number>();
  private logged = -Infinity;
  private lines = 0;

  /** log gets each line without the "widedoor ui: " prefix; now is Date.now outside tests. */
  constructor(
    private readonly log: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one refusal, and logs the counts when no line was logged in the last REFUSAL_LOG_MS. */
  count(kind: RefusalKind): void {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    if (this.now() - this.logged >= REFUSAL_LOG_MS) this.flush();
  }

  /** Logs the refusals counted since the last line, if any (the server calls it on close too). */
  flush(): void {
    let total = 0;
    for (const n of this.counts.values()) total += n;
    if (total === 0) return;
    const kinds = REFUSAL_KINDS.filter((k) => this.counts.has(k))
      .map((k) => `${this.counts.get(k)} ${LABELS[k]}`)
      .join(', ');
    const since = this.lines > 0 ? ' since the last line' : '';
    this.log(`refused ${total} request${total === 1 ? '' : 's'}${since} (${kinds})`);
    this.counts.clear();
    this.logged = this.now();
    this.lines++;
  }
}
