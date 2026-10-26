import { firstLine, safeText } from '@widedoor/core';

/*
 * The adapter's only HTTP client outside the browser (sitemaps and PDFs by URL). Every
 * redirect is followed by hand (`redirect: 'manual'`) so a policy hook sees
 * each hop before it is requested. The default hook keeps every hop on the
 * origin of the first URL. Phase 3 (hosted SSRF guard) swaps in a hook that
 * resolves DNS and rejects private ranges, and a `request` that pins the
 * resolved address; nothing else has to change.
 */

/**
 * Why a hop was refused. A caller may treat off-origin differently (a crawled
 * PDF link that redirects away is a scope gap); a hook (Phase 3's SSRF guard)
 * picks its own reason, "policy" by default.
 */
export type EgressRefusal = 'off-origin' | 'redirect-limit' | 'scheme' | 'policy';

export class EgressRefusedError extends Error {
  constructor(
    message: string,
    readonly reason: EgressRefusal = 'policy',
  ) {
    super(message);
    this.name = 'EgressRefusedError';
  }
}

/** Called before every request, including the first. Throw (or reject) to refuse the hop. */
export type HopCheck = (hop: URL, start: URL) => void | Promise<void>;

/** Refuses any hop that leaves the origin of the first URL. */
export const sameOriginHop: HopCheck = (hop, start) => {
  if (hop.origin !== start.origin)
    throw new EgressRefusedError(`redirect to ${hop.origin} leaves ${start.origin}`, 'off-origin');
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
        throw new EgressRefusedError(`refusing ${current.protocol} URL ${current.href}`, 'scheme');
      await checkHop(current, start);
      const response = await request(current.href, {
        redirect: 'manual',
        ...(init.signal ? { signal: init.signal } : {}),
      });
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || location === null)
        return { response, url: current.href };
      await response.body?.cancel();
      if (hop >= maxRedirects)
        throw new EgressRefusedError(`more than ${maxRedirects} redirects`, 'redirect-limit');
      current = new URL(location, current);
    }
  };
}

/** Largest PDF fetched by URL (spec config `pdf.maxBytes`), in bytes. */
export const DEFAULT_MAX_PDF_BYTES = 50 * 1024 * 1024;
/** Wall-clock limit for fetching one PDF, redirects and body included. */
export const DEFAULT_PDF_FETCH_TIMEOUT_MS = 60_000;

export type PdfFetchErrorCode =
  | 'pdf-redirect-off-origin'
  | 'pdf-fetch-refused'
  | 'pdf-fetch-failed'
  | 'pdf-too-large'
  | 'not-a-pdf'
  | 'timeout';

/** Why a PDF URL gave no PDF. The message is safe to print (safeText). */
export class PdfFetchError extends Error {
  constructor(
    readonly code: PdfFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PdfFetchError';
  }
}

export interface PdfFetchOptions {
  /** Largest body read, in bytes; counted while streaming. Default 50 MiB. */
  maxBytes?: number;
  /** Default 60000. */
  timeoutMs?: number;
  /** Cancels the fetch (request and body) at once; fetchPdf then rejects with its reason. */
  signal?: AbortSignal;
}

const MIB = 1024 * 1024;
const sizeText = (bytes: number) => (bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${bytes} bytes`);
const tooLarge = (max: number) =>
  new PdfFetchError('pdf-too-large', `the PDF is over the ${sizeText(max)} limit (pdf.maxBytes)`);
const notAPdf = () =>
  new PdfFetchError('not-a-pdf', 'the response is not a PDF (it does not start with %PDF-)');

/** A failure of the caller's write, passed through untouched rather than read as a network error. */
class WriteFailed extends Error {}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/**
 * Hands the body to write chunk by chunk, so no more than one chunk is held
 * in memory. Stops (and cancels the stream) once the body passes max bytes,
 * and as soon as its first bytes are not %PDF-.
 */
async function streamBody(
  response: Response,
  max: number,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<number> {
  const reader = response.body?.getReader();
  if (!reader) throw notAPdf();
  const head: number[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) throw tooLarge(max);
      for (let i = 0; head.length < PDF_MAGIC.length && i < value.length; i++)
        head.push(value[i] as number);
      if (head.some((b, i) => b !== PDF_MAGIC[i])) throw notAPdf();
      await write(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  if (head.length < PDF_MAGIC.length) throw notAPdf();
  return length;
}

/**
 * Fetches one PDF with the fetcher (so its hop check sees every redirect),
 * within one timeout and a byte cap enforced while the body streams to write.
 * The body must start with %PDF-: a Content-Type never makes something a PDF.
 * Resolves with the URL of the final hop. Throws PdfFetchError (or what
 * write threw); write may have had part of the body by then.
 */
export async function fetchPdf(
  fetcher: Fetcher,
  url: string,
  write: (chunk: Uint8Array) => Promise<void>,
  options: PdfFetchOptions = {},
): Promise<{ url: string; bytes: number }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PDF_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PDF_FETCH_TIMEOUT_MS;
  const { signal } = options;
  signal?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    let fetched: FetchResult;
    try {
      fetched = await fetcher(url, { signal: controller.signal });
    } catch (e) {
      if (e instanceof EgressRefusedError)
        throw new PdfFetchError(
          e.reason === 'off-origin' ? 'pdf-redirect-off-origin' : 'pdf-fetch-refused',
          safeText(firstLine(e), 300),
        );
      throw e;
    }
    const { response } = fetched;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PdfFetchError('pdf-fetch-failed', `the server answered ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw tooLarge(maxBytes);
    }
    const sink = async (chunk: Uint8Array) => {
      try {
        await write(chunk);
      } catch (e) {
        throw new WriteFailed('write failed', { cause: e });
      }
    };
    return { url: fetched.url, bytes: await streamBody(response, maxBytes, sink) };
  } catch (e) {
    if (e instanceof PdfFetchError) throw e;
    if (e instanceof WriteFailed) throw e.cause;
    signal?.throwIfAborted();
    if (controller.signal.aborted)
      throw new PdfFetchError('timeout', `the PDF did not arrive within ${timeoutMs} ms`);
    // Node's fetch says only "fetch failed"; the cause names the network error.
    const cause = (e as { cause?: { code?: unknown } })?.cause?.code;
    throw new PdfFetchError(
      'pdf-fetch-failed',
      safeText(`${firstLine(e)}${typeof cause === 'string' ? ` (${cause})` : ''}`, 300),
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
