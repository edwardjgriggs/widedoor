import { gunzipSync } from 'node:zlib';
import { createFetcher, type Fetcher } from './fetch.js';
import { normalizeUrl, originOf } from './url.js';

/*
 * sitemap.xml support (sitemaps.org protocol): a urlset or a sitemap index one
 * level deep, plain or gzip. Parsing is a single forward indexOf scan for
 * <loc> elements, not an XML parser: no DTD or external entity is ever
 * processed, and the cursor only moves forward, so time is linear in the
 * input. Every input is size-capped.
 */

export interface SitemapLimits {
  /** Largest sitemap after decompression, in bytes (the protocol allows 50 MB). */
  maxBytes: number;
  /** Largest gzip input, in bytes; enforced while downloading. */
  maxCompressedBytes: number;
  /** Most page URLs returned across all sitemaps (the protocol allows 50,000 per file). */
  maxUrls: number;
  /** Most child sitemaps read from a sitemap index. */
  maxSitemaps: number;
  /** Per-request timeout, in milliseconds. */
  timeoutMs: number;
}

export const DEFAULT_SITEMAP_LIMITS: SitemapLimits = {
  maxBytes: 50 * 1024 * 1024,
  maxCompressedBytes: 10 * 1024 * 1024,
  maxUrls: 50_000,
  maxSitemaps: 50,
  timeoutMs: 30_000,
};

export class SitemapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SitemapError';
  }
}

