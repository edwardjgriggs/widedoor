import { z } from 'zod';
import type { ProfileId } from '@widedoor/core/browser';
import { readReportFile, type LoadResult } from '../load.js';

/*
 * The only hosted module that calls fetch. It talks to the hosted API on its
 * own origin (the browser adds the Origin header the API checks on each POST
 * and DELETE), sends no credentials and caches nothing. A refusal becomes a
 * HostedError holding the server's short message and its Retry-After, which
 * the page shows as text only. Answers go through Zod schemas before the page
 * reads them; a report goes through load.ts like a file the user opened.
 */

export const NO_ANSWER =
  'The page could not reach the scanner. Check your connection and try again.';
export const UNREADABLE = 'The scanner sent an answer this page cannot read.';
export const SERVER_ERROR = 'The scanner hit an error. Try again later.';

/** Longest server message kept; the server's own refusals are far shorter. */
const MAX_MESSAGE = 1000;
/** Longest Retry-After taken (a day); the API never asks for more than an hour. */
const MAX_RETRY_S = 24 * 60 * 60;

/**
 * A call that did not succeed: status is the HTTP status, or 0 when no answer
 * came or it could not be read. retryAfterS is the server's Retry-After.
 */
export class HostedError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = 'HostedError';
  }
}

/** A Retry-After in seconds (the API sends whole seconds), if usable. */
function retryAfter(res: Response): number | undefined {
  const value = res.headers.get('retry-after');
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Math.min(Number(value), MAX_RETRY_S);
}

/** The error a refused call becomes: the API's `{ error }` text, or a fixed one for a 5xx. */
async function refusal(res: Response): Promise<HostedError> {
  let message = res.status >= 500 ? SERVER_ERROR : UNREADABLE;
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    if (typeof body?.error === 'string' && body.error !== '')
      message = body.error.slice(0, MAX_MESSAGE);
  } catch {
    // Not JSON: the fixed text stays.
  }
  // The scanner's own 500 says nothing useful; a 503's busy text does.
  if (res.status === 500) message = SERVER_ERROR;
  return new HostedError(res.status, message, retryAfter(res));
}

interface CallInit {
  method?: 'GET' | 'POST' | 'DELETE';
  json?: unknown;
  form?: FormData;
}

/** One call. Resolves with the response whatever its status; throws HostedError(0) when none came. */
async function call(path: string, init: CallInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  let body: string | FormData | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.form) body = init.form;
  try {
    return await fetch(path, {
      method: init.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {}),
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch {
    throw new HostedError(0, NO_ANSWER);
  }
}

/** The body of an answer, through its schema; HostedError(0) when it does not fit. */
async function parsed<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  try {
    return schema.parse(await res.json());
  } catch {
    throw new HostedError(0, UNREADABLE);
  }
}

const ID = z.string().regex(/^[0-9a-f]{32}$/);

export const SCAN_STATUSES = [
  'queued',
  'starting',
  'running',
  'done',
  'failed',
  'cancelled',
  'expired',
] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

const ScanViewSchema = z.object({
  id: ID,
  status: z.enum(SCAN_STATUSES),
  queuePosition: z.int().positive().optional(),
  message: z.string().max(MAX_MESSAGE).optional(),
});
/** A scan as GET /api/scans/:id answers it. */
export type ScanJob = z.infer<typeof ScanViewSchema>;

/** Whether a scan has ended, so polling stops. */
export const isEnded = (status: ScanStatus): boolean =>
  status === 'done' || status === 'failed' || status === 'cancelled' || status === 'expired';

/** What to scan: one URL (with a verification for the verified tier) or one PDF. */
export type ScanTarget =
  { kind: 'url'; url: string; verificationId?: string } | { kind: 'pdf'; file: File };

/** Starts a scan. Resolves with the new job (202); throws HostedError for a refusal. */
export async function startScan(target: ScanTarget, profile: ProfileId): Promise<ScanJob> {
  let res: Response;
  if (target.kind === 'url') {
    res = await call('/api/scans', {
      method: 'POST',
      json: {
        url: target.url,
        profile,
        ...(target.verificationId !== undefined ? { verificationId: target.verificationId } : {}),
      },
    });
  } else {
    const form = new FormData();
    form.append('pdf', target.file);
    form.append('profile', profile);
    res = await call('/api/scans', { method: 'POST', form });
  }
  if (res.status !== 202) throw await refusal(res);
  return parsed(res, ScanViewSchema);
}

