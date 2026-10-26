import { timingSafeEqual } from 'node:crypto';
import { CODE_HEADER, TOKEN_HEADER } from '@widedoor/report';

/*
 * The local server's request checks and response headers (ledger ruling for
 * Task 1.5, Task 2.10): loopback only, an exact Host (DNS rebinding), a
 * per-run token, and the CSP and the other security headers on every
 * response, refusals and 404s included. Trusted Types are enforced with no
 * policy, so no string can ever reach an HTML or script sink in the viewer.
 */

export const LOOPBACK = '127.0.0.1';
export { CODE_HEADER, TOKEN_HEADER };

export const UI_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  'img-src data:',
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': UI_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};

export function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const h = host.toLowerCase();
  return h === `${LOOPBACK}:${port}` || h === `localhost:${port}`;
}

/** Whether a request's Origin is this server's own, as reached through its (already checked) Host. */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || host === undefined) return false;
  return origin.toLowerCase() === `http://${host.toLowerCase()}`;
}

export function tokenMatches(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The response with every security header set (replacing any the handler set). */
export function secured(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
  return out;
}
