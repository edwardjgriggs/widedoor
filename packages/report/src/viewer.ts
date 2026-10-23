import { ZodError } from 'zod';

/*
 * What widedoor ui (the server) and the viewer (the page) must agree on: the
 * request headers, the report size cap and how a bad report is described.
 */

/** The header that carries the session token on every API request. */
export const TOKEN_HEADER = 'x-widedoor-token';
/** The header that carries the one-time code the opened link holds. */
export const CODE_HEADER = 'x-widedoor-code';
/** Report files larger than this are refused before they are read. */
export const MAX_REPORT_BYTES = 100 * 1024 * 1024;

/** Why a report could not be used, in words (the first schema issue, or a JSON error). */
export function describeReportError(e: unknown): string {
  if (e instanceof ZodError) {
    const issue = e.issues[0];
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
    return `it is not a Widedoor JSON report${where}: ${issue?.message ?? 'invalid'}`;
  }
  if (e instanceof SyntaxError) return 'it is not valid JSON';
  return 'it cannot be read';
}
