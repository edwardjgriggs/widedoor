import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import type { Browser, BrowserContext, Locator, Page, Response } from 'playwright';
import { loadStandardsData, type Asset, type AxeMap, type Finding } from '@widedoor/core';
import {
  REFLOW_VIEWPORT,
  createHardenedContext,
  isInside,
  launchChromium,
  type HardeningOptions,
  type LaunchOptions,
} from './context.js';
import { createFetcher, type Fetcher } from './fetch.js';
import { writeFileReplacing } from './files.js';
import {
  AXE_TAGS,
  mergeViewports,
  normalizeAxeResults,
  type AxeTarget,
  type NormalizedPass,
} from './normalize.js';
import { reviewHashFor } from './review-hash-run.js';
import { DEFAULT_SITEMAP_LIMITS, loadSitemap, type SitemapLimits } from './sitemap.js';
import { isPageUrl, normalizeUrl, originOf } from './url.js';

/** Whether a URL names a PDF by its path (.pdf, any case). */
export const isPdfUrl = (url: string): boolean => /\.pdf$/i.test(new URL(url).pathname);

/** Links read from one page at most; a page with more is a gap in a crawl. */
export const MAX_LINKS_PER_PAGE = 5_000;
/** PDF links taken from one page at most (default of WebScanOptions.maxPdfLinksPerPage). */
export const DEFAULT_MAX_PDF_LINKS_PER_PAGE = 100;
/** PDF URLs handed on for fetching per run at most (default of WebScanOptions.maxPdfLinks). */
export const DEFAULT_MAX_PDF_LINKS = 200;

/** Default page cap (spec config `web.crawl.maxPages`). */
export const DEFAULT_MAX_PAGES = 50;

export type ScanErrorCode =
  | 'unsupported-url'
  | 'navigation-failed'
  | 'non-html-document'
  | 'no-response'
  | 'document-too-large'
  | 'navigated-away'
  | 'timeout'
  | 'scan-failed'
  | 'sitemap-failed';

/** A scan error is run metadata, never a Finding; the asset rolls up as Not Evaluated. */
export interface ScanError {
  uri: string;
  code: ScanErrorCode;
  /** First line of the underlying error message. */
  message: string;
}

/** A URL that loaded but was deliberately not scanned. Run metadata, never a Finding. */
export interface SkippedPage {
  url: string;
  finalUrl: string;
  reason: 'redirect-off-origin';
}

/** A PDF in the web scope, for the caller to fetch (fetchPdf) and scan as a PDF. */
export interface PdfLink {
  url: string;
  /** In scope by name (the URL list, or the sitemap without a crawl), not found by a crawl. */
  listed: boolean;
}

export interface PageScan {
  /** The URL as requested, normalized. */
  url: string;
  /** Present when the page was scanned: final URL and the sha256 of the served document. */
  asset?: Asset;
  findings: Finding[];
  /** Normalized http(s) links found in the page (a[href], area[href]). */
  links: string[];
  /** Links past MAX_LINKS_PER_PAGE that were not read from the page. */
  linksDropped?: number;
  /** The page's links could not be read (the page broke the read); a crawl records a scope gap. */
  linksUnread?: boolean;
  /** The document title as loaded, at most 500 characters; scanned content, so untrusted. */
  title?: string;
  error?: ScanError;
  skipped?: SkippedPage;
  /** The server answered with a PDF (application/pdf), which the browser does not scan: fetch it instead. */
  servedPdf?: boolean;
}

export interface WebScannerOptions extends HardeningOptions, LaunchOptions {
  /** Where element screenshots of failures go. Without it no screenshots are taken. */
  evidenceDir?: string;
  /** Screenshots taken per page at most (the rest keep their snippet only). Default 100. */
  maxScreenshotsPerPage?: number;
  /** Screenshot bytes written per scanner at most. Default 256 MiB. */
  maxEvidenceBytes?: number;
  /** Elements wider or taller than this many CSS px get no screenshot. Default 4000. */
  maxScreenshotPx?: number;
  /** Largest main document hashed and scanned, in bytes. Default 20 MiB. */
  maxDocumentBytes?: number;
  /** Navigation timeout in milliseconds, within the page deadline. Default 30000. */
  navigationTimeoutMs?: number;
  /** One wall-clock deadline per page: load, both axe passes, screenshots. Default 60000. */
  pageTimeoutMs?: number;
  /** Mapping data; defaults to the axe-map.yaml shipped in @widedoor/core. */
  axeMap?: AxeMap;
}

