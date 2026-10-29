import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseJsonReport, type ScanReport } from '@widedoor/report';
import type { ScanResult } from '../src/hosted/protocol.ts';
import {
  NO_LEAKS,
  START,
  hostedLab,
  html,
  localPathForms,
  scanInLab,
  send,
  urlJob,
  type Lab,
} from './hosted-fixtures.ts';

/*
 * Hosted scans of a URL in Chromium, through the SSRF lab's egress proxy (npm
 * run test:browser): what the report holds, the open tier's page cap, robots.txt
 * on crawled pages, no linked PDFs and no screenshots.
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url));

/** A page with a failing image (so a screenshot would be due) and the given links. */
const page = (title: string, links: readonly string[] = []) =>
  html(
    `<p>${title}</p><img src="/pixel.gif" width="20" height="20">${links
      .map((l) => `<a href="${l}">${l}</a>`)
      .join(' ')}`,
  ).replace('<title>SSRF</title>', `<title>${title}</title>`);

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function reportOf(result: ScanResult): ScanReport {
  expect(result.status, result.error).toBe('done');
  return parseJsonReport(result.reportJson as string);
}

describe('runHostedScan: a URL', () => {
  let lab: Lab;
  const agents: string[] = [];
  beforeAll(async () => {
    lab = await hostedLab();
  });
  afterAll(() => lab.close());
  afterEach(() => {
    lab.routes.clear();
    lab.pub.requests.length = 0;
    agents.length = 0;
  });

  const site = (pages: Record<string, readonly string[]>) => {
    lab.routes.set('/pixel.gif', (_req, res) =>
      res.writeHead(200, { 'content-type': 'image/gif' }).end(GIF),
    );
    for (const [path, links] of Object.entries(pages))
      lab.routes.set(path, (req, res) => {
        agents.push(req.headers['user-agent'] ?? '');
        send(page(path, links))(req, res);
      });
  };

  it('scans a URL and returns JSON and HTML reports with no screenshots', async () => {
    site({ '/': ['/about'], '/about': [] });
    const { result, log } = await scanInLab(lab, urlJob());
    const report = reportOf(result);
    expect(report.assets.map((a) => a.uri)).toEqual([START, `${START}about`]);
    expect(report.scope.web).toMatchObject({
      urls: [START],
      crawl: { sameOrigin: true, maxPages: 6 },
    });
    // Findings that would have had screenshots in a CLI run, with none.
    expect(
      report.findings.some((f) => f.outcome === 'fail' && f.source.ruleId === 'image-alt'),
    ).toBe(true);
    expect(report.findings.every((f) => f.evidence?.screenshot === undefined)).toBe(true);
    // Only the JSON report comes back: the API renders the HTML itself (R37).
    expect(Object.keys(result).sort()).toEqual(['reportJson', 'status']);
    expect(result.reportJson).not.toMatch(/data:image\/png/);
    // The hosted user agent, and every request through the proxy.
    expect(agents.length).toBeGreaterThan(0);
    expect(
      agents.every((ua) => /Widedoor\/[^;]+; \+https:\/\/example\.org\/contact/.test(ua)),
    ).toBe(true);
    expect(lab.dials.length).toBeGreaterThan(0);
    expect(lab.leaks()).toEqual(NO_LEAKS);
    expect(log).toEqual([expect.stringMatching(/^widedoor event=robots_decision /)]);
  });

  it('open tier stops at 6 pages', async () => {
    const links = Array.from({ length: 10 }, (_, i) => `/p${i + 1}`);
    site(Object.fromEntries([['/', links], ...links.map((l) => [l, links])]));
    const report = reportOf((await scanInLab(lab, urlJob())).result);
    expect(report.assets).toHaveLength(6);
    expect(report.scope.web?.maxPages).toBe(6);
    expect(lab.pub.requests.filter((r) => /^\/(p\d+)?$/.test(r))).toHaveLength(6);
  });

  it('skips crawled pages robots.txt disallows and fetches no linked PDF', async () => {
    lab.routes.set('/robots.txt', send('User-agent: *\nDisallow: /private\n', 'text/plain'));
    site({ '/': ['/private', '/public', '/files/a.pdf'], '/public': [], '/private': [] });
    lab.routes.set('/files/a.pdf', send('%PDF-1.7', 'application/pdf'));
    const report = reportOf((await scanInLab(lab, urlJob())).result);
    expect(report.assets.map((a) => a.uri)).toEqual([START, `${START}public`]);
    expect(report.skipped).toEqual([
      { uri: `${START}private`, finalUri: `${START}private`, reason: 'robots-disallowed' },
    ]);
    expect(report.scopeGaps).toEqual([
      expect.stringMatching(/^1 linked PDF\(s\) were not scanned: the hosted scanner/),
    ]);
    expect(lab.pub.requests).not.toContain('/private');
    expect(lab.pub.requests).not.toContain('/files/a.pdf');
  });

  it('report text holds no absolute paths', async () => {
    site({ '/': [] });
    const { result } = await scanInLab(lab, urlJob());
    expect(result.status).toBe('done');
    const text = result.reportJson ?? '';
    for (const form of localPathForms([tmpdir(), homedir(), process.cwd(), repo]))
      expect(text).not.toContain(form);
  });
});
