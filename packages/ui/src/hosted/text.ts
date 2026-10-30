import { visibleText } from '@widedoor/report/browser';
import {
  HostedError,
  type ScanJob,
  type ScanTarget,
  type Tried,
  type VerificationStatus,
  type VerifyMethod,
} from './api.js';
import {
  MAX_URL_LENGTH,
  OPEN_MAX_PAGES,
  PDF_MAX_BYTES,
  PDF_MAX_PAGES,
  RETENTION_MS,
  SCANS_PER_HOUR,
  UPLOAD_DEADLINE_MS,
  VERIFIED_MAX_PAGES,
  VERIFY_VALID_MS,
  durationText,
  megabytes,
} from './limits.js';

/*
 * The hosted page's words, the client-side checks of what it is about to
 * send, and the rule for when a verification applies to a URL. Every number
 * in the copy comes from limits.ts. Text from the server goes through
 * visibleText where it is shown.
 */

const t = (value: unknown) => visibleText(value);

export const LIMITS_TEXT =
  `Each scan covers one URL plus up to ${OPEN_MAX_PAGES - 1} pages linked from it on the same site, ` +
  `or one PDF up to ${megabytes(PDF_MAX_BYTES)} and ${PDF_MAX_PAGES} pages. ` +
  `You can run about ${SCANS_PER_HOUR} scans an hour from one network. ` +
  `Reports are deleted ${durationText(RETENTION_MS)} after the scan ends.`;

/** The upload deadline in words, as ruled for the PDF field. */
export const UPLOAD_TIME_TEXT = `Uploads must finish within ${durationText(UPLOAD_DEADLINE_MS)}, so very large files need a reasonably fast connection.`;

export const VERIFIED_OPTION = `Scan on the verified tier (up to ${VERIFIED_MAX_PAGES} pages)`;

export const TOKEN_NOTE = `The token is not a secret: it is meant to be published, and it is valid for ${durationText(VERIFY_VALID_MS)}.`;

export const VERIFY_TIMEOUT = 'The check is taking longer than expected. Try again later.';

export const DOWNLOAD_NOTE = `The scanner deletes this report ${durationText(RETENTION_MS)} after the scan ended. Download it to keep a copy.`;

/** A server message as a sentence: capital first letter, full stop at the end. */
export function sentence(text: string): string {
  const s = t(text);
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}`;
}

/** A wait in words, rounded up: "30 seconds", "2 minutes", "1 hour" (from 59 minutes on). */
export function waitText(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  if (s < 3540) {
    const m = Math.ceil(s / 60);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const h = Math.ceil(s / 3600);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/** The sentence after a busy or rate-limit refusal. */
export const retryText = (seconds: number): string => `You can try again in ${waitText(seconds)}.`;

/** A refusal as the page shows it: the server's words, and the wait when it gave one. */
export function refusalText(e: unknown): string {
  if (!(e instanceof HostedError)) return 'This page hit an error it did not expect. Reload it.';
  const message = t(e.message);
  return e.retryAfterS !== undefined ? `${message} ${retryText(e.retryAfterS)}` : message;
}

/** The live region's words for a scan's state. */
export function scanStatusText(job: ScanJob, cancelling = false): string {
  if (
    cancelling &&
    (job.status === 'queued' || job.status === 'starting' || job.status === 'running')
  )
    return 'Cancelling the scan.';
  switch (job.status) {
    case 'queued':
      return job.queuePosition === undefined
        ? 'The scan is queued.'
        : job.queuePosition === 1
          ? 'The scan is queued. It is next in line.'
          : `The scan is queued. It is number ${job.queuePosition} in line.`;
    case 'starting':
      return 'The scanner is starting.';
    case 'running':
      return 'The scan is running. This can take a few minutes.';
    case 'done':
      return 'The scan finished.';
    case 'failed':
      return 'The scan failed.';
    case 'cancelled':
      return 'The scan was cancelled.';
    case 'expired':
      return 'The results of this scan have expired.';
  }
}

/** What an ended scan says besides its state: the server's message, or a fixed one. */
export function endedText(job: ScanJob): string {
  if (job.status === 'expired')
    return `Results are kept for ${durationText(RETENTION_MS)}, and this scan's are gone.`;
  if (job.status === 'cancelled') return 'The scan was cancelled.';
  return sentence(job.message ?? 'the scan failed');
}

/** The URL field's client-side check: why it cannot be sent, if it cannot. */
export function urlError(value: string): string | undefined {
  const text = value.trim();
  if (text === '') return 'Enter the address of a web page.';
  if (text.length > MAX_URL_LENGTH) return 'The address is too long.';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'Enter a full address that starts with https:// or http://.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return 'Enter a full address that starts with https:// or http://.';
  return undefined;
}

/** The PDF field's client-side check (its first bytes must be %PDF-, as the server checks). */
export async function pdfError(file: File | undefined): Promise<string | undefined> {
  if (file === undefined) return 'Choose a PDF file.';
  if (file.size > PDF_MAX_BYTES) return `The file is over the ${megabytes(PDF_MAX_BYTES)} limit.`;
  let head: string;
  try {
    head = await file.slice(0, 5).text();
  } catch {
    return 'The file could not be read. Choose it again.';
  }
  return head === '%PDF-' ? undefined : 'The file is not a PDF.';
}

/** A host as the API compares it: lower case, no brackets, no trailing dot. */
export const bareHost = (url: URL): string =>
  url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');

/** A verification the page knows of. The methods and token only for one made in this page. */
export interface VerificationState {
  id: string;
  host: string;
  expiresAt: string;
  status: VerificationStatus;
  tried?: Tried[];
}

/** Whether a verification is verified and unexpired now. */
export const isUsable = (v: VerificationState | undefined, now: number): boolean =>
  v?.status === 'verified' && Date.parse(v.expiresAt) > now;

/** Whether a verification applies to a scan of the URL: usable, and for exactly its host. */
export function coversUrl(v: VerificationState | undefined, url: string, now: number): boolean {
  if (!isUsable(v, now) || urlError(url) !== undefined) return false;
  return bareHost(new URL(url.trim())) === v?.host;
}

/**
 * What a URL scan sends: the URL, and the verification's id only when the user asked
 * for the verified tier and the verification covers that URL now.
 */
export function urlTarget(
  url: string,
  useVerified: boolean,
  v: VerificationState | undefined,
  now: number,
): ScanTarget {
  const target: ScanTarget = { kind: 'url', url: url.trim() };
  return useVerified && v !== undefined && coversUrl(v, url, now)
    ? { ...target, verificationId: v.id }
    : target;
}

/** A time in the user's own time zone (timeZone for tests). */
export function localTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone !== undefined ? { timeZone } : {}),
  }).format(new Date(iso));
}

export const METHOD_LABEL: Record<VerifyMethod, string> = {
  dns_txt: 'DNS TXT record',
  well_known: 'Well-known file',
  meta_tag: 'Meta tag',
};

/** One line per method tried: its name and how it went. */
export const triedText = (tried: Tried): string =>
  `${METHOD_LABEL[tried.method]}: ${tried.ok ? 'found the token' : t(tried.reason ?? 'did not match')}.`;
