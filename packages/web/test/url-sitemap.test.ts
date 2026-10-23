import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SITEMAP_LIMITS,
  SitemapError,
  decodeSitemapBytes,
  isPdfUrl,
  loadSitemap,
  normalizeUrl,
  parseSitemap,
} from '../src/index.ts';
import { serve, type TestServer } from './server.ts';

describe('isPdfUrl', () => {
  it('matches a .pdf path in any case, ignoring query and fragment', () => {
    expect(isPdfUrl('https://example.com/a/doc.pdf')).toBe(true);
    expect(isPdfUrl('https://example.com/DOC.PDF?v=2#p3')).toBe(true);
    expect(isPdfUrl('https://example.com/doc.pdf.html')).toBe(false);
    expect(isPdfUrl('https://example.com/view?file=doc.pdf')).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('lowercases scheme and host, drops the fragment and default ports', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/Path/?b=2&a=1#top')).toBe(
      'https://example.com/Path/?b=2&a=1',
    );
    expect(normalizeUrl('http://example.com:80/')).toBe('http://example.com/');
  });

  it('keeps non-default ports and the order of query parameters', () => {
    expect(normalizeUrl('http://example.com:8080/a?z=1&a=2')).toBe(
      'http://example.com:8080/a?z=1&a=2',
    );
    expect(normalizeUrl('http://example.com/a?a=2&z=1')).not.toBe(
      normalizeUrl('http://example.com/a?z=1&a=2'),
    );
  });

  it('resolves relative URLs against a base', () => {
    expect(normalizeUrl('../b#x', 'http://example.com/a/c')).toBe('http://example.com/b');
  });
});