export interface ScanPageOptions {
  /** Scan a page whose redirects end on another origin. Default false: it is skipped. */
  allowOffOriginRedirect?: boolean;
}

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0] ?? '';

const sha256 = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Lets layout settle after a viewport change. */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );

class DocumentTooLarge extends Error {}

function locatorFor(page: Page, target: AxeTarget): Locator | undefined {
  let root: Pick<Page, 'locator'> = page;
  let locator: Locator | undefined;
  target.forEach((part, i) => {
    for (const sel of typeof part === 'string' ? [part] : part) {
      locator = (locator ?? root).locator(sel);
    }
    if (i < target.length - 1 && locator) {
      root = locator.contentFrame();
      locator = undefined;
    }
  });
  return locator?.first();
}

/** How long scanPage waits for a page's context to close before moving on. */
const CLOSE_WAIT_MS = 2_000;

/**
 * One Chromium instance (OS sandbox on unless unsafeNoSandbox). scanPage may
 * be called concurrently; each call uses its own hardened context and page.
 */
export class WebScanner {
  /** Run-metadata warnings, for example that the sandbox is off. */
  readonly warnings: string[] = [];
  private evidenceBytes = 0;

  private constructor(
    private readonly browser: Browser,
    private readonly axeMap: AxeMap,
    private readonly options: WebScannerOptions,
  ) {
    if (options.unsafeNoSandbox)
      this.warnings.push(
        'Chromium ran without its OS sandbox (unsafeNoSandbox); a browser exploit in a scanned page would run as this user.',
      );
  }

  /** Throws SandboxUnavailableError when the sandboxed browser cannot start. */
  static async launch(options: WebScannerOptions = {}): Promise<WebScanner> {
    const axeMap = options.axeMap ?? loadStandardsData().axe;
    if (options.storageState !== undefined && !existsSync(options.storageState))
      throw new Error(`storage state file not found: ${options.storageState}`);
    return new WebScanner(await launchChromium(options), axeMap, options);
  }

