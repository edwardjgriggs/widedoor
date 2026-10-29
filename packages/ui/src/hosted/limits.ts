/*
 * The hosted scanner's limits as the page states them. The browser bundle
 * cannot import the server's modules (they reach Node), so it keeps its own
 * copy; test/hosted.test.tsx checks every value against the server's
 * constant (limits.ts, api.ts, jobs.ts, verify.ts, protocol.ts).
 */

/** Pages an open-tier scan covers, the start page included (OPEN_TIER.maxPages). */
export const OPEN_MAX_PAGES = 6;
/** Largest PDF, in bytes (OPEN_TIER.pdfMaxBytes). */
export const PDF_MAX_BYTES = 25 * 1024 * 1024;
/** PDFs with more pages are not scanned (OPEN_TIER.pdfMaxPages). */
export const PDF_MAX_PAGES = 100;
/** Pages a verified-tier scan covers (VERIFIED_TIER.maxPages). */
export const VERIFIED_MAX_PAGES = 200;
/** Scans per client network per hour (SCANS_PER_HOUR). */
export const SCANS_PER_HOUR = 10;
/** How long results stay downloadable after a scan ends (RETENTION_MS). */
export const RETENTION_MS = 60 * 60_000;
/** How long an upload may take (UPLOAD_DEADLINE_MS). */
export const UPLOAD_DEADLINE_MS = 120_000;
/** How long a verification is good for (VERIFY_VALID_MS). */
export const VERIFY_VALID_MS = 24 * 60 * 60_000;
/** Longest scan URL the API takes (MAX_TARGET_URL_LENGTH). */
export const MAX_URL_LENGTH = 2_048;

/** A whole number of hours or minutes in words: "1 hour", "24 hours", "2 minutes". */
export function durationText(ms: number): string {
  const unit = ms % 3_600_000 === 0 ? 'hour' : 'minute';
  const n = ms / (unit === 'hour' ? 3_600_000 : 60_000);
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** Bytes as whole megabytes (MiB, as the server counts them): "25 MB". */
export const megabytes = (bytes: number): string => `${Math.floor(bytes / (1024 * 1024))} MB`;
