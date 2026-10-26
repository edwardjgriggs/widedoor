import {
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import JSZip from 'jszip';
import type { Acr } from './acr.js';
import { visibleText } from './escape.js';
import { vpatOutline, type VpatBlock } from './vpat.js';

/*
 * The ACR as a Word document (DOCX) in the VPAT® 2.5Rev Revised Section 508
 * layout, built with the docx library from the same outline as the HTML file
 * (vpat.ts). The library writes and escapes all the XML. For an accessible
 * document: language en-US, title and author core properties, Heading 1 to 3
 * styles, real bulleted lists, and data tables only, each with a header row
 * marked to repeat on every page; no images and no layout tables. Every
 * string passes through visibleText (escape.ts) on its way to the library, as
 * the HTML file's do, so a character XML 1.0 does not allow (U+FFFE, a lone
 * surrogate) cannot reach the package even if safe text let one through.
 *
 * The library stamps the created and modified core properties and every zip
 * entry with the clock. Both come from acr.generated instead (the scan's
 * finish time), so the same ACR gives the same bytes: the package is reopened
 * with JSZip (the library's own zip dependency), the two timestamps are set,
 * and every entry is dated acr.generated.
 */

const BULLET = 'bullet';
// US Letter with one-inch margins, in twentieths of a point.
const PAGE = { width: 12_240, height: 15_840, margin: 1_440 };
const TEXT_WIDTH = PAGE.width - 2 * PAGE.margin;
const HEADINGS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
};

/** Runs for text with its line breaks kept. */
const runs = (value: string, bold = false) =>
  value
    .split('\n')
    .map(
      (line, i) => new TextRun({ text: visibleText(line), bold, ...(i > 0 ? { break: 1 } : {}) }),
    );

/**
 * Word's built-in heading style (name "heading N"), with its outline level
 * set, so the navigation pane and a PDF export see the heading. size is in
 * half-points.
 */
const headingStyle = (level: 1 | 2 | 3, size: number) => ({
  name: `heading ${level}`,
  run: { bold: true, size, color: '1F3864' },
  paragraph: { outlineLevel: level - 1, keepNext: true, spacing: { before: 240, after: 120 } },
});

const heading = (level: 1 | 2 | 3, text: string) =>
  new Paragraph({ heading: HEADINGS[level], children: runs(text) });

const bullets = (items: readonly string[]) =>
  items.map(
    (i) => new Paragraph({ numbering: { reference: BULLET, level: 0 }, children: runs(i) }),
  );

const cell = (lines: readonly string[], bold = false) =>
  new TableCell({ children: lines.map((l) => new Paragraph({ children: runs(l, bold) })) });

/** A row header cell: the header in bold, then any lines under it in normal weight. */
const headerCell = (header: string, also: readonly string[] = []) =>
  new TableCell({
    children: [
      new Paragraph({ children: runs(header, true) }),
      ...also.map((l) => new Paragraph({ children: runs(l) })),
    ],
  });

function table(b: Extract<VpatBlock, { kind: 'table' }>): Table {
  // Criteria tables give the remarks half the width; the standards table splits it evenly.
  const widths =
    b.head.length === 3
      ? [TEXT_WIDTH / 4, TEXT_WIDTH / 4, TEXT_WIDTH / 2]
      : b.head.map(() => TEXT_WIDTH / b.head.length);
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, children: b.head.map((h) => cell([h], true)) }),
      ...b.rows.map(
        (r) =>
          new TableRow({
            children: [headerCell(r.header, r.also), ...r.cells.map((c) => cell(c))],
          }),
      ),
    ],
  });
}

function block(b: VpatBlock): (Paragraph | Table)[] {
  switch (b.kind) {
    case 'heading':
      return [heading(b.level, b.text)];
    case 'field':
      return [
        new Paragraph({
          children: [
            new TextRun({ text: visibleText(`${b.label}:`), bold: true }),
            new TextRun(' '),
            ...runs(b.text),
          ],
        }),
      ];
    case 'paragraph':
      return [new Paragraph({ children: runs(b.text) })];
    case 'list':
      return bullets(b.items);
    case 'table':
      // An empty paragraph after each table keeps two tables in a row from merging in Word.
      return [table(b), new Paragraph({})];
  }
}

/** Renders the ACR as a VPAT® 2.5Rev 508 DOCX (a DRAFT that never names the template unless acr.complete). */
export async function renderVpatDocx(acr: Acr): Promise<Uint8Array> {
  const o = vpatOutline(acr);
  const generated = new Date(acr.generated);
  // Zip entries carry MS-DOS dates, which hold the years 1980 to 2107 only (W3CDTF allows 0000 to 9999).
  const year = generated.getUTCFullYear();
  if (Number.isNaN(year) || year < 1980 || year > 2107)
    throw new Error(
      `a DOCX needs a scan time from 1980 to 2107; acr.generated is "${visibleText(acr.generated)}"`,
    );
  const children = [
    ...(o.draft
      ? [
          heading(2, o.draft.heading),
          new Paragraph({ children: runs(o.draft.lead) }),
          ...bullets(o.draft.reasons),
        ]
      : []),
    heading(1, o.title),
    ...(o.version !== undefined ? [new Paragraph({ children: runs(o.version) })] : []),
    ...o.blocks.flatMap(block),
  ];
  const doc = new Document({
    title: visibleText(o.title),
    creator: visibleText(o.author),
    lastModifiedBy: visibleText(`Widedoor ${acr.tool.version}`),
    styles: {
      default: {
        document: { run: { language: { value: 'en-US' }, font: 'Calibri', size: 22 } },
        heading1: headingStyle(1, 32),
        heading2: headingStyle(2, 28),
        heading3: headingStyle(3, 24),
      },
    },
    numbering: {
      config: [
        {
          reference: BULLET,
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: '•',
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE.width, height: PAGE.height },
            margin: {
              top: PAGE.margin,
              right: PAGE.margin,
              bottom: PAGE.margin,
              left: PAGE.margin,
            },
          },
        },
        children,
      },
    ],
  });

  const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
  const core = zip.file('docProps/core.xml');
  if (!core) throw new Error('the docx library wrote no docProps/core.xml');
  let stamped = 0;
  // Only the timestamp text changes: an ISO 8601 time, which needs no escaping.
  const xml = (await core.async('string')).replace(
    /(<dcterms:(created|modified) xsi:type="dcterms:W3CDTF">)[^<]*(<\/dcterms:\2>)/g,
    (_whole, open: string, _name: string, close: string) => {
      stamped++;
      return `${open}${generated.toISOString()}${close}`;
    },
  );
  if (stamped !== 2)
    throw new Error('the docx library wrote core properties Widedoor does not expect');
  zip.file('docProps/core.xml', xml);
  zip.forEach((_path, entry) => {
    entry.date = generated;
  });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
