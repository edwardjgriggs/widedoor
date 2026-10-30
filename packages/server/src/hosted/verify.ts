import { randomBytes } from 'node:crypto';
import type { TxtLookup } from './dns.js';
import { VERIFY_COOLDOWN_MS, type Tier } from './limits.js';
import type { Tried, VerifyResult } from './protocol.js';

/*
 * Domain verification, the API's side (Task 11, plan ruling 6, ledger R40 to
 * R45). A site owner asks for a verification of one exact host and gets a
 * token to publish by one of three methods. The API checks DNS TXT itself (DNS
 * only, never HTTP: R36); the well-known file and the meta tag are checked by a
 * verify job on a throwaway scan machine, through its egress proxy and
 * firewall (R40). A verification is good for 24 hours from issue, for any
 * number of scans of that host (no subdomains, www is separate). Records live
 * in memory: at most MAX_VERIFICATIONS, the oldest one not verified dropped
 * first (a verified one only when every record is verified), and an expired
 * one is forgotten RECORD_MS after its expiry. A verification whose check
 * failed may start another machine check only VERIFY_COOLDOWN_MS later. Tokens are not secrets
 * (they end up in public DNS and HTML); a verification id is what grants the
 * verified tier, and it is given only to its creator.
 */

/** How long a verification is good for, from issue. */
export const VERIFY_VALID_MS = 24 * 60 * 60_000;
/** How long an expired verification still answers (410) before it is forgotten. */
export const VERIFY_RECORD_MS = 24 * 60 * 60_000;
/** Verifications held at most; past it the oldest is dropped. */
export const MAX_VERIFICATIONS = 10_000;
/** Verification requests (create and check together) per client network (/64, /32) per hour. */
export const VERIFIES_PER_HOUR = 30;
/** The same, per wider network (/48, /24). */
export const VERIFIES_PER_HOUR_WIDE = 90;

/** A verification id: 32 lowercase hex characters, a separate value from its token (R45). */
export const VERIFICATION_ID = /^[0-9a-f]{32}$/;
/** The DNS name the TXT record goes on is this, then the host. */
export const TXT_NAME_PREFIX = '_widedoor-challenge.';
/** The TXT record's value is this, then the token. */
export const TXT_VALUE_PREFIX = 'widedoor-verification=';

export const NOT_FOUND = 'That verification was not found.';
export const NOT_VERIFIED = 'That domain has not been verified yet.';
export const EXPIRED = 'That verification has expired.';
export const OTHER_HOST = 'That verification is for a different host.';

export const NO_TXT = 'no TXT record found';
export const TXT_MISMATCH = 'no TXT record matched the token';
export const DNS_FAILED = 'the DNS lookup failed';
/** A verify job that ended without a result (it failed, ran out of time or never started). */
export const CHECK_UNFINISHED = 'the check did not finish';

