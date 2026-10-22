import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { PDFDict, PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { corpusPath } from './lib/corpus.ts';

/*
 * Builds the four corpus PDFs from HTML defined below. Chromium renders them
 * (page.pdf, tagged where the case needs it) and pdf-lib sets metadata and
 * replaces every time-dependent value (dates, document ID), so a rebuild with
 * the same Chromium build and fonts gives the same bytes. See corpus/README.md.
 */

const FIXED_DATE = new Date('2026-01-01T00:00:00Z');
const PRODUCER = 'Widedoor corpus build (Chromium page.pdf, pdf-lib)';
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

interface Variant {
  lang: boolean;
  title: boolean;
  alt: boolean;
  tableHeaders: boolean;
}

const CLEAN: Variant = { lang: true, title: true, alt: true, tableHeaders: true };
const TITLE = 'Quarterly service report';

function html(v: Variant): string {
  const cell = (tag: string, text: string) => `<${tag}>${text}</${tag}>`;
  const head = v.tableHeaders ? 'th' : 'td';
  return `<!doctype html>
<html${v.lang ? ' lang="en"' : ''}>
<head>
<meta charset="utf-8">
${v.title ? `<title>${TITLE}</title>` : ''}
<style>
  body { font-family: Arial, sans-serif; font-size: 12pt; color: #000; background: #fff; margin: 0; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #000; padding: 4pt 8pt; text-align: left; }
  td.head { font-weight: bold; }
</style>
</head>
<body>
<h1>${TITLE}</h1>
<p>The help desk closed 412 requests this quarter, up from 380 last quarter.</p>
<h2>Requests by channel</h2>
<img src="data:image/png;base64,${PNG}" width="120" height="60"${v.alt ? ' alt="Bar chart: email 250, phone 120, walk-in 42"' : ''}>
<table>
<tr>${cell(head, 'Channel')}${cell(head, 'Requests')}</tr>
<tr>${cell('td', 'Email')}${cell('td', '250')}</tr>
<tr>${cell('td', 'Phone')}${cell('td', '120')}</tr>
<tr>${cell('td', 'Walk-in')}${cell('td', '42')}</tr>
</table>
<h2>Next steps</h2>
<p>Staff the phone line for longer on Mondays.</p>
</body>
</html>`;
}

const PAGE = {
  width: '8.5in',
  height: '11in',
  margin: { top: '1in', bottom: '1in', left: '1in', right: '1in' },
};

async function render(browser: Browser, v: Variant, tagged: boolean): Promise<Uint8Array> {
  const page = await browser.newPage();
  try {
    await page.route('**/*', (r) =>
      r.request().url().startsWith('data:') ? r.continue() : r.abort(),
    );
    await page.setContent(html(v), { waitUntil: 'load' });
    return await page.pdf({ ...PAGE, tagged, outline: tagged, printBackground: false });
  } finally {
    await page.close();
  }
}

/** A page image of the clean document: what a scanner produces, with no text layer. */
async function scan(browser: Browser): Promise<Uint8Array> {
  const page = await browser.newPage({
    viewport: { width: 816, height: 1056 },
    deviceScaleFactor: 1,
  });
  try {
    await page.setContent(html(CLEAN).replace('margin: 0;', 'margin: 96px;'), {
      waitUntil: 'load',
    });
    const png = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled' });
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const image = await pdf.embedPng(png);
    pdf.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
    return finish(pdf, 'scanned-image-only');
  } finally {
    await page.close();
  }
}

// XMP packets start with a byte order mark.
const BOM = String.fromCharCode(0xfeff);

function xmp(title: string): string {
  const date = FIXED_DATE.toISOString().replace('.000Z', 'Z');
  return `<?xpacket begin="${BOM}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about=""
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:xmp="http://ns.adobe.com/xap/1.0/"
 xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
 xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">
<dc:format>application/pdf</dc:format>
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>
<xmp:CreateDate>${date}</xmp:CreateDate>
<xmp:ModifyDate>${date}</xmp:ModifyDate>
<xmp:MetadataDate>${date}</xmp:MetadataDate>
<pdf:Producer>${PRODUCER}</pdf:Producer>
<pdfuaid:part>1</pdfuaid:part>
</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** Fixed dates, producer and document ID; nothing in the output depends on the clock. */
async function finish(pdf: PDFDocument, name: string): Promise<Uint8Array> {
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
  pdf.setProducer(PRODUCER);
  pdf.setCreator('Widedoor corpus/scripts/build-pdfs.ts');
  const id = PDFHexString.of(createHash('sha256').update(name).digest('hex').slice(0, 32));
  pdf.context.trailerInfo.ID = pdf.context.obj([id, id]);
  return pdf.save({ useObjectStreams: false });
}

/**
 * as-rendered: keep what Chromium wrote (only dates and ID change).
 * broken:      also drop the title, the language and DisplayDocTitle Chromium adds by default.
 * pdfua:       add the title, language, DisplayDocTitle and XMP metadata PDF/UA-1 requires.
 */
type Mode = 'as-rendered' | 'broken' | 'pdfua';

async function postProcess(bytes: Uint8Array, name: string, mode: Mode): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const info = pdf.context.lookup(pdf.context.trailerInfo.Info, PDFDict);
  for (const k of ['CreationDate', 'ModDate']) info.delete(PDFName.of(k));
  if (mode === 'broken') {
    info.delete(PDFName.of('Title'));
    for (const k of ['Lang', 'ViewerPreferences']) pdf.catalog.delete(PDFName.of(k));
  }
  if (mode === 'pdfua') {
    pdf.setTitle(TITLE, { showInWindowTitleBar: true });
    pdf.setLanguage('en');
    const stream = pdf.context.stream(xmp(TITLE), { Type: 'Metadata', Subtype: 'XML' });
    pdf.catalog.set(PDFName.of('Metadata'), pdf.context.register(stream));
  }
  return finish(pdf, name);
}

const out = (name: string) => corpusPath(`pdf/${name}.pdf`);
mkdirSync(corpusPath('pdf'), { recursive: true });
const browser = await chromium.launch();
try {
  const builds: [string, () => Promise<Uint8Array>][] = [
    [
      'untagged',
      async () => postProcess(await render(browser, CLEAN, false), 'untagged', 'as-rendered'),
    ],
    [
      'tagged-broken',
      async () =>
        postProcess(
          await render(
            browser,
            { lang: false, title: false, alt: false, tableHeaders: false },
            true,
          ),
          'tagged-broken',
          'broken',
        ),
    ],
    [
      'clean-pdfua',
      async () => postProcess(await render(browser, CLEAN, true), 'clean-pdfua', 'pdfua'),
    ],
    ['scanned-image-only', () => scan(browser)],
  ];
  for (const [name, build] of builds) {
    const bytes = await build();
    writeFileSync(out(name), bytes);
    console.log(
      `pdf/${name}.pdf ${bytes.length} bytes ${createHash('sha256').update(bytes).digest('hex')}`,
    );
  }
} finally {
  await browser.close();
}