  get engineVersion(): string {
    return this.axeMap.meta.engineVersion;
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  private async axePass(page: Page, asset: Asset): Promise<NormalizedPass> {
    const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
    return normalizeAxeResults(results, asset, this.axeMap);
  }

  private async servedBytes(response: Response | null, page: Page): Promise<Uint8Array | null> {
    const max = this.options.maxDocumentBytes ?? 20 * 1024 * 1024;
    if (response) {
      const declared = Number((await response.allHeaders())['content-length']);
      if (Number.isFinite(declared) && declared > max) throw new DocumentTooLarge();
      const body = await response.body();
      if (body.length > max) throw new DocumentTooLarge();
      return body;
    }
    // Chromium gives no response object for some file: loads; the file is what was served.
    const url = page.url();
    const root = this.options.fileRoot;
    if (!url.startsWith('file:') || root === undefined) return null;
    const path = fileURLToPath(url);
    if (!isInside(resolve(root), path)) return null;
    if ((await stat(path)).size > max) throw new DocumentTooLarge();
    return readFile(path);
  }

  private async shoot(
    page: Page,
    pass: NormalizedPass,
    findings: Finding[],
    budget: { n: number },
  ) {
    const dir = this.options.evidenceDir;
    if (dir === undefined) return;
    // Screenshots of signed-in pages hold the user's data: keep them private.
    await mkdir(dir, { recursive: true, ...(this.options.storageState ? { mode: 0o700 } : {}) });
    // A link (or junction) planted at the folder would send screenshots elsewhere.
    if ((await lstat(dir)).isSymbolicLink()) return;
    const mode = this.options.storageState ? 0o600 : 0o644;
    const maxPx = this.options.maxScreenshotPx ?? 4000;
    const maxBytes = this.options.maxEvidenceBytes ?? 256 * 1024 * 1024;
    for (const f of findings) {
      if (budget.n <= 0 || this.evidenceBytes >= maxBytes) return;
      const target = pass.targets.get(f.id);
      if (f.outcome !== 'fail' || !target) continue;
      const locator = locatorFor(page, target);
      if (!locator) continue;
      const file = `${f.id}.png`;
      try {
        const box = await locator.boundingBox({ timeout: 2_000 });
        if (!box || box.width > maxPx || box.height > maxPx) continue;
        const png = await locator.screenshot({ timeout: 2_000, animations: 'disabled' });
        await writeFileReplacing(dir, file, png, mode);
        this.evidenceBytes += png.length;
        budget.n--;
        f.evidence = { ...f.evidence, screenshot: file };
      } catch {
        // Hidden, zero-size or detached elements have nothing to show.
      }
    }
  }

  /**
   * Loads one page, runs axe at 1280x800 and again at 320x256, and returns the
   * merged findings, all within one pageTimeoutMs deadline. Screenshot paths in
   * evidence are relative to evidenceDir. Never throws for page problems; they
   * come back as `error` (or `skipped` for an off-origin redirect).
   */
  async scanPage(input: string, options: ScanPageOptions = {}): Promise<PageScan> {
    let url: string;
    try {
      url = normalizeUrl(input);
    } catch (e) {
      return error(input, 'unsupported-url', e);
    }
    if (!isPageUrl(url, this.options.fileRoot !== undefined))
      return error(url, 'unsupported-url', `cannot scan ${new URL(url).protocol} URLs`);

    const deadline = this.options.pageTimeoutMs ?? 60_000;
    const started = Date.now();
    const remaining = () => Math.max(1, deadline - (Date.now() - started));
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<'expired'>((done) => {
      timer = setTimeout(() => done('expired'), deadline);
    });
    // Each page gets its own context: Chromium never shares a renderer process
    // across contexts, so a page that hangs its renderer cannot stall the next.
    let context: BrowserContext | undefined;
    const work = (async () => {
      context = await createHardenedContext(this.browser, this.options);
      return this.scanOpenPage(await context.newPage(), url, options, remaining);
    })();
    work.catch(() => undefined);
    try {
      const result = await Promise.race([work, expired]);
      if (result === 'expired')
        return error(url, 'timeout', `page did not finish within ${deadline} ms`);
      return result;
    } finally {
      clearTimeout(timer);
      // Closing the context ends any evaluate still running in it. Closing can
      // wait on a busy renderer, so it gets a bounded wait and then runs on.
      const closing = (async () => {
        const c = context ?? (await work.then(() => context).catch(() => context));
        await c?.close().catch(() => undefined);
      })();
      await Promise.race([closing, new Promise((done) => setTimeout(done, CLOSE_WAIT_MS))]);
    }
  }

  private async scanOpenPage(
    page: Page,
    url: string,
    options: ScanPageOptions,
    remaining: () => number,
  ): Promise<PageScan> {
    // The last main-frame document response: a PDF makes goto fail ("Download is starting").
    let served: Response | undefined;
    page.on('response', (r) => {
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) served = r;
    });
    let response: Response | null;
    try {
      response = await page.goto(url, {
        waitUntil: 'load',
        timeout: Math.min(this.options.navigationTimeoutMs ?? 30_000, remaining()),
      });
    } catch (e) {
      if (served && isPdfType(served.headers()['content-type']))
        return servedPdf(url, normalizeUrl(served.url()), options);
      return error(url, 'navigation-failed', e);
    }
    // Any later document load means page script replaced what was requested.
    let replaced = false;
    page.on('domcontentloaded', () => {
      replaced = true;
    });
    const navigatedAway = (uri: string) =>
      error(url, 'navigated-away', 'the page navigated to another document during the scan', uri);
    try {
      const uri = normalizeUrl(response?.url() ?? page.url());
      if (!options.allowOffOriginRedirect && originOf(uri) !== originOf(url))
        return {
          url,
          findings: [],
          links: [],
          skipped: { url, finalUrl: uri, reason: 'redirect-off-origin' },
        };
      // axe-core needs an HTML document; SVG, XML and the like are reported, not scanned.
      const contentType = await page.evaluate(() => document.contentType);
      if (isPdfType(contentType)) return servedPdf(url, uri, options);
      if (contentType !== 'text/html')
        return error(url, 'non-html-document', `document is ${contentType}`, uri);
      let bytes: Uint8Array | null;
      try {
        bytes = await this.servedBytes(response, page);
      } catch (e) {
        if (e instanceof DocumentTooLarge)
          return error(url, 'document-too-large', 'the document is over maxDocumentBytes', uri);
        throw e;
      }
      if (!bytes)
        return error(url, 'no-response', 'the browser returned no document response', uri);
      const contentHash = sha256(bytes);
      const review = await reviewHashFor(bytes, contentHash);
      if (review.fallback)
        this.warnings.push(
          `${uri}: manual reviews are anchored to the content hash (${review.fallback})`,
        );
      const asset: Asset = { kind: 'web', uri, contentHash, reviewHash: review.hash };
      const title = (await page.title().catch(() => '')).slice(0, 500);

      const budget = { n: this.options.maxScreenshotsPerPage ?? 100 };
      const desktop = await this.axePass(page, asset);
      if (replaced) return navigatedAway(uri);
      await this.shoot(page, desktop, desktop.findings, budget);
      await page.setViewportSize({ ...REFLOW_VIEWPORT });
      await settle(page);
      const reflow = await this.axePass(page, asset);
      if (replaced) return navigatedAway(uri);
      const findings = mergeViewports(desktop.findings, reflow.findings, REFLOW_VIEWPORT);
      const reflowOnly = findings.filter((f) => f.evidence?.viewport && !f.evidence.screenshot);
      await this.shoot(page, reflow, reflowOnly, budget);

      const { links, total, read, unread } = await readLinks(page);
      return {
        url,
        asset,
        findings,
        links,
        ...(total > read ? { linksDropped: total - read } : {}),
        ...(unread ? { linksUnread: true } : {}),
        ...(title ? { title } : {}),
      };
    } catch (e) {
      return error(url, 'scan-failed', e);
    }
  }
}

