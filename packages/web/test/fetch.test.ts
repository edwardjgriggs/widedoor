import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EgressRefusedError,
  PdfFetchError,
  createFetcher,
  fetchPdf,
  withFetchedPdfs,
  type HopCheck,
} from '../src/index.ts';
import { serve, type TestServer } from './server.ts';

describe('createFetcher', () => {
  let site: TestServer;
  let other: TestServer;
  beforeAll(async () => {
    other = await serve(() => ({ '/x': { body: 'other' } }));
    site = await serve((o) => ({
      '/ok': { body: 'ok' },
      '/hop': { status: 302, body: '', headers: { location: '/ok' } },
      '/away': { status: 301, body: '', headers: { location: `${other.origin}/x` } },
      '/loop': { status: 302, body: '', headers: { location: `${o}/loop` } },
    }));
  });
  afterAll(async () => {
    await site.close();
    await other.close();
  });

  it('follows same-origin redirects hop by hop', async () => {
    const { response, url } = await createFetcher()(`${site.origin}/hop`);
    expect(await response.text()).toBe('ok');
    expect(url).toBe(`${site.origin}/ok`);
  });

  it('refuses a redirect to another origin before requesting it', async () => {
    await expect(createFetcher()(`${site.origin}/away`)).rejects.toMatchObject({
      name: 'EgressRefusedError',
      reason: 'off-origin',
    });
    expect(other.hits).toEqual([]);
  });

  it('caps the number of redirects', async () => {
    await expect(createFetcher({ maxRedirects: 3 })(`${site.origin}/loop`)).rejects.toMatchObject({
      message: 'more than 3 redirects',
      reason: 'redirect-limit',
    });
  });

  it('runs the injected hop check on every hop, including the first', async () => {
    const seen: string[] = [];
    const checkHop: HopCheck = (hop) => {
      seen.push(hop.pathname);
    };
    await createFetcher({ checkHop })(`${site.origin}/away`);
    expect(seen).toEqual(['/away', '/x']);
    await expect(
      createFetcher({
        checkHop: () => {
          throw new EgressRefusedError('blocked by policy');
        },
      })(`${site.origin}/ok`),
    ).rejects.toThrow(/blocked by policy/);
  });

  it('uses the injected request function with redirect: manual', async () => {
    const calls: RequestInit[] = [];
    const fetcher = createFetcher({
      request: async (_url, init) => {
        calls.push(init);
        return new Response('stub');
      },
    });
    expect(await (await fetcher('http://example.test/')).response.text()).toBe('stub');
    expect(calls[0]?.redirect).toBe('manual');
  });

  it('refuses non-http schemes', async () => {
    await expect(createFetcher()('file:///etc/passwd')).rejects.toMatchObject({
      message: expect.stringMatching(/^refusing file:/),
      reason: 'scheme',
    });
  });
});

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

/** What a fetch settles with: the PdfFetchError code and message when it rejects. */
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e instanceof PdfFetchError ? `${e.code}: ${e.message}` : String(e)),
  );

/** A write that collects the chunks it is handed. */
function collect() {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    write: async (c: Uint8Array) => void chunks.push(c),
    bytes: () => Buffer.concat(chunks),
  };
}
const ignore = async () => undefined;

