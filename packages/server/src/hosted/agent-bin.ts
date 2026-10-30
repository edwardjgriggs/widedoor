import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readCapped } from '@widedoor/web';
import { logValue } from '@widedoor/web/egress';
import { isHttpUrl } from '../config.js';
import { SCAN_UID } from './firewall.js';
import { TIERS, TIMEOUT_MARGIN_MS, timeLimitFor, wallClockFor } from './limits.js';
import {
  CONTACT_URL_ENV,
  CONTROL_URL_ENV,
  ChildJobSchema,
  INPUT_REFUSED,
  JOB_ID,
  JOB_ID_ENV,
  JOB_TOKEN_ENV,
  PROXY_URL_ENV,
  JobInputSchema,
  JobResultSchema,
  REPORT_TOO_LARGE,
  RESULT_DEADLINE_MS,
  TIMED_OUT,
  jobError,
  isToken,
  jobUrl,
  resultBodyMax,
  type JobInput,
  type JobResult,
} from './protocol.js';

/*
 * The scan machine's agent (the image's scan entry runs it as root, Task 8).
 * It holds the job token and talks only to the API: it fetches the job input
 * (and an uploaded PDF), validates it (a verify job runs the same way, with its
 * own cap), starts the scan child as uid 10001
 * through setpriv with an environment that holds no token, and sends back the
 * child's result, or a failure of its own when the child runs out of time, is
 * stopped, dies or answers nonsense. Its requests to the API use plain Node
 * fetch, not the egress proxy; they are the only requests that carry the
 * token, and they never follow a redirect. Of the child's stderr only
 * well-formed event lines reach the log (ChildStderr).
 */

export { CONTROL_URL_ENV, JOB_ID_ENV, JOB_TOKEN_ENV, SCAN_UID };
/**
 * Set to 1 to let the agent run as a user other than root (tests). The child
 * then shares the uid that holds the token, so the scan image never sets it.
 */
export const SAME_USER_ENV = 'WIDEDOOR_AGENT_SAME_USER';

/** By absolute path: root never looks a program up on PATH. */
export const SETPRIV = '/usr/bin/setpriv';

/** Largest job input read from the API. */
const MAX_INPUT_BYTES = 64 * 1024;
/**
 * Largest child output read: the largest result body of any tier (the report, which the
 * child checks against its tier's cap, as a JSON string), plus a little for the line.
 * Past it the report is too large.
 */
export const MAX_CHILD_OUTPUT_BYTES = resultBodyMax('verified') + 1024 * 1024;
/** Longest wait for one request to the API. */
const CONTROL_TIMEOUT_MS = 60_000;
/**
 * Longest wait for one result PUT: past the API's own RESULT_DEADLINE_MS, so the API
 * answers (or fails the job) before the agent gives up on it.
 */
export const RESULT_TIMEOUT_MS = RESULT_DEADLINE_MS + 15_000;
/** Wait before sending the result again after a 409 (another PUT of it is still being read). */
const BUSY_RETRY_MS = 2_000;
/** Shortest wait for one result request, even when the cap is nearer. */
const MIN_RESULT_WAIT_MS = 5_000;
/** Wait between SIGTERM and SIGKILL for a child that is told to stop. */
const KILL_GRACE_MS = 5_000;
/** Tries at sending the result. */
const RESULT_TRIES = 3;
/** Longest child stderr line forwarded, in bytes; longer lines are dropped. */
const MAX_STDERR_LINE = 4 * 1024;
/** Child stderr read at most, in bytes; past it every line is dropped. */
const MAX_STDERR_BYTES = 1024 * 1024;
/** A child line the agent forwards: one event with escaped fields, nothing else. */
const CHILD_EVENT = /^widedoor event=[a-z_]+( [a-z_]+=[A-Za-z0-9._:%[\]-]*)*$/;
/** The only events a child may report; every agent_ name but agent_child_crash is the agent's own. */
export const CHILD_EVENTS: ReadonlySet<string> = new Set([
  'robots_decision',
  'fetch_refused',
  'agent_child_crash',
]);
/** Keys the agent sets on a forwarded line; a child line that carries one is dropped. */
const AGENT_KEYS: ReadonlySet<string> = new Set(['event', 'source', 'job']);

