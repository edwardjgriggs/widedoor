/**
 * Canonical form of a page URL, used to dedupe the scan scope: scheme and host
 * lowercased, default port and fragment dropped. Path and query (including the
 * order of query parameters) are kept as given, since the spec does not say
 * that reordered queries name the same page.
 */
export function normalizeUrl(input: string | URL, base?: string | URL): string {
  const url = new URL(input, base);
  // WHATWG URL parsing already lowercases scheme and host and drops default ports.
  url.hash = '';
  return url.href;
}

/** Whether a URL can be scanned as a page: http(s), or file: when a file root is allowed. */
export function isPageUrl(url: string, allowFile = false): boolean {
  const { protocol } = new URL(url);
  return protocol === 'http:' || protocol === 'https:' || (allowFile && protocol === 'file:');
}

export const originOf = (url: string): string => new URL(url).origin;