/** A scan's state. An expired scan (410) answers its state too. */
export async function getScan(id: string): Promise<ScanJob> {
  const res = await call(`/api/scans/${encodeURIComponent(id)}`);
  if (res.status !== 200 && res.status !== 410) throw await refusal(res);
  return parsed(res, ScanViewSchema);
}

/** Cancels a scan (DELETE); resolves with its state afterwards. */
export async function cancelScan(id: string): Promise<ScanJob> {
  const res = await call(`/api/scans/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (res.status !== 200 && res.status !== 410) throw await refusal(res);
  return parsed(res, ScanViewSchema);
}

/** Where a finished scan's report downloads from (the server sends it as an attachment). */
export const reportPath = (id: string, format: 'json' | 'html'): string =>
  `/api/scans/${encodeURIComponent(id)}/report.${format}`;

/** The name load.ts gives the fetched report in its messages. */
export const REPORT_NAME = 'The report';

/**
 * A finished scan's JSON report, validated by load.ts exactly as a file the
 * user opened would be. Never the HTML report.
 */
export async function fetchReport(id: string): Promise<LoadResult> {
  let res: Response;
  try {
    res = await call(reportPath(id, 'json'));
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (res.status !== 200) return { ok: false, message: (await refusal(res)).message };
  let blob: Blob;
  try {
    blob = await res.blob();
  } catch {
    return { ok: false, message: NO_ANSWER };
  }
  return readReportFile(new File([blob], REPORT_NAME, { type: 'application/json' }));
}

export const VERIFY_METHODS = ['dns_txt', 'well_known', 'meta_tag'] as const;
export type VerifyMethod = (typeof VERIFY_METHODS)[number];

const TriedSchema = z.object({
  method: z.enum(VERIFY_METHODS),
  ok: z.boolean(),
  reason: z.string().max(MAX_MESSAGE).optional(),
});
export type Tried = z.infer<typeof TriedSchema>;

export const VERIFICATION_STATUSES = [
  'pending',
  'checking',
  'verified',
  'failed',
  'expired',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

const VerificationViewSchema = z.object({
  id: ID,
  host: z.string().min(1).max(253),
  status: z.enum(VERIFICATION_STATUSES),
  expiresAt: z.iso.datetime(),
  tried: z.array(TriedSchema).max(10).optional(),
});
/** A verification as GET /api/verifications/:id answers it: never the token. */
export type VerificationView = z.infer<typeof VerificationViewSchema>;

const MethodsSchema = z.object({
  dnsTxt: z.object({ name: z.string().max(MAX_MESSAGE), value: z.string().max(MAX_MESSAGE) }),
  metaTag: z.string().max(MAX_MESSAGE),
  wellKnown: z.object({ url: z.string().max(MAX_MESSAGE), body: z.string().max(MAX_MESSAGE) }),
});
export type Methods = z.infer<typeof MethodsSchema>;

const CreatedSchema = z.object({
  id: ID,
  host: z.string().min(1).max(253),
  token: z.string().regex(/^[0-9a-f]{32}$/),
  expiresAt: z.iso.datetime(),
  methods: MethodsSchema,
});
/** A new verification: the only answer that holds the token and the methods. */
export type Created = z.infer<typeof CreatedSchema>;

/** Asks for a verification of host (201). */
export async function createVerification(host: string): Promise<Created> {
  const res = await call('/api/verifications', { method: 'POST', json: { host } });
  if (res.status !== 201) throw await refusal(res);
  return parsed(res, CreatedSchema);
}

/** A verification's state. An expired one (410) answers its state too. */
export async function getVerification(id: string): Promise<VerificationView> {
  const res = await call(`/api/verifications/${encodeURIComponent(id)}`);
  if (res.status !== 200 && res.status !== 410) throw await refusal(res);
  return parsed(res, VerificationViewSchema);
}

const CheckSchema = z.object({ status: z.enum(VERIFICATION_STATUSES) });

/**
 * Asks the API to check a verification: 'verified' (200) when it passed at
 * once, 'checking' (202) while a machine checks it, 'expired' (410).
 */
export async function checkVerification(id: string): Promise<'verified' | 'checking' | 'expired'> {
  const res = await call(`/api/verifications/${encodeURIComponent(id)}/check`, {
    method: 'POST',
  });
  if (res.status === 410) return 'expired';
  if (res.status !== 200 && res.status !== 202) throw await refusal(res);
  const { status } = await parsed(res, CheckSchema);
  if (res.status === 200 && status === 'verified') return 'verified';
  if (res.status === 202 && status === 'checking') return 'checking';
  throw new HostedError(0, UNREADABLE);
}
