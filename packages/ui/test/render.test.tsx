import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { loadStandardsData } from '@widedoor/core';
import {
  AttachmentLoader,
  loadPlainData,
  manualReviews,
  renderHtml,
  type ScanReport,
} from '@widedoor/report';
import { PAYLOAD, fixtureReport } from '../../report/test/fixture.ts';
import {
  NOTES,
  REVIEWER,
  reviewFixtureReport,
  writeAttachments,
} from '../../report/test/review-fixture.ts';
import { ReportView, reportLead } from '../src/ReportView.tsx';
import type { ScreenshotView, UiData } from '../src/data.ts';
import { fixture508 } from './fixture-508.ts';

/*
 * The viewer must say what the HTML report says. Both render three fixtures:
 * the report package's (every outcome, hostile strings, unscanned assets, a
 * manual review), its review fixture (an override, the errata basis, an
 * expired review, attachments) and fixture-508.ts (the 508 view of a web page and a
 * non-web PDF: E205.4 exceptions, Chapter 5 conditions, an older report's
 * pdf-url and capped skips, sitemap, crawl and PDF URL scope, an empty title,
 * ACT and Baseline items).
 * The text of every block element in every section must match, as must every
 * link and image.
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const standards = loadStandardsData();
const data: UiData = {
  plain: loadPlainData(),
  wcagTitle: new Map(standards.wcag.criteria.map((c) => [c.id, c.title])),
  provisionTitle: new Map(standards.section508.provisions.map((p) => [p.id, p.title])),
  errata: new Map(standards.errata.criteria.map((c) => [c.id, c.citations])),
};

const BLOCKS = new Set([
  'h2',
  'h3',
  'h4',
  'p',
  'li',
  'dt',
  'dd',
  'th',
  'td',
  'caption',
  'summary',
  'pre',
]);
const CONTAINERS = new Set([
  'ul',
  'ol',
  'dl',
  'details',
  'table',
  'thead',
  'tbody',
  'tr',
  'section',
]);
const isElement = (n: Node): n is Element => 'tagName' in n;
const attr = (e: Element, name: string) => e.attrs.find((a) => a.name === name)?.value;

function textOf(n: Node): string {
  if (n.nodeName === '#text' && 'value' in n) return n.value;
  if (isElement(n) && n.tagName === 'br') return ' ';
  if (isElement(n) && n.tagName === 'style') return '';
  const inner = 'childNodes' in n ? n.childNodes.map(textOf).join('') : '';
  // Block boundaries separate words, whatever whitespace the markup has between them.
  return isElement(n) && (BLOCKS.has(n.tagName) || CONTAINERS.has(n.tagName))
    ? ` ${inner} `
    : inner;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function find(n: Node, test: (e: Element) => boolean): Element[] {
  const out: Element[] = [];
  const visit = (x: Node) => {
    if (isElement(x) && test(x)) out.push(x);
    if ('childNodes' in x) x.childNodes.forEach(visit);
  };
  visit(n);
  return out;
}

/** Block text, links and images of one section, in document order. */
function sectionOf(markup: string, id: string) {
  const [section] = find(parse(markup), (e) => attr(e, 'aria-labelledby') === id);
  if (!section) throw new Error(`no section ${id}`);
  return {
    blocks: find(section, (e) => BLOCKS.has(e.tagName)).map(
      (e) => `${e.tagName}: ${norm(textOf(e))}`,
    ),
    links: find(section, (e) => e.tagName === 'a').map(
      (e) => `${attr(e, 'href')} ${norm(textOf(e))}`,
    ),
    images: find(section, (e) => e.tagName === 'img').map(
      (e) => `${attr(e, 'src')} ${attr(e, 'alt')}`,
    ),
  };
}

const view = (
  report: ScanReport,
  findings?: ScanReport['findings'],
  attachments?: ReadonlyMap<string, ScreenshotView>,
) =>
  renderToStaticMarkup(
    <ReportView
      report={report}
      data={data}
      screenshots={new Map()}
      {...(attachments ? { attachments } : {})}
      {...(findings ? { findings } : {})}
    />,
  );

const SECTIONS = ['manual', 'fix', 'by-asset', 'summary', 'rollup', 'method', 'disclaimer'];

