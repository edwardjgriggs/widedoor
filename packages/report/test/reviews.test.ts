import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AjvDraft04 from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadStandardsData, safeText } from '@widedoor/core';
import {
  AttachmentLoader,
  isJpeg,
  isPng,
  overriddenFails,
  overrideEntries,
  parseJsonReport,
  renderHtml,
  serializeJson,
  serializeJunit,
  summarize,
  toSarif,
  xmlAttr,
  xmlText,
  type ScanReport,
} from '../src/index.ts';
import { PAYLOAD } from './fixture.ts';
import { expectInert } from './inert.ts';
import {
  ATTACHMENTS,
  CONTRAST,
  EXPIRED,
  FIGURE,
  HERO,
  JPEG,
  NOTES,
  OVERRIDE,
  PAGE,
  PDF,
  PNG,
  PNG_THEN_HTML,
  REVIEWER,
  reviewFixtureReport,
  writeAttachments,
} from './review-fixture.ts';
import { descendants, parseXml, type XmlElement } from './xml.ts';

/*
 * Task 2.5: manual review progress, reviewer overrides, the errata basis,
 * review attachments and the JUnit reporter, on review-fixture.ts.
 */

type Node = DefaultTreeAdapterMap['node'];

function textOf(node: Node): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  if ('tagName' in node && node.tagName === 'style') return '';
  return 'childNodes' in node ? node.childNodes.map(textOf).join('') : '';
}

function section(doc: Node, id: string): Node {
  let found: Node | undefined;
  const visit = (n: Node) => {
    if ('attrs' in n && n.attrs.some((a) => a.name === 'aria-labelledby' && a.value === id))
      found = n;
    if ('childNodes' in n) n.childNodes.forEach(visit);
  };
  visit(doc);
  if (!found) throw new Error(`no section ${id}`);
  return found;
}

const corpus = new URL('../../../corpus/act/test-assets/', import.meta.url);
const asset = (path: string) => readFileSync(new URL(path, corpus));

let root: string;
let attachmentsDir: string;
const report = reviewFixtureReport();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'widedoor-reviews-'));
  attachmentsDir = writeAttachments(root);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('buildScanReport with manual reviews', () => {
  it('counts the checklist by status, without storing the items', () => {
    expect(report.checklist).toBeDefined();
    const c = report.checklist!;
    expect(c.unscanned).toBe(0);
    expect(c.byStatus.done).toBe(2); // 1.1.1 (the override) and 2.1.1 on the page
    expect(c.byStatus.expired).toBe(1); // 1.3.2 on the PDF
    expect(c.byStatus['failed-automated']).toBeGreaterThanOrEqual(2); // 1.4.3 and the PDF figure
    expect(c.total).toBe(
      c.byStatus.open + c.byStatus.done + c.byStatus.expired + c.byStatus['failed-automated'],
    );
  });

  it('lists the overridden fail with the reviewer, date and notes', () => {
    expect(report.overrides).toEqual([
      {
        finding: HERO.id,
        uri: PAGE.uri,
        engine: 'axe-core',
        ruleId: 'image-alt',
        record: OVERRIDE.id,
        criterion: { type: 'wcag', id: '1.1.1' },
        reviewer: REVIEWER,
        date: '2026-10-22',
        notes: NOTES,
      },
    ]);
    expect(overrideEntries(report)).toEqual(report.overrides);
  });

  it('adds run warnings from the caller to the report', () => {
    expect(report.warnings).toContain(
      `manual review record wd_0 (wcag-9.9.9) was left out: orphaned: ${PAYLOAD}`,
    );
  });

  it('round trips through the JSON report, and reads a report without the new fields', () => {
    expect(parseJsonReport(serializeJson(report))).toEqual(report);
    const old = JSON.parse(serializeJson(report));
    delete old.checklist;
    delete old.overrides;
    for (const s of old.rollup.standards)
      for (const c of s.criteria)
        for (const d of [...c.assets, ...(c.product ? [c.product] : [])]) delete d.overridden;
    const parsed = parseJsonReport(JSON.stringify(old));
    // Without overridden lists nothing is set aside, so the fail counts again.
    expect(overriddenFails(parsed)(HERO)).toBe(false);
    expect(summarize(parsed).outcomes.fail).toBe(summarize(report).outcomes.fail + 1);
    expect(renderHtml(parsed)).toContain(
      'This report was written before Widedoor counted the manual review checklist.',
    );
  });
});

