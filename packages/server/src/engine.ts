import { rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  firstLine,
  getProfile,
  safeText,
  type Finding,
  type PdfDocumentType,
  type ProfileId,
} from '@widedoor/core';
import { PdfScanner, dockerCommand, scanPdfs, type PdfScanResult } from '@widedoor/pdf';
import { buildScanReport, type ReportScope, type ScanReport } from '@widedoor/report';
import {
  isInside,
  scanWeb,
  withFetchedPdfs,
  type Fetcher,
  type PagePolicy,
  type RequestGuard,
  type ScanProgress,
  type WebScanResult,
} from '@widedoor/web';
import type { ScanPlan } from './config.js';
import {
  ProcessTracker,
  containerPrefix,
  removeOwnContainers,
  sweepContainers,
} from './lifecycle.js';
import {
  fetchOffGap,
  inImage,
  pdfFetchDecision,
  pdfUrlsOf,
  sortFetchFailures,
} from './pdf-urls.js';
import { withoutPaths, type PathOptions } from './paths.js';
import { screenScanReviews } from './scan-reviews.js';

/*
 * The scan engine: runs the scan a plan describes and builds its report.
 * widedoor scan writes and prints the outcome; a widedoor ui scan job keeps
 * it in memory as the current report. Neither the console nor the report
 * folder is touched here: screenshots go to the evidence folder the caller
 * names (widedoor scan prepares the report folder first, a job uses a
 * private folder of its own).
 */

export interface ScanRequest {
  plan: ScanPlan;
  /** The manual review records of the plan's widedoor-review/ folder. */
  reviews: readonly Finding[];
  /** Where screenshots are written: an existing folder (mode 0700 for a restricted scan). */
  evidenceDir: string;
  /**
   * widedoor ui: report text names every absolute path outside the root by
   * its file name (home as ~). Otherwise (the CLI) only temp paths are.
   */
  hideAllPaths?: boolean;
  /**
   * The public-only network policy of widedoor mcp (Decision 6): every browser
   * request goes through the egress proxy behind requestGuard, and every Node
   * fetch (PDFs by URL) through fetcher, each hop checked. Absent, the scan
   * reaches the network as widedoor scan does.
   */
  egress?: ScanEgress;
}

/** How a local scan is held to the public-only egress policy (an in-process egress proxy). */
export interface ScanEgress {
  /** The egress proxy for every browser request (an IP literal URL). */
  proxy: { server: string };
  /** The early browser check in front of the proxy (guardedRequestGuard). */
  requestGuard: RequestGuard;
  /** Every Node fetch: each hop checked by the policy and the pinned resolver. */
  fetcher: Fetcher;
}

/**
 * A hosted scan (ledger R5): no screenshots (no evidence folder), the network
 * and limits of `hosted`, and report text that names every absolute path by
 * its file name.
 */
export interface HostedScanRequest {
  plan: ScanPlan;
  reviews: readonly Finding[];
  hosted: HostedScanSettings;
}

/**
 * How a hosted scan reaches the network and what it may take: every request
 * leaves through the egress proxy, pages are asked of robots.txt first, and
 * report text names every absolute path by its file name.
 */
export interface HostedScanSettings {
  /** The egress proxy for every browser request (an IP literal URL). */
  proxy: { server: string };
  /** The early browser check in front of the proxy (guardedRequestGuard). */
  requestGuard: RequestGuard;
  /** Every Node fetch (robots.txt, PDFs by URL): each hop checked, sent through the proxy. */
  fetcher: Fetcher;
  /** The browser's user agent: names Widedoor and a contact URL. */
  userAgent: string;
  /** Asked before each page (robotsPolicy). */
  pagePolicy: PagePolicy;
  /** Pages the policy may skip before the crawl stops. */
  maxPolicySkips: number;
  /** PDFs with more pages are not scanned (too-many-pages). */
  pdfMaxPages: number;
  /**
   * Fetch the PDFs a crawl finds linked. Plan ruling 5: hosted scans do not;
   * a PDF is scanned only as the target. The links left out are a scope gap.
   */
  linkedPdfs: boolean;
}

