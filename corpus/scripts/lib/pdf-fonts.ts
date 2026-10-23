import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';

/** Every font a PDF uses, by BaseFont name, from its font dictionaries. */
export async function pdfFonts(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const names = new Set<string>();
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (object.get(PDFName.of('Type'))?.toString() !== '/Font') continue;
    const base = object.get(PDFName.of('BaseFont'));
    names.add(base ? base.toString().replace(/^\//, '') : '(no BaseFont)');
  }
  return [...names].sort();
}

/** The only fonts corpus PDFs may embed: subsets of the vendored Liberation Sans. */
export const ALLOWED_FONT = /^[A-Z]{6}\+LiberationSans(?:-Bold)?$/;