const urlset = (...locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<url><loc>${l}</loc></url>`)
    .join('')}</urlset>`;

describe('parseSitemap', () => {
  it('reads urlset locs and decodes XML entities and CDATA', () => {
    const xml = urlset(
      'http://a.test/x?p=1&amp;q=2',
      ' http://a.test/y ',
      '<![CDATA[http://a.test/z?a=1&b=2]]>',
    );
    expect(parseSitemap(xml)).toEqual({
      kind: 'urlset',
      locs: ['http://a.test/x?p=1&q=2', 'http://a.test/y', 'http://a.test/z?a=1&b=2'],
    });
  });

  it('recognizes a sitemap index and ignores commented-out locs', () => {
    const xml =
      '<sitemapindex><!-- <sitemap><loc>http://a.test/old.xml</loc></sitemap> --><sitemap><loc>http://a.test/s1.xml</loc></sitemap></sitemapindex>';
    expect(parseSitemap(xml)).toEqual({ kind: 'sitemapindex', locs: ['http://a.test/s1.xml'] });
  });

  it('never expands DTD entities', () => {
    const xml =
      '<!DOCTYPE urlset [<!ENTITY x SYSTEM "file:///etc/passwd">]><urlset><url><loc>&x;</loc></url></urlset>';
    expect(parseSitemap(xml).locs).toEqual(['&x;']);
  });

  it('rejects documents that are not sitemaps', () => {
    expect(() => parseSitemap('<html></html>')).toThrow(SitemapError);
    expect(() => parseSitemap('<html><urlset></urlset></html>')).toThrow(SitemapError);
  });

  it('keeps an out-of-range character reference as written instead of failing', () => {
    const xml = urlset('http://a.test/&#99999999;', 'http://a.test/&#x41;');
    expect(parseSitemap(xml).locs).toEqual(['http://a.test/&#99999999;', 'http://a.test/A']);
  });

  it('handles namespace prefixes, attributes and malformed locs', () => {
    const xml =
      '<s:urlset xmlns:s="x"><s:url><s:loc a="1">http://a.test/1</s:loc></s:url><url><loc>http://a.test/bad</url><loc/><loc>http://a.test/2</loc></s:urlset>';
    expect(parseSitemap(xml)).toEqual({
      kind: 'urlset',
      locs: ['http://a.test/1', 'http://a.test/2'],
    });
  });

  it('parses 2 MB of adversarial input in linear time', () => {
    const inputs = [
      `<urlset>${'<loc>'.repeat(400_000)}`,
      `<urlset>${'<!--'.repeat(500_000)}`,
      `<urlset>${'<loc>x</url>'.repeat(170_000)}`,
      `<urlset>${'<loc'.repeat(500_000)}`,
      `<urlset><loc>${'&#x1'.repeat(500_000)}</loc>`,
    ];
    for (const xml of inputs) {
      expect(xml.length).toBeGreaterThan(1_900_000);
      const t0 = performance.now();
      parseSitemap(xml);
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });
});

describe('decodeSitemapBytes', () => {
  const limits = { ...DEFAULT_SITEMAP_LIMITS, maxBytes: 1000, maxCompressedBytes: 100 };

  it('gunzips gzip input', () => {
    const xml = urlset('http://a.test/');
    expect(decodeSitemapBytes(gzipSync(xml), { ...limits, maxCompressedBytes: 1000 })).toBe(xml);
  });

  it('caps plain input, gzip input and gzip output', () => {
    expect(() => decodeSitemapBytes(Buffer.alloc(1001, 32), limits)).toThrow(/larger than 1000/);
    const big = gzipSync(
      Buffer.from(Array.from({ length: 300 }, (_, i) => i.toString(36)).join('')),
    );
    expect(big.length).toBeGreaterThan(100);
    expect(() => decodeSitemapBytes(big, limits)).toThrow(/gzip sitemap is larger than 100/);
    const bomb = gzipSync(Buffer.alloc(5000, 32));
    expect(bomb.length).toBeLessThan(100);
    expect(() => decodeSitemapBytes(bomb, limits)).toThrow(/expands past 1000/);
  });
});

describe('loadSitemap', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await serve((o) => ({
      '/sitemap.xml': {
        type: 'application/xml',
        body: urlset(
          `${o}/a`,
          `${o}/a#dup`,
          `${o}/b?y=1&x=2`,
          'http://elsewhere.test/c',
          'mailto:x@y',
        ),
      },
      '/index.xml': {
        type: 'application/xml',
        body: `<sitemapindex><sitemap><loc>${o}/part.xml.gz</loc></sitemap><sitemap><loc>http://elsewhere.test/s.xml</loc></sitemap></sitemapindex>`,
      },
      '/part.xml.gz': { type: 'application/gzip', body: gzipSync(urlset(`${o}/p1`, `${o}/p2`)) },
      '/two.xml': {
        type: 'application/xml',
        body: `<sitemapindex><sitemap><loc>${o}/sitemap.xml</loc></sitemap><sitemap><loc>${o}/part.xml.gz</loc></sitemap></sitemapindex>`,
      },
      '/nested.xml': {
        type: 'application/xml',
        body: `<sitemapindex><sitemap><loc>${o}/index.xml</loc></sitemap></sitemapindex>`,
      },
      '/huge.xml': { type: 'application/xml', body: Buffer.alloc(4096, 32) },
      '/huge.xml.gz': {
        type: 'application/gzip',
        body: gzipSync(
          Buffer.from(Array.from({ length: 2000 }, (_, i) => i.toString(36)).join('')),
        ),
      },
      '/redirect.xml': {
        status: 302,
        body: '',
        headers: { location: 'http://elsewhere.test/sitemap.xml' },
      },
    }));
  });
  afterAll(() => server.close());

  it('keeps normalized same-origin page URLs only, deduped', async () => {
    const o = server.origin;
    expect(await loadSitemap(`${o}/sitemap.xml`)).toEqual([`${o}/a`, `${o}/b?y=1&x=2`]);
  });

  it('follows a sitemap index one level, including gzip children', async () => {
    const o = server.origin;
    expect(await loadSitemap(`${o}/index.xml`)).toEqual([`${o}/p1`, `${o}/p2`]);
    expect(server.hits.some((h) => h.path === '/s.xml')).toBe(false);
  });

  it('stops reading a body past the size cap', async () => {
    await expect(
      loadSitemap(`${server.origin}/huge.xml`, { ...DEFAULT_SITEMAP_LIMITS, maxBytes: 1024 }),
    ).rejects.toThrow(/larger than 1024/);
  });

  it('enforces the gzip input cap while downloading', async () => {
    await expect(
      loadSitemap(`${server.origin}/huge.xml.gz`, {
        ...DEFAULT_SITEMAP_LIMITS,
        maxCompressedBytes: 200,
      }),
    ).rejects.toThrow(/gzip sitemap .* is larger than 200/);
  });

  it('refuses a sitemap that redirects to another origin', async () => {
    await expect(loadSitemap(`${server.origin}/redirect.xml`)).rejects.toThrow(/leaves/);
  });

  it('caps the number of URLs', async () => {
    const urls = await loadSitemap(`${server.origin}/sitemap.xml`, {
      ...DEFAULT_SITEMAP_LIMITS,
      maxUrls: 1,
    });
    expect(urls).toHaveLength(1);
  });

  it('reports every limit that left part of the sitemap unread as a gap', async () => {
    const o = server.origin;
    const capped: string[] = [];
    await loadSitemap(
      `${o}/sitemap.xml`,
      { ...DEFAULT_SITEMAP_LIMITS, maxUrls: 1 },
      undefined,
      capped,
    );
    expect(capped).toEqual(['the sitemap lists more than 1 pages; the rest were not read']);

    const exact: string[] = [];
    await loadSitemap(
      `${o}/sitemap.xml`,
      { ...DEFAULT_SITEMAP_LIMITS, maxUrls: 2 },
      undefined,
      exact,
    );
    expect(exact).toEqual([]);

    const index: string[] = [];
    await loadSitemap(
      `${o}/two.xml`,
      { ...DEFAULT_SITEMAP_LIMITS, maxSitemaps: 1 },
      undefined,
      index,
    );
    expect(index).toEqual(['the sitemap index lists 2 sitemaps; only the first 1 were read']);

    const nested: string[] = [];
    await loadSitemap(`${o}/nested.xml`, DEFAULT_SITEMAP_LIMITS, undefined, nested);
    expect(nested).toEqual(['1 nested sitemap index(es) were not followed (one level only)']);
  });
});