/** Signed-in pages put the user's data in screenshots and reports: those are kept private (mode 0600 and 0700). */
export const isRestricted = (plan: ScanPlan): boolean => plan.web?.storageState !== undefined;

export interface ScanHooks {
  /**
   * Cancels the scan. When it fires, every process the scan started is
   * killed, its veraPDF containers are removed and the browser is closed
   * (the first two synchronously, so a process exit handler can fire it),
   * and performScan resolves as cancelled.
   */
  signal?: AbortSignal;
  /** A line for the console (stderr in the CLI), without the "widedoor: " prefix. Holds only escaped text. */
  log?: (line: string) => void;
  /** Assets done and known so far over the whole scan, and the one just started. */
  progress?: (progress: ScanProgress) => void;
}

/**
 * What a scan found, before manual reviews are applied. widedoor ui keeps it
 * with its current report and rebuilds the report from it (buildReport)
 * when a review is recorded.
 */
export interface ScanInputs {
  profile: ProfileId;
  pdfDocumentType: PdfDocumentType;
  startedAt: Date;
  finishedAt: Date;
  scope: ReportScope;
  /** The web run (a WebScanResult). */
  web?: NonNullable<Parameters<typeof buildScanReport>[0]['web']>;
  /** The PDF run, with the failed fetches among its errors, and its scope gaps. */
  pdf?: NonNullable<Parameters<typeof buildScanReport>[0]['pdf']>;
}

/**
 * The report of a scan with the review records applied (screenScanReviews):
 * what performScan returns, and what widedoor ui rebuilds after a review is
 * recorded. Returns the warnings for the records left out. Throws when the
 * report does not validate.
 */
export function buildReport(
  inputs: ScanInputs,
  reviews: readonly Finding[],
): { report: ScanReport; warnings: string[] } {
  const { web, pdf } = inputs;
  return screenScanReviews(
    reviews,
    {
      assets: [...(web?.assets ?? []), ...(pdf?.assets ?? [])],
      unscanned: [
        ...(web?.errors ?? []).map((e) => ({ uri: e.uri, kind: 'web' as const })),
        ...(web?.skipped ?? []).map((s) => ({ uri: s.url, kind: 'web' as const })),
        ...(pdf?.errors ?? []).map((e) => ({ uri: e.uri, kind: 'pdf' as const })),
      ],
      automated: [...(web?.findings ?? []), ...(pdf?.findings ?? [])],
    },
    inputs.profile,
    (applied, warnings) =>
      buildScanReport({
        profile: getProfile(inputs.profile, { pdfDocumentType: inputs.pdfDocumentType }),
        startedAt: inputs.startedAt,
        finishedAt: inputs.finishedAt,
        scope: inputs.scope,
        ...(web ? { web } : {}),
        ...(pdf ? { pdf } : {}),
        reviews: applied,
        warnings,
      }),
  );
}

export type ScanOutcome =
  | {
      kind: 'done';
      report: ScanReport;
      /** What the report was built from, for a rebuild with other review records. */
      inputs: ScanInputs;
      /** Signed-in pages: reports and screenshots are kept private (isRestricted). */
      restricted: boolean;
      /** Listed pages the page cap left unscanned (the CLI exits 2 on them). */
      unscannedListed: number;
    }
  /** The scan could not run or its report could not be built; message says why (escaped, no prefix). */
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

