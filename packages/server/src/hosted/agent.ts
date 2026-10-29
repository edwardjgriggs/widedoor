import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstLine } from '@widedoor/core';
import { serializeJson } from '@widedoor/report';
import { robotsPolicy, type PageVerdict, type RobotsDecision } from '@widedoor/web';
import {
  EgressRefusedError,
  createProxiedFetcher,
  guardedRequestGuard,
  hostedUserAgent,
  logValue,
  type PinnedResolver,
} from '@widedoor/web/egress';
import { classifyTarget, type ScanPlan } from '../config.js';
import { performHostedScan } from '../engine.js';
import { withoutPaths } from '../paths.js';
import { DEFAULT_MEMORY_MB } from '../settings.js';
import { TIERS, maxPolicySkipsFor, type TierLimits } from './limits.js';
import {
  INPUT_REFUSED,
  JobInputSchema,
  REPORT_TOO_LARGE,
  jobError,
  reportBytes,
  type JobInput,
  type ScanResult,
} from './protocol.js';

/*
 * One hosted scan, as the scan child runs it (agent-child.ts): a URL (one
 * page plus a same-origin crawl up to the tier's cap, or a PDF by URL) or an
 * uploaded PDF. No credentials, no screenshots, no linked PDFs (plan ruling
 * 5), one page at a time, and every request through the egress proxy:
 * Chromium by its proxy setting, Node fetches (robots.txt, PDFs) through the
 * proxied fetcher. The result is the JSON report, with no absolute path in it
 * and no larger than the tier's reportMaxBytes, or a failure in plain words. The
 * API renders the HTML report itself (ledger R37).
 */

export interface HostedScanOptions {
  input: JobInput;
  /** The uploaded PDF, for a pdf target. */
  pdf?: Uint8Array;
  /** The egress proxy, an IP literal URL such as http://127.0.0.1:<port> (WIDEDOOR_PROXY_URL). */
  proxyUrl: string;
  /**
   * One per scan: the proxied fetcher checks each hop's name with it before
   * asking the proxy. In tests the in-process proxy shares it. In the scan
   * machine the proxy is a separate process with its own resolver, and the
   * fetcher's requests go through it, so the pin that binds is the proxy's.
   */
  resolver: PinnedResolver;
  /** The page the user agent names, for site owners who want to know what Widedoor is. */
  contactUrl: string;
  signal: AbortSignal;
  /** One line per robots.txt decision and per refused fetch hop. Default: stderr. */
  log?: (line: string) => void;
  /** Tests only, on a host where Chromium's sandbox cannot start. The scan machine never sets it. */
  unsafeNoSandbox?: boolean;
  /** Makes the private folder an upload is staged in (tests). Default: mkdtemp in the temp folder. */
  makeStage?: () => Promise<string>;
}

const failed = (error: string): ScanResult => ({ status: 'failed', error: jobError(error) });

/** One log line per robots.txt decision; no path or query, every value escaped. */
export function formatRobotsDecision(decision: RobotsDecision): string {
  const fields: [string, string | number | boolean | undefined][] = [
    ['origin', decision.origin],
    ['verdict', decision.verdict],
    ['status', decision.status],
    ['bytes', decision.bytes],
    ['rules', decision.rules],
    ['truncated', decision.truncated],
    ['cause', decision.cause],
    ['block_reason', decision.blockReason],
  ];
  return `widedoor event=robots_decision ${fields
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${logValue(String(value))}`)
    .join(' ')}`;
}

/** One log line per fetch hop the egress policy refused: the host and the rule, never the path. */
export function formatFetchRefusal(hop: URL, error: EgressRefusedError): string {
  return `widedoor event=fetch_refused host=${logValue(hop.hostname)} reason=${logValue(error.blockReason ?? error.reason)}`;
}

/** Why robots.txt kept the start URL from being scanned, in plain words. */
function robotsRefusal(verdict: Exclude<PageVerdict, 'scan'>, decision?: RobotsDecision): string {
  if (verdict === 'robots-disallowed')
    return "the site's robots.txt does not allow Widedoor to scan this page";
  if (verdict === 'robots-unchecked')
    return 'the URL is too long to check against robots.txt, so it was not scanned';
  const why: Record<string, string> = {
    'http-5xx': `the server answered ${decision?.status ?? '5xx'}`,
    'http-429': 'the server answered 429 (too many requests)',
    'http-other': `the server answered ${decision?.status ?? 'with an error'}`,
    timeout: 'it did not arrive in time',
    network: 'the connection failed',
    refused: 'its address is not allowed',
    'too-many-redirects': 'it redirected too many times',
    'too-large': 'its rules for Widedoor are too large to apply',
  };
  const cause = decision?.cause !== undefined ? why[decision.cause] : undefined;
  return `the site's robots.txt could not be read${cause ? ` (${cause})` : ''}, so the site was not scanned`;
}

/**
 * Why a PDF job's file was not scanned, in the hosted scanner's words: the
 * hosted limits by name, never the scanner's own text (which names settings
 * a hosted user never sees); any other failure by its code and message.
 */
