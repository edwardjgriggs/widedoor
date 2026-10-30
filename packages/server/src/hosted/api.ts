import { createHmac, randomBytes } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { PROFILE_IDS, safeJson, type ProfileId } from '@widedoor/core';
import {
  REPORT_STYLE,
  ScanReportCheckedSchema,
  html,
  renderHtml,
  reportCsp,
  serializeJson,
  type ScanReport,
} from '@widedoor/report';
import {
  EgressRefusedError,
  PinnedResolver,
  checkTarget,
  hostedUserAgent,
} from '@widedoor/web/egress';
import { isHttpUrl } from '../config.js';
import { RequestError, hasType, readBody, readJson } from '../requests.js';
import { SECURITY_HEADERS } from '../security.js';
import { DEFAULT_PROFILE } from '../settings.js';
import type { StaticFile } from '../static-files.js';
import { caresTxtLookup, type TxtLookup } from './dns.js';
import type { FlyClient } from './fly.js';
import {
  BUSY,
  HostedJobs,
  NETWORK_RETRY_S,
  TOO_LARGE_TO_KEEP,
  TOO_SLOW,
  realScheduler,
  UNREADABLE,
  eventLine,
  type JobKind,
  type JobReports,
  type JobView,
  type Refusal,
  type Scheduler,
} from './jobs.js';
import {
  DOWNLOAD_CHUNK_BYTES,
  DOWNLOAD_RETRY_S,
  DOWNLOADS_IN_FLIGHT,
  DOWNLOADS_PER_JOB,
  DOWNLOADS_PER_NETWORK,
  DOWNLOADS_PER_WIDE,
  downloadDeadlineFor,
  OPEN_TIER,
  TIERS,
  type Tier,
} from './limits.js';
import {
  DEFAULT_CONTACT_URL,
  JOB_ROUTES,
  JobResultSchema,
  MAX_TARGET_URL_LENGTH,
  REPORT_TOO_LARGE,
  RESULT_DEADLINE_MS,
  isPdfFileName,
  isVerifyResult,
  normalizeVerifyHost,
  reportBytes,
  resultBodyMax,
  type VerifyResult,
} from './protocol.js';
import { Gate } from './gate.js';
import { RateLimiter, isClientIp, logPrefix, rateKey, takeAll, wideKey } from './rate-limit.js';
import {
  VERIFIES_PER_HOUR,
  VERIFIES_PER_HOUR_WIDE,
  Verifications,
  checkDnsTxt,
  verificationMethods,
} from './verify.js';

/*
 * The hosted API (ledger R10 to R12 and R35 to R39). Two Hono apps:
 *
 * The public app takes scan requests from anyone: a URL (JSON) or one PDF
 * (multipart). Before any machine starts it checks the Origin, the client's
 * network's live jobs and the scanner's room (before any rate token is charged
 * or body byte read), the client's rate limit (Fly-Client-IP only), the body,
 * that the target is not Widedoor
 * itself, and the egress policy with a DNS resolve through a fresh pinned
 * resolver. It makes no HTTP request for a target (R36): the scan machine's
 * agent does the robots check. The client never picks the tier; resolveTier
 * does (R38), from a domain verification (verify.ts). It serves each job's
 * state, its reports as attachments, a cancel, domain verification (create,
 * state and check), the about-scanner page and a health check. A check asks
 * DNS TXT itself and otherwise queues a verify job (R40, R41). It also serves
 * the hosted page (R46): hosted.html at /, the built assets and the license
 * notice, and nothing else of the build (never the local viewer's index.html).
 *
 * The control app is for scan machines only, on the private network. Its
 * three routes take the job's bearer token, and every failure (a bad id, an
 * unknown job, a wrong or revoked token) is the same empty 404; only the job's
 * own token holder hears 409, for a result sent while another of its PUTs is
 * still being read. A result carries no HTML (R37): the API validates reportJson
 * against the job's tier cap and renders both reports itself.
 *
 * Every response carries SECURITY_HEADERS; the report HTML replaces the CSP
 * with a sandboxing one.
 */

/** POST /api/scans per client network (IPv4 /32, IPv6 /64) per hour. */
export const SCANS_PER_HOUR = 10;
/** POST /api/scans per wider client network (IPv4 /24, IPv6 /48) per hour. */
export const SCANS_PER_HOUR_WIDE = 30;
/** Upload bodies read at once (and one per rate key). */
export const MAX_UPLOADS_IN_FLIGHT = 4;
/** DNS preflights at once: a scan's checkTarget and resolve, or a verification's TXT lookup. */
export const MAX_PREFLIGHTS = 4;
/** Longest read of an upload body (2 minutes, for slow links); past it 408. */
export const UPLOAD_DEADLINE_MS = 120_000;
/** Longest read of a JSON scan request; past it 408. */
export const JSON_DEADLINE_MS = 10_000;
export { RESULT_DEADLINE_MS };
/** Multipart bytes beyond the PDF itself. */
const MULTIPART_OVERHEAD = 64 * 1024;
/** Largest upload body read; past it 413 while streaming. */
export const MAX_UPLOAD_BODY = OPEN_TIER.pdfMaxBytes + MULTIPART_OVERHEAD;
/** Largest result body read from a verify job's machine: a verification is a few hundred bytes. */
export const MAX_VERIFY_RESULT_BYTES = 64 * 1024;
/** Longest verification id taken (a valid one is 32 characters). */
const MAX_VERIFICATION_ID = 256;
/** Longest host taken in a verification request, before IDN conversion. */
const MAX_VERIFY_HOST_INPUT = 1_024;
/** not_found lines logged per client network (logPrefix) per minute; past it they are counted. */
export const NOT_FOUND_LINES_PER_MINUTE = 20;
/** Client networks the not_found cap holds at once; past it the oldest is reported and dropped. */
export const MAX_NOT_FOUND_KEYS = 10_000;
/** control_refused lines logged per control route per minute; past it they are counted. */
export const CONTROL_REFUSED_LINES_PER_MINUTE = 20;
const MINUTE_MS = 60_000;
/** The name an upload gets when its own is not usable. */
export const DEFAULT_PDF_NAME = 'upload.pdf';

export const SELF_SCAN = 'Widedoor does not scan itself.';
export const BAD_HOST =
  'Give a host name only, such as example.org: no scheme, port, path, user name or IP address.';
const SERVER_ERROR = 'Server error.';
const FORBIDDEN = 'Forbidden: the request did not come from the Widedoor site.';
/** A check that needs a scan machine, refused by the scan buckets. */
export const MACHINE_CHECK_RATE =
  'Too many checks that need a scan machine from your network. Try again later.';