/**
 * The page's links: at most MAX_LINKS_PER_PAGE leave the page (the rest are
 * only counted), normalized and limited to page URLs. When the page breaks
 * the read (its context is gone, or its script interferes), unread is true
 * and there are no links: a crawl records that as a scope gap instead of
 * silently losing the page's frontier.
 */
export async function readLinks(
  page: Pick<Page, 'evaluate'>,
): Promise<{ links: string[]; total: number; read: number; unread: boolean }> {
  let unread = false;
  const { hrefs, total } = await page
    .evaluate((max) => {
      const all = document.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>(
        'a[href], area[href]',
      );
      const hrefs: string[] = [];
      for (let i = 0; i < all.length && i < max; i++) hrefs.push(all[i]!.href);
      return { hrefs, total: all.length };
    }, MAX_LINKS_PER_PAGE)
    .catch(() => {
      unread = true;
      return { hrefs: [] as string[], total: 0 };
    });
  const links = new Set<string>();
  for (const href of hrefs) {
    try {
      const n = normalizeUrl(href);
      if (isPageUrl(n)) links.add(n);
    } catch {
      // Unparseable hrefs are not pages.
    }
  }
  return { links: [...links], total, read: hrefs.length, unread };
}

const isPdfType = (type: string | undefined) =>
  type?.split(';')[0]?.trim().toLowerCase() === 'application/pdf';

/** A page that turned out to be a PDF: handed on for fetching, unless it redirected off-origin. */
function servedPdf(url: string, finalUrl: string, options: ScanPageOptions): PageScan {
  if (!options.allowOffOriginRedirect && originOf(finalUrl) !== originOf(url))
    return {
      url,
      findings: [],
      links: [],
      skipped: { url, finalUrl, reason: 'redirect-off-origin' },
    };
  return { url, findings: [], links: [], servedPdf: true };
}

function error(url: string, code: ScanErrorCode, e: unknown, uri = url): PageScan {
  return {
    url,
    findings: [],
    links: [],
    error: { uri, code, message: typeof e === 'string' ? e : firstLine(e) },
  };
}

export interface WebScope {
  /** Pages to scan. */
  urls?: readonly string[];
  /** sitemap.xml (or .xml.gz) whose same-origin URLs are added to the scope. */
  sitemap?: string;
  /** Follow links from scanned pages. Without it only urls and sitemap entries are scanned. */
  crawl?: { sameOrigin?: boolean; maxPages?: number };
  /**
   * Pages scanned at most in all (default 50). crawl.maxPages, when set, takes
   * precedence: it is the more specific setting.
   */
  maxPages?: number;
}

export interface WebScanOptions extends WebScannerOptions {
  /** Pages scanned in parallel. Default 2. */
  concurrency?: number;
  sitemapLimits?: SitemapLimits;
  /** HTTP client for everything fetched outside the browser. Default: same-origin redirects only. */
  fetcher?: Fetcher;
  /** PDF links taken from one page at most; the rest are a scope gap. Default 100. */
  maxPdfLinksPerPage?: number;
  /** PDF URLs handed on per run at most; the rest are a scope gap. Default 200. */
  maxPdfLinks?: number;
  /**
   * Stops the scan: no page is started after it fires, the browser is
   * closed (ending the pages in flight), and scanWeb rejects with its reason.
   */
  signal?: AbortSignal;
  /** Told when a page starts and when it is done: pages done, pages known so far (at most maxPages), and the page started. */
  onProgress?: (progress: ScanProgress) => void;
}

