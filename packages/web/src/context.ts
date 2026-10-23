import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
} from 'playwright';
import type { Viewport } from '@widedoor/core';

/** Desktop viewport for the main pass (spec: 1280x800). */
export const DESKTOP_VIEWPORT: Readonly<Viewport> = { width: 1280, height: 800 };
/** Reflow viewport (WCAG 1.4.10: 320 CSS px wide, the 400% zoom of 1280x1024). */
export const REFLOW_VIEWPORT: Readonly<Viewport> = { width: 320, height: 256 };

/** What a caller-supplied request hook decided for one http(s) request. */
export type InterceptDecision =
  'continue' | 'abort' | { status?: number; body: string | Buffer; contentType?: string };

/** What the request guard sees for one browser request. */
export interface GuardedRequest {
  url: URL;
  isNavigation: boolean;
  resourceType: string;
}

/**
 * Policy hook for every http(s) request the browser routes; resolve false to
 * block it. Playwright routes only the first URL of a redirect chain, never
 * the hops, and does not route WebRTC or preconnect sockets, so this is a
 * second layer: the Phase 3 hosted guard adds an egress proxy in front.
 */
export type RequestGuard = (request: GuardedRequest) => boolean | Promise<boolean>;

export interface HardeningOptions {
  /**
   * Directory that file: URLs may load from (the page itself and its
   * subresources). Without it, every file: URL is blocked.
   */
  fileRoot?: string;
  /** Checked for every http(s) request before `intercept`; false blocks it. */
  requestGuard?: RequestGuard;
  /**
   * Called for every http(s) request the guard allows. Returning undefined
   * lets it through. The corpus uses this to serve ACT test cases offline and
   * to block the network.
   */
  intercept?: (url: string) => InterceptDecision | undefined;
  /**
   * Playwright storage state file (cookies and localStorage) for authenticated
   * scans. CLI and self-host only, never the hosted scanner. Scanned page
   * scripts can read every non-HttpOnly cookie and all localStorage it holds,
   * and screenshots of signed-in pages hold the user's data.
   */
  storageState?: string;
}

export interface LaunchOptions {
  /**
   * Run Chromium without its OS sandbox. Off by default: a renderer exploit in
   * a scanned page then runs as the user. Set it only where the sandbox cannot
   * start; the scan records a warning.
   */
  unsafeNoSandbox?: boolean;
}

export class SandboxUnavailableError extends Error {
  constructor(cause: unknown) {
    const why = String((cause as Error)?.message ?? cause).split('\n')[0];
    super(
      `Chromium could not start with its OS sandbox (${why}). Widedoor does not fall back to an ` +
        'unsandboxed browser. On Linux this usually means unprivileged user namespaces are ' +
        'blocked (Ubuntu 23.10 and later: kernel.apparmor_restrict_unprivileged_userns=1) or the ' +
        'scan runs as root. Fix the host, or set unsafeNoSandbox to accept the risk.',
      { cause },
    );
    this.name = 'SandboxUnavailableError';
  }
}

export const chromiumLaunchOptions = (options: LaunchOptions = {}) => ({
  headless: true,
  chromiumSandbox: options.unsafeNoSandbox !== true,
});

/** Launches Chromium with its sandbox on, failing closed when the sandbox cannot start. */
export async function launchChromium(options: LaunchOptions = {}): Promise<Browser> {
  const launch = chromiumLaunchOptions(options);
  try {
    return await chromium.launch(launch);
  } catch (e) {
    if (launch.chromiumSandbox) throw new SandboxUnavailableError(e);
    throw e;
  }
}

/** Whether `file` lies strictly inside `dir`. */
export function isInside(dir: string, file: string): boolean {
  const rel = relative(resolve(dir), resolve(file));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Whether a request comes from a page the caller did not open with
 * context.newPage(): a popup (window.open, target=_blank, with or without
 * noopener). AxeBuilder opens its finishRun page through newPage, so it counts.
 */
function fromPopup(request: Request, owned: WeakSet<Page>): boolean {
  let page: Page;
  try {
    page = request.frame().page();
  } catch {
    // No frame yet: a popup's first navigation, or a worker (and workers are blocked).
    return true;
  }
  return !owned.has(page);
}

/**
 * A browser context no scanned page can use to leave the scan: downloads are
 * refused, service workers cannot register, WebSockets are closed, popups
 * load nothing and are closed, and file: URLs load only from `fileRoot`.
 */
export async function createHardenedContext(
  browser: Browser,
  options: HardeningOptions = {},
): Promise<BrowserContext> {
  if (options.storageState !== undefined && !existsSync(options.storageState))
    throw new Error(`storage state file not found: ${options.storageState}`);
  const context = await browser.newContext({
    viewport: { ...DESKTOP_VIEWPORT },
    acceptDownloads: false,
    serviceWorkers: 'block',
    ...(options.storageState !== undefined ? { storageState: options.storageState } : {}),
  });
  const fileRoot = options.fileRoot === undefined ? undefined : resolve(options.fileRoot);
  const owned = new WeakSet<Page>();
  const newPage = context.newPage.bind(context);
  context.newPage = async () => {
    const page = await newPage();
    owned.add(page);
    return page;
  };

  await context.routeWebSocket(/.*/, (ws) => ws.close());
  await context.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = request.url();
    const parsed = new URL(url);
    if (fromPopup(request, owned)) return route.abort('blockedbyclient');
    if (parsed.protocol === 'file:') {
      return fileRoot !== undefined && isInside(fileRoot, fileURLToPath(url))
        ? route.continue()
        : route.abort('blockedbyclient');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return route.abort('blockedbyclient');
    if (options.requestGuard) {
      const allowed = await options.requestGuard({
        url: parsed,
        isNavigation: request.isNavigationRequest(),
        resourceType: request.resourceType(),
      });
      if (!allowed) return route.abort('blockedbyclient');
    }
    const decision = options.intercept?.(url) ?? 'continue';
    if (decision === 'continue') return route.continue();
    if (decision === 'abort') return route.abort('blockedbyclient');
    return route.fulfill({
      status: decision.status ?? 200,
      body: decision.body,
      ...(decision.contentType !== undefined ? { contentType: decision.contentType } : {}),
    });
  });
  context.on('page', (page) => page.on('popup', (popup) => void popup.close()));
  return context;
}
