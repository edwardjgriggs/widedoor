import { readCapped } from '@widedoor/web';
import {
  EgressRefusedError,
  createProxiedFetcher,
  hostedUserAgent,
  type EgressBlockReason,
  type PinnedResolver,
} from '@widedoor/web/egress';
import type { Fetcher } from '@widedoor/web';
import { formatFetchRefusal } from './agent.js';
import {
  INPUT_REFUSED,
  VERIFY_TOKEN,
  isVerifyHost,
  jobError,
  type JobResult,
  type Tried,
} from './protocol.js';

/*
 * A domain verification as the scan child runs it (Task 11, ledger R40 and R43
 * to R45): no browser, no veraPDF, no robots.txt. Two fixed, owner-requested
 * https URLs on the named host, through the egress proxy like every scan
 * request: the well-known file first, then the home page's meta tag, stopping
 * at the first that passes. A redirect is followed only on the same scheme,
 * exact host and port, at most 3 hops, each hop checked by the egress policy
 * first. The meta tag counts only in the document head.
 * Bodies are read up to a cap while they stream, and nothing fetched is ever
 * quoted: each method's reason is a fixed phrase of ours.
 */

export const WELL_KNOWN_PATH = '/.well-known/widedoor.txt';
/** Bytes of the well-known file read at most. */
export const WELL_KNOWN_MAX_BYTES = 4 * 1024;
/** Bytes of the home page searched for the meta tag at most. */
export const PAGE_MAX_BYTES = 1024 * 1024;
/** Longest wait for one method's fetch, redirects and body included. */
export const VERIFY_FETCH_TIMEOUT_MS = 20_000;
/** Redirects followed at most (ledger R44). */
export const VERIFY_MAX_REDIRECTS = 3;
/** The meta tag's name attribute. */
export const META_NAME = 'widedoor-verification';

export const NO_FILE_MATCH = 'the file did not match the token';
export const NO_META_MATCH = 'the page has no matching meta tag';
export const OTHER_HOST = 'the site redirected to another host';
export const NOT_HTTPS = 'the site redirected away from https';
export const OTHER_PORT = 'the site redirected to another port';
export const TOO_MANY_REDIRECTS = 'the site redirected too many times';
export const UNREACHABLE = 'the site could not be reached';
export const NO_ANSWER_IN_TIME = 'the site did not answer in time';
export const VERIFY_STOPPED = 'the verification was stopped';

/** The egress refusal of a hop, in the plain words a site owner reads. */
const BLOCKED: Readonly<Record<EgressBlockReason, string>> = {
  private: 'private address',
  loopback: 'loopback address',
  'link-local': 'link-local address',
  cgnat: 'shared (CGNAT) address',
  multicast: 'multicast address',
  metadata: 'cloud metadata address',
  reserved: 'reserved address',
  unspecified: 'unspecified address',
  'host-name': 'a host name Widedoor does not visit',
  port: 'a port other than 80 or 443',
  scheme: 'an address that is not http or https',
  credentials: 'an address with a user name or password',
  unresolved: 'the name did not resolve',
  'host-limit': 'too many host names',
};

export interface VerificationOptions {
  /** The host as the API normalized it (isVerifyHost). */
  host: string;
  /** 32 hex characters. */
  token: string;
  /** The egress proxy, an IP literal URL such as http://127.0.0.1:<port>. */
  proxyUrl: string;
  /** One per job; see HostedScanOptions.resolver. */
  resolver: PinnedResolver;
  /** The page the user agent names. */
  contactUrl: string;
  signal: AbortSignal;
  /** One line per refused fetch hop. Default: stderr. */
  log?: (line: string) => void;
  /** Extra CA certificates to trust (tests). Verification stays on. */
  ca?: string;
}

/** A hop the verification's own rule (R44) refused; its message is the method's reason. */
class HopRefused extends Error {}

/** A host as the hop check compares it: lower case, no trailing dot. */
const bareHost = (url: URL) => url.hostname.toLowerCase().replace(/\.$/, '');

/** The first part of a body as text, or why there is none. */
type Fetched = { text: string } | { reason: string };

