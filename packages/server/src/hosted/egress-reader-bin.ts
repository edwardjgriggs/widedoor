import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Readable } from 'node:stream';
import { EGRESS_PORT, JOB_ID, JOB_ID_ENV } from './protocol.js';

/*
 * The scan entry's reader of egress-bin's output (stdout and stderr, through one FIFO).
 * The entry starts it as root, in a wrapper that tells the entry when the reader ends,
 * with an empty environment but for the job id (never the token) and the entry's pid. It waits up to READY_TIMEOUT_MS for `ready 18080` as
 * the first line (without it, it sends the entry SIGTERM, and the entry exits 1), then
 * creates the ready file the entry waits for, and
 * from then on forwards egress-bin's event lines to stderr for the whole scan, so the
 * proxy's writes never back up. egress-bin parses everything a scanned page sends, so
 * its lines are judged like the scan child's (agent-bin ChildStderr): only well-formed
 * lines of a known egress event, with no key repeated and none of the keys the reader
 * sets, are forwarded, tagged with the job id and source=egress; at most
 * MAX_LINES_PER_EVENT per event name, the rest counted and reported once each when the
 * scan ends: when the entry, once its agent has exited, sends the reader SIGTERM
 * (CWE-117, CWE-779). Then one egress_summary line counts the scan's refusals by reason,
 * forwarded or not. If egress-bin's output ends during the scan (the proxy exited or
 * lost its log), the reader sends the entry SIGUSR1, and the entry stops the agent: a
 * proxy without logs never keeps serving a scan (ledger R32).
 */

/** Longest wait for egress-bin's ready line. */
export const READY_TIMEOUT_MS = 10_000;
/** Lines forwarded per event name; past it they are counted. */
export const MAX_LINES_PER_EVENT = 200;
/** How often the reader checks that the entry still runs. */
const WATCH_MS = 200;
/** Longest egress-bin line read, in bytes; longer lines are dropped. */
const MAX_LINE = 4 * 1024;
/** A line the reader may forward: one event with escaped fields (proxy.ts logValue). */
const EGRESS_LINE = /^widedoor event=[a-z_]+( [a-z_]+=[A-Za-z0-9._:%[\]-]*)*$/;
/** The events egress-bin writes after its ready line (proxy.ts formatProxyEvent). */
export const EGRESS_EVENTS: ReadonlySet<string> = new Set([
  'egress_refused',
  'egress_malformed',
  'egress_upstream_error',
  'egress_idle_timeout',
  'egress_over_capacity',
]);
/**
 * The refusal reasons egress_summary counts (the proxy's block reasons and host rules, and
 * `policy` for a refusal with none), in the order the line gives them. A reason outside
 * the set counts as `other`. Dashes become underscores in the line's keys.
 */
export const SUMMARY_REASONS = [
  'metadata',
  'private',
  'loopback',
  'link-local',
  'cgnat',
  'multicast',
  'reserved',
  'unspecified',
  'host-name',
  'port',
  'scheme',
  'credentials',
  'unresolved',
  'host-limit',
  'policy',
  'other',
] as const;
/** Keys the reader sets on a forwarded line; an egress line that carries one is dropped. */
const READER_KEYS: ReadonlySet<string> = new Set(['event', 'source', 'job']);
/** The name dropped lines are counted under when they are not a known, well-formed event. */
const INVALID = 'invalid';

/**
 * egress-bin's stdout, line by line. The first line must be exactly the ready line;
 * after it, lines are judged, tagged and forwarded (or counted) as the file comment says.
 */
export class EgressLines {
  /** waiting: no line yet; ready: the first line was the ready line; refused: it was not. */
  state: 'waiting' | 'ready' | 'refused' = 'waiting';
  private readonly forwarded = new Map<string, number>();
  private readonly dropped = new Map<string, number>();
  /** egress_refused lines by reason, forwarded or not. */
  private readonly refusals = new Map<string, number>();
  private readonly job: string;
  private line: Buffer[] = [];
  private length = 0;
  private overLong = false;