describe('overridden fails', () => {
  it('are set aside only when overridden in every criterion they count in', () => {
    const test = overriddenFails(report);
    expect(test(HERO)).toBe(true);
    expect(test(CONTRAST)).toBe(false);
    expect(test(FIGURE)).toBe(false);
    // The same fail citing a second criterion it still fails is not set aside.
    const both = { ...HERO, criteria: { wcag: ['1.1.1', '4.1.2'] } };
    const twice = reviewFixtureReport();
    const r: ScanReport = {
      ...twice,
      rollup: {
        ...twice.rollup,
        standards: twice.rollup.standards.map((s) => ({
          ...s,
          criteria: s.criteria.map((c) =>
            c.id === '4.1.2'
              ? {
                  ...c,
                  assets: c.assets.map((d) =>
                    d.uri === PAGE.uri ? { ...d, state: 'fail', evidence: [HERO.id] } : d,
                  ),
                }
              : c,
          ),
        })),
      },
    };
    expect(overriddenFails(r)(both)).toBe(false);
  });

  it('leave the fail counts and count on their own', () => {
    const s = summarize(report);
    expect(s.overridden).toBe(1);
    expect(s.outcomes.fail).toBe(2); // CONTRAST and FIGURE
    expect(s.failsByImpact.critical).toBe(0);
    expect(s.failsByImpact.serious).toBe(2);
  });

  it('name the Supports that rest on the errata basis', () => {
    const s = summarize(report);
    for (const c of s.criteria) expect(c.errataSupports).toEqual(['4.1.1']);
  });
});

describe('HTML report with manual reviews', () => {
  let page: string;
  let doc: Node;
  beforeAll(() => {
    page = renderHtml(report, { attachmentsDir });
    doc = parse(page);
  });

  it('is inert with the attachments embedded, and allows data: images', () => {
    const r = expectInert(page);
    expect(r.images).toEqual([
      `data:image/png;base64,${PNG.toString('base64')}`,
      `data:image/jpeg;base64,${JPEG.toString('base64')}`,
    ]);
  });

  it('puts the manual review section first, with the checklist counts', () => {
    const manual = textOf(section(doc, 'manual'));
    const c = report.checklist!;
    expect(manual).toContain(`Open (not reviewed yet)${c.byStatus.open}`);
    expect(manual).toContain(`Done (a current manual result decides it)${c.byStatus.done}`);
    expect(manual).toContain(
      `Expired (the page or file changed since the review)${c.byStatus.expired}`,
    );
    expect(manual).toContain(`Total${c.total}`);
    expect(page.indexOf('aria-labelledby="manual"')).toBeLessThan(
      page.indexOf('aria-labelledby="fix"'),
    );
  });

  it('moves the overridden fail to its own list, with reviewer, date and notes as text', () => {
    const manual = textOf(section(doc, 'manual'));
    expect(manual).toContain(
      `${REVIEWER}, 2026-10-22: axe-core rule image-alt (${HERO.id}) for WCAG 1.1.1 on ${PAGE.uri}. Notes: ${NOTES}`,
    );
    const fix = textOf(section(doc, 'fix'));
    expect(fix).not.toContain('image-alt');
    expect(fix).toContain('Rule: axe-core 4.14.0, color-contrast');
    expect(textOf(section(doc, 'by-asset'))).not.toContain('img.hero');
    expect(textOf(section(doc, 'summary'))).toContain(
      'Problems set aside by a reviewer (overridden)1',
    );
  });

  it('links the errata on 4.1.1 and says Supports rests on them', () => {
    const rollup = section(doc, 'rollup');
    const links: string[] = [];
    const visit = (n: Node) => {
      if ('tagName' in n && n.tagName === 'a') links.push(n.attrs[0]?.value ?? '');
      if ('childNodes' in n) n.childNodes.forEach(visit);
    };
    visit(rollup);
    const urls = loadStandardsData().errata.criteria[0]!.citations.map((c) => c.url);
    for (const url of urls) expect(links.filter((l) => l === url)).toHaveLength(2);
    expect(textOf(rollup)).toContain('2 assets pass on the errata basis, not on a test');
    expect(textOf(section(doc, 'summary'))).toContain(
      'Section 508: 1 Supports (4.1.1 on the errata basis, not on a test)',
    );
  });

  it('marks the expired review and leaves out attachments that are not whole images', () => {
    const method = textOf(section(doc, 'method'));
    expect(method).toContain(`for WCAG 1.3.2 on ${PDF.uri} (expired:`);
    expect(method).toContain(
      `Attachment ${ATTACHMENTS.html} left out: the file is not a whole PNG or JPEG image.`,
    );
    expect(method).toContain(
      `Attachment ${ATTACHMENTS.missing} left out: the file is not in the attachments folder.`,
    );
    expect(EXPIRED.outcome).toBe('pass');
  });

  it('embeds an image two records name once, and counts it once against the total', () => {
    const method = textOf(section(doc, 'method'));
    expect(method).toContain(
      `Attachment ${ATTACHMENTS.png}: the same file as in an earlier record above.`,
    );
    const tight = renderHtml(report, {
      attachmentsDir,
      attachments: { maxTotalBytes: PNG.length + JPEG.length },
    });
    expect(expectInert(tight).images).toHaveLength(2);
  });

  it('links only https errata citations', () => {
    const data = loadStandardsData();
    const http = structuredClone(data);
    const first = http.errata.criteria[0]!.citations[0]!;
    first.url = first.url.replace('https://', 'http://');
    const plain = renderHtml(report, { data: http });
    expect(plain).not.toContain(`href="${first.url}"`);
    expect(plain).toContain(`href="${data.errata.criteria[0]!.citations[1]!.url}"`);
  });

  it('embeds nothing, and keeps data: images out of the CSP, without an attachments folder', () => {
    const plain = renderHtml(report);
    expect(expectInert(plain).images).toEqual([]);
    expect(plain).toContain('left out: no attachments folder was given.');
  });

  it('matches its snapshot', async () => {
    await expect(page).toMatchFileSnapshot('__snapshots__/reviews.html');
  });
});