function pdfNotScanned(error: { code: string; message: string } | undefined, limits: TierLimits) {
  if (error?.code === 'too-many-pages')
    return `the PDF has more than ${limits.pdfMaxPages} pages, the hosted limit`;
  if (error?.code === 'file-too-large')
    return `the PDF is over the ${limits.pdfMaxBytes / (1024 * 1024)} MiB limit`;
  return error
    ? `the PDF was not scanned (${error.code}): ${error.message}`
    : 'the PDF was not scanned';
}

/** Runs one hosted scan and returns its result; never throws. */
export async function runHostedScan(options: HostedScanOptions): Promise<ScanResult> {
  const { signal } = options;
  // Checked again here: the file name becomes a path and the URL a request.
  const parsed = JobInputSchema.safeParse(options.input);
  if (!parsed.success) return failed(INPUT_REFUSED);
  const input = parsed.data;
  const limits = TIERS[input.tier];
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  // Set as each is made, so the finally undoes only what exists.
  let closeFetcher: (() => Promise<void>) | undefined;
  let stage: string | undefined;
  // Error text names any path by its file name, the stage relative to itself.
  const hide = (text: string) =>
    withoutPaths(text, stage ?? tmpdir(), { folders: [tmpdir()], others: 'name' });
  try {
    const userAgent = hostedUserAgent(options.contactUrl);
    const fetcher = createProxiedFetcher({
      proxyUrl: options.proxyUrl,
      resolver: options.resolver,
      userAgent,
      onRefused: (hop, error) => log(formatFetchRefusal(hop, error)),
    });
    closeFetcher = () => fetcher.close();
    const decisions = new Map<string, RobotsDecision>();
    const pagePolicy = robotsPolicy(fetcher, 'Widedoor', {
      onDecision: (decision) => {
        decisions.set(decision.origin, decision);
        log(formatRobotsDecision(decision));
      },
    });
    // Uploads are staged here, and only here; reports never leave memory.
    stage = await (options.makeStage ?? (() => mkdtemp(join(tmpdir(), 'widedoor-job-'))))();
    const base: ScanPlan = {
      profile: input.profile,
      pdfDocumentType: 'non-web',
      pdfMaxBytes: limits.pdfMaxBytes,
      pdfFetch: true,
      formats: ['json', 'html'],
      failOn: 'none',
      // Never written: performScan writes no report, and a hosted scan has no evidence folder.
      out: stage,
      outRoots: [stage],
      reviewDir: stage,
      unsafeNoSandbox: options.unsafeNoSandbox === true,
      concurrency: 1,
      memoryMb: DEFAULT_MEMORY_MB,
    };
    let plan: ScanPlan;
    const { target } = input;
    // A verify job is runVerification's (verify-check.ts), never a scan.
    if (target.kind === 'verify') return failed(INPUT_REFUSED);
    if (target.kind === 'url') {
      // The start URL is asked first: a refusal means no page is requested at all.
      const verdict = await pagePolicy(target.url);
      if (signal.aborted) return failed('the scan was stopped');
      if (verdict !== 'scan')
        return failed(robotsRefusal(verdict, decisions.get(new URL(target.url).origin)));
      const classified = classifyTarget(target.url);
      plan =
        classified.kind === 'pdf-url'
          ? { ...base, pdf: { baseDir: stage, files: [], include: [], urls: [target.url] } }
          : {
              ...base,
              web: {
                urls: [target.url],
                crawl: { sameOrigin: true, maxPages: limits.maxPages },
                maxPages: limits.maxPages,
                maxPagesSetting: 'default',
              },
            };
    } else {
      if (options.pdf === undefined) return failed('the job has no PDF to scan');
      if (options.pdf.byteLength > limits.pdfMaxBytes)
        return failed(`the PDF is over the ${limits.pdfMaxBytes / (1024 * 1024)} MiB limit`);
      const dir = join(stage, 'pdf');
      await mkdir(dir, { mode: 0o700 });
      await writeFile(join(dir, target.fileName), options.pdf, { flag: 'wx', mode: 0o600 });
      plan = { ...base, pdf: { baseDir: dir, files: [target.fileName], include: [], urls: [] } };
    }

    const outcome = await performHostedScan(
      {
        plan,
        reviews: [],
        hosted: {
          proxy: { server: options.proxyUrl },
          requestGuard: guardedRequestGuard(),
          fetcher,
          userAgent,
          pagePolicy,
          maxPolicySkips: maxPolicySkipsFor(limits),
          pdfMaxPages: limits.pdfMaxPages,
          linkedPdfs: false,
        },
      },
      { signal },
    );
    if (outcome.kind === 'cancelled' || signal.aborted) return failed('the scan was stopped');
    if (outcome.kind === 'error') return failed(hide(outcome.message));
    const { report, inputs } = outcome;
    // A PDF job is one file: when it was not scanned, there is nothing to report but why.
    if (plan.pdf && !plan.web && (inputs.pdf?.assets.length ?? 0) === 0)
      return failed(pdfNotScanned(inputs.pdf?.errors[0], limits));
    const result = { status: 'done' as const, reportJson: serializeJson(report) };
    if (reportBytes(result) > limits.reportMaxBytes) return failed(REPORT_TOO_LARGE);
    return result;
  } catch (e) {
    if (signal.aborted) return failed('the scan was stopped');
    return failed(`the scan failed: ${hide(firstLine(e))}`);
  } finally {
    await closeFetcher?.().catch(() => undefined);
    if (stage !== undefined)
      await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
  }
}
