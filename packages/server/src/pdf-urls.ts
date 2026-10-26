import { safeText } from '@widedoor/core';
import type { VerapdfRunner } from '@widedoor/pdf';
import { normalizeUrl, type PdfFetchFailure, type PdfLink } from '@widedoor/web';

/*
 * The rules for PDFs by URL that performScan applies around the fetch: which URLs
 * to fetch, whether this run fetches at all (pdf.fetch), and which failures
 * are scan errors and which are scope gaps.
 */

/**
 * The PDF URLs to fetch: the listed ones (pdf.urls or the command line), then
 * those the web scan found, normalized as pages are and deduped. A URL is
 * listed when any source named it.
 */
export function pdfUrlsOf(listed: readonly string[], found: readonly PdfLink[]): PdfLink[] {
  const urls = new Map<string, PdfLink>();
  const add = (input: string, isListed: boolean) => {
    let url: string;
    try {
      url = normalizeUrl(input);
    } catch {
      url = input;
    }
    const known = urls.get(url);
    if (known) known.listed ||= isListed;
    else urls.set(url, { url, listed: isListed });
  };
  for (const u of listed) add(u, true);
  for (const p of found) add(p.url, p.listed);
  return [...urls.values()];
}

/**
 * Whether veraPDF is the bundled runner inside Widedoor's image: the runner's
 * isolatedHost flag, never its warning text, so a reworded warning cannot turn
 * fetching back on there.
 */
export const inImage = (runner: Pick<VerapdfRunner, 'kind' | 'isolatedHost'> | undefined) =>
  runner?.kind === 'local' && runner.isolatedHost === true;

/** The line added when pdf.fetch is set on inside Widedoor's image. */
export const IN_CONTAINER_FETCH_WARNING =
  'pdf.fetch is on inside the Widedoor image: PDFs fetched from the network are parsed by veraPDF in this container, which has the network and the same mounts. To keep PDF parsing off the network, download the files and scan them in a --network none run.';

/**
 * Whether this run fetches PDFs by URL. pdf.fetch decides when set. Unset, a
 * run fetches unless veraPDF is the bundled runner inside Widedoor's image,
 * where the parser would share the networked container (the host CLI's
 * Docker runner gives veraPDF its own container with --network none).
 */
export function pdfFetchDecision(
  setting: boolean | undefined,
  inContainer: boolean,
): { fetch: boolean; warning?: string } {
  const fetch = setting ?? !inContainer;
  return fetch && inContainer ? { fetch, warning: IN_CONTAINER_FETCH_WARNING } : { fetch };
}

/** The scope gap for a PDF URL a run with pdf.fetch off did not fetch. */
export const fetchOffGap = (url: string) =>
  `${safeText(url, 300)} was not fetched: PDF fetching is off in this run (pdf.fetch); download the file and scan it in a PDF run`;

export const SIGNED_OUT_NOTE = ' (PDFs are fetched without the signed-in session)';

/**
 * Splits fetch failures: each is a scan error, except a crawled (not listed)
 * link whose redirect left its origin, which is refused like an off-origin
 * link and is a scope gap. In a signed-in scan the error says the fetch had
 * no session.
 */
export function sortFetchFailures(
  failed: readonly PdfFetchFailure[],
  links: readonly PdfLink[],
  signedIn: boolean,
): { errors: { uri: string; code: string; message: string }[]; gaps: string[] } {
  const listed = new Set(links.filter((p) => p.listed).map((p) => p.url));
  const errors: { uri: string; code: string; message: string }[] = [];
  const gaps: string[] = [];
  for (const f of failed) {
    if (f.code === 'pdf-redirect-off-origin' && !listed.has(f.url))
      gaps.push(`${safeText(f.url, 300)} was not fetched: ${f.message}`);
    else
      errors.push({
        uri: f.url,
        code: f.code,
        message: signedIn ? `${f.message}${SIGNED_OUT_NOTE}` : f.message,
      });
  }
  return { errors, gaps };
}
