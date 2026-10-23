import {
  CODE_HEADER,
  MAX_REPORT_BYTES,
  ScanReportCheckedSchema,
  TOKEN_HEADER,
  describeReportError,
  parseJsonReport,
  type ScanReport,
} from '@widedoor/report/browser';
import { ScreenshotsSchema, type ScreenshotView } from './data.js';

/*
 * Where a report comes from: the one widedoor ui serves (behind the per-run
 * token), or a JSON file the user opens. Both go through the report
 * package's Zod schema before anything renders.
 */

export interface Loaded {
  report: ScanReport;
  screenshots: ReadonlyMap<string, ScreenshotView>;
  source: 'server' | 'file';
  /** The file name, for a report opened from a file. */
  name: string;
}

export type LoadResult = { ok: true; loaded: Loaded } | { ok: false; message: string };

const TOKEN_KEY = 'widedoor-token';

export const REFUSED =
  'The server refused the request. Open the link widedoor ui printed in the terminal again.';

function storedToken(): string | undefined {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

type TokenResult = { token: string } | { message: string };

/**
 * The per-run token. The opened link carries a one-time code, which is
 * removed from the address bar and traded for the token once; the token then
 * stays in this tab's session storage, so a reload keeps working.
 */
async function getToken(): Promise<TokenResult> {
  const code = new URLSearchParams(window.location.search).get('code');
  if (!code) {
    const token = storedToken();
    return token
      ? { token }
      : {
          message:
            'Open a Widedoor JSON report below, or open the link widedoor ui printed (it carries an access code).',
        };
  }
  window.history.replaceState(null, '', window.location.pathname);
  let res: Response;
  try {
    res = await fetch('/api/session', {
      method: 'POST',
      headers: { [CODE_HEADER]: code },
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch {
    return { message: 'The widedoor ui server is not running. Open a report below.' };
  }
  if (!res.ok) {
    // A reload of a tab that already traded its code still has the token.
    const token = storedToken();
    if (token) return { token };
    // Only a 401 means the code was refused; anything else is some other refusal.
    return {
      message:
        res.status === 401
          ? 'This link was already used. Each link opens the viewer once: reload the tab it opened, or restart widedoor ui for a new link.'
          : REFUSED,
    };
  }
  const body = (await res.json()) as { token?: unknown };
  if (typeof body.token !== 'string' || body.token === '')
    return { message: 'The server sent no access token.' };
  try {
    window.sessionStorage.setItem(TOKEN_KEY, body.token);
  } catch {
    // Storage can be off; the token then lasts until a reload.
  }
  return { token: body.token };
}

let token: Promise<TokenResult> | undefined;

export async function fetchServedReport(): Promise<LoadResult> {
  token ??= getToken();
  const got = await token;
  if (!('token' in got)) return { ok: false, message: got.message };
  let res: Response;
  try {
    res = await fetch('/api/report', {
      headers: { [TOKEN_HEADER]: got.token },
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch {
    return { ok: false, message: 'The widedoor ui server is not running. Open a report below.' };
  }
  if (res.status === 204)
    return {
      ok: false,
      message: 'widedoor ui was started without --report. Open a Widedoor JSON report below.',
    };
  if (!res.ok) return { ok: false, message: REFUSED };
  try {
    const body = (await res.json()) as { report?: unknown; screenshots?: unknown };
    return {
      ok: true,
      loaded: {
        report: ScanReportCheckedSchema.parse(body.report),
        screenshots: new Map(Object.entries(ScreenshotsSchema.parse(body.screenshots ?? {}))),
        source: 'server',
        name: '',
      },
    };
  } catch (e) {
    return { ok: false, message: `The served report is not usable: ${describeReportError(e)}.` };
  }
}

export async function readReportFile(file: File): Promise<LoadResult> {
  if (file.size > MAX_REPORT_BYTES)
    return { ok: false, message: `${file.name} is not usable: it is over 100 MiB.` };
  try {
    const report = parseJsonReport(await file.text());
    return {
      ok: true,
      loaded: { report, screenshots: new Map(), source: 'file', name: file.name },
    };
  } catch (e) {
    return { ok: false, message: `${file.name} is not usable: ${describeReportError(e)}.` };
  }
}