describe('ReportView', () => {
  const report = fixtureReport();
  const html = renderHtml(report, { plain: data.plain });
  const ui = view(report);

  it.each(SECTIONS)('matches the HTML report in section %s', (id) => {
    const want = sectionOf(html, id);
    const got = sectionOf(ui, id);
    expect(want.blocks.length).toBeGreaterThan(0);
    expect(got).toEqual(want);
  });

  it('has the HTML report lead line and the exact disclaimer', () => {
    const [lead] = find(parse(html), (e) => e.tagName === 'p' && attr(e, 'class') === 'lead');
    expect(reportLead(report)).toBe(norm(textOf(lead as Element)));
    expect(ui).toContain(
      'This report documents the testing performed. It is not a certification of conformance.',
    );
  });

  it('renders hostile strings as text only', () => {
    const doc = parse(`<!doctype html><html><head></head><body>${ui}</body></html>`);
    expect(find(doc, (e) => e.tagName === 'script')).toEqual([]);
    expect(find(doc, (e) => e.attrs.some((a) => a.name.startsWith('on')))).toEqual([]);
    const hrefs = find(doc, (e) => e.tagName === 'a').map((e) => attr(e, 'href') ?? '');
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.filter((h) => !h.startsWith('https://'))).toEqual([]);
    expect(norm(textOf(doc))).toContain(norm(PAYLOAD));
  });

  it('shows invisible and bidi characters as markers, as the HTML report does', () => {
    const marked = JSON.parse(JSON.stringify(report), (key, value) =>
      typeof value === 'string' &&
      ['title', 'snippet', 'message', 'finalUri', 'reviewer', 'notes', 'selector', 'what'].includes(
        key,
      )
        ? `${value}\u202e\u0007`
        : value,
    ) as ScanReport;
    const out = view(marked);
    expect(out).not.toContain('\u202e');
    expect(out).not.toContain('\u0007');
    expect(out).toContain('[U+202E][U+0007]');
    for (const id of SECTIONS)
      expect(sectionOf(out, id)).toEqual(sectionOf(renderHtml(marked, { plain: data.plain }), id));
  });

  it('keeps each page count whole when the list is filtered', () => {
    const critical = report.findings.filter((f) => f.impact === 'critical');
    const leads = (markup: string) =>
      find(parse(markup), (e) => e.tagName === 'p' && attr(e, 'class') === 'lead').map((e) =>
        norm(textOf(e)),
      );
    expect(leads(view(report, critical))).toEqual(leads(sectionOfHtml(html)));
    expect(leads(view(report, []))).toEqual(leads(sectionOfHtml(html)));
    expect(view(report, critical)).toMatch(/The filter shows 2 of 5\./);
  });

  it('lists only the findings it is given, and says so when none match', () => {
    const fails = report.findings.filter((f) => f.outcome === 'fail' && f.impact === 'critical');
    const some = sectionOf(view(report, fails), 'fix');
    expect(some.blocks.filter((b) => b.startsWith('h3:'))).toHaveLength(1);
    const none = sectionOf(view(report, []), 'fix');
    expect(none.blocks).toEqual(['h2: What to fix first', 'p: No findings match the filter.']);
    expect(sectionOf(view(report, []), 'summary')).toEqual(sectionOf(ui, 'summary'));
  });
});

/** The per-asset section of a full HTML report, as markup. */
function sectionOfHtml(markup: string): string {
  const start = markup.indexOf('<section aria-labelledby="by-asset">');
  return markup.slice(start, markup.indexOf('<section aria-labelledby="summary">'));
}

describe('ReportView on a 508 scan of a web page and a non-web PDF', () => {
  const report = fixture508();
  const html = renderHtml(report, { plain: data.plain });
  const ui = view(report);

  it('covers the branches this fixture is for', () => {
    const text = norm(textOf(parse(html)));
    for (const expected of [
      'Not applicable to 1 PDF under E205.4',
      'Condition (501.1)',
      'did not fetch PDFs by URL (pdf-url)',
      'a PDF link, not fetched by that version (pdf-url)',
      'PDF by URL: https://example.gov/forms/b.pdf',
      'more skipped pages and files are listed in the JSON report',
      'Sitemap: https://example.gov/sitemap.xml',
      'Followed links on the same site, up to 2 pages',
      'The page limit was reached before every page was scanned.',
      '(empty page title)',
      'W3C ACT rule 23a2a8',
      'ICT Testing Baseline test 7.A',
    ])
      expect(text, expected).toContain(expected);
  });

  it.each(SECTIONS)('matches the HTML report in section %s', (id) => {
    const want = sectionOf(html, id);
    expect(want.blocks.length).toBeGreaterThan(0);
    expect(sectionOf(ui, id)).toEqual(want);
  });
});

describe('ReportView on a scan with manual reviews, an override, the errata and attachments', () => {
  const report = reviewFixtureReport();
  const root = mkdtempSync(join(tmpdir(), 'widedoor-ui-reviews-'));
  const dir = writeAttachments(root);
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  // What widedoor ui serves: every attachment the records name, through the same loader.
  const loader = new AttachmentLoader(dir);
  const attachments = new Map<string, ScreenshotView>();
  for (const r of manualReviews(report).records)
    for (const path of r.attachments) {
      const loaded = loader.load(path);
      attachments.set(
        path,
        loaded.ok ? { ok: true, dataUri: loaded.dataUri } : { ok: false, reason: loaded.reason },
      );
    }
  const html = renderHtml(report, { plain: data.plain, attachmentsDir: dir });
  const ui = view(report, undefined, attachments);

  it.each(SECTIONS)('matches the HTML report in section %s', (id) => {
    const want = sectionOf(html, id);
    expect(want.blocks.length).toBeGreaterThan(0);
    expect(sectionOf(ui, id)).toEqual(want);
  });

  it('shows the attachments, the overridden list and the errata links', () => {
    expect(sectionOf(ui, 'method').images).toHaveLength(2);
    expect(sectionOf(ui, 'manual').blocks).toContain('h3: Overridden by a reviewer');
    expect(sectionOf(ui, 'rollup').links.filter((l) => l.includes('/errata/'))).toHaveLength(4);
  });

  it('renders hostile reviewer names and notes as text only', () => {
    const doc = parse(`<!doctype html><html><head></head><body>${ui}</body></html>`);
    expect(find(doc, (e) => e.tagName === 'script')).toEqual([]);
    expect(find(doc, (e) => e.attrs.some((a) => a.name.startsWith('on')))).toEqual([]);
    for (const src of find(doc, (e) => e.tagName === 'img').map((e) => attr(e, 'src') ?? ''))
      expect(src).toMatch(/^data:image\/(?:png|jpeg);base64,/);
    const text = norm(textOf(doc));
    expect(text).toContain(norm(REVIEWER));
    expect(text).toContain(norm(NOTES));
  });

  it('says why an attachment is missing when the report came from a file', () => {
    expect(view(report)).toContain('left out: no attachments folder was given.');
  });
});