describe('JSON and SARIF reports with manual reviews', () => {
  it('match their snapshots', async () => {
    await expect(serializeJson(report)).toMatchFileSnapshot('__snapshots__/reviews.json');
    await expect(`${JSON.stringify(toSarif(report), null, 2)}\n`).toMatchFileSnapshot(
      '__snapshots__/reviews.sarif',
    );
  });

  it('keep the overridden fail as a suppressed SARIF result with the notes as justification', () => {
    const vendor = new URL('../vendor/sarif/', import.meta.url);
    const ajv = new AjvDraft04.default({ strict: true, strictRequired: false, allErrors: true });
    addFormats.default(ajv);
    const validate = ajv.compile(
      JSON.parse(readFileSync(new URL('sarif-schema-2.1.0.json', vendor), 'utf8')),
    );
    const sarif = toSarif(report) as {
      runs: {
        results: { partialFingerprints: Record<string, string>; suppressions?: unknown }[];
      }[];
    };
    expect(validate(sarif), JSON.stringify(validate.errors)).toBe(true);
    const results = sarif.runs[0]!.results;
    const byId = (id: string) =>
      results.filter((r) => r.partialFingerprints['widedoorFindingId/v1'] === id);
    expect(byId(HERO.id)).toHaveLength(1);
    expect(byId(HERO.id)[0]?.suppressions).toEqual([
      { kind: 'external', justification: safeText(NOTES, 2000) },
    ]);
    expect(byId(CONTRAST.id)[0]?.suppressions).toBeUndefined();
    expect(results).toHaveLength(3);
  });
});