  constructor(
    jobId: string,
    private readonly log: (line: string) => void,
    private readonly readyLine = `ready ${EGRESS_PORT}`,
  ) {
    // The id is not secret, but only a valid one is written.
    this.job = JOB_ID.test(jobId) ? ` job=${jobId}` : '';
  }

  push(chunk: Buffer): void {
    let from = 0;
    for (let at = chunk.indexOf(0x0a); at >= 0; at = chunk.indexOf(0x0a, from)) {
      this.add(chunk.subarray(from, at));
      this.endLine();
      from = at + 1;
    }
    this.add(chunk.subarray(from));
  }

  /** egress-bin's stdout ended: a last line without a line end is judged too. */
  end(): void {
    if (this.length > 0 || this.overLong) this.endLine();
  }

  /**
   * One `egress_lines_dropped` line (tagged with the job) per event name that had lines
   * dropped, then (when the scan ran: by default once the proxy was ready) one
   * `egress_summary` line with the scan's refusals by reason, every reason of
   * SUMMARY_REASONS given (0 included): a probe stays visible past the line cap.
   */
  summary(ran = this.state === 'ready'): string[] {
    const dropped = [...this.dropped].map(
      ([name, count]) =>
        `widedoor event=egress_lines_dropped${this.job} name=${name} count=${count}`,
    );
    if (!ran) return dropped;
    const counts = SUMMARY_REASONS.map(
      (reason) => `${reason.replace(/-/g, '_')}=${this.refusals.get(reason) ?? 0}`,
    );
    const total = [...this.refusals.values()].reduce((sum, n) => sum + n, 0);
    return [
      ...dropped,
      `widedoor event=egress_summary${this.job} refused=${total} ${counts.join(' ')}`,
    ];
  }

  private add(part: Buffer): void {
    if (part.length === 0 || this.overLong) return;
    if (this.length + part.length > MAX_LINE) {
      this.overLong = true;
      this.line = [];
      return;
    }
    this.line.push(part);
    this.length += part.length;
  }

  private drop(name: string): void {
    this.dropped.set(name, (this.dropped.get(name) ?? 0) + 1);
  }

  private endLine(): void {
    const text = this.overLong
      ? undefined
      : Buffer.concat(this.line).toString('utf8').replace(/\r$/, '');
    this.line = [];
    this.length = 0;
    this.overLong = false;
    if (this.state === 'refused') return;
    if (this.state === 'waiting') {
      this.state = text === this.readyLine ? 'ready' : 'refused';
      return;
    }
    if (text === '') return;
    if (text === undefined || !EGRESS_LINE.test(text)) return this.drop(INVALID);
    const [, first = '', ...rest] = text.split(' ');
    const name = first.slice('event='.length);
    const keys = rest.map((field) => field.slice(0, field.indexOf('=')));
    if (
      !EGRESS_EVENTS.has(name) ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => READER_KEYS.has(key))
    )
      return this.drop(INVALID);
    if (name === 'egress_refused') {
      const given = rest.find((field) => field.startsWith('reason='))?.slice('reason='.length);
      const reason = (SUMMARY_REASONS as readonly string[]).includes(given ?? '')
        ? (given as string)
        : 'other';
      this.refusals.set(reason, (this.refusals.get(reason) ?? 0) + 1);
    }
    const sent = this.forwarded.get(name) ?? 0;
    if (sent >= MAX_LINES_PER_EVENT) return this.drop(name);
    this.forwarded.set(name, sent + 1);
    this.log(`widedoor ${first}${this.job} source=egress${rest.map((f) => ` ${f}`).join('')}`);
  }
}

