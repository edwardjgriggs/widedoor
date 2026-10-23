/*
 * The adapter's only HTTP client outside the browser (today: sitemaps). Every
 * redirect is followed by hand (`redirect: 'manual'`) so a policy hook sees
 * each hop before it is requested. The default hook keeps every hop on the
 * origin of the first URL. Phase 3 (hosted SSRF guard) swaps in a hook that
 * resolves DNS and rejects private ranges, and a `request` that pins the
 * resolved address; nothing else has to change.
 */

export class EgressRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressRefusedError';
  }
}

/** Called before every request, including the first. Throw (or reject) to refuse the hop. */
export type HopCheck = (hop: URL, start: URL) => void | Promise<void>;

/** Refuses any hop that leaves the origin of the first URL. */
export const sameOriginHop: HopCheck = (hop, start) => {
  if (hop.origin !== start.origin)
    throw new EgressRefusedError(`redirect to ${hop.origin} leaves ${start.origin}`);
};

export interface FetcherOptions {
  /** Low-level request; defaults to global fetch. Always called with redirect: 'manual'. */
  request?: (url: string, init: RequestInit) => Promise<Response>;
  /** Per-hop policy. Defaults to sameOriginHop. */
  checkHop?: HopCheck;
  /** Redirects followed at most. Default 5. */
  maxRedirects?: number;
}

export interface FetchResult {
  response: Response;
  /** URL of the final hop. */
  url: string;
}

export type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResult>;

export function createFetcher(options: FetcherOptions = {}): Fetcher {
  const request = options.request ?? ((url, init) => fetch(url, init));
  const checkHop = options.checkHop ?? sameOriginHop;
  const maxRedirects = options.maxRedirects ?? 5;
  return async (url, init = {}) => {
    const start = new URL(url);
    let current = start;
    for (let hop = 0; ; hop++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:')
        throw new EgressRefusedError(`refusing ${current.protocol} URL ${current.href}`);
      await checkHop(current, start);
      const response = await request(current.href, {
        redirect: 'manual',
        ...(init.signal ? { signal: init.signal } : {}),
      });
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || location === null)
        return { response, url: current.href };
      await response.body?.cancel();
      if (hop >= maxRedirects) throw new EgressRefusedError(`more than ${maxRedirects} redirects`);
      current = new URL(location, current);
    }
  };
}