describe('JUnit report', () => {
  const xml = serializeJunit(report);
  const doc = parseXml(xml);
  const suites = descendants(doc, 'testsuite');
  const suite = (name: string) => suites.find((s) => s.attrs.name === name) as XmlElement;
  const testcase = (s: XmlElement, id: string) =>
    s.children.find((c) => c.name === 'testcase' && c.attrs.name?.startsWith(`${id} `));

  it('is well-formed XML with one suite per asset and one for product-scope items', () => {
    expect(doc.name).toBe('testsuites');
    expect(suites.map((s) => s.attrs.name)).toEqual([
      PAGE.uri,
      PDF.uri,
      'Product (judged once for the whole product)',
    ]);
  });

  it('has one testcase per criterion of the first standard view that applies to the asset', () => {
    const view = report.rollup.standards[0]!;
    expect(view.standard).toBe('508');
    for (const s of suites.slice(0, 2)) {
      const expected = view.criteria
        .filter((c) => c.assets.some((a) => a.uri === s.attrs.name))
        .map((c) => `${c.id} ${c.title}`);
      expect(s.children.filter((c) => c.name === 'testcase').map((c) => c.attrs.name)).toEqual(
        expected,
      );
      for (const c of s.children.filter((x) => x.name === 'testcase'))
        expect(c.attrs.classname).toBe('Section 508');
    }
  });

  it('maps results: fail is a failure, no deciding result skipped, pass and N/A pass', () => {
    const page = suite(PAGE.uri);
    const contrast = testcase(page, '1.4.3');
    expect(contrast?.children[0]?.name).toBe('failure');
    expect(contrast?.children[0]?.attrs.type).toBe('Does Not Support');
    expect(contrast?.children[0]?.text).toContain(`${CONTRAST.id} axe-core color-contrast`);
    const override = testcase(page, '1.1.1');
    expect(override?.children.map((c) => c.name)).toEqual(['system-out']);
    expect(override?.children[0]?.text).toContain('set aside the automated fails');
    const parsing = testcase(page, '4.1.1');
    expect(parsing?.children[0]?.name).toBe('system-out');
    expect(parsing?.children[0]?.text).toContain('on the errata basis, not on a test');
    expect(parsing?.children[0]?.text).toContain('https://www.w3.org/WAI/WCAG21/errata/');
    const expired = testcase(suite(PDF.uri), '1.3.2');
    expect(expired?.children[0]?.name).toBe('skipped');
    expect(expired?.children[0]?.attrs.message).toMatch(/^Not Evaluated: no deciding result/);
    const counts = (s: XmlElement) => {
      const cases = s.children.filter((c) => c.name === 'testcase');
      return {
        tests: String(cases.length),
        failures: String(cases.filter((c) => c.children[0]?.name === 'failure').length),
        skipped: String(cases.filter((c) => c.children[0]?.name === 'skipped').length),
      };
    };
    for (const s of suites) expect(s.attrs).toMatchObject(counts(s));
    // JUnit's timestamp: date and time in UTC, no zone suffix and no fraction.
    for (const s of suites) expect(s.attrs.timestamp).toBe('2026-10-23T12:00:00');
    expect(Number(doc.attrs.tests)).toBe(suites.reduce((n, s) => n + Number(s.attrs.tests), 0));
  });

  it('matches its snapshot', async () => {
    await expect(xml).toMatchFileSnapshot('__snapshots__/reviews.junit.xml');
  });

  it('escapes for XML 1.0: drops invalid characters, marks invisible ones, escapes markup', () => {
    const hostile = `a\u0000b\u0007c\uFFFE\uD800d\u202Ee<f&g>"h'\ti\nj`;
    expect(xmlText(hostile)).toBe('abcd[U+202E]e&lt;f&amp;g&gt;"h\'\ti\nj');
    expect(xmlAttr(hostile)).toBe('abcd[U+202E]e&lt;f&amp;g&gt;&quot;h&apos;&#9;i&#10;j');
    // A hostile asset uri and review text still give well-formed XML.
    const evil = '</testsuite><script>alert(1)</script>&amp;';
    const r: ScanReport = JSON.parse(
      JSON.stringify(report).replaceAll(PAGE.uri, `${PAGE.uri}?${evil}\\u0000\\u202e`),
    );
    const parsed = parseXml(serializeJunit(r));
    expect(descendants(parsed, 'testsuite')[0]?.attrs.name).toBe(`${PAGE.uri}?${evil}[U+202E]`);
  });
});