/** How far a scan is: assets done, assets known so far, and the one just started. */
export interface ScanProgress {
  done: number;
  known: number;
  current?: string;
}

export interface WebScanResult {
  engine: { name: 'axe-core'; version: string };
  pages: PageScan[];
  assets: Asset[];
  findings: Finding[];
  errors: ScanError[];
  /** Pages that redirected off-origin and were not scanned. */
  skipped: SkippedPage[];
  /**
   * PDFs in scope (by URL, by link, or served as application/pdf to the
   * browser), deduped, in the order found. The browser never scans them.
   */
  pdfs: PdfLink[];
  warnings: string[];
  /** True when maxPages stopped the scan with pages still queued. */
  truncated: boolean;
  /**
   * Listed URLs (and sitemap URLs when there is no crawl) that maxPages left
   * unscanned. They were in scope by name, so the CLI exits 2 on them.
   */
  unscannedListed: number;
  /** The page cap the run used. */
  maxPages: number;
  /**
   * Why the scope is incomplete beyond the listed pages: a sitemap read only
   * in part, links past a cap. Each is also a warning.
   */
  scopeGaps: string[];
}

/**
 * Resolves the scope (URL list, sitemap, crawl) and scans every page, at most
 * maxPages (default 50) in all. URLs are deduped after normalization. A crawl
 * follows links only to the origins of the URL list and the sitemap, and a
 * page that redirects to another origin is skipped, unless sameOrigin is false.
 */