export { TIMED_OUT };
export const TOO_LARGE = REPORT_TOO_LARGE;
export const STOPPED = 'the scan was stopped';

/**
 * The child's argv. As root it drops to SCAN_UID with setpriv (no supplementary
 * groups, no inheritable or bounding capabilities, no new privileges);
 * otherwise (SAME_USER_ENV) it runs as the current user.
 */
export function childCommand(isRoot: boolean, childPath: string): string[] {
  const node = [process.execPath, childPath];
  return isRoot
    ? [
        SETPRIV,
        `--reuid=${SCAN_UID}`,
        `--regid=${SCAN_UID}`,
        '--clear-groups',
        '--inh-caps=-all',
        '--bounding-set=-all',
        '--no-new-privs',
        ...node,
      ]
    : node;
}

/** Variables the child may see from the agent's environment (never the token or the control address). */
const PASSED = ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'];
/** Also passed when the child runs as the current user: its home and the browser's install folder. */
const PASSED_SAME_USER = [
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'PATHEXT',
  'COMSPEC',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'WINDIR',
  'PLAYWRIGHT_BROWSERS_PATH',
];

/**
 * The child's environment, built from an allow list: the system basics, the
 * proxy and contact URLs, and nothing else. As root, HOME is the temp folder
 * (root's own is not the scan user's to read) and the browser path is the
 * image's.
 */
export function childEnv(
  env: NodeJS.ProcessEnv,
  isRoot: boolean,
  proxyUrl: string,
  contactUrl: string | undefined,
): NodeJS.ProcessEnv {
  // Windows names are case-insensitive, and a copied environment keeps its own spelling (Path).
  const get = (name: string) =>
    Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
  const out: NodeJS.ProcessEnv = {};
  for (const name of [...PASSED, ...(isRoot ? [] : PASSED_SAME_USER)]) {
    const value = get(name);
    if (value !== undefined) out[name] = value;
  }
  if (isRoot) {
    out.HOME = tmpdir();
    const browsers = get('PLAYWRIGHT_BROWSERS_PATH');
    if (browsers !== undefined) out.PLAYWRIGHT_BROWSERS_PATH = browsers;
  }
  out[PROXY_URL_ENV] = proxyUrl;
  if (contactUrl !== undefined) out[CONTACT_URL_ENV] = contactUrl;
  return out;
}

export interface AgentOptions {
  /** The agent's environment; the token is deleted from it once read. */
  env: NodeJS.ProcessEnv;
  /** The child's argv. Default: childCommand for agent-child.js next to this file. */
  child?: readonly string[];
  /** The tier's wall-clock cap, counted from the agent's start (tests). */
  capMs?: number;
  /** How long before the cap the scan is stopped (tests). Default TIMEOUT_MARGIN_MS. */
  marginMs?: number;
  /** Stops the scan (SIGTERM or SIGINT to the agent): the child is stopped and failed is sent. */
  signal?: AbortSignal;
  /** Largest child stdout read (tests). Default MAX_CHILD_OUTPUT_BYTES. */
  maxOutputBytes?: number;
  /**
   * Runs REAP_COMMAND after the child, as root, up to REAP_PASSES times (tests).
   * Default: spawn without a shell.
   */
  reap?: RunCommand;
  /** The agent's uid (tests). Default process.getuid(). */
  uid?: number;
  /** Where log lines go. Default: stderr. */
  log?: (line: string) => void;
}

/** One request to the API with the job token; no redirect is followed. */
async function control(
  url: string,
  token: string,
  init: { method?: string; body?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const timeout = AbortSignal.timeout(init.timeoutMs ?? CONTROL_TIMEOUT_MS);
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
    redirect: 'error',
    signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
  });
}

