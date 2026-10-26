import { describe, expect, it } from 'vitest';
import {
  DISCLAIMER,
  SUPPORT_DOCS_NOTE,
  buildAcr,
  renderVpatDocx,
  vpatOutline,
  type Acr,
} from '../src/index.ts';
import {
  HOSTILE_META,
  HOSTILE_NOTES_SAFE,
  NONCHARACTERS_SAFE,
  META,
  acrReport,
  decidedReport,
  hostileReferenceReport,
} from './acr-fixture.ts';
import { PAYLOAD } from './fixture.ts';
import { descendants, parseXml, type XmlElement } from './xml.ts';
import { readZip, type ZipEntry } from './zip.ts';

/*
 * The ACR as DOCX: the package is unzipped with the test's own reader and
 * each XML part parsed with the test's own XML reader, then checked for what
 * makes a Word document accessible (language, title and author, Heading 1 to
 * 3, data tables with a repeating header row, no images) and for the same
 * VPAT® naming and template order as the HTML file.
 */

// Strict UTF-8: a bad byte sequence throws instead of reading as U+FFFD.
const decoder = new TextDecoder('utf-8', { fatal: true });
const utf8 = (bytes: Uint8Array) => decoder.decode(bytes);

interface Docx {
  entries: ZipEntry[];
  part: (name: string) => XmlElement;
  /** Every XML part as text. */
  xml: string;
}

async function open(acr: Acr): Promise<Docx> {
  const entries = readZip(await renderVpatDocx(acr));
  const text = (name: string) => {
    const e = entries.find((x) => x.name === name);
    if (!e) throw new Error(`no ${name}`);
    return utf8(e.data);
  };
  return {
    entries,
    part: (name) => parseXml(text(name)),
    xml: entries
      .filter((e) => /\.(xml|rels)$/.test(e.name))
      .map((e) => utf8(e.data))
      .join('\n'),
  };
}

const child = (el: XmlElement, name: string) => el.children.find((c) => c.name === name);
const textOf = (el: XmlElement) =>
  descendants(el, 'w:t')
    .map((t) => t.text)
    .join('');
/** Paragraph text with each w:br as a line break. */
const lines = (p: XmlElement): string => {
  const out: string[] = [];
  for (const r of descendants(p, 'w:r'))
    for (const c of r.children) {
      if (c.name === 'w:br') out.push('\n');
      if (c.name === 'w:t') out.push(c.text);
    }
  return out.join('');
};
const style = (p: XmlElement) => {
  const pPr = child(p, 'w:pPr');
  return pPr ? child(pPr, 'w:pStyle')?.attrs['w:val'] : undefined;
};
const body = (d: Docx) => {
  const b = child(d.part('word/document.xml'), 'w:body');
  if (!b) throw new Error('no body');
  return b;
};
/** Headings in order, as "Heading2 Notes". */
const headings = (d: Docx) =>
  body(d)
    .children.filter((c) => c.name === 'w:p' && /^Heading[1-3]$/.test(style(c) ?? ''))
    .map((p) => `${style(p)} ${textOf(p)}`);

const complete = buildAcr(decidedReport(), META);
const draft = buildAcr(acrReport(), META);

