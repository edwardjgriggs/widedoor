import { join } from 'node:path';
import { ATTACHMENT_DIR } from '@widedoor/core';
import {
  buildAcr,
  renderHtml,
  renderVpatDocx,
  renderVpatHtml,
  serializeJson,
  serializeJunit,
  serializeOpenAcr,
  serializeSarif,
  type AcrMeta,
  type ScanReport,
} from '@widedoor/report';
import {
  evidencePath,
  reportName,
  reportPath,
  writeReport,
  writeSignedInMarker,
} from './output.js';
import { ACR_FORMATS, type Format } from './settings.js';

/*
 * The report files of a scan, built in memory: widedoor scan writes them to
 * the report folder, and GET /api/export/:format sends one for download.
 */

export interface ReportFile {
  format: Format;
  /** report.<ext>, as written to the report folder. */
  name: string;
  data: string | Uint8Array;
}

export interface ReportFilesOptions {
  formats: readonly Format[];
  /** The config's acr block; required for an ACR format (buildPlan or the export checked it). */
  acr?: AcrMeta;
  /** The screenshots the HTML report embeds. */
  evidenceDir: string;
  /** The folder that holds widedoor-review/, whose attachments the HTML report embeds. */
  reviewDir: string;
}

/**
 * Builds the report of every format named, in that order. Every ACR format
 * is built and validated first, so an ACR that fails validation (a bug)
 * throws before any other format is built.
 */
export async function buildReportFiles(
  report: ScanReport,
  options: ReportFilesOptions,
): Promise<ReportFile[]> {
  const acr = new Map<Format, string | Uint8Array>();
  if (options.formats.some((f) => ACR_FORMATS.includes(f))) {
    const model = buildAcr(report, options.acr ?? {});
    if (options.formats.includes('openacr')) acr.set('openacr', serializeOpenAcr(model));
    if (options.formats.includes('vpat-html')) acr.set('vpat-html', renderVpatHtml(model));
    if (options.formats.includes('vpat-docx')) acr.set('vpat-docx', await renderVpatDocx(model));
  }
  return options.formats.map((format) => ({
    format,
    name: reportName(format),
    data:
      acr.get(format) ??
      (format === 'json'
        ? serializeJson(report)
        : format === 'sarif'
          ? serializeSarif(report)
          : format === 'junit'
            ? serializeJunit(report)
            : renderHtml(report, {
                evidenceDir: options.evidenceDir,
                attachmentsDir: join(options.reviewDir, ATTACHMENT_DIR),
              })),
  }));
}

/**
 * Writes the report of every format named to the report folder (prepared
 * by prepareOut) and returns their paths. Nothing is written when any
 * format fails to build.
 */
export async function writeReports(
  report: ScanReport,
  plan: { formats: readonly Format[]; out: string; reviewDir: string; acr?: AcrMeta },
  restricted: boolean,
): Promise<string[]> {
  const files = await buildReportFiles(report, {
    formats: plan.formats,
    ...(plan.acr ? { acr: plan.acr } : {}),
    evidenceDir: evidencePath(plan.out),
    reviewDir: plan.reviewDir,
  });
  // A signed-in scan's reports carry the marker, so AI knows them on every platform. Written
  // before any report, so a failed or interrupted write never leaves one of them unmarked.
  if (restricted) await writeSignedInMarker(plan.out);
  const written: string[] = [];
  for (const file of files) {
    await writeReport(plan.out, file.format, file.data, restricted);
    written.push(reportPath(plan.out, file.format));
  }
  return written;
}
