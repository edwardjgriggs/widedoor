import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { z } from 'zod';
import { PROFILE_IDS, safeText } from '@widedoor/core';
import { isHttpUrl } from '../config.js';
import { MAX_REPORT_BYTES, TIERS, TIER_NAMES, type Tier } from './limits.js';

/*
 * What the hosted API and a scan machine say to each other over the private
 * network. The agent fetches the job (GET input, and GET pdf for an upload)
 * and sends back one result (PUT result), every request with the job's bearer
 * token. Each side validates what it receives with these schemas before using
 * any of it: the API's input is still untrusted in the scan machine, and the
 * result comes from a machine that ran a hostile page.
 */

/** The control API's base URL, set in the scan machine's environment. */
export const CONTROL_URL_ENV = 'WIDEDOOR_CONTROL_URL';
/** The scan machine's job id. */
export const JOB_ID_ENV = 'WIDEDOOR_JOB_ID';
/** The job's bearer token; only the agent ever reads it. */
export const JOB_TOKEN_ENV = 'WIDEDOOR_JOB_TOKEN';
/**
 * The egress proxy's fixed port (ledger R29): the scan machine's firewall names it before
 * the proxy starts, and the scan user may reach no other port on loopback. The entry
 * script repeats it as PROXY_PORT.
 */
export const EGRESS_PORT = 18080;
/** The proxy URL the scan machine's entry script sets (ledger R4). */
export const PROXY_URL_ENV = 'WIDEDOOR_PROXY_URL';
/** The contact URL named in the user agent. */
export const CONTACT_URL_ENV = 'WIDEDOOR_CONTACT_URL';
/** The contact page when WIDEDOOR_CONTACT_URL is not set. */
export const DEFAULT_CONTACT_URL = 'https://widedoor.fly.dev/about-scanner';

/** The fixed answer to a job input that does not validate; it never quotes the input. */
export const INPUT_REFUSED = 'the job could not be read, so no scan was run';
/** A job that ran past its cap, as the agent and the API both say it. */
export const TIMED_OUT = 'the scan ran out of time';
/** A report over its tier's reportMaxBytes, as the agent and the API both say it. */
export const REPORT_TOO_LARGE = 'the report was too large';

/**
 * Longest a result PUT may take on the API, its wait for the result gate included; past it
 * the job fails. The agent waits longer than this for its answer.
 */
export const RESULT_DEADLINE_MS = 120_000;

/**
 * Largest result body for a job of a tier: one report of reportMaxBytes as a JSON string
 * (its escaping can double it) and the rest of the object. The agent checks its body against
 * it before sending, and the API reads no more.
 */
export const resultBodyMax = (tier: Tier): number => 2 * TIERS[tier].reportMaxBytes + 64 * 1024;

/** A job id: 32 lowercase hex characters. */
export const JOB_ID = /^[0-9a-f]{32}$/;

/** A verification token: 32 lowercase hex characters (ledger R45), safe in DNS and in HTML. */
export const VERIFY_TOKEN = /^[0-9a-f]{32}$/;

/** A job token as the scan machine accepts it: 1 to 512 visible ASCII characters. */
export const isToken = (value: string): boolean => /^[\x21-\x7e]{1,512}$/.test(value);

/** The routes of the API's private listener, Hono style. */
export const JOB_ROUTES = {
  input: '/internal/jobs/:id/input',
  pdf: '/internal/jobs/:id/pdf',
  result: '/internal/jobs/:id/result',
} as const;

/** The URL of one job route on the control address. Throws for an id that is not JOB_ID. */
export function jobUrl(control: string, id: string, route: keyof typeof JOB_ROUTES): string {
  if (!JOB_ID.test(id)) throw new Error('not a job id');
  return `${control.replace(/\/+$/, '')}${JOB_ROUTES[route].replace(':id', id)}`;
}

/** Longest target URL taken. */
export const MAX_TARGET_URL_LENGTH = 2_048;
/** Longest uploaded PDF name, in characters, ".pdf" included. */
export const MAX_PDF_NAME_LENGTH = 200;
/** Longest job error, in characters. */
export const JOB_ERROR_MAX = 300;