describe('fetchPdf', () => {
  let site: TestServer;
  let other: TestServer;
  // Streams 64 KiB chunks with no Content-Length until the client goes away.
  let endless: Server;
  let endlessOrigin = '';
  let sent = 0;
  beforeAll(async () => {
    other = await serve(() => ({ '/x.pdf': { body: PDF, type: 'application/pdf' } }));
    site = await serve((o) => ({
      '/doc.pdf': { body: PDF, type: 'application/pdf' },
      '/hop.pdf': { status: 302, body: '', headers: { location: '/doc.pdf' } },
      '/page.pdf': { body: '<!doctype html><title>Not a PDF</title>', type: 'application/pdf' },
      '/away.pdf': { status: 302, body: '', headers: { location: `${other.origin}/x.pdf` } },
      '/loop.pdf': { status: 302, body: '', headers: { location: `${o}/loop.pdf` } },
      '/ftp.pdf': { status: 302, body: '', headers: { location: 'ftp://127.0.0.1/x.pdf' } },
      '/tiny.pdf': { body: '%PD', type: 'application/pdf' },
    }));
    endless = createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'application/pdf',
        ...(req.url === '/declared.pdf' ? { 'content-length': '999999' } : {}),
      });
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      res.write(req.url === '/html.pdf' ? '<!doctype html>' : '%PDF-1.7\n');
      if (req.url !== '/big.pdf' && req.url !== '/html.pdf') return;
      const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer);
        res.write(chunk);
        sent += chunk.length;
      }, 1);
      res.on('close', () => clearInterval(timer));
    });
    await new Promise<void>((ok) => endless.listen(0, '127.0.0.1', ok));
    endlessOrigin = `http://127.0.0.1:${(endless.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await site.close();
    await other.close();
    endless.closeAllConnections();
    await new Promise<void>((ok) => endless.close(() => ok()));
  });

  it('streams the body of a PDF to write and names the final hop', async () => {
    const sink = collect();
    const got = await fetchPdf(createFetcher(), `${site.origin}/hop.pdf`, sink.write);
    expect(got).toEqual({ url: `${site.origin}/doc.pdf`, bytes: PDF.length });
    expect(sink.bytes().equals(PDF)).toBe(true);
  });

  it('refuses an HTML page served as x.pdf: the body must start with %PDF-', async () => {
    const sink = collect();
    expect(await codeOf(fetchPdf(createFetcher(), `${site.origin}/page.pdf`, sink.write))).toBe(
      'not-a-pdf: the response is not a PDF (it does not start with %PDF-)',
    );
    // Refused on its first bytes: nothing of it reached the file.
    expect(sink.chunks).toEqual([]);
    expect(await codeOf(fetchPdf(createFetcher(), `${site.origin}/tiny.pdf`, ignore))).toBe(
      'not-a-pdf: the response is not a PDF (it does not start with %PDF-)',
    );
  });

  it('stops reading an endless body that does not start with %PDF-', async () => {
    sent = 0;
    expect(await codeOf(fetchPdf(createFetcher(), `${endlessOrigin}/html.pdf`, ignore))).toMatch(
      /^not-a-pdf: /,
    );
    await new Promise((ok) => setTimeout(ok, 300));
    const after = sent;
    await new Promise((ok) => setTimeout(ok, 300));
    expect(sent).toBe(after);
  });

  it('stops an oversize body at the cap while it streams, one chunk at a time', async () => {
    sent = 0;
    let largest = 0;
    let total = 0;
    const fetching = fetchPdf(
      createFetcher(),
      `${endlessOrigin}/big.pdf`,
      async (c) => {
        largest = Math.max(largest, c.length);
        total += c.length;
      },
      { maxBytes: 1024 * 1024 },
    );
    expect(await codeOf(fetching)).toBe(
      'pdf-too-large: the PDF is over the 1 MiB limit (pdf.maxBytes)',
    );
    // write never saw more than the cap, and never a chunk larger than the network gave.
    expect(total).toBeLessThanOrEqual(1024 * 1024);
    expect(largest).toBeLessThanOrEqual(1024 * 1024);
    // The stream was cancelled: the server stops writing, well short of an endless body.
    await new Promise((ok) => setTimeout(ok, 300));
    const after = sent;
    await new Promise((ok) => setTimeout(ok, 300));
    expect(sent).toBe(after);
    expect(sent).toBeLessThan(32 * 1024 * 1024);
  });

  it('refuses a declared Content-Length over the cap without waiting for the body', async () => {
    expect(
      await codeOf(
        fetchPdf(createFetcher(), `${endlessOrigin}/declared.pdf`, ignore, { maxBytes: 1000 }),
      ),
    ).toBe('pdf-too-large: the PDF is over the 1000 bytes limit (pdf.maxBytes)');
  });

  it('gives an off-origin redirect its own code, and other refusals the refused code', async () => {
    expect(await codeOf(fetchPdf(createFetcher(), `${site.origin}/away.pdf`, ignore))).toBe(
      `pdf-redirect-off-origin: redirect to ${other.origin} leaves ${site.origin}`,
    );
    expect(other.hits).toEqual([]);
    expect(await codeOf(fetchPdf(createFetcher(), `${site.origin}/loop.pdf`, ignore))).toBe(
      'pdf-fetch-refused: more than 5 redirects',
    );
    expect(await codeOf(fetchPdf(createFetcher(), `${site.origin}/ftp.pdf`, ignore))).toBe(
      'pdf-fetch-refused: refusing ftp: URL ftp://127.0.0.1/x.pdf',
    );
    // A hook's own refusal (Phase 3's SSRF guard) is "policy" unless it says otherwise.
    const blocked = createFetcher({
      checkHop: () => {
        throw new EgressRefusedError('private address');
      },
    });
    expect(await codeOf(fetchPdf(blocked, `${site.origin}/doc.pdf`, ignore))).toBe(
      'pdf-fetch-refused: private address',
    );
  });

  it('reports an HTTP error status and a timeout as fetch errors', async () => {
    expect(await codeOf(fetchPdf(createFetcher(), `${site.origin}/missing.pdf`, ignore))).toBe(
      'pdf-fetch-failed: the server answered 404',
    );
    expect(
      await codeOf(
        fetchPdf(createFetcher(), `${endlessOrigin}/hang.pdf`, ignore, { timeoutMs: 300 }),
      ),
    ).toBe('timeout: the PDF did not arrive within 300 ms');
  });

  it('stops at once when its signal fires, mid body or before the request', async () => {
    const stop = new AbortController();
    const t0 = Date.now();
    const run = fetchPdf(createFetcher(), `${endlessOrigin}/hang.pdf`, ignore, {
      signal: stop.signal,
    });
    setTimeout(() => stop.abort(new Error('cancelled')), 200);
    await expect(run).rejects.toThrow('cancelled');
    // Far short of the 60 s default limit.
    expect(Date.now() - t0).toBeLessThan(10_000);
    // A body that keeps streaming stops too.
    const big = new AbortController();
    const before = sent;
    const streaming = fetchPdf(createFetcher(), `${endlessOrigin}/big.pdf`, ignore, {
      signal: big.signal,
      maxBytes: 1024 * 1024 * 1024,
    });
    setTimeout(() => big.abort(new Error('cancelled')), 200);
    await expect(streaming).rejects.toThrow('cancelled');
    const after = sent;
    await new Promise((done) => setTimeout(done, 300));
    expect(sent - after).toBeLessThanOrEqual(2 * 64 * 1024);
    expect(after).toBeGreaterThan(before);
    await expect(
      fetchPdf(createFetcher(), `${site.origin}/doc.pdf`, ignore, { signal: stop.signal }),
    ).rejects.toThrow('cancelled');
  });

  it('names the network error when nothing listens', async () => {
    const closed = await serve(() => ({}));
    await closed.close();
    expect(await codeOf(fetchPdf(createFetcher(), `${closed.origin}/doc.pdf`, ignore))).toBe(
      'pdf-fetch-failed: fetch failed (ECONNREFUSED)',
    );
  });

  it('passes a failure of write through as it is', async () => {
    const broken = new Error('disk full');
    await expect(
      fetchPdf(createFetcher(), `${site.origin}/doc.pdf`, () => Promise.reject(broken)),
    ).rejects.toBe(broken);
  });
});

describe('withFetchedPdfs', () => {
  let site: TestServer;
  beforeAll(async () => {
    site = await serve(() => ({
      '/a.pdf': { body: PDF, type: 'application/pdf' },
      '/..%2F..%2Fescape.pdf': { body: PDF, type: 'application/pdf' },
      '/page.pdf': { body: '<p>no</p>' },
      '/old.pdf': { status: 301, body: '', headers: { location: '/a.pdf#page=2' } },
    }));
  });
  afterAll(() => site.close());

  it('streams each PDF on load into a private temp folder, then removes the folder', async () => {
    const urls = [
      `${site.origin}/a.pdf`,
      `${site.origin}/page.pdf`,
      `${site.origin}/..%2F..%2Fescape.pdf`,
      `${site.origin}/old.pdf`,
    ];
    const paths: string[] = [];
    const { result, failed } = await withFetchedPdfs(urls, {}, async (sources) => {
      expect(sources.map((s) => s.url)).toEqual(urls);
      // Nothing is fetched before a source is loaded.
      expect(site.hits).toEqual([]);
      const uris: (string | undefined)[] = [];
      for (const source of sources) {
        const loaded = await source.load();
        uris.push(loaded?.uri);
        if (loaded === undefined) continue;
        paths.push(loaded.path);
        expect(readFileSync(loaded.path).equals(PDF)).toBe(true);
        // Counter names: nothing of the URL reaches the file system.
        expect(basename(loaded.path)).toMatch(/^\d+\.pdf$/);
        expect(dirname(dirname(loaded.path))).toBe(tmpdir());
        if (process.platform !== 'win32') {
          expect(statSync(loaded.path).mode & 0o777).toBe(0o600);
          expect(statSync(dirname(loaded.path)).mode & 0o777).toBe(0o700);
        }
        await source.release();
        expect(existsSync(loaded.path)).toBe(false);
      }
      return uris;
    });
    // The uri is the final hop, normalized as pages are (no fragment).
    expect(result).toEqual([
      `${site.origin}/a.pdf`,
      undefined,
      `${site.origin}/..%2F..%2Fescape.pdf`,
      `${site.origin}/a.pdf`,
    ]);
    expect(paths).toHaveLength(3);
    expect(failed).toEqual([
      {
        url: urls[1],
        code: 'not-a-pdf',
        message: 'the response is not a PDF (it does not start with %PDF-)',
      },
    ]);
    expect(existsSync(dirname(paths[0]!))).toBe(false);
  });

  it('leaves no partial file behind when a fetch fails', async () => {
    let dir = '';
    await withFetchedPdfs(
      [`${site.origin}/page.pdf`],
      { onTempDir: (d) => (dir = d) },
      async ([source]) => {
        expect(await source!.load()).toBeUndefined();
        expect(readdirSync(dir)).toEqual([]);
      },
    );
    expect(existsSync(dir)).toBe(false);
  });

  it('removes the folder and its files when the scan throws', async () => {
    let path: string | undefined;
    await expect(
      withFetchedPdfs([`${site.origin}/a.pdf`], {}, async ([source]) => {
        path = (await source!.load())?.path;
        throw new Error('scan broke');
      }),
    ).rejects.toThrow('scan broke');
    expect(path).toBeDefined();
    expect(existsSync(dirname(path!))).toBe(false);
  });
});