export interface ReaderOptions {
  env: NodeJS.ProcessEnv;
  /** The reader's arguments: the entry's pid ($$) and the ready file's path. */
  args: readonly string[];
  /** egress-bin's stdout. */
  input: Readable;
  /** Where lines go. Default: stderr. */
  log?: (line: string) => void;
  /** The reader's parent pid, read anew each time (tests). Default process.ppid. */
  getppid?: () => number;
  /** Signals the entry (tests). Default process.kill. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** The scan is over: report the dropped lines and end, as SIGTERM does (tests). */
  signal?: AbortSignal;
  readyTimeoutMs?: number;
  watchMs?: number;
}

/**
 * Runs the reader. Resolves with the exit code once the scan is over: 0 when it was told
 * so (or the entry is gone) with egress-bin still up; 1 when egress-bin never got ready
 * (the entry is sent SIGTERM), when its output ended during the scan (the entry is sent
 * SIGUSR1), or when the reader's arguments are wrong.
 */
export function runReader(options: ReaderOptions): Promise<number> {
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const getppid = options.getppid ?? (() => process.ppid);
  const kill = options.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const jobId = options.env[JOB_ID_ENV] ?? '';
  const job = JOB_ID.test(jobId) ? ` job=${jobId}` : '';
  const [pidArg = '', readyFile = ''] = options.args;
  const entryPid = Number(pidArg);
  // The entry runs the reader in a wrapper (scan-entry.sh), so its parent is the wrapper.
  const parent = getppid();
  if (!/^[1-9][0-9]{0,9}$/.test(pidArg) || !isAbsolute(readyFile)) {
    log(`widedoor event=egress_reader_config_error${job}`);
    return Promise.resolve(1);
  }
  const lines = new EgressLines(jobId, log);

  return new Promise((resolve) => {
    let over = false;
    let announced = false;
    /** The ready file could not be made: the entry never went on to a scan. */
    let noFile = false;
    const finish = (code: number) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      clearInterval(watch);
      options.signal?.removeEventListener('abort', stop);
      options.input.off('data', onData);
      // No refusal summary when the entry never got the ready file: no scan ran.
      for (const line of lines.summary(announced && !noFile)) log(line);
      resolve(code);
    };
    const signalEntry = (signal: NodeJS.Signals) => {
      try {
        kill(entryPid, signal);
      } catch {
        // Already gone.
      }
    };
    // The entry is still waiting for the ready file: SIGTERM makes it exit 1.
    const notReady = (reason: string) => {
      log(`widedoor event=egress_not_ready${job} reason=${reason}`);
      signalEntry('SIGTERM');
      finish(1);
    };
    const timer = setTimeout(() => notReady('timeout'), options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    // A backstop: the wrapper (and so the entry) is gone once this reader's parent changes.
    const watch = setInterval(() => {
      if (getppid() !== parent) finish(0);
    }, options.watchMs ?? WATCH_MS);
    const stop = () => finish(0);
    if (options.signal?.aborted) return stop();
    options.signal?.addEventListener('abort', stop, { once: true });

    const onData = (chunk: Buffer) => {
      lines.push(chunk);
      if (lines.state === 'refused') return notReady('line');
      if (lines.state !== 'ready' || announced) return;
      announced = true;
      clearTimeout(timer);
      // wx: a file already there was not made by this reader, so the entry must not go on.
      writeFile(readyFile, '', { mode: 0o600, flag: 'wx' }).catch(() => {
        noFile = true;
        notReady('file');
      });
    };
    const lost = () => {
      if (over) return;
      lines.end();
      if (!announced) return notReady(lines.state === 'refused' ? 'line' : 'exited');
      log(`widedoor event=egress_exited${job}`);
      // The entry stops the agent and exits non-zero.
      signalEntry('SIGUSR1');
      finish(1);
    };
    options.input.on('data', onData);
    options.input.once('end', lost);
    options.input.once('error', lost);
  });
}

// Only as a process entry point.
if (import.meta.main) {
  const stop = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    process.once(name, () => stop.abort());
  const code = await runReader({
    env: process.env,
    args: process.argv.slice(2),
    input: process.stdin,
    signal: stop.signal,
  });
  // stdin may still be open (egress-bin up): exit now rather than wait for it.
  process.exit(code);
}