describe('whole-image checks', () => {
  it('accept real PNG and JPEG files', () => {
    for (const f of ['contrast/example.png', 'shared/background.png', 'shared/w3c-logo.png'])
      expect(isPng(asset(f)), f).toBe(true);
    for (const f of ['c487ae/planets.jpg', 'contrast/black-hole.jpeg', 'shared/fireworks.jpg'])
      expect(isJpeg(asset(f)), f).toBe(true);
    expect(isPng(PNG)).toBe(true);
    expect(isJpeg(JPEG)).toBe(true);
  });

  it('refuse a signature followed by anything else, trailing bytes and truncation', () => {
    expect(isPng(PNG_THEN_HTML)).toBe(false);
    expect(isPng(Buffer.concat([PNG, Buffer.from('<script>')]))).toBe(false);
    expect(isPng(PNG.subarray(0, PNG.length - 1))).toBe(false);
    const flipped = Buffer.from(PNG);
    flipped[20] = (flipped[20] as number) ^ 1;
    expect(isPng(flipped)).toBe(false);
    expect(isJpeg(Buffer.concat([JPEG.subarray(0, 20), Buffer.from('<html></html>')]))).toBe(false);
    expect(isJpeg(Buffer.concat([JPEG, Buffer.from('<script>')]))).toBe(false);
    expect(isJpeg(JPEG.subarray(0, JPEG.length - 2))).toBe(false);
    expect(isJpeg(PNG)).toBe(false);
    expect(isPng(JPEG)).toBe(false);
  });
});

describe('AttachmentLoader', () => {
  const load = (path: string) => new AttachmentLoader(attachmentsDir).load(path);

  it('types an image by its bytes, never by its name', () => {
    expect(load(ATTACHMENTS.png)).toMatchObject({
      ok: true,
      dataUri: expect.stringMatching(/^data:image\/png;/),
    });
    expect(load(ATTACHMENTS.jpeg)).toMatchObject({
      ok: true,
      dataUri: expect.stringMatching(/^data:image\/jpeg;/),
    });
    writeFileSync(join(attachmentsDir, 'named-png.png'), JPEG);
    expect(load('attachments/named-png.png')).toMatchObject({
      ok: true,
      dataUri: expect.stringMatching(/^data:image\/jpeg;/),
    });
  });

  it('refuses paths that are not attachments/<name>, and files outside the folder', () => {
    for (const path of [
      'attachments/../secret.png',
      '../attachments/x.png',
      'attachments/sub/x.png',
      'x.png',
      'attachments/x.svg',
      'attachments/x.png.html',
      '/etc/passwd',
      'attachments/x.png\0',
    ])
      expect(load(path), path).toEqual({
        ok: false,
        reason: 'the path is not attachments/<name>.png, .jpg or .jpeg',
      });
    writeFileSync(join(root, 'outside.png'), PNG);
    try {
      symlinkSync(join(root, 'outside.png'), join(attachmentsDir, 'link.png'), 'file');
    } catch (e) {
      // A file link needs Developer Mode or admin rights on Windows; the folder-link case is in html.test.ts.
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return;
      throw e;
    }
    expect(load('attachments/link.png')).toEqual({
      ok: false,
      reason: 'the file is not in the attachments folder',
    });
  });

  it('refuses a widedoor-review/ or attachments/ that is a link or junction', () => {
    const outside = join(root, 'elsewhere');
    mkdirSync(join(outside, 'attachments'), { recursive: true });
    writeFileSync(join(outside, 'attachments', 'x.png'), PNG);
    writeFileSync(join(outside, 'x.png'), PNG);
    // A junction needs no special rights on Windows and is a symbolic link elsewhere.
    const linkedReview = join(root, 'a', 'widedoor-review');
    mkdirSync(join(root, 'a'));
    symlinkSync(outside, linkedReview, 'junction');
    expect(
      new AttachmentLoader(join(linkedReview, 'attachments')).load('attachments/x.png'),
    ).toEqual({
      ok: false,
      reason:
        'widedoor-review/ is a symbolic link or junction; Widedoor reads only a real folder here',
    });
    const review = join(root, 'b', 'widedoor-review');
    mkdirSync(review, { recursive: true });
    symlinkSync(outside, join(review, 'attachments'), 'junction');
    expect(new AttachmentLoader(join(review, 'attachments')).load('attachments/x.png')).toEqual({
      ok: false,
      reason: 'attachments/ is a symbolic link or junction; Widedoor reads only a real folder here',
    });
  });

  it('stops at its total for the report', () => {
    const loader = new AttachmentLoader(attachmentsDir, { maxTotalBytes: PNG.length + 1 });
    expect(loader.load(ATTACHMENTS.png).ok).toBe(true);
    expect(loader.load(ATTACHMENTS.jpeg)).toEqual({
      ok: false,
      reason: 'the report reached its attachment size limit',
    });
  });
});