export async function scanWeb(
  scope: WebScope,
  options: WebScanOptions = {},
): Promise<WebScanResult> {
  const maxPages = scope.crawl?.maxPages ?? scope.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1)
    throw new Error(`maxPages must be a positive integer, got ${maxPages}`);
  const crossOrigin = scope.crawl?.sameOrigin === false;
  if (crossOrigin && options.storageState !== undefined)
    throw new Error('an authenticated scan (storageState) cannot crawl with sameOrigin: false');

  const errors: ScanError[] = [];
  const scopeGaps: string[] = [];
  const seeds: string[] = [];
  const listedSeeds: string[] = [];
  for (const u of scope.urls ?? []) {
    try {
      seeds.push(normalizeUrl(u));
      listedSeeds.push(seeds.at(-1) as string);
    } catch (e) {
      errors.push({ uri: u, code: 'unsupported-url', message: firstLine(e) });
    }
  }
  if (scope.sitemap !== undefined) {
    try {
      seeds.push(
        ...(await loadSitemap(
          scope.sitemap,
          options.sitemapLimits ?? DEFAULT_SITEMAP_LIMITS,
          options.fetcher ?? createFetcher(),
          scopeGaps,
        )),
      );
    } catch (e) {
      errors.push({ uri: scope.sitemap, code: 'sitemap-failed', message: firstLine(e) });
    }
  }
  // Pages in scope by name: the URL list always, the sitemap only when there is no crawl.
  const listed = new Set(scope.crawl === undefined ? seeds : listedSeeds);
  const origins = new Set(seeds.map(originOf));
  if (scope.sitemap !== undefined) origins.add(originOf(scope.sitemap));
  const follow = (link: string) =>
    scope.crawl !== undefined && (crossOrigin || origins.has(originOf(link)));

  const seen = new Set<string>();
  const assetUris = new Set<string>();
  const queue: string[] = [];
  const pdfs: PdfLink[] = [];
  const maxPdfLinks = options.maxPdfLinks ?? DEFAULT_MAX_PDF_LINKS;
  const maxPdfPerPage = options.maxPdfLinksPerPage ?? DEFAULT_MAX_PDF_LINKS_PER_PAGE;
  let pdfOverRun = 0;
  let pdfOverPage = 0;
  let linksDropped = 0;
  const enqueue = (u: string) => {
    if (seen.has(u)) return;
    seen.add(u);
    // A .pdf URL is never loaded in the browser and spends no page: it is handed on (up to a cap).
    if (!isPdfUrl(u)) queue.push(u);
    else if (pdfs.length < maxPdfLinks) pdfs.push({ url: u, listed: listed.has(u) });
    else pdfOverRun++;
  };
  seeds.forEach(enqueue);
  const enqueueLinks = (links: readonly string[]) => {
    let pdfs = 0;
    for (const link of links) {
      if (!follow(link)) continue;
      if (isPdfUrl(link) && !seen.has(link) && ++pdfs > maxPdfPerPage) {
        seen.add(link);
        pdfOverPage++;
        continue;
      }
      enqueue(link);
    }
  };

  const { signal, onProgress } = options;
  signal?.throwIfAborted();
  const scanner = await WebScanner.launch(options);
  // Closing the browser ends every page in flight; the loop starts no other.
  const stop = () => void scanner.close().catch(() => undefined);
  signal?.addEventListener('abort', stop, { once: true });
  const pages: { order: number; scan: PageScan }[] = [];
  try {
    const concurrency = Math.max(1, options.concurrency ?? 2);
    const pending = new Set<Promise<void>>();
    let claimed = 0;
    const progress = (current?: string) =>
      onProgress?.({
        done: pages.length,
        known: Math.min(maxPages, claimed + queue.length),
        ...(current !== undefined ? { current } : {}),
      });
    for (;;) {
      while (
        pending.size < concurrency &&
        claimed < maxPages &&
        queue.length > 0 &&
        !signal?.aborted
      ) {
        const url = queue.shift() as string;
        // Already scanned as another URL's redirect target: do not spend a page on it.
        if (assetUris.has(url)) continue;
        const order = claimed++;
        progress(url);
        const task: Promise<void> = scanner
          .scanPage(url, { allowOffOriginRedirect: crossOrigin })
          .then((scan) => {
            pages.push({ order, scan });
            // Already a page of the scan, so no PDF cap applies.
            if (scan.servedPdf) pdfs.push({ url, listed: listed.has(url) });
            if (scan.asset) {
              seen.add(scan.asset.uri);
              assetUris.add(scan.asset.uri);
            }
            if (scan.linksDropped && scope.crawl !== undefined) linksDropped += scan.linksDropped;
            if (scan.linksUnread && scope.crawl !== undefined)
              scopeGaps.push(
                `links on ${scan.asset?.uri ?? url} could not be read, so they were not followed`,
              );
            enqueueLinks(scan.links);
            progress();
          });
        pending.add(task);
        const done = () => void pending.delete(task);
        task.then(done, done);
      }
      if (pending.size === 0) break;
      await Promise.race(pending);
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    await scanner.close();
  }
  signal?.throwIfAborted();

  pages.sort((a, b) => a.order - b.order);
  const assets: Asset[] = [];
  const findings: Finding[] = [];
  const skipped: SkippedPage[] = [];
  const scanned = new Set<string>();
  const result: PageScan[] = [];
  for (const { scan } of pages) {
    if (scan.error) errors.push(scan.error);
    if (scan.skipped) skipped.push(scan.skipped);
    // Two queued URLs that redirect to one page yield one asset.
    if (scan.asset && scanned.has(scan.asset.uri)) continue;
    if (scan.asset) {
      scanned.add(scan.asset.uri);
      assets.push(scan.asset);
    }
    findings.push(...scan.findings);
    result.push(scan);
  }
  if (pdfOverPage > 0)
    scopeGaps.push(
      `${pdfOverPage} PDF link(s) were not scanned: at most ${maxPdfPerPage} are taken from one page`,
    );
  if (pdfOverRun > 0)
    scopeGaps.push(
      `${pdfOverRun} PDF link(s) were not scanned: at most ${maxPdfLinks} are scanned per run`,
    );
  const unscannedListed = new Set(queue.filter((u) => listed.has(u))).size;
  if (unscannedListed > 0)
    scopeGaps.push(
      `${unscannedListed} listed page(s) were not scanned: at most ${maxPages} pages are scanned per run`,
    );
  if (linksDropped > 0)
    scopeGaps.push(
      `${linksDropped} link(s) were not followed: at most ${MAX_LINKS_PER_PAGE} are read from one page`,
    );
  return {
    engine: { name: 'axe-core', version: scanner.engineVersion },
    pages: result,
    assets,
    findings,
    errors,
    skipped,
    pdfs,
    warnings: [...scanner.warnings, ...scopeGaps],
    truncated: queue.length > 0,
    scopeGaps,
    unscannedListed,
    maxPages,
  };
}