describe.each([
  ['complete', complete],
  ['draft', draft],
] as const)('VPAT DOCX package, %s', (_name, acr) => {
  it('is a valid zip with the content types, the document and the core properties', async () => {
    const d = await open(acr);
    const names = d.entries.map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining(['[Content_Types].xml', 'word/document.xml', 'docProps/core.xml']),
    );
    // Every XML part is well formed and holds only XML 1.0 characters.
    const parts = d.entries.filter((x) => /\.(xml|rels)$/.test(x.name));
    expect(parts.length).toBeGreaterThan(10);
    for (const e of parts) parseXml(utf8(e.data));
    const types = d.part('[Content_Types].xml');
    expect(
      types.children.some(
        (c) =>
          c.attrs.PartName === '/word/document.xml' &&
          c.attrs.ContentType ===
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
      ),
    ).toBe(true);
  });

  it('sets the title and author, and dates it from the scan, not the clock', async () => {
    const d = await open(acr);
    const core = d.part('docProps/core.xml');
    expect(child(core, 'dc:title')?.text).toBe(vpatOutline(acr).title);
    expect(child(core, 'dc:creator')?.text).toBe('Example Agency');
    expect(child(core, 'dcterms:created')?.text).toBe('2026-10-23T12:05:00.000Z');
    expect(child(core, 'dcterms:modified')?.text).toBe('2026-10-23T12:05:00.000Z');
    // Every zip entry is dated 2026-10-23 12:05:00 UTC too (MS-DOS date and time fields).
    const dosDate = ((2026 - 1980) << 9) | (10 << 5) | 23;
    const dosTime = (12 << 11) | (5 << 5);
    for (const e of d.entries)
      expect([e.name, e.dosDate, e.dosTime]).toEqual([e.name, dosDate, dosTime]);
  });

  it('is the same bytes for the same ACR', async () => {
    const a = await renderVpatDocx(acr);
    const b = await renderVpatDocx(acr);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('is in US English, with Heading 1 to 3 styles', async () => {
    const d = await open(acr);
    const styles = d.part('word/styles.xml');
    const defaults = descendants(styles, 'w:docDefaults')[0];
    expect(defaults && descendants(defaults, 'w:lang')[0]?.attrs['w:val']).toBe('en-US');
    const ids = descendants(styles, 'w:style').map((s) => s.attrs['w:styleId']);
    expect(ids).toEqual(expect.arrayContaining(['Heading1', 'Heading2', 'Heading3']));
    for (const level of [1, 2, 3]) {
      const s = descendants(styles, 'w:style').find(
        (x) => x.attrs['w:styleId'] === `Heading${level}`,
      );
      expect(s && child(s, 'w:name')?.attrs['w:val']).toBe(`heading ${level}`);
      expect(s && descendants(s, 'w:outlineLvl')[0]?.attrs['w:val']).toBe(String(level - 1));
    }
  });

  it('has data tables only, each with a header row marked to repeat, and no images', async () => {
    const d = await open(acr);
    const tables = descendants(body(d), 'w:tbl');
    expect(tables).toHaveLength(1 + acr.tables.length);
    for (const t of tables) {
      expect(descendants(t, 'w:tbl')).toEqual([]);
      const rows = t.children.filter((c) => c.name === 'w:tr');
      const header = (r: XmlElement) => {
        const trPr = child(r, 'w:trPr');
        return trPr !== undefined && child(trPr, 'w:tblHeader') !== undefined;
      };
      expect(rows.map(header)).toEqual(rows.map((_, i) => i === 0));
    }
    const heads = tables.map((t) =>
      descendants(t.children.find((c) => c.name === 'w:tr') as XmlElement, 'w:tc').map(textOf),
    );
    expect(heads[0]).toEqual(['Standard/Guideline', 'Included In Report']);
    for (const h of heads.slice(1))
      expect(h).toEqual(['Criteria', 'Conformance Level', 'Remarks and Explanations']);
    expect(d.entries.some((e) => e.name.startsWith('word/media/'))).toBe(false);
    expect(d.xml).not.toMatch(/<w:drawing|<w:pict|<pic:|<v:imagedata/);
  });
});

describe('VPAT DOCX content', () => {
  it('titles a complete ACR as based on VPAT® 2.5Rev, and writes the name only as VPAT®', async () => {
    const d = await open(complete);
    const paragraphs = body(d).children.filter((c) => c.name === 'w:p');
    expect(style(paragraphs[0] as XmlElement)).toBe('Heading1');
    expect(textOf(paragraphs[0] as XmlElement)).toBe(
      'Example Agency Accessibility Conformance Report, Revised Section 508 Edition',
    );
    expect(textOf(paragraphs[1] as XmlElement)).toBe('(Based on VPAT® Version 2.5Rev)');
    const uses = d.xml.match(/VPAT/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    expect(d.xml.match(/VPAT®/g)?.length).toBe(uses.length);
  });

  it('follows the template order, the same headings as the HTML outline', async () => {
    const d = await open(complete);
    const o = vpatOutline(complete);
    expect(headings(d)).toEqual([
      `Heading1 ${o.title}`,
      ...o.blocks.flatMap((b) => (b.kind === 'heading' ? [`Heading${b.level} ${b.text}`] : [])),
    ]);
    expect(headings(d).slice(0, 6)).toEqual([
      `Heading1 ${o.title}`,
      'Heading2 Notes',
      'Heading2 Evaluation Methods Used',
      'Heading2 Applicable Standards/Guidelines',
      'Heading2 Terms',
      'Heading2 WCAG 2.0 Report',
    ]);
    expect(headings(d).at(-1)).toBe('Heading2 Legal Disclaimer');
    const text = textOf(body(d));
    for (const label of [
      'Name of Product/Version:',
      'Report Date:',
      'Product Description:',
      'Contact Information:',
    ])
      expect(text).toContain(label);
    expect(text).toContain('Report Date: October 2026');
    expect(text).toContain('Generated by Widedoor 0.0.0.');
    expect(text).toContain(DISCLAIMER);
    for (const m of complete.methods) expect(text).toContain(m);
  });

  it('lists the Web and Electronic Docs cells of a row as their own paragraphs', async () => {
    const d = await open(complete);
    const row = descendants(body(d), 'w:tr').find((r) =>
      textOf(r).startsWith('1.1.1 Non-text Content (Level A)'),
    );
    if (!row) throw new Error('no 1.1.1 row');
    const cells = descendants(row, 'w:tc').map((c) => descendants(c, 'w:p').map(lines));
    expect(cells[1]).toEqual(['Web: Supports', 'Electronic Docs: Supports']);
    expect(cells[2]).toEqual(
      complete.tables[0]?.rows[0]?.components.map(
        (c, i) => `${i === 0 ? 'Web' : 'Electronic Docs'}: ${c.remarks}`,
      ),
    );
  });

  it('puts the "Also applies to" lines in the row header cell, not in bold', async () => {
    const d = await open(complete);
    const row = descendants(body(d), 'w:tr').find((r) =>
      textOf(r).startsWith('4.1.1 Parsing (Level A)'),
    );
    if (!row) throw new Error('no 4.1.1 row');
    const header = descendants(row, 'w:tc')[0] as XmlElement;
    const paragraphs = descendants(header, 'w:p');
    expect(paragraphs.map(lines)).toEqual([
      '4.1.1 Parsing (Level A)',
      'Also applies to:',
      "WCAG 2.0 - Always answer 'Supports'",
      'Revised Section 508',
      '501 (Web)(Software)',
      '504.2 (Authoring Tool)',
      '602.3 (Support Docs)',
    ]);
    // The library writes <w:b w:val="false"/> for a run that is not bold.
    const bold = (p: XmlElement) =>
      descendants(p, 'w:b').some((b) => !['false', '0'].includes(b.attrs['w:val'] ?? ''));
    expect(paragraphs.map(bold)).toEqual(paragraphs.map((_, i) => i === 0));
  });

  it('writes the WCAG 2.0 Report introduction and the 501.1 row', async () => {
    const text = textOf(body(await open(complete)));
    expect(text).toContain(
      'Tables 1 and 2 also document conformance with Revised Section 508:Chapter 5 - 501.1 Scope, 504.2 Content Creation or EditingChapter 6 - 602.3 Electronic Support DocumentationNote: When reporting on conformance',
    );
    expect(text).toContain(
      '501.1 Scope - Incorporation of WCAG 2.0 AASee WCAG 2.x sectionSee information in WCAG 2.x section',
    );
  });

  it('opens a draft with the banner, titles it DRAFT and never names the template', async () => {
    const d = await open(draft);
    expect(d.xml).not.toContain('VPAT');
    const h = headings(d);
    expect(h.slice(0, 2)).toEqual([
      'Heading2 Draft',
      'Heading1 DRAFT Example Agency Accessibility Conformance Report',
    ]);
    const paragraphs = body(d).children.filter((c) => c.name === 'w:p');
    expect(textOf(paragraphs[1] as XmlElement)).toMatch(
      new RegExp(`^${draft.undecided} rows are not decided yet`),
    );
    // The reasons are a bulleted list.
    const reasons = paragraphs.slice(2, 2 + draft.incomplete.length);
    expect(reasons.map(textOf)).toEqual(draft.incomplete);
    for (const p of reasons) expect(descendants(p, 'w:numPr')).toHaveLength(1);
    expect(child(d.part('docProps/core.xml'), 'dc:title')?.text).toBe(
      'DRAFT Example Agency Accessibility Conformance Report',
    );
    const text = textOf(body(d));
    expect(text).toContain('Generated by Widedoor 0.0.0.');
    expect(text).toContain(DISCLAIMER);
    for (const m of draft.methods) expect(text).toContain(m);
    expect(headings(d).at(-1)).toBe('Heading2 Legal Disclaimer');
  });

  it('keeps hostile vendor, product and notes as text in every part', async () => {
    const acr = buildAcr(acrReport(), HOSTILE_META);
    const d = await open(acr);
    expect(d.xml).not.toContain(PAYLOAD);
    expect(d.xml).not.toMatch(/<script|<img|<\/style>/i);
    const core = d.part('docProps/core.xml');
    expect(child(core, 'dc:title')?.text).toBe(
      `DRAFT Evil\\x1b[31m ${PAYLOAD} Accessibility Conformance Report`,
    );
    expect(child(core, 'dc:creator')?.text).toBe(`Evil\\x1b[31m ${PAYLOAD}`);
    const paragraphs = descendants(body(d), 'w:p').map(lines);
    expect(paragraphs).toContain(`Name of Product/Version: Portal\\u202e ${PAYLOAD}`);
    expect(paragraphs).toContain(
      `Product Description: Line one\nkey: value ${PAYLOAD}${NONCHARACTERS_SAFE}`,
    );
    expect(paragraphs).toContain(`---\nchapters: {}\n${PAYLOAD}\\x07`);
    expect(paragraphs).toContain('Contact Information: x@example.com\\x0akey: injected');
    for (const e of d.entries.filter((x) => /\.(xml|rels)$/.test(x.name))) parseXml(utf8(e.data));
  });
});

describe('VPAT DOCX reviewer notes', () => {
  it('keeps hostile reviewer notes on 504.2 and 602.3 as text', async () => {
    const d = await open(buildAcr(hostileReferenceReport(), META));
    expect(d.xml).not.toContain(PAYLOAD);
    expect(d.xml).not.toMatch(/<b>|<a |<script|<img/i);
    for (const code of [0x202e, 0x07]) expect(d.xml).not.toContain(String.fromCharCode(code));
    const rows = descendants(body(d), 'w:tr');
    for (const header of [
      '504.2 Content Creation or Editing',
      '602.3 Electronic Support Documentation',
    ]) {
      const row = rows.find((r) => textOf(r).startsWith(header));
      if (!row) throw new Error(`no row ${header}`);
      const cells = descendants(row, 'w:tc').map((c) => descendants(c, 'w:p').map(lines));
      expect(cells[1], header).toEqual(['See WCAG 2.x section']);
      expect(cells[2]?.[0], header).toContain(`${HOSTILE_NOTES_SAFE}.`);
    }
    for (const e of d.entries.filter((x) => /\.(xml|rels)$/.test(x.name))) parseXml(utf8(e.data));
  });

  it('carries the support documentation note', async () => {
    const paragraphs = descendants(body(await open(complete)), 'w:p').map(lines);
    expect(paragraphs).toContain(SUPPORT_DOCS_NOTE);
  });
});

describe('VPAT DOCX characters and dates', () => {
  const FFFE = String.fromCharCode(0xfffe);
  const LONE = String.fromCharCode(0xd800);

  it('has a test XML reader that refuses characters XML 1.0 does not allow', () => {
    const doc = (s: string) => `<?xml version="1.0" encoding="UTF-8"?><a b="1">${s}</a>`;
    expect(parseXml(doc('ok')).text).toBe('ok');
    for (const ch of [FFFE, String.fromCharCode(0xffff), LONE, String.fromCharCode(1)])
      expect(() => parseXml(doc(ch))).toThrow(/is not allowed in XML 1\.0/);
    expect(() => parseXml(`<?xml version="1.0" encoding="UTF-8"?><a${FFFE}/>`)).toThrow(
      /is not allowed in XML 1\.0/,
    );
  });

  it('shows a character XML 1.0 does not allow as a marker, even one that skipped safe text', async () => {
    // An ACR built by hand, so the strings never went through buildAcr.
    const acr: Acr = structuredClone(complete);
    acr.meta = { ...acr.meta, vendor: { name: `Vendor${FFFE}`, contact: `a${LONE}b` } };
    const first = acr.tables[0]?.rows[0]?.components[0];
    if (!first) throw new Error('no cell');
    first.remarks = `Remark${String.fromCharCode(0xffff)}`;
    const d = await open(acr);
    for (const e of d.entries.filter((x) => /\.(xml|rels)$/.test(x.name))) parseXml(utf8(e.data));
    expect(child(d.part('docProps/core.xml'), 'dc:creator')?.text).toBe('Vendor[U+FFFE]');
    const paragraphs = descendants(body(d), 'w:p').map(lines);
    expect(paragraphs).toContain('Contact Information: a[U+D800]b');
    expect(paragraphs).toContain('Web: Remark[U+FFFF]');
  });

  it('refuses a scan time a zip or core properties date cannot hold', async () => {
    for (const generated of ['1979-12-31T23:59:59.000Z', '2108-01-01T00:00:00.000Z', 'not a time'])
      await expect(renderVpatDocx({ ...complete, generated })).rejects.toThrow(
        /a DOCX needs a scan time from 1980 to 2107; acr\.generated is /,
      );
    for (const generated of ['1980-01-01T00:00:00.000Z', '2107-12-31T23:59:58.000Z'])
      expect((await renderVpatDocx({ ...complete, generated })).length).toBeGreaterThan(0);
  });
});