export const VERIFICATION_STATUSES = [
  'pending',
  'checking',
  'verified',
  'failed',
  'expired',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** How to publish a token, exactly as the plan states it. */
export interface VerificationMethods {
  dnsTxt: { name: string; value: string };
  metaTag: string;
  wellKnown: { url: string; body: string };
}

export function verificationMethods(host: string, token: string): VerificationMethods {
  return {
    dnsTxt: { name: `${TXT_NAME_PREFIX}${host}`, value: `${TXT_VALUE_PREFIX}${token}` },
    metaTag: `<meta name="widedoor-verification" content="${token}">`,
    wellKnown: { url: `https://${host}/.well-known/widedoor.txt`, body: token },
  };
}

/**
 * The DNS TXT method: a record of the challenge name, its chunks joined, equal to the
 * expected value exactly. No record and no such name read the same; any other DNS
 * failure reads as a failed lookup. Never throws.
 */
export async function checkDnsTxt(lookup: TxtLookup, host: string, token: string): Promise<Tried> {
  let records: string[][];
  try {
    records = await lookup(`${TXT_NAME_PREFIX}${host}`);
  } catch {
    return { method: 'dns_txt', ok: false, reason: DNS_FAILED };
  }
  if (records.some((chunks) => chunks.join('') === `${TXT_VALUE_PREFIX}${token}`))
    return { method: 'dns_txt', ok: true };
  return { method: 'dns_txt', ok: false, reason: records.length === 0 ? NO_TXT : TXT_MISMATCH };
}

/** What POST /api/verifications answers (with methods); the only answer that holds the token. */
export interface VerificationCreated {
  id: string;
  host: string;
  token: string;
  expiresAt: string;
}

/** What GET /api/verifications/:id answers: never the token. */
export interface VerificationView {
  id: string;
  host: string;
  status: VerificationStatus;
  expiresAt: string;
  tried?: Tried[];
}

interface Verification {
  readonly id: string;
  readonly host: string;
  readonly token: string;
  readonly expiresAt: number;
  /** Expired is never stored: it is read from the clock. */
  status: Exclude<VerificationStatus, 'expired'>;
  tried: Tried[] | undefined;
  /** The verify job of the check in flight, if it got that far. */
  jobId: string | undefined;
  /** The network of the client whose check is in flight, for the log (logPrefix). */
  ip: string | undefined;
  /** When its last check ended failed. */
  failedAt: number | undefined;
}

/** A record and its stored state before a check began, to put back when the check could not start. */
export interface CheckStart {
  status: 'pending' | 'failed';
  tried: Tried[] | undefined;
}

export class Verifications {
  private readonly now: () => number;
  private readonly max: number;
  /** By id, oldest first (every record is valid for the same time, so also by expiry). */
  private readonly records = new Map<string, Verification>();
  /** Verification ids by the id of their check's verify job. */
  private readonly checks = new Map<string, string>();

  constructor(options: { now?: () => number; max?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.max = options.max ?? MAX_VERIFICATIONS;
  }

  /** Records held (tests). */
  get size(): number {
    return this.records.size;
  }

  /** Forgets every record RECORD_MS past its expiry. */
  private prune(): void {
    const now = this.now();
    for (const record of this.records.values()) {
      if (record.expiresAt + VERIFY_RECORD_MS > now) break;
      this.forget(record);
    }
  }

  private forget(record: Verification): void {
    this.records.delete(record.id);
    if (record.jobId !== undefined) this.checks.delete(record.jobId);
  }

  private find(id: string): Verification | undefined {
    if (!VERIFICATION_ID.test(id)) return undefined;
    this.prune();
    return this.records.get(id);
  }

  private statusOf(record: Verification): VerificationStatus {
    return this.now() >= record.expiresAt ? 'expired' : record.status;
  }

  /** A new verification of host (already normalized and judged by the caller). */
  create(host: string): VerificationCreated {
    this.prune();
    while (this.records.size >= this.max) {
      // The oldest record that is not verified goes first: a flood of new requests must
      // not push out a site owner's working verification.
      let victim: Verification | undefined;
      for (const record of this.records.values())
        if (this.statusOf(record) !== 'verified') {
          victim = record;
          break;
        }
      victim ??= this.records.values().next().value;
      if (victim === undefined) break;
      this.forget(victim);
    }
    const record: Verification = {
      id: randomBytes(16).toString('hex'),
      host,
      token: randomBytes(16).toString('hex'),
      expiresAt: this.now() + VERIFY_VALID_MS,
      status: 'pending',
      tried: undefined,
      jobId: undefined,
      ip: undefined,
      failedAt: undefined,
    };
    this.records.set(record.id, record);
    return {
      id: record.id,
      host,
      token: record.token,
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  /** The verification's state, or undefined for an id that is unknown or forgotten. */
  view(id: string): VerificationView | undefined {
    const record = this.find(id);
    if (record === undefined) return undefined;
    return {
      id: record.id,
      host: record.host,
      status: this.statusOf(record),
      expiresAt: new Date(record.expiresAt).toISOString(),
      ...(record.tried !== undefined ? { tried: record.tried } : {}),
    };
  }

  /** What a check needs to know of a verification: its host and token, if it may be checked. */
  subject(id: string): { host: string; token: string } | undefined {
    const record = this.find(id);
    return record && { host: record.host, token: record.token };
  }

  /**
   * Starts a check: the verification reads checking, so a second check starts nothing.
   * Gives what it held before, for abandon; undefined unless it was pending or failed.
   */
  begin(id: string, ip: string | undefined): CheckStart | undefined {
    const record = this.find(id);
    if (record === undefined) return undefined;
    const status = this.statusOf(record);
    if (status !== 'pending' && status !== 'failed') return undefined;
    const before: CheckStart = { status, tried: record.tried };
    record.status = 'checking';
    record.tried = undefined;
    record.ip = ip;
    return before;
  }

  /** The DNS TXT outcome: verified when it passed, else still checking with the outcome kept. */
  dnsChecked(id: string, tried: Tried): void {
    const record = this.find(id);
    if (record?.status !== 'checking') return;
    record.tried = [tried];
    if (tried.ok) {
      record.status = 'verified';
      record.ip = undefined;
    }
  }

  /** How long until the verification may start another machine check (0 when it may now). */
  cooldownLeft(id: string): number {
    const failedAt = this.find(id)?.failedAt;
    return failedAt === undefined ? 0 : Math.max(0, failedAt + VERIFY_COOLDOWN_MS - this.now());
  }

  /** The check goes on in a verify job; its end comes through jobEnded. */
  awaitJob(id: string, jobId: string): void {
    const record = this.find(id);
    if (record?.status !== 'checking') return;
    record.jobId = jobId;
    this.checks.set(jobId, id);
  }

  /** A check that could not start a job: the verification reads as it did before it began. */
  abandon(id: string, before: CheckStart): void {
    const record = this.find(id);
    if (record?.status !== 'checking' || record.jobId !== undefined) return;
    record.status = before.status;
    record.tried = before.tried;
    record.ip = undefined;
  }

  /**
   * A verify job ended, with its result or without one (it failed, ran out of time,
   * waited too long or was cancelled). Its verification is verified when a method
   * passed, else failed, with every method's outcome. Gives the verification's id and
   * host, the checker's network and the methods the job reported, for the log;
   * undefined for a job no verification waits on.
   */
  jobEnded(
    jobId: string,
    result: VerifyResult | undefined,
  ): { id: string; host: string; ip: string | undefined; tried: Tried[] } | undefined {
    const id = this.checks.get(jobId);
    this.checks.delete(jobId);
    const record = id === undefined ? undefined : this.records.get(id);
    if (record?.jobId !== jobId || record.status !== 'checking') return undefined;
    const reported: Tried[] = result?.tried ?? [
      { method: 'well_known', ok: false, reason: CHECK_UNFINISHED },
      { method: 'meta_tag', ok: false, reason: CHECK_UNFINISHED },
    ];
    record.jobId = undefined;
    record.tried = [...(record.tried ?? []), ...reported];
    record.status = result?.status === 'verified' ? 'verified' : 'failed';
    if (record.status === 'failed') record.failedAt = this.now();
    const ip = record.ip;
    record.ip = undefined;
    return { id: record.id, host: record.host, ip, tried: result?.tried ?? [] };
  }

  /**
   * The tier a scan of host takes with verificationId: verified only for a verification
   * that exists, is verified, has not expired and names exactly that host.
   */
  tierFor(verificationId: string, host: string): Tier | { refused: string } {
    const record = this.find(verificationId);
    if (record === undefined) return { refused: NOT_FOUND };
    const status = this.statusOf(record);
    if (status === 'expired') return { refused: EXPIRED };
    if (status !== 'verified') return { refused: NOT_VERIFIED };
    if (record.host !== host) return { refused: OTHER_HOST };
    return 'verified';
  }
}
