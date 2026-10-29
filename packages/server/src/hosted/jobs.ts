import { randomBytes } from 'node:crypto';
import { logValue } from '@widedoor/web/egress';
import type { ProfileId } from '@widedoor/core';
import { tokenMatches } from '../security.js';
import { FlyError, sweepScanMachines, type FlyClient } from './fly.js';
import { VERIFIED_TIER, VERIFY_DAILY_CAP, wallClockFor, type Tier } from './limits.js';
import {
  DEFAULT_CONTACT_URL,
  JOB_ID,
  JobInputSchema,
  TIMED_OUT,
  type JobInput,
  type VerifyResult,
} from './protocol.js';
import { rateKey, wideKey } from './rate-limit.js';

/*
 * The hosted API's scan jobs, in memory (plan ruling 7, ledger R35 to R39). Each
 * job gets one scan machine and one bearer token; the token works only for its
 * own job and only while the job is starting or running, and is cleared the
 * moment the job leaves those states. At most MAX_RUNNING machine slots are
 * held at once and MAX_QUEUED jobs wait; past either, or past MAX_PER_DAY jobs
 * in a UTC day, a new job is refused. A job holds its slot until its create has
 * settled and every destroy it started has finished, so more than MAX_RUNNING
 * machines never run. A job past its tier's wall-clock cap, counted from the
 * move to starting, gets its machine destroyed; a job queued past the queue
 * wait fails. Results, the input and the uploaded PDF are dropped RETENTION_MS
 * after the job ends (the PDF as soon as the agent fetched it), and the job
 * reads expired. Queued PDFs and kept reports share one byte budget. Every
 * timer goes through an injectable clock and scheduler. Log lines are one event
 * each, every value through logValue, and never hold a token, a URL path or
 * query, or a PDF name.
 *
 * Each client network holds few live jobs (queued, starting or running; scans and
 * verify jobs of both tiers alike): per rate key (IPv4 /32, IPv6 /64) at most one
 * starting or running and one queued, per wider network (IPv4 /24, IPv6 /48) at most
 * MAX_LIVE_PER_WIDE. A queued job whose network already has one running waits while
 * later jobs of other networks start. Counts come from the jobs' states, so every way
 * a job ends releases its place.
 *
 * A verify job (Task 11, ledger R40 to R42) is a job like any other: the same
 * slots, queue, daily cap and token rules, on a scan machine of the same image
 * and size. At most VERIFY_DAILY_CAP of a day's jobs are verify jobs. Its cap is
 * VERIFY_WALL_CLOCK_MS, it keeps no report, its events are named verify_job_*
 * instead of scan_*, and onVerifyEnd hears how it ended. A job made for a
 * verification (a verify job, or a verified-tier scan) carries its vref, a log
 * reference that is not the verification id, on every event.
 */

