import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ATTACHMENT_DIR } from '@widedoor/core';
import {
  AttachmentLoader,
  MAX_REPORT_BYTES,
  ScreenshotLoader,
  describeReportError,
  manualReviews,
  parseJsonReport,
  type ScanReport,
} from '@widedoor/report';
import type { ScanInputs } from './engine.js';
import { evidencePath } from './output.js';

/** A report file that cannot be used; the message says why. widedoor review, diff and ui read reports the same way. */
export class ReportFileError extends Error {}

/** Reads and validates a JSON report (parseJsonReport). Throws ReportFileError. */
export function readReport(path: string): ScanReport {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new ReportFileError('it is not a file');
    size = stat.size;
  } catch (e) {
    if (e instanceof ReportFileError) throw e;
    throw new ReportFileError('it cannot be read');
  }
  if (size > MAX_REPORT_BYTES) throw new ReportFileError('it is over 100 MiB');
  try {
    return parseJsonReport(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ReportFileError(describeReportError(e));
  }
}

type ScreenshotResult = { ok: true; dataUri: string } | { ok: false; reason: string };

/** The report widedoor ui serves: GET /api/report, the checklist and the exports read it. */
export interface CurrentReport {
  report: ScanReport;
  /** The GET /api/report body (reportBodyOf). */
  body: string;
  /** The evidence/ folder its screenshots are in. */
  evidenceDir: string;
  /** A scan job's work folder that holds those screenshots, removed once another report replaces this one. */
  workDir?: string;
  /**
   * What a scan job's report was built from: with it, the report is rebuilt
   * after each recorded review ('live'). A report file has none ('as-scanned').
   */
  inputs?: ScanInputs;
}

/** Whether the served report shows reviews recorded since it was built. */
export type ReviewsState = 'live' | 'as-scanned';

/**
 * The /api/report body: the report, whether it shows reviews recorded since
 * (reviews), every screenshot it names, loaded from evidenceDir, and every
 * attachment its manual review records name, loaded from
 * widedoor-review/attachments under reviewDir (or why one was left out).
 */
export function reportBodyOf(
  report: ScanReport,
  evidenceDir: string,
  reviewDir?: string,
  reviews: ReviewsState = 'as-scanned',
): string {
  const loader = new ScreenshotLoader(evidenceDir);
  // A Map, so a path such as "__proto__" is an ordinary key.
  const screenshots = new Map<string, ScreenshotResult>();
  for (const f of report.findings) {
    const shot = f.evidence?.screenshot;
    if (shot === undefined || screenshots.has(shot)) continue;
    const loaded = loader.load(shot);
    screenshots.set(
      shot,
      loaded.ok ? { ok: true, dataUri: loaded.dataUri } : { ok: false, reason: loaded.reason },
    );
  }
  const files = new AttachmentLoader(
    reviewDir === undefined ? undefined : join(reviewDir, ATTACHMENT_DIR),
  );
  const attachments = new Map<string, ScreenshotResult>();
  for (const r of manualReviews(report).records)
    for (const name of r.attachments) {
      if (attachments.has(name)) continue;
      const loaded = files.load(name);
      attachments.set(
        name,
        loaded.ok ? { ok: true, dataUri: loaded.dataUri } : { ok: false, reason: loaded.reason },
      );
    }
  return JSON.stringify({
    report,
    reviews,
    screenshots: Object.fromEntries(screenshots),
    attachments: Object.fromEntries(attachments),
  });
}

/** A report file as the current report: validated, with the screenshots of the evidence/ folder next to it. Throws ReportFileError. */
export function loadReportFile(path: string, reviewDir?: string): CurrentReport {
  const report = readReport(path);
  const evidenceDir = evidencePath(dirname(path));
  return { report, evidenceDir, body: reportBodyOf(report, evidenceDir, reviewDir) };
}