/** One GET of url, its body read up to cap bytes, within its own timeout under the job's signal. */
async function fetchText(
  fetcher: Fetcher,
  url: string,
  cap: number,
  signal: AbortSignal,
): Promise<Fetched> {
  const timeout = AbortSignal.timeout(VERIFY_FETCH_TIMEOUT_MS);
  try {
    const { response } = await fetcher(url, { signal: AbortSignal.any([signal, timeout]) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { reason: `the site answered ${response.status}` };
    }
    // Past the cap the rest of the stream is cancelled unread.
    const { bytes } = await readCapped(response, cap);
    return { text: new TextDecoder('utf-8').decode(bytes) };
  } catch (e) {
    if (e instanceof HopRefused) return { reason: e.message };
    if (e instanceof EgressRefusedError) {
      if (e.reason === 'redirect-limit') return { reason: TOO_MANY_REDIRECTS };
      return { reason: (e.blockReason && BLOCKED[e.blockReason]) ?? UNREACHABLE };
    }
    if (timeout.aborted && !signal.aborted) return { reason: NO_ANSWER_IN_TIME };
    return { reason: UNREACHABLE };
  }
}

/** Whether the file's first line, trimmed, is the token. */
const fileMatches = (text: string, token: string): boolean =>
  (text.split('\n')[0] ?? '').trim() === token;

/** A meta tag longer than this, from `<meta` to its `>`, is skipped unread. */
export const MAX_META_TAG_CHARS = 2 * 1024;
/**
 * One attribute: a name, then a double-quoted, single-quoted or bare value. The
 * lookbehind anchors the name at its start, so a long run of name characters is tried
 * once, not once per character (CWE-1333).
 */
const ATTRIBUTE = /(?<![^\s"'<>/=])([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
/** Elements whose content is not markup: a `<meta` inside one is text. */
const RAW_TEXT = new Set([
  'script',
  'style',
  'template',
  'textarea',
  'title',
  'noscript',
  'noframes',
  'noembed',
  'xmp',
  'iframe',
]);
/** Start tags a head may hold; any other ends the head, as it does in a browser. */
const HEAD_TAGS = new Set([
  'html',
  'head',
  'meta',
  'link',
  'base',
  'title',
  'style',
  'script',
  'noscript',
  'template',
]);
/** What may follow a tag name. */
const NAME_END = /[\s/>]/;

/** The tag name at `at` (letters, digits and hyphens, lower case). */
function tagName(lower: string, at: number): string {
  let end = at;
  while (end < lower.length && /[a-z0-9-]/.test(lower[end] ?? '')) end++;
  return lower.slice(at, end);
}

/**
 * Where the tag that starts at `at` ends (its `>`), or -1 when it never does. A quoted
 * attribute value is skipped whole, so a `>` inside one does not end the tag.
 */
function tagEnd(html: string, at: number): number {
  for (let i = at + 1; i < html.length; i++) {
    const c = html[i];
    if (c === '>') return i;
    if (c !== '=') continue;
    let j = i + 1;
    while (j < html.length && /\s/.test(html[j] ?? '')) j++;
    const quote = html[j];
    if (quote !== '"' && quote !== "'") continue;
    const close = html.indexOf(quote, j + 1);
    if (close < 0) return -1;
    i = close;
  }
  return -1;
}

/** Whether a meta tag's attributes (the text between `<meta` and `>`) name the token. */
function metaMatches(attributesText: string, token: string): boolean {
  const attributes = new Map<string, string>();
  for (const [, name = '', double, single, bare] of attributesText.matchAll(ATTRIBUTE)) {
    const key = name.toLowerCase();
    // As in HTML, the first of a repeated attribute counts.
    if (!attributes.has(key)) attributes.set(key, double ?? single ?? bare ?? '');
  }
  return attributes.get('name')?.toLowerCase() === META_NAME && attributes.get('content') === token;
}

/**
 * Whether the document head holds `<meta name="widedoor-verification" content="<token>">`,
 * in either attribute order, single or double quotes, tag and attribute names in any case.
 * Only the head counts (CWE-345): the walk stops at `</head>` or at the first start tag
 * a head may not hold (HEAD_TAGS; `<body`, or a `<div` on a page that leaves body out),
 * skips comments, `<!...>` and `<?...>` (bogus comments, to the next `>`) and the
 * content of raw-text elements (RAW_TEXT), and reads only `<meta` tags it meets at its
 * own level, so a tag inside a comment, script JSON, another tag's attribute or the
 * body never matches. Every step moves forward with indexOf or one pass over a tag, so
 * the walk is linear; a meta tag over MAX_META_TAG_CHARS is skipped without being
 * matched. Not modelled: the double-escaped state of `<script><!--<script>`, which
 * matters only where user content can already put a raw `<meta>` in the head.
 */
export function hasVerificationMeta(html: string, token: string): boolean {
  // ASCII only, so every index stays the same as in html.
  const lower = html.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());
  let at = 0;
  for (;;) {
    const open = lower.indexOf('<', at);
    if (open < 0) return false;
    if (lower.startsWith('<!--', open)) {
      const close = lower.indexOf('-->', open + 4);
      if (close < 0) return false;
      at = close + 3;
      continue;
    }
    if (lower.startsWith('<?', open) || lower.startsWith('<!', open)) {
      // A bogus comment (or a doctype): it ends at the next `>`, quotes or not.
      const close = lower.indexOf('>', open + 2);
      if (close < 0) return false;
      at = close + 1;
      continue;
    }
    const closing = lower[open + 1] === '/';
    const name = tagName(lower, open + (closing ? 2 : 1));
    const named = name !== '' && NAME_END.test(lower[open + (closing ? 2 : 1) + name.length] ?? '');
    if (!named) {
      // A `<` that starts no tag is text.
      at = open + 1;
      continue;
    }
    if (closing ? name === 'head' : !HEAD_TAGS.has(name)) return false;
    const end = tagEnd(html, open);
    if (end < 0) return false;
    if (
      !closing &&
      name === 'meta' &&
      end - open <= MAX_META_TAG_CHARS &&
      metaMatches(html.slice(open + '<meta'.length, end), token)
    )
      return true;
    at = end + 1;
    if (!closing && RAW_TEXT.has(name)) {
      // The content runs to the matching end tag; whatever it holds is not markup.
      let close = lower.indexOf(`</${name}`, at);
      while (close >= 0 && !NAME_END.test(lower[close + 2 + name.length] ?? '>'))
        close = lower.indexOf(`</${name}`, close + 1);
      if (close < 0) return false;
      at = close;
    }
  }
}

/**
 * Runs one verification and returns its result: verified with the method that
 * passed, not_verified with every method's reason, or failed for an input that
 * does not validate (nothing is requested) or a stop. Never throws.
 */
export async function runVerification(options: VerificationOptions): Promise<JobResult> {
  const { host, token, signal } = options;
  // Checked again here: the host becomes two requests.
  if (!isVerifyHost(host) || !VERIFY_TOKEN.test(token))
    return { status: 'failed', error: INPUT_REFUSED };
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const fetcher = createProxiedFetcher({
    proxyUrl: options.proxyUrl,
    resolver: options.resolver,
    userAgent: hostedUserAgent(options.contactUrl),
    maxRedirects: VERIFY_MAX_REDIRECTS,
    ...(options.ca !== undefined ? { ca: options.ca } : {}),
    onRefused: (hop, error) => log(formatFetchRefusal(hop, error)),
    // After the egress check, so a hop to a blocked address reads as that, not as another
    // host. By design that check resolves a hop's name first: a redirect to another host
    // has that host looked up by the scan machine's DNS before this rule refuses it, and
    // such a hop may report the DNS reason (for example "the name did not resolve")
    // instead of OTHER_HOST.
    checkHop: (hop, start) => {
      if (bareHost(hop) !== host) throw new HopRefused(OTHER_HOST);
      if (hop.protocol !== 'https:') throw new HopRefused(NOT_HTTPS);
      // Both empty for 443: the URL parser drops a scheme's default port.
      if (hop.port !== start.port) throw new HopRefused(OTHER_PORT);
    },
  });
  const tried: Tried[] = [];
  try {
    const file = await fetchText(
      fetcher,
      `https://${host}${WELL_KNOWN_PATH}`,
      WELL_KNOWN_MAX_BYTES,
      signal,
    );
    if (signal.aborted) return { status: 'failed', error: jobError(VERIFY_STOPPED) };
    if ('text' in file && fileMatches(file.text, token))
      return { status: 'verified', tried: [{ method: 'well_known', ok: true }] };
    tried.push({
      method: 'well_known',
      ok: false,
      reason: 'reason' in file ? file.reason : NO_FILE_MATCH,
    });

    const home = await fetchText(fetcher, `https://${host}/`, PAGE_MAX_BYTES, signal);
    if (signal.aborted) return { status: 'failed', error: jobError(VERIFY_STOPPED) };
    if ('text' in home && hasVerificationMeta(home.text, token))
      return { status: 'verified', tried: [...tried, { method: 'meta_tag', ok: true }] };
    tried.push({
      method: 'meta_tag',
      ok: false,
      reason: 'reason' in home ? home.reason : NO_META_MATCH,
    });
    return { status: 'not_verified', tried };
  } catch {
    if (signal.aborted) return { status: 'failed', error: jobError(VERIFY_STOPPED) };
    return { status: 'failed', error: jobError('the verification failed') };
  } finally {
    await fetcher.close().catch(() => undefined);
  }
}
