import { describe, expect, it } from 'vitest';
import { IN_CONTAINER_WARNING, NOT_ISOLATED_WARNING } from '@widedoor/pdf';
import {
  IN_CONTAINER_FETCH_WARNING,
  inImage,
  SIGNED_OUT_NOTE,
  fetchOffGap,
  pdfFetchDecision,
  pdfUrlsOf,
  sortFetchFailures,
} from '../src/pdf-urls.ts';

describe('pdfUrlsOf', () => {
  it('normalizes as pages are and keeps one entry per PDF, listed when any source lists it', () => {
    expect(
      pdfUrlsOf(
        ['HTTPS://Example.COM:443/r/a.pdf#page=2', 'https://example.com/b.pdf'],
        [
          { url: 'https://example.com/r/a.pdf', listed: false },
          { url: 'https://example.com/c.pdf', listed: false },
          { url: 'https://example.com/b.pdf', listed: false },
        ],
      ),
    ).toEqual([
      { url: 'https://example.com/r/a.pdf', listed: true },
      { url: 'https://example.com/b.pdf', listed: true },
      { url: 'https://example.com/c.pdf', listed: false },
    ]);
  });
});

describe('pdfFetchDecision (pdf.fetch)', () => {
  it('fetches by default on the host, where veraPDF has its own container', () => {
    expect(pdfFetchDecision(undefined, false)).toEqual({ fetch: true });
    expect(pdfFetchDecision(false, false)).toEqual({ fetch: false });
  });

  it('does not fetch by default inside the image, and warns when pdf.fetch turns it on', () => {
    expect(pdfFetchDecision(undefined, true)).toEqual({ fetch: false });
    expect(pdfFetchDecision(true, true)).toEqual({
      fetch: true,
      warning: IN_CONTAINER_FETCH_WARNING,
    });
  });

  it('takes the image from the runner flag, never from its warning text', () => {
    const runner = (isolatedHost: boolean | undefined, warnings: string[]) => ({
      kind: 'local' as const,
      ...(isolatedHost !== undefined ? { isolatedHost } : {}),
      warnings,
    });
    // The in-container warning without the flag (say, reworded or reused) does not count.
    expect(inImage(runner(false, [IN_CONTAINER_WARNING]))).toBe(false);
    expect(inImage(runner(undefined, [IN_CONTAINER_WARNING]))).toBe(false);
    // The flag counts whatever the warnings say.
    expect(inImage(runner(true, []))).toBe(true);
    expect(inImage(runner(true, [NOT_ISOLATED_WARNING]))).toBe(true);
    // Only the local CLI can be the image's runner; no runner is not the image.
    expect(inImage({ kind: 'docker', isolatedHost: true })).toBe(false);
    expect(inImage(undefined)).toBe(false);
    expect(pdfFetchDecision(undefined, inImage(runner(true, []))).fetch).toBe(false);
    expect(pdfFetchDecision(undefined, inImage(runner(false, [IN_CONTAINER_WARNING]))).fetch).toBe(
      true,
    );
  });

  it('words the gap for a PDF that was not fetched, escaped', () => {
    expect(fetchOffGap('https://example.com/a.pdf\u001b[2J')).toBe(
      'https://example.com/a.pdf\\x1b[2J was not fetched: PDF fetching is off in this run (pdf.fetch); download the file and scan it in a PDF run',
    );
  });
});

describe('sortFetchFailures', () => {
  const links = [
    { url: 'https://example.com/listed.pdf', listed: true },
    { url: 'https://example.com/crawled.pdf', listed: false },
  ];
  const offOrigin = (url: string) => ({
    url,
    code: 'pdf-redirect-off-origin' as const,
    message: 'redirect to https://other.example leaves https://example.com',
  });

  it('makes a crawled off-origin redirect a scope gap and a listed one an error', () => {
    const { errors, gaps } = sortFetchFailures(
      [offOrigin('https://example.com/listed.pdf'), offOrigin('https://example.com/crawled.pdf')],
      links,
      false,
    );
    expect(errors).toEqual([
      {
        uri: 'https://example.com/listed.pdf',
        code: 'pdf-redirect-off-origin',
        message: 'redirect to https://other.example leaves https://example.com',
      },
    ]);
    expect(gaps).toEqual([
      'https://example.com/crawled.pdf was not fetched: redirect to https://other.example leaves https://example.com',
    ]);
  });

  it('keeps too many redirects and a refused scheme as errors, crawled or not', () => {
    const { errors, gaps } = sortFetchFailures(
      [
        { url: 'https://example.com/crawled.pdf', code: 'pdf-fetch-refused', message: 'x' },
        { url: 'https://example.com/listed.pdf', code: 'pdf-fetch-refused', message: 'y' },
      ],
      links,
      false,
    );
    expect(gaps).toEqual([]);
    expect(errors.map((e) => e.uri)).toEqual([
      'https://example.com/crawled.pdf',
      'https://example.com/listed.pdf',
    ]);
  });

  it('says in a signed-in scan that PDFs are fetched without the session', () => {
    const { errors } = sortFetchFailures(
      [{ url: 'https://example.com/listed.pdf', code: 'not-a-pdf', message: 'not a PDF' }],
      links,
      true,
    );
    expect(errors[0]?.message).toBe(`not a PDF${SIGNED_OUT_NOTE}`);
    expect(SIGNED_OUT_NOTE).toBe(' (PDFs are fetched without the signed-in session)');
  });
});
