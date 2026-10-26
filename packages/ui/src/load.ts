import {
  MAX_REPORT_BYTES,
  ScanReportCheckedSchema,
  describeReportError,
  parseJsonReport,
  type ScanReport,
} from '@widedoor/report/browser';
import {
  ApiError,
  NOT_RUNNING,
  REFUSED,
  SERVER_ERROR,
  SESSION_ENDED,
  reportBody,
  session,
} from './api.js';
import { AttachmentsSchema, ScreenshotsSchema, type ScreenshotView } from './data.js';

/*
 * Where a report comes from: the one widedoor ui serves (behind the per-run
 * token, through api.ts), or a JSON file the user opens. Both go through the
 * report package's Zod schema before anything renders.
 */

/**
 * Whether a served report shows the reviews recorded since it was made: a
 * scan job's report is rebuilt with each one (live), a --report file is shown
 * as scanned.
 */
export type ReviewsState = 'live' | 'as-scanned';

export interface Loaded {
  report: ScanReport;
  screenshots: ReadonlyMap<string, ScreenshotView>;
  /** Review attachments by the path their record names. */
  attachments: ReadonlyMap<string, ScreenshotView>;
  source: 'server' | 'file';
  /** The file name, for a report opened from a file. */
  name: string;
  /** For a served report. */
  reviews?: ReviewsState;
}

export type LoadResult = { ok: true; loaded: Loaded } | { ok: false; message: string };

export async function fetchServedReport(): Promise<LoadResult> {
  const got = await session();
  if (!('token' in got)) return { ok: false, message: got.message };
  let body;
  try {
    body = (await reportBody()) as
      | { report?: unknown; reviews?: unknown; screenshots?: unknown; attachments?: unknown }
      | undefined;
  } catch (e) {
    if (!(e instanceof ApiError) || e.message === NOT_RUNNING)
      return { ok: false, message: 'The widedoor ui server is not running. Open a report below.' };
    if (e.status === 0) return { ok: false, message: e.message };
    return {
      ok: false,
      message: e.status === 401 ? SESSION_ENDED : e.status >= 500 ? SERVER_ERROR : REFUSED,
    };
  }
  if (body === undefined)
    return {
      ok: false,
      message: 'widedoor ui was started without --report. Open a Widedoor JSON report below.',
    };
  try {
    return {
      ok: true,
      loaded: {
        report: ScanReportCheckedSchema.parse(body.report),
        screenshots: new Map(Object.entries(ScreenshotsSchema.parse(body.screenshots ?? {}))),
        attachments: new Map(Object.entries(AttachmentsSchema.parse(body.attachments ?? {}))),
        source: 'server',
        name: '',
        reviews: body.reviews === 'live' ? 'live' : 'as-scanned',
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
      loaded: {
        report,
        screenshots: new Map(),
        attachments: new Map(),
        source: 'file',
        name: file.name,
      },
    };
  } catch (e) {
    return { ok: false, message: `${file.name} is not usable: ${describeReportError(e)}.` };
  }
}