/** Why the web scan could not start, with the fix for the common case of a missing browser. */
function webStartError(e: unknown): string {
  const line = firstLine(e);
  if (/Executable doesn't exist/i.test(line))
    return 'Chromium is not installed. Run "npx playwright install chromium" (or use the Widedoor Docker image).';
  return safeText(line);
}

/**
 * A web run without the PDFs it found by link (plan ruling 5): only those in
 * scope by name stay, and the rest are counted in a scope gap.
 */
function withoutLinkedPdfs(web: WebScanResult): WebScanResult {
  const pdfs = web.pdfs.filter((p) => p.listed);
  const dropped = web.pdfs.length - pdfs.length;
  if (dropped === 0) return web;
  const gap = `${dropped} linked PDF(s) were not scanned: the hosted scanner scans a PDF only when it is the target (scan linked PDFs with the CLI)`;
  return { ...web, pdfs, scopeGaps: [...web.scopeGaps, gap], warnings: [...web.warnings, gap] };
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

/**
 * The run's error and warning text as the report keeps it (every export
 * carries it, and widedoor ui shows it): a file inside the root named
 * relative to it, a temp copy (an uploaded PDF's stage, a fetched PDF) by
 * its name, and any other path as options say (withoutPaths). Asset uris
 * are left as they are: a PDF the user named outside the root keeps its path.
 */
export function withoutLocalPaths(
  inputs: ScanInputs,
  root: string,
  options: PathOptions,
): ScanInputs {
  const hide = (text: string) => withoutPaths(text, root, options);
  const { web, pdf } = inputs;
  return {
    ...inputs,
    ...(web
      ? {
          web: {
            ...web,
            errors: web.errors.map((e) => ({ ...e, message: hide(e.message) })),
            warnings: web.warnings.map(hide),
            ...(web.scopeGaps ? { scopeGaps: web.scopeGaps.map(hide) } : {}),
          },
        }
      : {}),
    ...(pdf
      ? {
          pdf: {
            ...pdf,
            errors: pdf.errors.map((e) => ({ ...e, message: hide(e.message) })),
            warnings: pdf.warnings.map(hide),
            ...(pdf.scopeGaps ? { scopeGaps: pdf.scopeGaps.map(hide) } : {}),
          },
        }
      : {}),
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
  if (plan.pdf)
    scope.pdf = {
      files: plan.pdf.files,
      include: plan.pdf.include,
      ...(plan.pdf.urls.length > 0 ? { urls: plan.pdf.urls } : {}),
    };
  return scope;
}

/** Runs the scan a plan describes and returns its report (what widedoor scan does, minus writing and printing). */
export function performScan(request: ScanRequest, hooks: ScanHooks = {}): Promise<ScanOutcome> {
  return runScan(request, hooks);
}

/** performScan for the hosted scanner: the same engine with its network, limits and no evidence. */
export function performHostedScan(
  request: HostedScanRequest,
  hooks: ScanHooks = {},
): Promise<ScanOutcome> {
  return runScan(request, hooks);
}

async function runScan(
  request: ScanRequest | HostedScanRequest,
  hooks: ScanHooks,
): Promise<ScanOutcome> {
  const { plan, reviews } = request;
  const hosted = 'hosted' in request ? request.hosted : undefined;
  const evidenceDir = 'evidenceDir' in request ? request.evidenceDir : undefined;
  const egress = 'egress' in request ? request.egress : undefined;
  const { signal } = hooks;
  const log = hooks.log ?? (() => undefined);
  const tracker = new ProcessTracker();
  const prefix = containerPrefix();
  // Set once a PDF scan is due (a web scan can find PDFs, so not known up front).
  let docker: string | undefined;
  // The folder PDFs fetched by URL wait in; an interrupt exits before withFetchedPdfs removes it.
  let pdfTemp: string | undefined;
  const cleanup = () => {
    tracker.stop();
    if (docker !== undefined) removeOwnContainers(docker, prefix);
    try {
      if (pdfTemp !== undefined) rmSync(pdfTemp, { recursive: true, force: true });
    } catch {
      // A file still held open (Windows); the OS temp cleanup gets it later.
    }
  };
  if (signal?.aborted) return { kind: 'cancelled' };
  signal?.addEventListener('abort', cleanup, { once: true });
  const cancelledOr = (outcome: ScanOutcome): ScanOutcome =>
    signal?.aborted ? { kind: 'cancelled' } : outcome;

  // Progress over the whole scan: the web pages, then the PDFs.
  let webDone = 0;
  let webKnown = 0;
  const progress = (p: ScanProgress, phase: 'web' | 'pdf') => {
    if (phase === 'web') {
      webDone = p.done;
      webKnown = p.known;
      hooks.progress?.(p);
    } else
      hooks.progress?.({
        done: webDone + p.done,
        known: webKnown + p.known,
        ...(p.current !== undefined ? { current: p.current } : {}),
      });
  };

  let web: WebScanResult | undefined;
  let pdf: PdfScanResult | undefined;
  const pdfGaps: string[] = [];
  const fetchErrors: { uri: string; code: string; message: string }[] = [];
  try {
    const startedAt = new Date();
    const restricted = isRestricted(plan);
    if (plan.unsafeNoSandbox)
      log('warning: Chromium runs without its OS sandbox (--unsafe-no-sandbox).');
    if (plan.web) {
      log(
        `scanning web pages (${plan.web.urls.length} listed${plan.web.sitemap ? ', plus the sitemap' : ''}${plan.web.crawl ? `, crawl up to ${plan.web.crawl.maxPages}` : `, up to ${plan.web.maxPages}`})`,
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
            ...(evidenceDir !== undefined ? { evidenceDir } : {}),
            concurrency: plan.concurrency,
            ...(plan.unsafeNoSandbox ? { unsafeNoSandbox: true } : {}),
            ...(plan.web.storageState !== undefined ? { storageState: plan.web.storageState } : {}),
            ...(hosted
              ? {
                  proxy: hosted.proxy,
                  requestGuard: hosted.requestGuard,
                  userAgent: hosted.userAgent,
                  fetcher: hosted.fetcher,
                  pagePolicy: hosted.pagePolicy,
                  maxPolicySkips: hosted.maxPolicySkips,
                }
              : egress
                ? {
                    proxy: egress.proxy,
                    requestGuard: egress.requestGuard,
                    fetcher: egress.fetcher,
                  }
                : {}),
            ...(signal ? { signal } : {}),
            onProgress: (p) => progress(p, 'web'),
          },
        );
      } catch (e) {
        return cancelledOr({
          kind: 'error',
          message: `the web scan could not run: ${webStartError(e)}`,
        });
      }
      if (plan.web.storageState !== undefined) web = hideStorageState(web, plan.web.storageState);
      if (hosted && !hosted.linkedPdfs) web = withoutLinkedPdfs(web);
    }

    const pdfUrls = pdfUrlsOf(plan.pdf?.urls ?? [], web?.pdfs ?? []);
    if (plan.pdf || pdfUrls.length > 0) {
      const command = dockerCommand();
      docker = command;
      if (command !== undefined) {
        const swept = await sweepContainers(command, tracker.spawn);
        if (swept > 0) log(`removed ${swept} leftover veraPDF container(s)`);
      }
      const memory = plan.memoryMb;
      const files = plan.pdf?.files ?? [];
      const include = plan.pdf?.include ?? [];
      const pdfWarnings: string[] = [];
      try {
        // The runner is resolved first: whether this run fetches PDFs depends on it.
        const baseDir = plan.pdf?.baseDir ?? plan.reviewDir;
        const scanner = await PdfScanner.create({
          baseDir,
          local: { spawn: tracker.spawn },
          docker: { spawn: tracker.spawn, namePrefix: prefix, memory: `${memory}m` },
          readerSpawn: tracker.spawn,
          inspectMaxRssMb: memory,
          inspectHeapMb: Math.max(128, Math.floor(memory * 0.6)),
          ...(hosted ? { maxPages: hosted.pdfMaxPages, maxFileBytes: plan.pdfMaxBytes } : {}),
        });
        // A hosted scan machine is thrown away after the scan: fetching there is the point, not a risk to warn about.
        const decision: { fetch: boolean; warning?: string } = hosted
          ? { fetch: true }
          : pdfFetchDecision(plan.pdfFetch, inImage(scanner.runner));
        if (decision.warning) {
          log(`warning: ${decision.warning}`);
          pdfWarnings.push(decision.warning);
        }
        if (!decision.fetch) pdfGaps.push(...pdfUrls.map((p) => fetchOffGap(p.url)));
        const toFetch = decision.fetch ? pdfUrls : [];
        log(`scanning PDF files${toFetch.length > 0 ? ` (${toFetch.length} by URL)` : ''}`);
        const fetched = await withFetchedPdfs(
          toFetch.map((p) => p.url),
          {
            maxBytes: plan.pdfMaxBytes,
            ...(hosted ? { fetcher: hosted.fetcher } : egress ? { fetcher: egress.fetcher } : {}),
            onTempDir: (dir) => (pdfTemp = dir),
            ...(signal ? { signal } : {}),
          },
          (sources) =>
            scanPdfs(
              { files, include, fetched: sources },
              {
                baseDir,
                concurrency: plan.concurrency,
                scanner,
                ...(signal ? { signal } : {}),
                onProgress: (p) => progress(p, 'pdf'),
              },
            ),
        );
        pdf = fetched.result;
        const sorted = sortFetchFailures(
          fetched.failed,
          toFetch,
          plan.web?.storageState !== undefined,
        );
        fetchErrors.push(...sorted.errors);
        pdfGaps.push(...sorted.gaps);
      } catch (e) {
        return cancelledOr({
          kind: 'error',
          message: `the PDF scan could not run: ${safeText(firstLine(e))}`,
        });
      }
      const temp = pdfTemp;
      if (
        include.length > 0 &&
        pdf.files.every((f) => temp !== undefined && isInside(temp, f.path))
      ) {
        // In the report too: a glob typo must not read as "no PDFs".
        const gap = `no PDF files matched pdf.include (${include.join(', ')})`;
        log(`warning: ${safeText(gap, 1000)}`);
        pdfGaps.push(gap);
      }
      pdf = { ...pdf, warnings: [...pdf.warnings, ...pdfWarnings, ...pdfGaps] };
    }
    if (signal?.aborted) return { kind: 'cancelled' };

    const inputs: ScanInputs = withoutLocalPaths(
      {
        profile: plan.profile,
        pdfDocumentType: plan.pdfDocumentType,
        startedAt,
        finishedAt: new Date(),
        scope: scopeOf(plan),
        ...(web ? { web } : {}),
        ...(pdf
          ? { pdf: { ...pdf, errors: [...pdf.errors, ...fetchErrors], scopeGaps: pdfGaps } }
          : {}),
      },
      plan.reviewDir,
      hosted
        ? // The report leaves the machine: every path is named by its file name, home included.
          {
            folders: [tmpdir(), ...(plan.pdf ? [plan.pdf.baseDir] : [])],
            others: 'name',
          }
        : 'hideAllPaths' in request && request.hideAllPaths
          ? {
              // A PDF folder outside the root is a stage (widedoor ui copies uploads into one).
              folders: [
                tmpdir(),
                ...(plan.pdf?.baseDir !== undefined &&
                resolve(plan.pdf.baseDir) !== resolve(plan.reviewDir) &&
                !isInside(plan.reviewDir, plan.pdf.baseDir)
                  ? [plan.pdf.baseDir]
                  : []),
              ],
              home: homedir(),
              others: 'name',
            }
          : // The CLI's user typed the other paths; only temp copies are named by their name.
            { folders: [tmpdir()], others: 'keep' },
    );
    let report: ScanReport;
    try {
      const screened = buildReport(inputs, reviews);
      report = screened.report;
      for (const line of screened.warnings) log(line);
    } catch (e) {
      return { kind: 'error', message: `the report could not be built: ${safeText(firstLine(e))}` };
    }
    return { kind: 'done', report, inputs, restricted, unscannedListed: web?.unscannedListed ?? 0 };
  } finally {
    signal?.removeEventListener('abort', cleanup);
    tracker.stop();
    // A finished PDF scan that did not use Docker started no containers.
    if (docker !== undefined && (pdf === undefined || pdf.engines.verapdf.runner === 'docker'))
      removeOwnContainers(docker, prefix);
  }
}