export interface ParsedSitemap {
  kind: 'urlset' | 'sitemapindex';
  locs: string[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlText(text: string): string {
  // Bounded quantifiers keep this linear; an out-of-range reference stays as written.
  return text.replace(/&(#x[0-9a-f]{1,8}|#[0-9]{1,10}|[a-z]{1,8});/gi, (whole, ref: string) => {
    const hex = ref[1] === 'x' || ref[1] === 'X';
    if (ref.startsWith('#')) {
      const cp = parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** Drops <!-- --> comments in one pass; an unclosed comment runs to the end. */
function stripComments(xml: string): string {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const open = xml.indexOf('<!--', i);
    if (open < 0) {
      parts.push(xml.slice(i));
      break;
    }
    parts.push(xml.slice(i, open));
    const close = xml.indexOf('-->', open + 4);
    if (close < 0) break;
    i = close + 3;
  }
  return parts.join('');
}

const NAME_MAX = 64;
const isNameChar = (c: number) =>
  (c >= 0x61 && c <= 0x7a) || // a-z
  (c >= 0x41 && c <= 0x5a) || // A-Z
  (c >= 0x30 && c <= 0x39) || // 0-9
  c === 0x2d || // -
  c === 0x2e || // .
  c === 0x3a || // :
  c === 0x5f; // _

interface Tag {
  closing: boolean;
  /** Lowercased local name (namespace prefix dropped). */
  local: string;
  /** Index just past the name. */
  end: number;
}

/** Reads the tag name at s[i] === '<'. Reads at most NAME_MAX name characters. */
function readTag(s: string, i: number): Tag | undefined {
  let j = i + 1;
  const closing = s.charCodeAt(j) === 0x2f; // '/'
  if (closing) j++;
  const start = j;
  while (j < s.length && j - start < NAME_MAX && isNameChar(s.charCodeAt(j))) j++;
  if (j === start) return undefined;
  const name = s.slice(start, j).toLowerCase();
  return { closing, local: name.slice(name.lastIndexOf(':') + 1), end: j };
}

/** Reads the <loc> values of a urlset or sitemapindex document. */
export function parseSitemap(xml: string): ParsedSitemap {
  const s = stripComments(xml);

  let kind: ParsedSitemap['kind'] | undefined;
  for (let i = s.indexOf('<'); i >= 0; i = s.indexOf('<', i + 1)) {
    const next = s[i + 1];
    if (next === '?' || next === '!') continue; // declaration, DOCTYPE
    const tag = readTag(s, i);
    if (tag && !tag.closing && (tag.local === 'urlset' || tag.local === 'sitemapindex'))
      kind = tag.local;
    break; // only the root element decides
  }
  if (!kind) throw new SitemapError('not a sitemap: no <urlset> or <sitemapindex> element');

  const locs: string[] = [];
  let i = 0;
  while ((i = s.indexOf('<', i)) >= 0) {
    const tag = readTag(s, i);
    if (!tag || tag.closing || tag.local !== 'loc') {
      i = tag ? tag.end : i + 1;
      continue;
    }
    const gt = s.indexOf('>', tag.end);
    if (gt < 0) break;
    if (s[gt - 1] === '/') {
      i = gt + 1; // <loc/>
      continue;
    }
    let textStart = gt + 1;
    while (textStart < s.length && /\s/.test(s[textStart] ?? '')) textStart++;
    let text: string;
    let close: number;
    if (s.startsWith('<![CDATA[', textStart)) {
      const end = s.indexOf(']]>', textStart + 9);
      if (end < 0) break;
      text = s.slice(textStart + 9, end);
      close = s.indexOf('</', end + 3);
    } else {
      close = s.indexOf('</', textStart);
      text = close < 0 ? '' : decodeXmlText(s.slice(textStart, close));
    }
    if (close < 0) break;
    const end = readTag(s, close);
    // A loc closed by anything but </loc> is malformed and skipped.
    if (end?.local === 'loc') {
      const loc = text.trim();
      if (loc) locs.push(loc);
    }
    i = end ? end.end : close + 2;
  }
  return { kind, locs };
}

const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/** Decodes sitemap bytes, gunzipping when they start with the gzip magic number. */
export function decodeSitemapBytes(bytes: Uint8Array, limits: SitemapLimits): string {
  if (!isGzip(bytes)) {
    if (bytes.length > limits.maxBytes)
      throw new SitemapError(`sitemap is larger than ${limits.maxBytes} bytes`);
    return new TextDecoder('utf-8').decode(bytes);
  }
  if (bytes.length > limits.maxCompressedBytes)
    throw new SitemapError(`gzip sitemap is larger than ${limits.maxCompressedBytes} bytes`);
  let out: Buffer;
  try {
    out = gunzipSync(bytes, { maxOutputLength: limits.maxBytes });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)
      throw new SitemapError(`gzip sitemap expands past ${limits.maxBytes} bytes`);
    throw new SitemapError(`gzip sitemap is corrupt: ${(e as Error).message}`);
  }
  return new TextDecoder('utf-8').decode(out);
}

/**
 * Downloads a sitemap into memory. The cap is maxBytes for plain XML and
 * maxCompressedBytes once the first bytes show gzip; the read stops as soon
 * as the cap is passed.
 */
async function fetchCapped(
  fetcher: Fetcher,
  url: string,
  limits: SitemapLimits,
): Promise<Uint8Array> {
  const { response } = await fetcher(url, { signal: AbortSignal.timeout(limits.timeoutMs) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new SitemapError(`sitemap ${url} returned HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limits.maxBytes) {
    await response.body?.cancel();
    throw new SitemapError(`sitemap ${url} is larger than ${limits.maxBytes} bytes`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cap = limits.maxBytes;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total === 0 && isGzip(value)) cap = limits.maxCompressedBytes;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new SitemapError(
        `${cap === limits.maxBytes ? 'sitemap' : 'gzip sitemap'} ${url} is larger than ${cap} bytes`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Page URLs listed by the sitemap at `url`, normalized and deduped, in document
 * order. Only http(s) URLs on the sitemap's own origin are kept (the protocol
 * scopes a sitemap to its host). A sitemap index is followed one level deep.
 * All requests go through `fetcher` (default: same-origin redirects only).
 * When a limit leaves part of the sitemap unread, a note goes into `gaps`.
 */
export async function loadSitemap(
  url: string,
  limits: SitemapLimits = DEFAULT_SITEMAP_LIMITS,
  fetcher: Fetcher = createFetcher(),
  gaps: string[] = [],
): Promise<string[]> {
  const origin = originOf(url);
  const read = async (u: string) =>
    parseSitemap(decodeSitemapBytes(await fetchCapped(fetcher, u, limits), limits));
  const sameOrigin = (loc: string): string | undefined => {
    try {
      const n = normalizeUrl(loc, url);
      return originOf(n) === origin && /^https?:/.test(n) ? n : undefined;
    } catch {
      return undefined;
    }
  };

  const top = await read(url);
  const pages = new Set<string>();
  let overUrls = false;
  let nested = 0;
  const add = (locs: string[]) => {
    for (const loc of locs) {
      const n = sameOrigin(loc);
      if (n === undefined || pages.has(n)) continue;
      if (pages.size >= limits.maxUrls) {
        overUrls = true;
        return;
      }
      pages.add(n);
    }
  };
  if (top.kind === 'urlset') {
    add(top.locs);
  } else {
    const children = [...new Set(top.locs.map(sameOrigin).filter((u) => u !== undefined))];
    if (children.length > limits.maxSitemaps)
      gaps.push(
        `the sitemap index lists ${children.length} sitemaps; only the first ${limits.maxSitemaps} were read`,
      );
    for (const [i, child] of children.slice(0, limits.maxSitemaps).entries()) {
      const sub = await read(child);
      // One level only: a nested index is ignored rather than followed.
      if (sub.kind === 'urlset') add(sub.locs);
      else nested++;
      // Full with sitemaps left unread: they may list more pages, so the scope is a gap.
      if (pages.size >= limits.maxUrls && i < Math.min(children.length, limits.maxSitemaps) - 1) {
        overUrls = true;
        break;
      }
    }
  }
  if (overUrls)
    gaps.push(`the sitemap lists more than ${limits.maxUrls} pages; the rest were not read`);
  if (nested > 0)
    gaps.push(`${nested} nested sitemap index(es) were not followed (one level only)`);
  return [...pages];
}