/** The last non-empty line of the child's stdout as a result, or undefined. Only that line is decoded. */
function parseResult(stdout: Buffer): JobResult | undefined {
  let end = stdout.length;
  while (end > 0 && (stdout[end - 1] === 0x0a || stdout[end - 1] === 0x0d)) end--;
  if (end === 0) return undefined;
  const start = stdout.lastIndexOf(0x0a, end - 1) + 1;
  try {
    const parsed = JobResultSchema.safeParse(JSON.parse(stdout.toString('utf8', start, end)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The child's stderr, line by line: only well-formed lines (CHILD_EVENT) of a
 * child event (CHILD_EVENTS), with no key repeated and none of the agent's
 * keys (event, source, job) after the event name, are forwarded, with the
 * agent's job id and source=child added. Lines over MAX_STDERR_LINE, anything
 * past MAX_STDERR_BYTES and every other line are dropped and counted, so a
 * child cannot forge (whether a parser takes a key's first value or its last),
 * flood or leak through the machine's log (CWE-117).
 */
export class ChildStderr {
  /** Lines not forwarded. */
  dropped = 0;
  private read = 0;
  private line: Buffer[] = [];
  private length = 0;
  private overLong = false;
  /** Past the cap: a line has started (or was cut) and its line end has not come yet. */
  private openPastCap = false;

  constructor(
    private readonly jobId: string,
    private readonly log: (line: string) => void,
  ) {}

  push(chunk: Buffer): void {
    const kept = chunk.subarray(0, Math.max(0, MAX_STDERR_BYTES - this.read));
    this.read += kept.length;
    let from = 0;
    for (let at = kept.indexOf(0x0a); at >= 0; at = kept.indexOf(0x0a, from)) {
      this.add(kept.subarray(from, at));
      this.endLine();
      from = at + 1;
    }
    this.add(kept.subarray(from));
    if (kept.length === chunk.length) return;
    // Past the cap nothing is decoded: a line the cap cut is discarded, and every line
    // past it is only counted, once, at its line end or at the end of the output.
    if (this.length > 0 || this.overLong) this.openPastCap = true;
    this.line = [];
    this.length = 0;
    this.overLong = false;
    let past = kept.length;
    for (let at = chunk.indexOf(0x0a, past); at >= 0; at = chunk.indexOf(0x0a, past)) {
      this.dropped++;
      this.openPastCap = false;
      past = at + 1;
    }
    if (past < chunk.length) this.openPastCap = true;
  }

  /** The child has exited: a last line without a line end is judged (or, past the cap, counted) too. */
  end(): void {
    if (this.openPastCap) {
      this.dropped++;
      this.openPastCap = false;
    } else if (this.length > 0 || this.overLong) this.endLine();
  }

  private add(part: Buffer): void {
    if (part.length === 0 || this.overLong) return;
    if (this.length + part.length > MAX_STDERR_LINE) {
      this.overLong = true;
      this.line = [];
      return;
    }
    this.line.push(part);
    this.length += part.length;
  }

  private endLine(): void {
    const text = this.overLong
      ? undefined
      : Buffer.concat(this.line).toString('utf8').replace(/\r$/, '');
    this.line = [];
    this.length = 0;
    this.overLong = false;
    if (text === '') return;
    if (text === undefined || !CHILD_EVENT.test(text)) {
      this.dropped++;
      return;
    }
    const [, first = '', ...rest] = text.split(' ');
    const keys = rest.map((field) => field.slice(0, field.indexOf('=')));
    if (
      !CHILD_EVENTS.has(first.slice('event='.length)) ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => AGENT_KEYS.has(key))
    ) {
      this.dropped++;
      return;
    }
    this.log(
      `widedoor ${first} job=${this.jobId}${rest.map((f) => ` ${f}`).join('')} source=child`,
    );
  }
}

/**
 * Kills every process of the scan user left after the child closed. Chromium
 * and veraPDF run in process groups of their own (Playwright and the veraPDF
 * runner spawn them detached), so the child's group signal misses them.
 */
export const REAP_COMMAND: readonly string[] = ['/usr/bin/pkill', '-KILL', '-U', String(SCAN_UID)];
/** Most runs of REAP_COMMAND: a process forked during one pass is caught by the next. */
export const REAP_PASSES = 3;
/** Wait between passes, so the init process can collect what the last pass killed. */
const REAP_PAUSE_MS = 200;

/** Runs a command with no shell and resolves with its exit code (null when it could not run). */
export type RunCommand = (argv: readonly string[]) => Promise<number | null>;

const runCommand: RunCommand = (argv) =>
  new Promise((done) => {
    const [command, ...args] = argv as [string, ...string[]];
    const child = spawn(command, args, { stdio: 'ignore', timeout: 10_000 });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });

/**
 * Runs REAP_COMMAND until it finds no process left (pkill exits 1), at most REAP_PASSES
 * times, and logs the outcome: reaped, failed (pkill could not run or failed), or
 * incomplete (the scan user still had processes after the last pass).
 */
async function reapScanUser(
  run: RunCommand,
  event: (name: string, fields?: string) => void,
): Promise<void> {
  for (let pass = 1; pass <= REAP_PASSES; pass++) {
    const code = await run(REAP_COMMAND);
    // 1 means no process was left.
    if (code === 1) return event('agent_reaped', `found=${pass > 1 ? 'yes' : 'no'} passes=${pass}`);
    if (code !== 0) return event('agent_reap_failed', `code=${logValue(String(code))}`);
    if (pass < REAP_PASSES) await new Promise((wait) => setTimeout(wait, REAP_PAUSE_MS));
  }
  event('agent_reap_incomplete', `passes=${REAP_PASSES}`);
}

/** Sends a signal to the child and, on POSIX, to its process group (the PDF reader). */
function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    // Windows has no process groups: there the child alone gets it.
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

/**
 * Runs the child with the job on stdin and resolves with its result: the
 * child's own, or a failure when it outlives timeLimitMs, is stopped, writes
 * more than the output cap, cannot start or exits without a valid result.
 */
function runChild(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  job: string,
  timeLimitMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
  event: (name: string, fields?: string) => void,
  stderr: ChildStderr,
): Promise<JobResult> {
  return new Promise((done) => {
    const [command, ...args] = argv as [string, ...string[]];
    // Its own process group on POSIX, so a stop reaches what it started.
    const child = spawn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped: string | undefined;
    let killer: NodeJS.Timeout | undefined;
    const stop = (why: string) => {
      if (stopped !== undefined) return;
      stopped = why;
      signalChild(child, 'SIGTERM');
      killer = setTimeout(() => signalChild(child, 'SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      event('agent_timeout');
      stop(TIMED_OUT);
    }, timeLimitMs);
    const onAbort = () => {
      event('agent_stopped');
      stop(STOPPED);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutputBytes) stop(TOO_LARGE);
      else if (stopped === undefined) chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    // A child that dies early closes stdin under the write; its exit says what happened.
    child.stdin.on('error', () => undefined);
    child.stdin.end(job);
    child.on('error', () => {
      event('agent_child_start_failed');
      stopped ??= 'the scan could not start';
    });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      clearTimeout(killer);
      signal?.removeEventListener('abort', onAbort);
      stderr.end();
      if (stderr.dropped > 0) event('agent_child_stderr_dropped', `count=${stderr.dropped}`);
      if (stopped !== undefined) return done({ status: 'failed', error: stopped });
      const result = parseResult(Buffer.concat(chunks));
      if (result) return done(result);
      event(
        'agent_child_failed',
        `code=${logValue(String(code))} signal=${logValue(String(exitSignal))}`,
      );
      done({ status: 'failed', error: 'the scan stopped unexpectedly' });
    });
  });
}

/**
 * Fetches the job, runs the scan child and sends its result. Resolves with
 * the exit code: 0 once a result was accepted, 1 when the agent may not run
 * (not root without SAME_USER_ENV, a missing setting), the job could not be
 * reached or the result could not be sent.
 */
export async function runAgent(options: AgentOptions): Promise<number> {
  const { env, signal } = options;
  // The API's cap runs from the job's start, before its create call, so the agent's clock
  // starts now, not at the child; the machine's boot is already spent.
  const started = Date.now();
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const controlUrl = env[CONTROL_URL_ENV] ?? '';
  const jobId = env[JOB_ID_ENV] ?? '';
  const token = env[JOB_TOKEN_ENV] ?? '';
  // Read once; nothing the agent starts or loads later can find it in the environment.
  delete env[JOB_TOKEN_ENV];
  // The id is not secret, but only a valid one is written.
  const job = JOB_ID.test(jobId) ? ` job=${jobId}` : '';
  const event = (name: string, fields?: string) =>
    log(`widedoor event=${name}${job}${fields ? ` ${fields}` : ''}`);

  // Without these there is no one to report to: say which, never its value.
  for (const [name, ok] of [
    [CONTROL_URL_ENV, isHttpUrl(controlUrl)],
    [JOB_ID_ENV, JOB_ID.test(jobId)],
    [JOB_TOKEN_ENV, isToken(token)],
  ] as const)
    if (!ok) {
      event('agent_config_error', `name=${name}`);
      return 1;
    }

  // The result must reach the API before the cap, when it destroys the machine; the
  // tier's cap once the input names it.
  let deadline = started + (options.capMs ?? TIERS.open.wallClockMs);
  let tier: keyof typeof TIERS = 'open';
  // Each PUT waits at most the time left before the cap. After the child timed out, less
  // than TIMEOUT_MARGIN_MS (30 s) remain, so a PUT queued at a busy result gate gives up
  // before the API's own RESULT_DEADLINE_MS (120 s) and the job ends unreadable or timed
  // out. That happens only at the cap, where the job fails anyway.
  const send = async (result: JobResult): Promise<number> => {
    let body = JSON.stringify(result);
    let status = result.status;
    // Checked before it goes: the API reads no more than this for the job's tier.
    if (Buffer.byteLength(body) > resultBodyMax(tier)) {
      event('agent_result_too_large');
      status = 'failed';
      body = JSON.stringify({ status, error: REPORT_TOO_LARGE });
    }
    for (let attempt = 1; attempt <= RESULT_TRIES; attempt++) {
      const left = deadline - Date.now();
      // The first try always goes; a retry only while it would still have its minimum wait.
      if (attempt > 1 && left < MIN_RESULT_WAIT_MS) break;
      try {
        const response = await control(jobUrl(controlUrl, jobId, 'result'), token, {
          method: 'PUT',
          body,
          timeoutMs: Math.max(MIN_RESULT_WAIT_MS, Math.min(RESULT_TIMEOUT_MS, left)),
        });
        await response.body?.cancel().catch(() => undefined);
        if (response.ok) {
          event('agent_result', `status=${status}`);
          return 0;
        }
        event('agent_result_refused', `status=${response.status}`);
        // Another PUT of this result is still being read: try again later, within the
        // deadline, without spending a try.
        if (response.status === 409) {
          if (deadline - Date.now() < MIN_RESULT_WAIT_MS + BUSY_RETRY_MS) return 1;
          await new Promise((wait) => setTimeout(wait, BUSY_RETRY_MS));
          attempt--;
          continue;
        }
        // The API judged the result: sending it again will not change that. A timeout
        // (408) or a rate limit (429) is not a judgment.
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429
        )
          return 1;
      } catch {
        event('agent_result_unsent');
      }
      if (attempt < RESULT_TRIES)
        await new Promise((wait) =>
          setTimeout(wait, Math.max(0, Math.min(1_000 * attempt, deadline - Date.now()))),
        );
    }
    return 1;
  };
  const fail = (error: string) => send({ status: 'failed', error: jobError(error) });

  // As anyone but root the child would share the uid that holds the token (/proc/<pid>/environ,
  // ptrace). The API hears why the job failed, in fixed words; the agent still exits non-zero.
  const isRoot = (options.uid ?? process.getuid?.()) === 0;
  if (!isRoot && env[SAME_USER_ENV] !== '1') {
    event('agent_config_error', 'name=uid');
    await fail('the scan machine is misconfigured');
    return 1;
  }

  const input = await (async (): Promise<JobInput | 'refused' | 'stopped' | undefined> => {
    try {
      const response = await control(jobUrl(controlUrl, jobId, 'input'), token, {
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        event('agent_input_unavailable', `status=${response.status}`);
        return undefined;
      }
      const { bytes, over } = await readCapped(response, MAX_INPUT_BYTES);
      let raw: unknown;
      try {
        raw = over ? undefined : JSON.parse(Buffer.from(bytes).toString('utf8'));
      } catch {
        raw = undefined;
      }
      const parsed = JobInputSchema.safeParse(raw);
      // The input must be this machine's job: a mix-up must not scan someone else's target.
      if (!parsed.success || parsed.data.jobId !== jobId) {
        event('agent_input_refused');
        return 'refused';
      }
      return parsed.data;
    } catch {
      if (signal?.aborted) return 'stopped';
      event('agent_input_unavailable');
      return undefined;
    }
  })();
  if (input === undefined) return 1;
  if (input === 'stopped') {
    event('agent_stopped');
    return fail(STOPPED);
  }
  if (input === 'refused') return fail(INPUT_REFUSED);
  const limits = TIERS[input.tier];
  tier = input.tier;
  // A verify job has its own, shorter cap (ledger R42).
  const verify = input.target.kind === 'verify';
  if (options.capMs === undefined) deadline = started + wallClockFor(input.tier, verify);

  const proxyUrl = env[PROXY_URL_ENV] ?? '';
  if (!isHttpUrl(proxyUrl)) {
    event('agent_config_error', `name=${PROXY_URL_ENV}`);
    return fail('the scan machine is not set up to scan');
  }

  let pdf: string | undefined;
  if (input.target.kind === 'pdf') {
    try {
      const response = await control(jobUrl(controlUrl, jobId, 'pdf'), token, {
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        event('agent_pdf_unavailable', `status=${response.status}`);
        return fail('the uploaded PDF could not be read');
      }
      const { bytes, over } = await readCapped(response, limits.pdfMaxBytes);
      if (over) return fail(`the PDF is over the ${limits.pdfMaxBytes / (1024 * 1024)} MiB limit`);
      pdf = Buffer.from(bytes).toString('base64');
    } catch {
      if (signal?.aborted) {
        event('agent_stopped');
        return fail(STOPPED);
      }
      event('agent_pdf_unavailable');
      return fail('the uploaded PDF could not be read');
    }
  }
  if (signal?.aborted) return fail(STOPPED);

  const argv =
    options.child ??
    childCommand(isRoot, fileURLToPath(new URL('./agent-child.js', import.meta.url)));
  const childJob = JSON.stringify(
    ChildJobSchema.parse({ input, ...(pdf !== undefined ? { pdf } : {}) }),
  );
  const result = await runChild(
    argv,
    childEnv(env, isRoot, proxyUrl, env[CONTACT_URL_ENV]),
    childJob,
    options.capMs === undefined && options.marginMs === undefined
      ? timeLimitFor(input.tier, Date.now() - started, verify)
      : Math.max(1, deadline - (options.marginMs ?? TIMEOUT_MARGIN_MS) - Date.now()),
    options.maxOutputBytes ?? MAX_CHILD_OUTPUT_BYTES,
    signal,
    event,
    new ChildStderr(jobId, log),
  );
  if (isRoot) await reapScanUser(options.reap ?? runCommand, event);
  return send(result);
}

// Only as a process entry point.
if (import.meta.main) {
  const stop = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT'] as const) process.once(name, () => stop.abort());
  const code = await runAgent({ env: process.env, signal: stop.signal });
  process.exitCode = code;
  // Backstop: a handle left open must not keep the machine up.
  setTimeout(() => process.exit(code), 2_000).unref();
}