/** The hosted page's file in the UI build, served at /. */
export const HOSTED_PAGE = '/hosted.html';
/** The UI build's third-party license notice, served at its own path. */
export const LICENSES_PATH = '/THIRD-PARTY-LICENSES.txt';
/** Where /about-scanner sends security problems and anything private: SECURITY.md on GitHub. */
export const SECURITY_POLICY_URL = 'https://github.com/edwardjgriggs/widedoor/security/policy';
/** Built assets have hashed names, so a browser may keep them. */
export const ASSET_CACHE = 'public, max-age=31536000, immutable';

/**
 * The built assets a page names: its scripts, module preloads and style sheets under
 * /assets/. Read from hosted.html at start, so only the hosted page's own files are served.
 * It matches the tags Vite writes today: double-quoted src and href on script and link
 * tags. An asset the page reaches some other way (a lazy chunk imported at run time, or a
 * file only a style sheet names, such as a font) would get 404; the hosted browser test's
 * console-error check would catch that before it shipped.
 */
export function hostedAssets(page: string): string[] {
  const found: string[] = [];
  for (const m of page.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)="(\/assets\/[^"?#]+)"/g))
    if (m[1] !== undefined) found.push(m[1]);
  return found;
}

/** The CSP of a downloaded HTML report: sandboxed, plus renderHtml's own (no images are embedded). */
export const REPORT_HTML_CSP = `sandbox; ${reportCsp(REPORT_STYLE)}`;

/** POST /api/scans as JSON. */
export const HostedScanSchema = z.strictObject({
  url: z.string().max(MAX_TARGET_URL_LENGTH).refine(isHttpUrl, 'expected an http or https URL'),
  profile: z.enum(PROFILE_IDS).optional(),
  verificationId: z.string().min(1).max(MAX_VERIFICATION_ID).optional(),
});

/** POST /api/verifications. */
export const VerificationRequestSchema = z.strictObject({
  host: z.string().min(1).max(MAX_VERIFY_HOST_INPUT),
});

/**
 * Picks a URL scan's tier, or refuses it with a message for the client (400). The
 * default: open with no verificationId, verified for a verification of the URL's host.
 */
export type ResolveTier = (
  target: URL,
  verificationId: string | undefined,
) => Promise<Tier | { refused: string }>;

export interface HostedApiOptions {
  fly: FlyClient;
  /** The scan image ref. */
  image: string;
  /** The control listener's URL as scan machines reach it. */
  controlUrl: string;
  /** WIDEDOOR_PUBLIC_ORIGIN: POST and DELETE must carry it as Origin, and its host is never scanned. */
  publicOrigin: string;
  /**
   * An https URL, named on /about-scanner and passed to every scan machine for its user
   * agent. Default DEFAULT_CONTACT_URL.
   */
  contactUrl?: string;
  /** The Fly region scan machines are created in (the API's FLY_REGION). Default: Fly picks. */
  region?: string;
  resolveTier?: ResolveTier;
  /** A fresh resolver for each request (tests give one over a fake lookup). */
  resolver?: () => PinnedResolver;
  /** Domain verification's TXT lookup (tests give a fake). Default caresTxtLookup(). */
  txtLookup?: TxtLookup;
  /**
   * The UI build (loadStaticFiles, plus LICENSES_PATH), read once at start. Without it
   * the page and its files answer 404.
   */
  staticFiles?: ReadonlyMap<string, StaticFile>;
  /** Tests only: a request with no Fly-Client-IP is keyed as `test` instead of refused. */
  trustMissingClientIp?: boolean;
  now?: () => number;
  /** Upload bodies read at once; one more is refused (503) unread. Default MAX_UPLOADS_IN_FLIGHT. */
  maxUploadsInFlight?: number;
  /**
   * DNS preflights (scan resolves and verification TXT lookups) at once; one more is
   * refused (503). Default MAX_PREFLIGHTS.
   */
  maxPreflights?: number;
  /** Body read deadlines. Defaults UPLOAD_DEADLINE_MS, JSON_DEADLINE_MS and RESULT_DEADLINE_MS. */
  uploadDeadlineMs?: number;
  jsonDeadlineMs?: number;
  resultDeadlineMs?: number;
  /** Byte budget for queued PDFs and kept reports. Default MAX_RETAINED_BYTES (jobs.ts). */
  maxRetainedBytes?: number;
  /** Longest wait in the queue. Default QUEUE_WAIT_MS (jobs.ts). */
  queueWaitMs?: number;
  /** Client networks the not_found cap holds at once. Default MAX_NOT_FOUND_KEYS. */
  maxNotFoundKeys?: number;
  schedule?: Scheduler;
  log?: (line: string) => void;
}

export interface HostedApi {
  publicApp: Hono;
  controlApp: Hono;
  jobs: HostedJobs;
  verifications: Verifications;
  /** Starts the background sweep of old scan machines (now, then every 10 minutes). */
  start(): void;
  /** Stops the sweeps and logs the counts of capped log lines whose minute is still open. */
  stop(): void;
  /** Report downloads being sent now (tests). */
  inFlightDownloads(): number;
}

/**
 * Sets SECURITY_HEADERS on a response's headers. A CSP the handler set stays, and so
 * does ASSET_CACHE (a built asset's); any other cache-control becomes no-store.
 */
export function withSecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (name === 'content-security-policy' && headers.has(name)) continue;
    if (name === 'cache-control' && headers.get(name) === ASSET_CACHE) continue;
    headers.set(name, value);
  }
}

const secure: MiddlewareHandler = async (c, next) => {
  await next();
  withSecurityHeaders(c.res.headers);
};

type Status = 200 | 201 | 202 | 400 | 403 | 404 | 408 | 409 | 410 | 413 | 415 | 429 | 500 | 503;