export const JOB_STATUSES = [
  'queued',
  'starting',
  'running',
  'done',
  'failed',
  'cancelled',
  'expired',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Scan machines at once. */
export const MAX_RUNNING = 3;
/** Jobs waiting for a machine. */
export const MAX_QUEUED = 20;
/** Jobs taken per UTC day. */
export const MAX_PER_DAY = 300;
/** Bytes held at most for queued PDFs and kept reports (JSON plus rendered HTML) together. */
export const MAX_RETAINED_BYTES = 512 * 1024 * 1024;
/** Longest wait in the queue; past it the job fails as busy. */
export const QUEUE_WAIT_MS = 30 * 60_000;
/** How long results stay downloadable after a job ends. */
export const RETENTION_MS = 60 * 60_000;
/** How long an ended job's id still answers (expired or cancelled) before it is forgotten. */
export const RECORD_MS = 24 * 60 * 60_000;
/** Longest wait for a machine create; past it the machine may or may not exist. */
export const CREATE_TIMEOUT_MS = 30_000;
/** Scan machines older than this are destroyed by the sweep: the longest cap plus 5 minutes. */
export const SWEEP_MAX_AGE_MS = VERIFIED_TIER.wallClockMs + 5 * 60_000;
/** Time between sweeps. */
export const SWEEP_EVERY_MS = 10 * 60_000;
/** Longest wait for one sweep; past it the next sweep may run, and intake never waits. */
export const SWEEP_DEADLINE_MS = 2 * 60_000;
/** Jobs starting or running per rate key (IPv4 /32, IPv6 /64). */
export const MAX_RUNNING_PER_NETWORK = 1;
/** Jobs queued per rate key. */
export const MAX_QUEUED_PER_NETWORK = 1;
/** Live jobs (queued, starting or running) per wider network (IPv4 /24, IPv6 /48). */
export const MAX_LIVE_PER_WIDE = 2;
/** Retry-After, in seconds, for a refusal by the per-network cap. */
export const NETWORK_RETRY_S = 60;

export const BUSY = 'The scanner is busy. Try again in a few minutes.';
export const BUSY_NETWORK =
  'You already have a scan in progress. Wait for it to finish, then try again.';
export const START_FAILED = 'The scanner could not start. Try again.';
export { TIMED_OUT };
export const UNREADABLE = 'the scan returned an unreadable report';
export const TOO_LARGE_TO_KEEP = 'the report was too large to keep';
export const TOO_SLOW = 'the scan report took too long to arrive';

const DAY_MS = 24 * 60 * 60_000;

/** Runs fire after ms; the returned function cancels it. */
export type Scheduler = (fire: () => void, ms: number) => () => void;

export const realScheduler: Scheduler = (fire, ms) => {
  const timer = setTimeout(fire, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/** One log line: `widedoor event=<name>` and the fields that are set, each through logValue. */
export function eventLine(
  name: string,
  fields: Readonly<Record<string, string | number | undefined>> = {},
): string {
  const parts = Object.entries(fields)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => ` ${key}=${logValue(String(value))}`);
  return `widedoor event=${name}${parts.join('')}`;
}

/**
 * What a job scans. The PDF's name goes to the scan machine only; it is never logged.
 * The PDF is the uploaded multipart part itself, the only copy held.
 */
export type JobTarget =
  | { kind: 'url'; url: string; host: string }
  | { kind: 'pdf'; fileName: string; pdf: Blob | undefined }
  | { kind: 'verify'; host: string; token: string };

/** A scan, or a domain verification's HTTP check. */
export type JobKind = 'scan' | 'verify';

export interface NewJob {
  tier: Tier;
  profile: ProfileId;
  target: JobTarget;
  /** The client's network for the log (logPrefix). */
  ip?: string;
  /**
   * The client's address (Fly-Client-IP): its networks key the per-network cap. Only the
   * networks are kept, and never logged. Without it the job counts toward no network.
   */
  client?: string;
  /** The verification's log reference (api.ts), for a verify job or a verified-tier scan. */
  vref?: string;
}

/** A refusal to take a job: busy_network for the per-network cap, busy for anything else. */
export type Refusal = { ok: false; message: string; reason: 'busy' | 'busy_network' };

/** What GET /api/scans/:id answers. */
export interface JobView {
  id: string;
  status: JobStatus;
  /** 1 for the next job to start; queued jobs only. */
  queuePosition?: number;
  message?: string;
}

/** A finished scan's reports, both built by the API from the validated report, as UTF-8. */
export interface JobReports {
  json: Buffer<ArrayBuffer>;
  html: Buffer<ArrayBuffer>;
}

const reportBytes = (reports: JobReports): number => reports.json.length + reports.html.length;

interface Job {
  id: string;
  kind: JobKind;
  vref: string | undefined;
  tier: Tier;
  profile: ProfileId;
  status: JobStatus;
  target: JobTarget | undefined;
  token: string | undefined;
  machineId: string | undefined;
  message: string | undefined;
  reports: JobReports | undefined;
  startedAt: number | undefined;
  /** Cancels the job's pending timer (queue wait, cap, expiry or forgetting). */
  cancelTimer: (() => void) | undefined;
  /** Cancels the create timeout while the create is in flight. */
  cancelCreate: (() => void) | undefined;
  /** Whether the job holds a machine slot. */
  slot: boolean;
  /** Fly calls in flight that keep the slot held: the create, and destroys. */
  pending: number;
  /** The client's rate key and wider network (rateKey, wideKey), for the per-network cap. */
  narrow: string | undefined;
  wide: string | undefined;
}

export interface HostedJobsOptions {
  fly: FlyClient;
  /** The scan image ref. */
  image: string;
  /** The control listener's URL as scan machines reach it. */
  controlUrl: string;
  /** Passed to every scan machine for its user agent. Default DEFAULT_CONTACT_URL. */
  contactUrl?: string;
  /** The region scan machines are created in (the API's FLY_REGION). Default: Fly picks. */
  region?: string;
  /** Default MAX_RETAINED_BYTES. */
  maxRetainedBytes?: number;
  /** Default QUEUE_WAIT_MS. */
  queueWaitMs?: number;
  /**
   * Hears every verify job's end once: with its result when the machine sent one,
   * undefined when it failed, ran out of time, waited too long or was cancelled.
   */
  onVerifyEnd?: (jobId: string, result: VerifyResult | undefined) => void;
  /**
   * Hears a job's kept reports being dropped (expiry or cancel), right after the budget
   * releases them, so their open downloads can end and the Buffers be collected.
   */
  onDrop?: (jobId: string) => void;
  now?: () => number;
  schedule?: Scheduler;
  log?: (line: string) => void;
}

export type ReportLookup =
  | { kind: 'ok'; reports: JobReports }
  | { kind: 'unknown' }
  | { kind: 'gone' }
  | { kind: 'not-ready' };

export class HostedJobs {
  private readonly fly: FlyClient;
  private readonly image: string;
  private readonly controlUrl: string;
  private readonly contactUrl: string;
  private readonly region: string | undefined;
  private readonly maxRetainedBytes: number;
  private readonly queueWaitMs: number;
  private readonly now: () => number;
  private readonly schedule: Scheduler;
  private readonly log: (line: string) => void;
  private readonly onVerifyEnd: (jobId: string, result: VerifyResult | undefined) => void;
  private readonly onDrop: (jobId: string) => void;
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private day = -1;
  private today = 0;
  private verifyToday = 0;
  private slots = 0;
  private retainedBytes = 0;
  private sweeping = false;
  /** Counts sweeps, so a hung one that settles late cannot clear a newer one's flag. */
  private sweepRun = 0;
  /** Whether a sweep's machine list has succeeded since start; until then sweeps are first sweeps. */
  private firstSweepDone = false;
  private stopSweeps: (() => void) | undefined;

  constructor(options: HostedJobsOptions) {
    this.fly = options.fly;
    this.image = options.image;
    this.controlUrl = options.controlUrl;
    this.contactUrl = options.contactUrl ?? DEFAULT_CONTACT_URL;
    this.region = options.region;
    this.maxRetainedBytes = options.maxRetainedBytes ?? MAX_RETAINED_BYTES;
    this.queueWaitMs = options.queueWaitMs ?? QUEUE_WAIT_MS;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? realScheduler;
    this.log = options.log ?? (() => undefined);
    this.onVerifyEnd = options.onVerifyEnd ?? (() => undefined);
    this.onDrop = options.onDrop ?? (() => undefined);
  }

  private event(name: string, fields?: Readonly<Record<string, string | number | undefined>>) {
    this.log(eventLine(name, fields));
  }

  /** A job's own event: scan_<what> or verify_job_<what>, with its id and (a scan's) tier. */
  private jobEvent(
    job: Job,
    what: string,
    fields: Readonly<Record<string, string | number | undefined>> = {},
  ) {
    const name = job.kind === 'verify' ? `verify_job_${what}` : `scan_${what}`;
    this.event(name, {
      job: job.id,
      tier: job.kind === 'scan' ? job.tier : undefined,
      vref: job.vref,
      ...fields,
    });
  }

  /** Logs fly_auth_failed for a 401 or 403: the token is wrong, expired or scoped to another app. */
  private flyStatus(error: unknown): number {
    const status = error instanceof FlyError ? error.status : 0;
    if (status === 401 || status === 403) this.event('fly_auth_failed', { status });
    return status;
  }

  /** Machine slots held (tests). */
  get running(): number {
    return this.slots;
  }

  /** Bytes held for queued PDFs and kept reports (tests). */
  get retained(): number {
    return this.retainedBytes;
  }

  /** Live jobs of one network: starting or running, and queued. */
  private liveOf(key: 'narrow' | 'wide', network: string): { running: number; queued: number } {
    let running = 0;
    let queued = 0;
    for (const job of this.jobs.values()) {
      if (job[key] !== network) continue;
      if (job.status === 'queued') queued++;
      else if (job.status === 'starting' || job.status === 'running') running++;
    }
    return { running, queued };
  }

  /**
   * Whether a new job of `bytes` held bytes from client (its address) would be taken now:
   * the client's networks' live jobs, the day's cap (and for a verify job its own share
   * of it), a machine slot or a queue place, and the byte budget. The API asks before it
   * charges a rate token or reads a body.
   */
  canAccept(bytes = 0, kind: JobKind = 'scan', client?: string): { ok: true } | Refusal {
    if (client !== undefined) {
      const narrow = this.liveOf('narrow', rateKey(client) ?? client);
      const wide = this.liveOf('wide', wideKey(client) ?? client);
      if (
        narrow.queued >= MAX_QUEUED_PER_NETWORK ||
        narrow.running + narrow.queued >= MAX_RUNNING_PER_NETWORK + MAX_QUEUED_PER_NETWORK ||
        wide.running + wide.queued >= MAX_LIVE_PER_WIDE
      )
        return { ok: false, message: BUSY_NETWORK, reason: 'busy_network' };
    }
    const busy: Refusal = { ok: false, message: BUSY, reason: 'busy' };
    const day = Math.floor(this.now() / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.today = 0;
      this.verifyToday = 0;
    }
    if (this.today >= MAX_PER_DAY) return busy;
    if (kind === 'verify' && this.verifyToday >= VERIFY_DAILY_CAP) return busy;
    if (this.slots >= MAX_RUNNING && this.queue.length >= MAX_QUEUED) return busy;
    if (this.retainedBytes + bytes > this.maxRetainedBytes) return busy;
    return { ok: true };
  }

  /**
   * Whether reports of `bytes` (JSON and HTML together, UTF-8) fit the byte budget now.
   * The control app asks before it builds the kept Buffers, so a report that would end
   * too_large_to_keep never costs their copy.
   */
  canKeep(bytes: number): boolean {
    return this.retainedBytes + bytes <= this.maxRetainedBytes;
  }

  /** Takes a job, or refuses it as canAccept would. */
  submit(request: NewJob): { ok: true; view: JobView } | Refusal {
    const bytes = request.target.kind === 'pdf' ? (request.target.pdf?.size ?? 0) : 0;
    const kind: JobKind = request.target.kind === 'verify' ? 'verify' : 'scan';
    const { client } = request;
    const accept = this.canAccept(bytes, kind, client);
    if (!accept.ok) return accept;
    this.today++;
    if (kind === 'verify') this.verifyToday++;
    this.retainedBytes += bytes;
    const job: Job = {
      id: randomBytes(16).toString('hex'),
      kind,
      vref: request.vref,
      tier: request.tier,
      profile: request.profile,
      status: 'queued',
      target: request.target,
      token: undefined,
      machineId: undefined,
      message: undefined,
      reports: undefined,
      startedAt: undefined,
      cancelTimer: undefined,
      cancelCreate: undefined,
      slot: false,
      pending: 0,
      narrow: client === undefined ? undefined : (rateKey(client) ?? client),
      wide: client === undefined ? undefined : (wideKey(client) ?? client),
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    job.cancelTimer = this.schedule(() => this.waitedTooLong(job), this.queueWaitMs);
    this.jobEvent(job, 'queued', {
      host: request.target.kind === 'pdf' ? undefined : request.target.host,
      ip: request.ip,
    });
    this.pump();
    return { ok: true, view: this.viewOf(job) };
  }

  private viewOf(job: Job): JobView {
    const position = job.status === 'queued' ? this.queue.indexOf(job) + 1 : 0;
    return {
      id: job.id,
      status: job.status,
      ...(position > 0 ? { queuePosition: position } : {}),
      ...(job.message !== undefined ? { message: job.message } : {}),
    };
  }

  /** The job's state, or undefined for an id that is unknown or forgotten. */
  view(id: string): JobView | undefined {
    const job = JOB_ID.test(id) ? this.jobs.get(id) : undefined;
    return job ? this.viewOf(job) : undefined;
  }

  /** A done job's reports; gone once it expired or was cancelled. */
  reports(id: string): ReportLookup {
    const job = JOB_ID.test(id) ? this.jobs.get(id) : undefined;
    if (job === undefined) return { kind: 'unknown' };
    if (job.status === 'expired' || job.status === 'cancelled') return { kind: 'gone' };
    if (job.status !== 'done' || job.reports === undefined) return { kind: 'not-ready' };
    return { kind: 'ok', reports: job.reports };
  }

  /** Whether another job of this job's rate key is starting or running. */
  private networkBusy(job: Job): boolean {
    return (
      job.narrow !== undefined &&
      this.liveOf('narrow', job.narrow).running >= MAX_RUNNING_PER_NETWORK
    );
  }

  /**
   * Starts queued jobs while slots are free, in queue order, passing over a job whose
   * network already has one starting or running.
   */
  private pump(): void {
    while (this.slots < MAX_RUNNING) {
      const index = this.queue.findIndex((job) => !this.networkBusy(job));
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      if (job !== undefined) this.start(job);
    }
  }

  /** Frees the job's slot once it has ended and no Fly call it started is still in flight. */
  private release(job: Job): void {
    if (!job.slot || job.pending > 0 || job.status === 'starting' || job.status === 'running')
      return;
    job.slot = false;
    this.slots--;
    this.pump();
  }

  /** Keeps the job's slot held until work settles. */
  private track(job: Job, work: Promise<void>): void {
    job.pending++;
    void work.finally(() => {
      job.pending--;
      this.release(job);
    });
  }

  private dropPdf(job: Job): void {
    if (job.target?.kind !== 'pdf' || job.target.pdf === undefined) return;
    this.retainedBytes -= job.target.pdf.size;
    job.target.pdf = undefined;
  }

  private dropReports(job: Job): void {
    if (job.reports === undefined) return;
    this.retainedBytes -= reportBytes(job.reports);
    job.reports = undefined;
    this.onDrop(job.id);
  }

  /** A queued job that waited QUEUE_WAIT_MS fails as busy. */
  private waitedTooLong(job: Job): void {
    if (job.status !== 'queued') return;
    this.queue.splice(this.queue.indexOf(job), 1);
    job.status = 'failed';
    job.message = BUSY;
    this.dropPdf(job);
    this.jobEvent(job, 'failed', { reason: 'queue_wait' });
    job.cancelTimer = this.schedule(() => this.expire(job), RETENTION_MS);
    if (job.kind === 'verify') this.onVerifyEnd(job.id, undefined);
  }

  private start(job: Job): void {
    job.cancelTimer?.();
    job.status = 'starting';
    job.token = randomBytes(32).toString('base64url');
    job.startedAt = this.now();
    job.slot = true;
    this.slots++;
    job.cancelTimer = this.schedule(
      () => this.capped(job),
      wallClockFor(job.tier, job.kind === 'verify'),
    );
    this.jobEvent(job, 'started');
    const began = this.now();
    let settled = false;
    // The create keeps the slot held until it settles (or times out).
    job.pending++;
    const settle = () => {
      settled = true;
      job.cancelCreate?.();
      job.cancelCreate = undefined;
    };
    const done = () => {
      job.pending--;
      this.release(job);
    };
    /** A create with no answer may still have started a machine: look it up by job and destroy it. */
    const lost = () => {
      if (job.status === 'starting') this.end(job, 'failed', START_FAILED, 'fly_create');
      this.track(job, this.destroyByJob(job.id));
    };
    job.cancelCreate = this.schedule(() => {
      if (settled) return;
      settle();
      this.event('fly_create', { job: job.id, status: 0, ms: this.now() - began });
      lost();
      done();
    }, CREATE_TIMEOUT_MS);
    this.fly
      .createScanMachine({
        jobId: job.id,
        token: job.token,
        image: this.image,
        controlUrl: this.controlUrl,
        contactUrl: this.contactUrl,
        tier: job.tier,
        ...(this.region !== undefined ? { region: this.region } : {}),
      })
      .then(
        ({ id }) => {
          if (settled) {
            // Answered after the timeout: the job already failed, so the machine goes.
            void this.destroy(job.id, id);
            return;
          }
          settle();
          this.event('fly_create', { job: job.id, machine: id, ms: this.now() - began });
          if (job.status === 'starting') {
            job.machineId = id;
            job.status = 'running';
          } else {
            // Ended (cancelled, capped or a result) while the create was in flight.
            this.track(job, this.destroy(job.id, id));
          }
          done();
        },
        (error: unknown) => {
          if (settled) return;
          settle();
          const status = this.flyStatus(error);
          this.event('fly_create', { job: job.id, status, ms: this.now() - began });
          if (status === 0) lost();
          else if (job.status === 'starting') this.end(job, 'failed', START_FAILED, 'fly_create');
          done();
        },
      );
  }

  /** The tier's cap passed with the job still starting or running. */
  private capped(job: Job): void {
    if (job.status === 'starting' || job.status === 'running')
      this.end(job, 'failed', TIMED_OUT, 'timeout');
  }

  /**
   * Ends a starting or running job as done or failed: the token is revoked at once, the
   * create timeout stopped, the machine destroyed, the results kept for RETENTION_MS
   * (within the byte budget) and the slot freed once no Fly call is in flight. A verify
   * job's end, with its check when done, goes to onVerifyEnd.
   */
  private end(
    job: Job,
    status: 'done' | 'failed',
    message: string | undefined,
    reason: string | undefined,
    reports?: JobReports,
    check?: VerifyResult,
  ): void {
    job.token = undefined;
    job.cancelTimer?.();
    job.cancelCreate?.();
    job.cancelCreate = undefined;
    this.dropPdf(job);
    if (
      reports !== undefined &&
      this.retainedBytes + reportBytes(reports) > this.maxRetainedBytes
    ) {
      status = 'failed';
      message = TOO_LARGE_TO_KEEP;
      reason = 'too_large_to_keep';
      reports = undefined;
    }
    job.status = status;
    job.message = message;
    if (reports !== undefined) {
      job.reports = reports;
      this.retainedBytes += reportBytes(reports);
    }
    const ms = job.startedAt === undefined ? undefined : this.now() - job.startedAt;
    if (status === 'done') this.jobEvent(job, 'done', { ms });
    else this.jobEvent(job, 'failed', { reason, ms });
    const machine = job.machineId;
    job.machineId = undefined;
    if (machine !== undefined) this.track(job, this.destroy(job.id, machine));
    job.cancelTimer = this.schedule(() => this.expire(job), RETENTION_MS);
    this.release(job);
    if (job.kind === 'verify') this.onVerifyEnd(job.id, status === 'done' ? check : undefined);
  }

  /** Drops what an ended job held; the job reads expired. */
  private expire(job: Job): void {
    if (job.status !== 'done' && job.status !== 'failed') return;
    job.status = 'expired';
    this.drop(job);
  }

  /** Drops the input and results (their bytes leave the budget), and forgets the job RECORD_MS later. */
  private drop(job: Job): void {
    this.dropPdf(job);
    this.dropReports(job);
    job.target = undefined;
    job.message = undefined;
    job.cancelTimer = this.schedule(() => this.jobs.delete(job.id), RECORD_MS);
  }

  /**
   * Cancels a job in any state but expired: its machine is destroyed and what it held
   * dropped. ip is the canceller's network for the log (logPrefix).
   */
  cancel(id: string, ip?: string): JobView | undefined {
    const job = JOB_ID.test(id) ? this.jobs.get(id) : undefined;
    if (job === undefined) return undefined;
    if (job.status === 'cancelled' || job.status === 'expired') return this.viewOf(job);
    // A verify job that ended already told onVerifyEnd.
    const live = job.status === 'queued' || job.status === 'starting' || job.status === 'running';
    if (job.status === 'queued') this.queue.splice(this.queue.indexOf(job), 1);
    job.token = undefined;
    job.cancelTimer?.();
    job.cancelCreate?.();
    job.cancelCreate = undefined;
    job.status = 'cancelled';
    this.jobEvent(job, 'cancelled', { ip });
    const machine = job.machineId;
    job.machineId = undefined;
    if (machine !== undefined) this.track(job, this.destroy(job.id, machine));
    this.drop(job);
    this.release(job);
    if (live && job.kind === 'verify') this.onVerifyEnd(job.id, undefined);
    return this.viewOf(job);
  }

  /** Destroys one machine; failures are logged, never thrown. */
  private async destroy(jobId: string, machine: string): Promise<void> {
    const began = this.now();
    try {
      // A 404 (already gone through auto_destroy, or the wrong app) is logged with its status.
      const { status } = await this.fly.destroy(machine);
      this.event('fly_destroy', { job: jobId, machine, status, ms: this.now() - began });
    } catch (error) {
      const status = this.flyStatus(error);
      this.event('fly_destroy', { job: jobId, machine, status, ms: this.now() - began });
    }
  }

  /** Finds the machines Fly holds for a job (by widedoor_job) and destroys them. Never throws. */
  private async destroyByJob(jobId: string): Promise<void> {
    let machines;
    try {
      machines = await this.fly.listScanMachines();
    } catch (error) {
      // The sweep destroys it later.
      this.event('fly_destroy', {
        job: jobId,
        status: this.flyStatus(error),
        reason: 'list_failed',
      });
      return;
    }
    for (const machine of machines)
      if (machine.jobId === jobId) await this.destroy(jobId, machine.id);
  }

  /**
   * The job a control request may act on: a job id, a job that is starting or running,
   * and its own token. Undefined for anything else, whatever the reason.
   */
  authorize(id: string, token: string | undefined): string | undefined {
    if (!JOB_ID.test(id)) return undefined;
    const job = this.jobs.get(id);
    if (job === undefined || (job.status !== 'starting' && job.status !== 'running'))
      return undefined;
    if (job.token === undefined || !tokenMatches(token, job.token)) return undefined;
    return job.id;
  }

  /** What an authorized job is: a scan or a verify job. Undefined unless authorized. */
  kindOf(id: string, token: string | undefined): JobKind | undefined {
    return this.authorize(id, token) === undefined ? undefined : this.jobs.get(id)?.kind;
  }

  /** An authorized job's tier. Undefined unless authorized. */
  tierOf(id: string, token: string | undefined): Tier | undefined {
    return this.authorize(id, token) === undefined ? undefined : this.jobs.get(id)?.tier;
  }

  /** The job input for the scan machine, or undefined unless authorized. */
  input(id: string, token: string | undefined): JobInput | undefined {
    const job = this.authorize(id, token) === undefined ? undefined : this.jobs.get(id);
    const target = job?.target;
    if (job === undefined || target === undefined) return undefined;
    return JobInputSchema.parse({
      jobId: job.id,
      tier: job.tier,
      target:
        target.kind === 'url'
          ? { kind: 'url', url: target.url }
          : target.kind === 'pdf'
            ? { kind: 'pdf', fileName: target.fileName }
            : { kind: 'verify', host: target.host, token: target.token },
      profile: job.profile,
    });
  }

  /** The uploaded PDF, once: it is dropped (and its bytes released) as it is handed over. */
  takePdf(id: string, token: string | undefined): Blob | undefined {
    const job = this.authorize(id, token) === undefined ? undefined : this.jobs.get(id);
    if (job?.target?.kind !== 'pdf') return undefined;
    const pdf = job.target.pdf;
    this.dropPdf(job);
    return pdf;
  }

  /**
   * Ends an authorized job with the scan machine's result: done with the API's own
   * reports (a scan), done with its check (a verify job), or failed with a message.
   * False when the request may not act on the job, or the outcome is not of its kind.
   */
  finish(
    id: string,
    token: string | undefined,
    outcome:
      | { status: 'done'; reports: JobReports }
      | { status: 'checked'; check: VerifyResult }
      | { status: 'failed'; message: string; reason: string },
  ): boolean {
    if (this.authorize(id, token) === undefined) return false;
    const job = this.jobs.get(id);
    if (job === undefined) return false;
    if (outcome.status === 'failed') this.end(job, 'failed', outcome.message, outcome.reason);
    else if ((outcome.status === 'checked') !== (job.kind === 'verify')) return false;
    else if (outcome.status === 'done')
      this.end(job, 'done', undefined, undefined, outcome.reports);
    else this.end(job, 'done', undefined, undefined, undefined, outcome.check);
    return true;
  }

  /**
   * One sweep of old scan machines; skipped while another is still going. Past
   * SWEEP_DEADLINE_MS a sweep stops counting as going, so a hung one cannot stop the
   * next. Until one sweep's list has succeeded, each sweep is a first sweep: it destroys
   * every scan machine of any age but those of jobs this API already started (a fresh API
   * holds no other job), so a list that fails at start does not leave old machines to the
   * age rule. Each sweep also counts the app's machines that carry no widedoor_role
   * (foreign) and destroys none of them. Never throws.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    const first = !this.firstSweepDone;
    const run = ++this.sweepRun;
    const finished = () => {
      // A sweep that settles after its deadline must not clear a newer sweep's flag.
      if (this.sweepRun === run) this.sweeping = false;
    };
    let failed = 0;
    let cancelDeadline: (() => void) | undefined;
    const countForeign = () =>
      this.fly.countForeignMachines().then(
        (foreign) => foreign,
        (error: unknown) => {
          this.event('fly_sweep', { status: this.flyStatus(error), reason: 'foreign_list_failed' });
          return undefined;
        },
      );
    const work = sweepScanMachines(
      this.fly,
      this.now(),
      SWEEP_MAX_AGE_MS,
      (machine, error) => {
        failed++;
        this.event('fly_destroy', { machine, status: this.flyStatus(error) });
      },
      first ? { all: true, keep: (machine) => this.jobs.has(machine.jobId) } : {},
    )
      .then(
        async (destroyed) => {
          // The list succeeded: from now on the age rule applies.
          this.firstSweepDone = true;
          const foreign = await countForeign();
          this.event('fly_sweep', { destroyed, failed, foreign, first: first ? 1 : undefined });
        },
        (error: unknown) => {
          this.event('fly_sweep', { status: this.flyStatus(error), reason: 'list_failed' });
        },
      )
      .finally(finished);
    const deadline = new Promise<void>((timeUp) => {
      cancelDeadline = this.schedule(() => {
        finished();
        this.event('fly_sweep', { timed_out: 1 });
        timeUp();
      }, SWEEP_DEADLINE_MS);
    });
    try {
      await Promise.race([work, deadline]);
    } finally {
      cancelDeadline?.();
    }
  }

  /** Sweeps now in the background and every SWEEP_EVERY_MS until stop. */
  startSweeps(): void {
    if (this.stopSweeps !== undefined) return;
    let cancel: () => void = () => undefined;
    const run = () => {
      void this.sweep();
      cancel = this.schedule(run, SWEEP_EVERY_MS);
    };
    this.stopSweeps = () => cancel();
    run();
  }

  /** Stops the periodic sweep. Jobs and their timers are left as they are. */
  stop(): void {
    this.stopSweeps?.();
    this.stopSweeps = undefined;
  }
}