/** Characters no file name may hold on any platform the name might reach. */
const NAME_FORBIDDEN = /[\\/:*?"<>|]/;

/**
 * An uploaded PDF's name as the scan stages it: one file name ending in .pdf,
 * no separators or characters Windows refuses, nothing safeText would escape.
 */
export const isPdfFileName = (name: string): boolean =>
  Array.from(name).length <= MAX_PDF_NAME_LENGTH &&
  /\.pdf$/i.test(name) &&
  name.length > '.pdf'.length &&
  !NAME_FORBIDDEN.test(name) &&
  safeText(name, MAX_PDF_NAME_LENGTH) === name;

/** An http or https URL with no user name or password (the hosted site never takes credentials). */
const targetUrl = z
  .string()
  .max(MAX_TARGET_URL_LENGTH)
  .refine(isHttpUrl, 'expected an http or https URL')
  .refine((value) => {
    const url = new URL(value);
    return url.username === '' && url.password === '';
  }, 'the URL must not hold a user name or password');

/** Longest host name taken for a verification, in characters (DNS allows 253). */
export const MAX_VERIFY_HOST_LENGTH = 253;

/**
 * A host as a verification names it (Task 11): lower case, one trailing dot dropped, an
 * IDN in its ASCII form. Undefined for anything but a bare host name: an empty value, a
 * port, a path, user info, an IP literal (in any form the URL parser reads as one), or
 * anything the parser would rewrite. The egress policy is judged separately.
 */
export function normalizeVerifyHost(value: string): string | undefined {
  const lowered = value.toLowerCase().replace(/\.$/, '');
  if (lowered === '' || /[\s:/\\@?#%[\]]/.test(lowered)) return undefined;
  const ascii = domainToASCII(lowered);
  if (ascii === '' || ascii.length > MAX_VERIFY_HOST_LENGTH || isIP(ascii) !== 0) return undefined;
  // Only one trailing dot is dropped above: `a.org..` or `a..org` is no host.
  if (ascii.split('.').includes('')) return undefined;
  let url: URL;
  try {
    url = new URL(`https://${ascii}/`);
  } catch {
    return undefined;
  }
  // 0x7f.1 or 2130706433 parse as IPv4 and come back rewritten.
  return url.hostname === ascii ? ascii : undefined;
}

/** Whether a host is already in the form normalizeVerifyHost gives. */
export const isVerifyHost = (value: string): boolean => normalizeVerifyHost(value) === value;

export const JobInputSchema = z.strictObject({
  jobId: z.string().regex(JOB_ID),
  tier: z.enum(TIER_NAMES),
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('url'), url: targetUrl }),
    z.strictObject({
      kind: z.literal('pdf'),
      fileName: z.string().refine(isPdfFileName, 'not a usable PDF file name'),
    }),
    // A domain verification (Task 11): two fixed fetches on the host, no scan.
    z.strictObject({
      kind: z.literal('verify'),
      host: z.string().refine(isVerifyHost, 'not a verification host'),
      token: z.string().regex(VERIFY_TOKEN),
    }),
  ]),
  profile: z.enum(PROFILE_IDS),
});
export type JobInput = z.infer<typeof JobInputSchema>;

/** Text for a job's error: safeText, cut to JOB_ERROR_MAX characters (escapes included). */
export const jobError = (text: string): string =>
  Array.from(safeText(text, JOB_ERROR_MAX)).slice(0, JOB_ERROR_MAX).join('');

export const isJobError = (text: string): boolean =>
  text.length > 0 &&
  Array.from(text).length <= JOB_ERROR_MAX &&
  safeText(text, Number.POSITIVE_INFINITY) === text;

/** Bytes of a done result's report (UTF-8). */
export const reportBytes = (result: { reportJson?: string | undefined }): number =>
  Buffer.byteLength(result.reportJson ?? '');

/**
 * A scan job's result. A done result carries the JSON report (at most MAX_REPORT_BYTES;
 * the job's tier may allow less) and no error; a failed one carries only its error, and
 * is how any job, a verification included, reports that it could not run. There is no
 * HTML report: the API renders its own from the JSON (ledger R37).
 */
export const ScanResultSchema = z
  .strictObject({
    status: z.enum(['done', 'failed']),
    reportJson: z.string().optional(),
    error: z.string().refine(isJobError, 'not a job error').optional(),
  })
  .refine(
    (r) =>
      r.status === 'done'
        ? r.reportJson !== undefined && r.error === undefined && reportBytes(r) <= MAX_REPORT_BYTES
        : r.error !== undefined && r.reportJson === undefined,
    'a done result has a report and no error; a failed one has only an error',
  );
export type ScanResult = z.infer<typeof ScanResultSchema>;

/** How a verification was tried: the API checks DNS TXT, a scan machine the two HTTP methods. */
export const VERIFY_METHODS = ['dns_txt', 'well_known', 'meta_tag'] as const;
export type VerifyMethod = (typeof VERIFY_METHODS)[number];

/** One method's outcome; the reason is a fixed phrase of Widedoor's, never fetched content. */
export const TriedSchema = z.strictObject({
  method: z.enum(VERIFY_METHODS),
  ok: z.boolean(),
  reason: z.string().refine(isJobError, 'not a job error').optional(),
});
export type Tried = z.infer<typeof TriedSchema>;

/**
 * A verify job's result: the HTTP methods tried, each at most once, in order. It is
 * verified exactly when one of them passed. A scan machine never reports DNS TXT.
 */
export const VerifyResultSchema = z
  .strictObject({
    status: z.enum(['verified', 'not_verified']),
    tried: z.array(TriedSchema).min(1).max(2),
  })
  .refine(
    (r) =>
      r.tried.every((t) => t.method !== 'dns_txt') &&
      new Set(r.tried.map((t) => t.method)).size === r.tried.length &&
      (r.status === 'verified') === r.tried.some((t) => t.ok),
    'a verification result tries each HTTP method at most once and is verified when one passed',
  );
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

/**
 * What a scan machine sends back: a scan result or a verification result. The two
 * shapes share no status, so a verify job cannot deliver a report and a scan job
 * cannot deliver a verification; the API refuses a result of the wrong kind.
 */
export const JobResultSchema = z.union([ScanResultSchema, VerifyResultSchema]);
export type JobResult = z.infer<typeof JobResultSchema>;

/** Whether a result is a verification's (verified or not_verified). */
export const isVerifyResult = (result: { status: string }): result is VerifyResult =>
  result.status === 'verified' || result.status === 'not_verified';

/** Largest uploaded PDF of any tier, as base64. */
const MAX_PDF_BASE64 =
  Math.ceil(Math.max(...Object.values(TIERS).map((t) => t.pdfMaxBytes)) / 3) * 4;

/** What agent-bin writes to the scan child's stdin: the validated input, and an upload's bytes. */
export const ChildJobSchema = z.strictObject({
  input: JobInputSchema,
  pdf: z.base64().max(MAX_PDF_BASE64).optional(),
});
export type ChildJob = z.infer<typeof ChildJobSchema>;