const json = (value: unknown, status: Status = 200, headers: Record<string, string> = {}) =>
  new Response(safeJson(value, 0), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

const problem = (error: string, status: Status, headers?: Record<string, string>) =>
  json({ error }, status, headers);

/** The refusal reason of a body read's RequestError. */
const bodyReason = (status: number) =>
  status === 413 ? 'size' : status === 415 ? 'type' : status === 408 ? 'timeout' : 'schema';

/** An error's class name for the log, never its message (it may quote a request). */
const errName = (error: unknown) =>
  (error instanceof Error ? error.constructor.name : typeof error) || 'Error';

/** The client's network for the log (logPrefix), when Fly-Client-IP holds an IP. */
const clientNet = (c: Context) => {
  const value = c.req.header('fly-client-ip');
  return value !== undefined && isClientIp(value) ? logPrefix(value) : undefined;
};

/** A host as checkTarget judges it: no brackets, lower case, no trailing dot. */
const bareHost = (url: URL) =>
  url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');

/** The about-scanner page: plain HTML, every value escaped. */
function aboutPage(contactUrl: string): string {
  const agent = hostedUserAgent(contactUrl);
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>About the Widedoor scanner</title>
      </head>
      <body>
        <main>
          <h1>About the Widedoor scanner</h1>
          <p>
            Widedoor is an open source accessibility checker for websites and PDFs (Section 508 and
            WCAG 2.1 AA). Its hosted scanner visits a site only when someone asks it to check a
            page: the page itself and a few pages linked from it on the same site.
          </p>
          <h2>User agent</h2>
          <p>The scanner identifies itself as:</p>
          <pre>${agent}</pre>
          <h2>Opting out</h2>
          <p>The scanner honors robots.txt. To keep it off your site, add:</p>
          <pre>
User-agent: Widedoor
Disallow: /</pre>
          <h2>Domain verification</h2>
          <p>
            When a site owner asks Widedoor to verify their site, it fetches two fixed addresses on
            that host, /.well-known/widedoor.txt and the home page, without consulting robots.txt,
            using the same user agent.
          </p>
          <p>
            Verification tokens are not secrets: they are meant to be published in DNS or on the
            site, and a token alone lets no one scan anything.
          </p>
          <h2>Contact</h2>
          <p><a href="${contactUrl}">${contactUrl}</a></p>
          <p>
            That contact may be public. Report a security problem, or anything private, through the
            repository's private vulnerability reporting instead:
            <a href="${SECURITY_POLICY_URL}">${SECURITY_POLICY_URL}</a>.
          </p>
        </main>
      </body>
    </html> `.toString();
}

/**
 * A log cap (CWE-779): perMinute lines per key in a minute that starts at the key's first
 * line; the rest are only counted. Windows are held in the order they opened, so the ones
 * that are over sit at the front: close() drops them, each reported to onCount when it
 * counted any. Past maxKeys windows the oldest is reported and dropped early.
 */
class LineCap {
  private readonly windows = new Map<string, { start: number; lines: number; dropped: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly maxKeys: number,
    private readonly now: () => number,
    private readonly onCount: (key: string, count: number) => void,
  ) {}

  /** Counts a line for key: whether it may be logged. */
  take(key: string): boolean {
    let window = this.windows.get(key);
    if (window === undefined) {
      window = { start: this.now(), lines: 0, dropped: 0 };
      this.windows.set(key, window);
      for (const [oldest, held] of this.windows) {
        if (this.windows.size <= this.maxKeys) break;
        this.drop(oldest, held.dropped);
      }
    }
    if (window.lines < this.perMinute) {
      window.lines++;
      return true;
    }
    window.dropped++;
    return false;
  }

  /** Drops the windows whose minute is over. */
  close(): void {
    const t = this.now();
    for (const [key, window] of this.windows) {
      if (t - window.start < MINUTE_MS) break;
      this.drop(key, window.dropped);
    }
  }

  /** Drops every window, its minute over or not (at stop). */
  flush(): void {
    for (const [key, window] of this.windows) this.drop(key, window.dropped);
  }

  private drop(key: string, dropped: number): void {
    this.windows.delete(key);
    if (dropped > 0) this.onCount(key, dropped);
  }
}

export function createHostedApi(options: HostedApiOptions): HostedApi {
  const origin = new URL(options.publicOrigin);
  const publicOrigin = origin.origin;
  const selfHost = bareHost(origin);
  const contactUrl = options.contactUrl ?? DEFAULT_CONTACT_URL;
  // Every scan machine gets it too, and fly.ts takes only an https URL.
  if (!isHttpUrl(contactUrl) || new URL(contactUrl).protocol !== 'https:')
    throw new Error('the contact URL must be an https URL');
  const resolver = options.resolver ?? (() => new PinnedResolver());
  const txtLookup = options.txtLookup ?? caresTxtLookup();
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const scanLimiters = [
    new RateLimiter({ perHour: SCANS_PER_HOUR, now }),
    new RateLimiter({ perHour: SCANS_PER_HOUR_WIDE, keyOf: wideKey, now }),
  ];
  // Create and check share these, apart from the scans' (Task 11).
  const verifyLimiters = [
    new RateLimiter({ perHour: VERIFIES_PER_HOUR, now }),
    new RateLimiter({ perHour: VERIFIES_PER_HOUR_WIDE, keyOf: wideKey, now }),
  ];
  const verifications = new Verifications({ now });
  // Made here and never logged or configured: a vref ties a verification's log lines
  // together without the id, which grants the verified tier, ever reaching the log.
  const vrefKey = randomBytes(32);
  /** A verification's log reference: the first 12 hex of HMAC-SHA256(id). */
  const vref = (id: string) => createHmac('sha256', vrefKey).update(id).digest('hex').slice(0, 12);
  const resolveTier: ResolveTier =
    options.resolveTier ??
    ((target, verificationId) =>
      Promise.resolve(
        verificationId === undefined
          ? 'open'
          : verifications.tierFor(verificationId, bareHost(target)),
      ));
  /** A verify job ended: the verification takes its outcome, and each method is logged. */
  const onVerifyEnd = (jobId: string, result: VerifyResult | undefined) => {
    const ended = verifications.jobEnded(jobId, result);
    for (const tried of ended?.tried ?? [])
      log(
        eventLine('verify_checked', {
          method: tried.method,
          ok: String(tried.ok),
          host: ended?.host,
          ip: ended?.ip,
          vref: ended && vref(ended.id),
        }),
      );
  };
  /** Each job's open downloads, by the function that ends one (when its reports drop). */
  const openDownloads = new Map<string, Set<(why: 'dropped') => void>>();
  const jobs = new HostedJobs({
    fly: options.fly,
    image: options.image,
    controlUrl: options.controlUrl,
    contactUrl,
    ...(options.region !== undefined ? { region: options.region } : {}),
    ...(options.maxRetainedBytes !== undefined
      ? { maxRetainedBytes: options.maxRetainedBytes }
      : {}),
    ...(options.queueWaitMs !== undefined ? { queueWaitMs: options.queueWaitMs } : {}),
    onVerifyEnd,
    // A job's reports were dropped (expiry or cancel): its downloads end, so no view keeps
    // the Buffer alive outside the budget.
    onDrop: (id) => {
      for (const end of [...(openDownloads.get(id) ?? [])]) end('dropped');
    },
    now,
    ...(options.schedule ? { schedule: options.schedule } : {}),
    log,
  });
  const about = aboutPage(contactUrl);
  const maxUploads = options.maxUploadsInFlight ?? MAX_UPLOADS_IN_FLIGHT;
  const maxPreflights = options.maxPreflights ?? MAX_PREFLIGHTS;
  const uploadDeadlineMs = options.uploadDeadlineMs ?? UPLOAD_DEADLINE_MS;
  const jsonDeadlineMs = options.jsonDeadlineMs ?? JSON_DEADLINE_MS;
  let uploading = 0;
  /** Rate keys with an upload being read: one each. */
  const uploadingKeys = new Set<string>();
  let preflights = 0;

  /** Logs a refusal; reason is a fixed word (a block reason for a target). */
  const refused = (
    reason: string,
    status: Status,
    fields: { host?: string | undefined; ip?: string | undefined } = {},
  ) => log(eventLine('refused', { reason, status, host: fields.host, ip: fields.ip }));

  // 404s, per client network; requests with no client IP share one window ('').
  const notFound = new LineCap(
    NOT_FOUND_LINES_PER_MINUTE,
    options.maxNotFoundKeys ?? MAX_NOT_FOUND_KEYS,
    now,
    (net, count) =>
      log(
        eventLine('refused', {
          reason: 'not_found_suppressed',
          count,
          ip: net === '' ? undefined : net,
        }),
      ),
  );
  // Refused control requests, per route (a handful of keys).
  const controlRefused = new LineCap(CONTROL_REFUSED_LINES_PER_MINUTE, 16, now, (route, count) =>
    log(eventLine('control_refused_suppressed', { route, count })),
  );
  // Downloads ended early (deadline, cancel, dropped report), per client network.
  const downloadEnded = new LineCap(20, MAX_NOT_FOUND_KEYS, now, (net, count) =>
    log(eventLine('download_ended_suppressed', { count, ip: net === '' ? undefined : net })),
  );
  /** Reports and drops the capped windows whose minute is over: after every request of either app. */
  const closeWindows = () => {
    notFound.close();
    controlRefused.close();
    downloadEnded.close();
  };

  const isSelf = (host: string) =>
    host === selfHost || host.endsWith('.fly.dev') || host.endsWith('.internal');

  /** A view as JSON: 410 once the job expired. */
  const viewResponse = (view: JobView) => json(view, view.status === 'expired' ? 410 : 200);

  /**
   * The Origin and Fly-Client-IP rules of every public POST: the client's address (its
   * rate key) or the refusal. ip is the client's network for the log.
   */
  const admit = (c: Context, ip: string | undefined): string | Response => {
    if (c.req.header('origin') !== publicOrigin) {
      refused('origin', 403, { ip });
      return problem(FORBIDDEN, 403);
    }
    const clientIp = c.req.header('fly-client-ip');
    if (clientIp !== undefined && isClientIp(clientIp)) return clientIp;
    if (clientIp === undefined && options.trustMissingClientIp === true) return 'test';
    refused('client-ip', 400);
    return problem('The request did not come through the Widedoor site.', 400);
  };

  /** A 429 for a rate refusal. */
  const tooMany = (what: string, retryAfterS: number) =>
    problem(`Too many ${what} from your network. Try again later.`, 429, {
      'retry-after': String(retryAfterS),
    });

  /**
   * A job the scanner would not take: 429 with Retry-After for the per-network cap
   * (busy_network), else 503 busy. Logged either way.
   */
  const notTaken = (
    room: Refusal,
    fields: { host?: string | undefined; ip?: string | undefined },
  ): Response => {
    if (room.reason === 'busy_network') {
      refused('busy_network', 429, fields);
      return problem(room.message, 429, { 'retry-after': String(NETWORK_RETRY_S) });
    }
    refused('busy', 503, fields);
    return problem(room.message, 503);
  };

  /** The client's address for the per-network cap: only a real one (never the tests' `test`). */
  const clientOf = (key: string) => (isClientIp(key) ? { client: key } : {});

  const app = new Hono();
  app.use(secure);
  // Every 404 is logged by the kind of path asked for, never the path: probes for
  // files or for report ids show up without the log holding what they tried. Capped
  // per client network (LineCap).
  app.use(async (c, next) => {
    await next();
    closeWindows();
    if (c.res.status !== 404) return;
    const ip = clientNet(c);
    if (!notFound.take(ip ?? '')) return;
    const path = new URL(c.req.url).pathname;
    const pathClass = path.startsWith('/api/')
      ? 'api'
      : path === '/' || path === LICENSES_PATH || path.startsWith('/assets/')
        ? 'static'
        : 'other';
    log(eventLine('refused', { reason: 'not_found', path_class: pathClass, ip }));
  });

  app.post('/api/scans', async (c) => {
    const ip = clientNet(c);
    const key = admit(c, ip);
    if (key instanceof Response) return key;
    const type = c.req.header('content-type') ?? null;
    const isUpload = hasType(type, ['multipart/form-data']);
    // Uploads are counted per rate key (an IPv6 /64, IPv4-mapped folded), not per address.
    const uploadKey = rateKey(key) ?? key;
    // Checked before the rate charge, so a busy refusal spends no token.
    if (isUpload && (uploading >= maxUploads || uploadingKeys.has(uploadKey))) {
      refused('busy', 503, { ip });
      return problem(BUSY, 503);
    }
    // No rate token is charged and no body byte is read for a job that would not be
    // taken: the client's networks' live jobs and the scanner's capacity come first. An
    // upload is judged at the largest PDF it may hold.
    const room = jobs.canAccept(isUpload ? OPEN_TIER.pdfMaxBytes : 0, 'scan', clientOf(key).client);
    if (!room.ok) return notTaken(room, { ip });
    const rate = takeAll(scanLimiters, key);
    if (!rate.ok) {
      refused('rate', 429, { ip });
      return tooMany('scans', rate.retryAfterS);
    }

    let request: {
      tier: Tier;
      profile: ProfileId;
      target: Parameters<HostedJobs['submit']>[0]['target'];
      vref?: string;
    };
    let host: string | undefined;
    try {
      if (isUpload) {
        // No await since the check above, so the places are still free.
        uploading++;
        uploadingKeys.add(uploadKey);
        let upload;
        try {
          upload = await readUpload(c.req.raw, type, uploadDeadlineMs);
        } finally {
          uploading--;
          uploadingKeys.delete(uploadKey);
        }
        if (upload instanceof Response) {
          refused(bodyReason(upload.status), upload.status as Status, { ip });
          return upload;
        }
        request = {
          tier: 'open',
          profile: upload.profile,
          target: { kind: 'pdf', fileName: upload.fileName, pdf: upload.pdf },
        };
      } else {
        const body = await readJson(c.req.raw, HostedScanSchema, jsonDeadlineMs);
        const url = new URL(body.url);
        url.hash = '';
        host = bareHost(url);
        // Before any policy check or DNS lookup.
        if (url.href.length > MAX_TARGET_URL_LENGTH) {
          refused('schema', 400, { host, ip });
          return problem('The URL is too long.', 400);
        }
        if (isSelf(host)) {
          refused('self', 400, { host, ip });
          return problem(SELF_SCAN, 400);
        }
        if (preflights >= maxPreflights) {
          refused('busy', 503, { host, ip });
          return problem(BUSY, 503);
        }
        preflights++;
        try {
          checkTarget(url);
          await resolver().resolve(url.hostname);
        } catch (e) {
          const known = e instanceof EgressRefusedError;
          refused(known ? (e.blockReason ?? e.reason) : 'policy', 400, { host, ip });
          // The policy's message names the host and the reason in fixed words, never the path.
          return problem(
            known
              ? `Widedoor will not scan ${e.message.replace(/^refusing /, '')}.`
              : 'Widedoor will not scan this address.',
            400,
          );
        } finally {
          preflights--;
        }
        const tier = await resolveTier(url, body.verificationId);
        if (typeof tier !== 'string') {
          refused('verification', 400, { host, ip });
          return problem(tier.refused, 400);
        }
        request = {
          tier,
          profile: body.profile ?? DEFAULT_PROFILE,
          target: { kind: 'url', url: url.href, host },
          // Ties a verified-tier scan to its verification in the log, without the id.
          ...(tier === 'verified' && body.verificationId !== undefined
            ? { vref: vref(body.verificationId) }
            : {}),
        };
      }
    } catch (e) {
      if (e instanceof RequestError) {
        refused(bodyReason(e.status), e.status, { host, ip });
        return problem(e.message, e.status);
      }
      throw e;
    }

    const taken = jobs.submit({
      ...request,
      ...(ip !== undefined ? { ip } : {}),
      ...clientOf(key),
    });
    if (!taken.ok) return notTaken(taken, { host, ip });
    return json({ id: taken.view.id, status: taken.view.status }, 202);
  });

  app.get('/api/scans/:id', (c) => {
    const view = jobs.view(c.req.param('id'));
    return view ? viewResponse(view) : problem('Not found: no such scan.', 404);
  });

  /*
   * Report downloads (CWE-400, CWE-770): a kept report is sent as views of its Buffer,
   * DOWNLOAD_CHUNK_BYTES at a time, so no download copies it. At most DOWNLOADS_PER_JOB of
   * one job, DOWNLOADS_PER_NETWORK per client rate key, DOWNLOADS_PER_WIDE per wider network
   * and DOWNLOADS_IN_FLIGHT in all are sent at once. A place is taken before the body starts
   * and freed once, on one path, when the stream is read to the end, cancelled (the client
   * went away), past its deadline (downloadDeadlineFor its size) or its job's reports are
   * dropped (expiry or cancel). An early end is logged as download_ended, capped per network.
   * It ends the stream with an error coded ERR_STREAM_PREMATURE_CLOSE: @hono/node-server then
   * destroys the socket without a console.error (it prints one console.info line instead).
   */
  let downloading = 0;
  const downloadsOf = new Map<string, number>();
  const downloadsByNet = new Map<string, number>();
  const schedule = options.schedule ?? realScheduler;
  const bump = (counts: Map<string, number>, key: string, by: 1 | -1) => {
    const n = (counts.get(key) ?? 0) + by;
    if (n > 0) counts.set(key, n);
    else counts.delete(key);
  };
  /** The client's two download keys: its rate key and its wider network ('' without an IP). */
  const downloadKeys = (c: Context) => {
    const value = c.req.header('fly-client-ip');
    const ip = value !== undefined && isClientIp(value) ? value : undefined;
    return {
      narrow: `n:${ip === undefined ? '' : (rateKey(ip) ?? '')}`,
      wide: `w:${ip === undefined ? '' : (wideKey(ip) ?? '')}`,
    };
  };
  const sendReport = (
    id: string,
    body: Buffer<ArrayBuffer>,
    keys: { narrow: string; wide: string },
    ip: string | undefined,
    socket: { destroy(): unknown } | undefined,
  ): ReadableStream<Uint8Array> => {
    downloading++;
    bump(downloadsOf, id, 1);
    bump(downloadsByNet, keys.narrow, 1);
    bump(downloadsByNet, keys.wide, 1);
    let released = false;
    let stopDeadline: () => void = () => undefined;
    let ended: Set<(why: 'dropped') => void> | undefined;
    let endEarly: (why: 'deadline' | 'dropped') => void = () => undefined;
    /** Frees every count this download holds, once. */
    const release = () => {
      if (released) return false;
      released = true;
      stopDeadline();
      downloading--;
      bump(downloadsOf, id, -1);
      bump(downloadsByNet, keys.narrow, -1);
      bump(downloadsByNet, keys.wide, -1);
      ended?.delete(endEarly);
      if (ended?.size === 0) openDownloads.delete(id);
      return true;
    };
    const logEnded = (reason: 'deadline' | 'cancelled' | 'dropped') => {
      if (downloadEnded.take(ip ?? '')) log(eventLine('download_ended', { reason, ip }));
    };
    let offset = 0;
    return new ReadableStream<Uint8Array>(
      {
        start(controller) {
          endEarly = (why) => {
            if (!release()) return;
            logEnded(why);
            // Errored, the stream drops its queue and this source, and with them the views.
            controller.error(
              Object.assign(new Error(`the download ended early (${why})`), {
                code: 'ERR_STREAM_PREMATURE_CLOSE',
              }),
            );
            // A client that stopped reading never sees the error: the server's writer waits
            // for it to drain. Destroying the response ends the socket and drops the chunks
            // the writer still holds.
            socket?.destroy();
          };
          ended = openDownloads.get(id) ?? new Set();
          ended.add(endEarly);
          openDownloads.set(id, ended);
          stopDeadline = schedule(() => endEarly('deadline'), downloadDeadlineFor(body.length));
        },
        pull(controller) {
          if (released) return;
          const end = Math.min(offset + DOWNLOAD_CHUNK_BYTES, body.length);
          if (end > offset) controller.enqueue(body.subarray(offset, end));
          offset = end;
          if (offset >= body.length) {
            release();
            controller.close();
          }
        },
        cancel: () => {
          if (release()) logEnded('cancelled');
        },
      },
      { highWaterMark: 0 },
    );
  };

  const download = (c: Context, kind: keyof JobReports) => {
    const id = c.req.param('id') ?? '';
    const found = jobs.reports(id);
    if (found.kind === 'unknown') return problem('Not found: no such scan.', 404);
    if (found.kind === 'gone')
      return problem('The report is gone: results are kept for 1 hour.', 410);
    if (found.kind === 'not-ready')
      return problem('There is no report: the scan has not finished.', 409);
    const ip = clientNet(c);
    const keys = downloadKeys(c);
    if (
      (downloadsOf.get(id) ?? 0) >= DOWNLOADS_PER_JOB ||
      (downloadsByNet.get(keys.narrow) ?? 0) >= DOWNLOADS_PER_NETWORK ||
      (downloadsByNet.get(keys.wide) ?? 0) >= DOWNLOADS_PER_WIDE ||
      downloading >= DOWNLOADS_IN_FLIGHT
    ) {
      refused('busy_download', 429, { ip });
      return problem('Too many downloads at once. Try again shortly.', 429, {
        'retry-after': String(DOWNLOAD_RETRY_S),
      });
    }
    log(eventLine('report_download', { job: id, format: kind, ip }));
    const body = found.reports[kind];
    // Under @hono/node-server (api-bin.ts), the Node response, to end a stalled download.
    const socket = (c.env as { outgoing?: { destroy(): unknown } } | undefined)?.outgoing;
    return new Response(sendReport(id, body, keys, ip, socket), {
      headers: {
        'content-type':
          kind === 'json' ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
        'content-length': String(body.length),
        'content-disposition': `attachment; filename="widedoor-report.${kind}"`,
        'x-content-type-options': 'nosniff',
        ...(kind === 'html' ? { 'content-security-policy': REPORT_HTML_CSP } : {}),
      },
    });
  };
  app.get('/api/scans/:id/report.json', (c) => download(c, 'json'));
  app.get('/api/scans/:id/report.html', (c) => download(c, 'html'));

  app.delete('/api/scans/:id', (c) => {
    const ip = clientNet(c);
    if (c.req.header('origin') !== publicOrigin) {
      refused('origin', 403, { ip });
      return problem(FORBIDDEN, 403);
    }
    const view = jobs.cancel(c.req.param('id'), ip);
    return view ? viewResponse(view) : problem('Not found: no such scan.', 404);
  });

  app.post('/api/verifications', async (c) => {
    const ip = clientNet(c);
    const key = admit(c, ip);
    if (key instanceof Response) return key;
    const rate = takeAll(verifyLimiters, key);
    if (!rate.ok) {
      refused('rate', 429, { ip });
      return tooMany('verification requests', rate.retryAfterS);
    }
    let body;
    try {
      body = await readJson(c.req.raw, VerificationRequestSchema, jsonDeadlineMs);
    } catch (e) {
      if (e instanceof RequestError) {
        refused(bodyReason(e.status), e.status, { ip });
        return problem(e.message, e.status);
      }
      throw e;
    }
    // Never logged or echoed as given: only the normalized host is.
    const host = normalizeVerifyHost(body.host);
    if (host === undefined) {
      refused('schema', 400, { ip });
      return problem(BAD_HOST, 400);
    }
    if (isSelf(host)) {
      refused('self', 400, { host, ip });
      return problem(SELF_SCAN, 400);
    }
    try {
      checkTarget(new URL(`https://${host}/`));
    } catch (e) {
      const known = e instanceof EgressRefusedError;
      refused(known ? (e.blockReason ?? e.reason) : 'policy', 400, { host, ip });
      return problem(
        known
          ? `Widedoor will not verify ${e.message.replace(/^refusing /, '')}.`
          : 'Widedoor will not verify this host.',
        400,
      );
    }
    const created = verifications.create(host);
    log(eventLine('verify_created', { host, ip, vref: vref(created.id) }));
    return json({ ...created, methods: verificationMethods(host, created.token) }, 201);
  });

  app.get('/api/verifications/:id', (c) => {
    const view = verifications.view(c.req.param('id'));
    if (view === undefined) return problem('Not found: no such verification.', 404);
    return json(view, view.status === 'expired' ? 410 : 200);
  });

  app.post('/api/verifications/:id/check', async (c) => {
    const ip = clientNet(c);
    const key = admit(c, ip);
    if (key instanceof Response) return key;
    const id = c.req.param('id');
    const view = verifications.view(id);
    if (view === undefined) return problem('Not found: no such verification.', 404);
    // A verified or expired verification, or one being checked, answers as it stands.
    if (view.status === 'expired') return json(view, 410);
    if (view.status === 'verified') return json({ status: 'verified' }, 200);
    if (view.status === 'checking') return json({ status: 'checking' }, 202);
    const { host } = view;
    const ref = vref(id);
    // A busy refusal spends no token (as Task 10).
    if (preflights >= maxPreflights) {
      refused('busy', 503, { host, ip });
      return problem(BUSY, 503);
    }
    const rate = takeAll(verifyLimiters, key);
    if (!rate.ok) {
      refused('rate', 429, { host, ip });
      return tooMany('verification requests', rate.retryAfterS);
    }
    const token = verifications.subject(id)?.token;
    // No await since the view above, so the verification is still there and pending or failed.
    const before = verifications.begin(id, ip);
    if (token === undefined || before === undefined) return problem(SERVER_ERROR, 500);
    // DNS TXT comes first: a match needs no machine, so a full scanner never stops it (R41).
    preflights++;
    let dns;
    try {
      dns = await checkDnsTxt(txtLookup, host, token);
    } finally {
      preflights--;
    }
    log(
      eventLine('verify_checked', { method: dns.method, ok: String(dns.ok), host, ip, vref: ref }),
    );
    verifications.dnsChecked(id, dns);
    // It may have been dropped or expired during the lookup.
    const after = verifications.view(id);
    if (after === undefined) return problem('Not found: no such verification.', 404);
    if (after.status === 'expired') return json(after, 410);
    if (after.status === 'verified') return json({ status: 'verified' }, 200);

    // A miss would start a machine. Every refusal from here leaves the verification as it was.
    let taken: ReturnType<HostedJobs['submit']> | undefined;
    try {
      const cooldown = verifications.cooldownLeft(id);
      if (cooldown > 0) {
        refused('cooldown', 429, { host, ip });
        return problem('That verification was just checked. Try again shortly.', 429, {
          'retry-after': String(Math.ceil(cooldown / 1000)),
        });
      }
      // The network's live jobs and capacity first, so a refusal spends no scan token.
      const room = jobs.canAccept(0, 'verify', clientOf(key).client);
      if (!room.ok) return notTaken(room, { host, ip });
      // A machine check costs what a scan costs, in the scan buckets. From here to the
      // submit (which checks capacity again) nothing awaits.
      const scanRate = takeAll(scanLimiters, key);
      if (!scanRate.ok) {
        refused('rate', 429, { host, ip });
        return problem(MACHINE_CHECK_RATE, 429, { 'retry-after': String(scanRate.retryAfterS) });
      }
      // The job carries the host and the token, nothing else.
      taken = jobs.submit({
        tier: 'open',
        profile: DEFAULT_PROFILE,
        target: { kind: 'verify', host, token },
        vref: ref,
        ...(ip !== undefined ? { ip } : {}),
        ...clientOf(key),
      });
      if (!taken.ok) return notTaken(taken, { host, ip });
      verifications.awaitJob(id, taken.view.id);
      return json({ status: 'checking' }, 202);
    } finally {
      // Also when submit throws: the verification is never left checking with no job.
      if (taken?.ok !== true) verifications.abandon(id, before);
    }
  });

  app.get(
    '/about-scanner',
    () => new Response(about, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  );
  // The hosted page: hosted.html at /, the assets it names and the license notice. No
  // other file of the build is reachable: not the local viewer's index.html, nor its script.
  const files = options.staticFiles ?? new Map<string, StaticFile>();
  const page = files.get(HOSTED_PAGE);
  const served = new Set([
    HOSTED_PAGE,
    LICENSES_PATH,
    ...(page ? hostedAssets(new TextDecoder().decode(page.body)) : []),
  ]);
  const fileResponse = (path: string, cache?: string) => {
    const file = served.has(path) ? files.get(path) : undefined;
    if (file === undefined) return problem('Not found.', 404);
    return new Response(file.body, {
      headers: {
        'content-type': file.type,
        ...(cache !== undefined ? { 'cache-control': cache } : {}),
      },
    });
  };
  app.get('/', () => fileResponse(HOSTED_PAGE));
  app.get(LICENSES_PATH, () => fileResponse(LICENSES_PATH));
  app.get('/assets/*', (c) => fileResponse(new URL(c.req.url).pathname, ASSET_CACHE));
  app.get(
    '/healthz',
    () => new Response('ok', { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
  );
  app.notFound(() => problem('Not found.', 404));
  app.onError((error) => {
    // Never the error's text: it may quote a request.
    log(eventLine('api_error', { status: 500, err: errName(error) }));
    return problem(SERVER_ERROR, 500);
  });

  const control = createControlApp(jobs, log, options.resultDeadlineMs ?? RESULT_DEADLINE_MS, {
    refused: (route, reason) => {
      if (controlRefused.take(route)) log(eventLine('control_refused', { route, reason }));
    },
    closeWindows,
  });
  return {
    publicApp: app,
    controlApp: control,
    jobs,
    verifications,
    start: () => jobs.startSweeps(),
    inFlightDownloads: () => downloading,
    stop: () => {
      jobs.stop();
      // Counts of windows still open are reported now rather than lost.
      notFound.flush();
      controlRefused.flush();
      downloadEnded.flush();
    },
  };
}

interface Upload {
  profile: ProfileId;
  fileName: string;
  pdf: Blob;
}

/**
 * Reads a multipart upload: exactly one pdf file field and an optional profile field.
 * 413 past MAX_UPLOAD_BODY (while streaming) or a file over the open tier's cap,
 * 415 for a file that is not a PDF, 400 for anything else wrong.
 */
async function readUpload(
  req: Request,
  type: string | null,
  deadlineMs: number,
): Promise<Upload | Response> {
  const body = await readBody(req, MAX_UPLOAD_BODY, deadlineMs);
  let form: FormData;
  try {
    form = await new Response(body, { headers: { 'content-type': type ?? '' } }).formData();
  } catch {
    return problem('The upload is not valid multipart/form-data.', 400);
  }
  let file: File | undefined;
  let profile: ProfileId = DEFAULT_PROFILE;
  let files = 0;
  let profiles = 0;
  for (const [name, value] of form.entries()) {
    if (name === 'pdf' && typeof value !== 'string') {
      files++;
      file = value;
    } else if (name === 'profile' && typeof value === 'string') {
      profiles++;
      if (!(PROFILE_IDS as readonly string[]).includes(value))
        return problem(`profile must be one of ${PROFILE_IDS.join(', ')}.`, 400);
      profile = value as ProfileId;
    } else return problem('The upload takes one pdf file and an optional profile.', 400);
  }
  if (file === undefined || files !== 1 || profiles > 1)
    return problem('The upload takes one pdf file and an optional profile.', 400);
  const maxMiB = OPEN_TIER.pdfMaxBytes / (1024 * 1024);
  if (file.size > OPEN_TIER.pdfMaxBytes)
    return problem(`The PDF is over the ${maxMiB} MiB limit.`, 413);
  // Only the first bytes are copied: the part itself is the one copy the job keeps.
  const head = Buffer.from(await file.slice(0, 5).arrayBuffer()).toString('latin1');
  if (head !== '%PDF-') return problem('The file is not a PDF.', 415);
  return { profile, fileName: isPdfFileName(file.name) ? file.name : DEFAULT_PDF_NAME, pdf: file };
}

/**
 * A result body as far as the API needs it: a failure's error, a done scan's report,
 * or a verify job's check.
 */
type ReadResult =
  | { status: 'failed'; error: string | undefined }
  | { status: 'done'; report: ScanReport | undefined }
  | VerifyResult;

/**
 * Reads a result body of at most maxBytes (RequestError on a read past its cap or
 * deadline): undefined when it is not a JobResult. The bytes and the text stay inside,
 * gone once it returns.
 */
async function readJobResult(
  req: Request,
  deadlineMs: number,
  maxBytes: number,
): Promise<
  { status: 'done' | 'failed'; error?: string; reportJson?: string } | VerifyResult | undefined
> {
  const bytes = await readBody(req, maxBytes, deadlineMs);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  const parsed = JobResultSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const result = parsed.data;
  if (isVerifyResult(result)) return result;
  const { status, error, reportJson } = result;
  return {
    status,
    ...(error !== undefined ? { error } : {}),
    ...(reportJson !== undefined ? { reportJson } : {}),
  };
}

/**
 * A result with its report validated; reportJson is gone once it returns, before renderHtml.
 * A result of the wrong kind for the job (a report from a verify job, a check from a scan)
 * is undefined, as unreadable as nonsense; its report is never parsed. A verify job's body
 * is capped at MAX_VERIFY_RESULT_BYTES before its kind is known from what it holds, a
 * scan's at its tier's resultBodyMax. A report over its tier's reportMaxBytes throws
 * RequestError 413, as a body over the cap does.
 */
async function readResult(
  req: Request,
  deadlineMs: number,
  kind: JobKind,
  tier: Tier,
): Promise<ReadResult | undefined> {
  const result = await readJobResult(
    req,
    deadlineMs,
    kind === 'verify' ? MAX_VERIFY_RESULT_BYTES : resultBodyMax(tier),
  );
  if (result === undefined) return undefined;
  if (result.status === 'failed') return { status: 'failed', error: result.error };
  if (isVerifyResult(result)) return kind === 'verify' ? result : undefined;
  if (kind !== 'scan') return undefined;
  if (reportBytes(result) > TIERS[tier].reportMaxBytes)
    throw new RequestError(413, REPORT_TOO_LARGE);
  try {
    return {
      status: 'done',
      report: ScanReportCheckedSchema.parse(JSON.parse(result.reportJson ?? '')),
    };
  } catch {
    return { status: 'done', report: undefined };
  }
}

/** What the control app logs through: a capped refusal line, and the cap's minute check. */
interface ControlLog {
  /** One control_refused line (capped per route): the route's name and a fixed reason. */
  refused: (route: 'input' | 'pdf' | 'result' | 'other', reason: string) => void;
  closeWindows: () => void;
}

/**
 * The control app: the job routes, each with the job's token, and an empty 404 for
 * anything else. Every 404 is logged as control_refused with the route's name only (never
 * the path, the id or a token), capped per route per minute. A result PUT while another
 * PUT of the same job is still being read answers 409 to the job's own token holder.
 */
function createControlApp(
  jobs: HostedJobs,
  log: (line: string) => void,
  resultDeadlineMs: number,
  controlLog: ControlLog,
): Hono {
  const token = (c: Context) =>
    /^Bearer ([\x21-\x7e]{1,512})$/.exec(c.req.header('authorization') ?? '')?.[1];
  /** The uniform empty 404, logged by route. */
  const nothing = (route: 'input' | 'pdf' | 'result' | 'other', reason = 'unauthorized') => {
    controlLog.refused(route, reason);
    return new Response(null, { status: 404 });
  };
  /** Jobs with a result PUT being read or processed: one each. */
  const delivering = new Set<string>();
  /** One result at a time from body read to renderHtml, so only one is held in transit. */
  const gate = new Gate();
  const app = new Hono();
  app.use(secure);
  // Minutes that are over are reported first, so a count comes before the next line.
  app.use(async (_c, next) => {
    controlLog.closeWindows();
    await next();
  });

  app.get(JOB_ROUTES.input, (c) => {
    const input = jobs.input(c.req.param('id'), token(c));
    return input ? json(input) : nothing('input');
  });

  app.get(JOB_ROUTES.pdf, (c) => {
    const pdf = jobs.takePdf(c.req.param('id'), token(c));
    return pdf
      ? new Response(pdf, { headers: { 'content-type': 'application/pdf' } })
      : nothing('pdf');
  });

  /** Ends a scan job with its report: kept when both renderings fit the budget. */
  /**
   * The HTML report as kept bytes, when it and the JSON (measured, not kept) fit the budget:
   * 'too_large' when they do not, undefined when the report cannot be rendered. The HTML
   * text is gone once this returns, before the JSON is made again.
   */
  const keptHtml = (report: ScanReport): Buffer<ArrayBuffer> | 'too_large' | undefined => {
    try {
      const jsonBytes = Buffer.byteLength(serializeJson(report));
      const html = renderHtml(report);
      if (!jobs.canKeep(jsonBytes + Buffer.byteLength(html))) return 'too_large';
      return Buffer.from(html);
    } catch {
      return undefined;
    }
  };

  /** Ends a scan job with its report: kept when both renderings fit the budget. */
  const keep = (id: string, given: string | undefined, report: ScanReport | undefined) => {
    const html = report && keptHtml(report);
    if (report === undefined || html === undefined)
      return jobs.finish(id, given, {
        status: 'failed',
        message: UNREADABLE,
        reason: 'unreadable_report',
      });
    if (html === 'too_large')
      return jobs.finish(id, given, {
        status: 'failed',
        message: TOO_LARGE_TO_KEEP,
        reason: 'too_large_to_keep',
      });
    let json: Buffer<ArrayBuffer>;
    try {
      json = Buffer.from(serializeJson(report));
    } catch {
      return jobs.finish(id, given, {
        status: 'failed',
        message: UNREADABLE,
        reason: 'unreadable_report',
      });
    }
    return jobs.finish(id, given, { status: 'done', reports: { json, html } });
  };

  app.put(JOB_ROUTES.result, async (c) => {
    const began = performance.now();
    const id = c.req.param('id');
    const given = token(c);
    // Nothing is read for a request that may not act on the job, or while another one does.
    if (jobs.authorize(id, given) === undefined) return nothing('result');
    if (delivering.has(id)) {
      controlLog.refused('result', 'delivering');
      return new Response(null, { status: 409 });
    }
    delivering.add(id);
    const fail = (message: string, reason: string, status: 400 | 408 | 413) =>
      jobs.finish(id, given, { status: 'failed', message, reason })
        ? new Response(null, { status })
        : nothing('result', 'ended');
    let leave: (() => void) | undefined;
    try {
      leave = await gate.enter(resultDeadlineMs);
      if (leave === undefined) return fail(TOO_SLOW, 'too_slow', 408);
      // The job may have ended while this request waited.
      const kind = jobs.kindOf(id, given);
      const tier = jobs.tierOf(id, given);
      if (kind === undefined || tier === undefined) return nothing('result', 'ended');
      const left = resultDeadlineMs - (performance.now() - began);
      if (left <= 0) return fail(TOO_SLOW, 'too_slow', 408);
      let result: ReadResult | undefined;
      try {
        result = await readResult(c.req.raw, left, kind, tier);
      } catch (e) {
        if (e instanceof RequestError && e.status === 413)
          return fail(REPORT_TOO_LARGE, 'too_large', 413);
        if (e instanceof RequestError && e.status === 408) return fail(TOO_SLOW, 'too_slow', 408);
        return fail(UNREADABLE, 'unreadable_result', 400);
      }
      if (result === undefined) return fail(UNREADABLE, 'unreadable_result', 400);
      let finished: boolean;
      if (result.status === 'failed') {
        finished = jobs.finish(id, given, {
          status: 'failed',
          message: result.error ?? UNREADABLE,
          reason: 'scan_error',
        });
      } else if (isVerifyResult(result)) {
        finished = jobs.finish(id, given, { status: 'checked', check: result });
      } else {
        // Both reports come from the validated JSON (R37). Their sizes are known before any
        // kept Buffer is built, so a report over the byte budget costs no copy. The two
        // largest strings of a result are never held at once: the JSON text is measured and
        // dropped, the HTML rendered and copied out, then the JSON made again and copied.
        finished = keep(id, given, result.report);
      }
      return finished ? new Response(null, { status: 204 }) : nothing('result', 'ended');
    } finally {
      leave?.();
      delivering.delete(id);
    }
  });

  app.notFound(() => nothing('other', 'no_route'));
  app.onError((error) => {
    log(eventLine('control_error', { status: 500, err: errName(error) }));
    return new Response(null, { status: 500 });
  });
  return app;
}
