import { getProfile, type Finding } from '@widedoor/core';
import { dockerCommand, scanPdfs, type PdfScanResult } from '@widedoor/pdf';
import {
  buildScanReport,
  renderHtml,
  serializeJson,
  serializeSarif,
  type ReportScope,
  type ScanReport,
} from '@widedoor/report';
import { scanWeb, type WebScanResult } from '@widedoor/web';
import type { ScanPlan } from './config.js';
import {
  ProcessTracker,
  containerPrefix,
  onStop,
  removeOwnContainers,
  sweepContainers,
} from './lifecycle.js';
import { OutputError, evidencePath, prepareOut, reportPath, writeReport } from './output.js';
import { EXIT_ERROR, exitDecision } from './policy.js';
import { printSummary } from './summary.js';
import { firstLine, safeText } from './text.js';
import type { Io } from './main.js';

/** Why the web scan could not start, with the fix for the common case of a missing browser. */
function webStartError(e: unknown): string {
  const line = firstLine(e);
  if (/Executable doesn't exist/i.test(line))
    return 'Chromium is not installed. Run "npx playwright install chromium" (or use the Widedoor Docker image).';
  return safeText(line);
}

/** Scan errors may quote the storage state path (Playwright names the file): the report names the setting instead. */
function hideStorageState(web: WebScanResult, path: string): WebScanResult {
  const hide = (message: string) => message.split(path).join('web.auth.storageState');
  return {
    ...web,
    errors: web.errors.map((e) => ({ ...e, message: hide(e.message) })),
    pages: web.pages.map((p) =>
      p.error ? { ...p, error: { ...p.error, message: hide(p.error.message) } } : p,
    ),
  };
}

function scopeOf(plan: ScanPlan): ReportScope {
  const scope: ReportScope = {};
  if (plan.web)
    scope.web = {
      urls: plan.web.urls,
      ...(plan.web.sitemap !== undefined ? { sitemap: plan.web.sitemap } : {}),
      ...(plan.web.crawl ? { crawl: plan.web.crawl } : {}),
      maxPages: plan.web.maxPages,
      truncated: false,
    };
  if (plan.pdf) scope.pdf = { files: plan.pdf.files, include: plan.pdf.include };
  return scope;
}

/** Runs the scan a plan describes, writes the reports and returns the exit code. */
export async function runScan(
  plan: ScanPlan,
  reviews: readonly Finding[],
  io: Io,
): Promise<number> {
  const tracker = new ProcessTracker();
  const prefix = containerPrefix();
  const docker = plan.pdf ? dockerCommand() : undefined;
  let stopping = false;
  const cleanup = () => {
    tracker.stop();
    if (docker !== undefined) removeOwnContainers(docker, prefix);
  };
  const dispose = onStop((signal) => {
    if (stopping) return;
    stopping = true;
    io.err(`widedoor: interrupted (${signal}); stopping the scan. No report was written.`);
    dispose();
    cleanup();
    process.exit(EXIT_ERROR);
  }, cleanup);

  let web: WebScanResult | undefined;
  let pdf: PdfScanResult | undefined;
  const pdfGaps: string[] = [];
  try {
    const startedAt = new Date();
    const restricted = plan.web?.storageState !== undefined;
    // Signed-in pages put the user's data in screenshots and reports: keep them private.
    try {
      await prepareOut(plan.out, restricted, plan.outRoots);
    } catch (e) {
      if (!(e instanceof OutputError)) throw e;
      io.err(`widedoor: the report folder cannot be used: ${safeText(e.message, 1000)}`);
      return EXIT_ERROR;
    }
    if (plan.unsafeNoSandbox)
      io.err('widedoor: warning: Chromium runs without its OS sandbox (--unsafe-no-sandbox).');
    if (docker !== undefined) {
      const swept = await sweepContainers(docker, tracker.spawn);
      if (swept > 0) io.err(`widedoor: removed ${swept} leftover veraPDF container(s)`);
    }

    if (plan.web) {
      io.err(
        `widedoor: scanning web pages (${plan.web.urls.length} listed${plan.web.sitemap ? ', plus the sitemap' : ''}${plan.web.crawl ? `, crawl up to ${plan.web.crawl.maxPages}` : `, up to ${plan.web.maxPages}`})`,
      );
      try {
        web = await scanWeb(
          {
            urls: plan.web.urls,
            ...(plan.web.sitemap !== undefined ? { sitemap: plan.web.sitemap } : {}),
            ...(plan.web.crawl ? { crawl: plan.web.crawl } : {}),
            maxPages: plan.web.maxPages,
          },
          {
            evidenceDir: evidencePath(plan.out),
            concurrency: plan.concurrency,
            ...(plan.unsafeNoSandbox ? { unsafeNoSandbox: true } : {}),
            ...(plan.web.storageState !== undefined ? { storageState: plan.web.storageState } : {}),
          },
        );
      } catch (e) {
        io.err(`widedoor: the web scan could not run: ${webStartError(e)}`);
        return EXIT_ERROR;
      }
      if (plan.web.storageState !== undefined) web = hideStorageState(web, plan.web.storageState);
    }

    if (plan.pdf) {
      io.err('widedoor: scanning PDF files');
      const memory = plan.memoryMb;
      try {
        pdf = await scanPdfs(
          { files: plan.pdf.files, include: plan.pdf.include },
          {
            baseDir: plan.pdf.baseDir,
            concurrency: plan.concurrency,
            local: { spawn: tracker.spawn },
            docker: { spawn: tracker.spawn, namePrefix: prefix, memory: `${memory}m` },
            readerSpawn: tracker.spawn,
            inspectMaxRssMb: memory,
            inspectHeapMb: Math.max(128, Math.floor(memory * 0.6)),
          },
        );
      } catch (e) {
        io.err(`widedoor: the PDF scan could not run: ${safeText(firstLine(e))}`);
        return EXIT_ERROR;
      }
      if (pdf.files.length === 0 && pdf.errors.length === 0) {
        // In the report too: a glob typo must not read as "no PDFs".
        const gap = `no PDF files matched pdf.include (${plan.pdf.include.join(', ')})`;
        io.err(`widedoor: warning: ${safeText(gap, 1000)}`);
        pdf = { ...pdf, warnings: [...pdf.warnings, gap] };
        pdfGaps.push(gap);
      }
    }

    let report: ScanReport;
    try {
      // Reviews of assets outside this run cannot enter its report.
      const known = new Set([
        ...[...(web?.assets ?? []), ...(pdf?.assets ?? [])].map((a) => a.uri),
        ...[...(web?.errors ?? []), ...(pdf?.errors ?? [])].map((e) => e.uri),
        ...(web?.skipped ?? []).map((s) => s.url),
      ]);
      const inScope = reviews.filter((r) => known.has(r.asset.uri));
      if (inScope.length < reviews.length)
        io.err(
          `widedoor: ${reviews.length - inScope.length} manual review record(s) are for pages or files outside this scan and were left out`,
        );
      report = buildScanReport({
        profile: getProfile(plan.profile, { pdfDocumentType: plan.pdfDocumentType }),
        startedAt,
        finishedAt: new Date(),
        scope: scopeOf(plan),
        ...(web ? { web } : {}),
        ...(pdf ? { pdf: { ...pdf, scopeGaps: pdfGaps } } : {}),
        reviews: inScope,
      });
    } catch (e) {
      io.err(`widedoor: the report could not be built: ${safeText(firstLine(e))}`);
      return EXIT_ERROR;
    }

    const written: string[] = [];
    try {
      for (const format of plan.formats) {
        const text =
          format === 'json'
            ? serializeJson(report)
            : format === 'sarif'
              ? serializeSarif(report)
              : renderHtml(report, { evidenceDir: evidencePath(plan.out) });
        await writeReport(plan.out, format, text, restricted);
        written.push(reportPath(plan.out, format));
      }
    } catch (e) {
      io.err(`widedoor: the report could not be written: ${safeText(firstLine(e))}`);
      return EXIT_ERROR;
    }

    const decision = exitDecision(report, plan.failOn, {
      unscannedListed: web?.unscannedListed ?? 0,
      ...(plan.web
        ? { maxPages: plan.web.maxPages, maxPagesSetting: plan.web.maxPagesSetting }
        : {}),
    });
    printSummary(report, { written, decision, failOn: plan.failOn }, io);
    return decision.code;
  } finally {
    dispose();
    tracker.stop();
    // A finished PDF scan that did not use Docker started no containers.
    if (docker !== undefined && (pdf === undefined || pdf.engines.verapdf.runner === 'docker'))
      removeOwnContainers(docker, prefix);
  }
}
