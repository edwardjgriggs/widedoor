import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFHexString, PDFName, StandardFonts, type PDFRef } from 'pdf-lib';
import type { ProcessResult, SpawnFn, VerapdfRunner } from '../src/index.ts';

/** A 1x1 grey PNG. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export interface MakePdfOptions {
  pages?: number;
  /** 1-based pages drawn as an image with no text. */
  imagePages?: number[];
  /** 1-based pages left blank. */
  blankPages?: number[];
  title?: string;
  displayDocTitle?: boolean;
  lang?: string;
  bookmarks?: boolean;
}

/** Builds a PDF in memory: text pages by default, with the requested defects. */
export async function makePdf(o: MakePdfOptions = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const png = await pdf.embedPng(Buffer.from(PNG, 'base64'));
  for (let i = 1; i <= (o.pages ?? 1); i++) {
    const page = pdf.addPage([612, 792]);
    if (o.blankPages?.includes(i)) continue;
    if (o.imagePages?.includes(i)) page.drawImage(png, { x: 50, y: 50, width: 500, height: 600 });
    else page.drawText(`Page ${i} of the generated report.`, { x: 72, y: 700, size: 12, font });
  }
  if (o.title !== undefined)
    pdf.setTitle(o.title, { showInWindowTitleBar: o.displayDocTitle ?? true });
  if (o.lang !== undefined) pdf.setLanguage(o.lang);
  if (o.bookmarks) {
    const ctx = pdf.context;
    const outlines = ctx.nextRef();
    const item = ctx.register(
      ctx.obj({
        Title: PDFHexString.fromText('Start'),
        Parent: outlines,
        Dest: [pdf.getPage(0).ref, PDFName.of('Fit')],
      }),
    );
    ctx.assign(outlines, ctx.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 }));
    pdf.catalog.set(PDFName.of('Outlines'), outlines);
  }
  return pdf.save({ useObjectStreams: false });
}

export interface RawPage {
  /** The page content stream, as PDF operators (or bytes already encoded with `filter`). */
  content: string | Uint8Array;
  filter?: 'FlateDecode';
  /** An image XObject /Im1 of this size (8-bit grey). */
  image?: { width: number; height: number };
  /** A form XObject /Fm1 that shows a line of text. */
  formText?: boolean;
  /** A tiling pattern /P1 whose cell draws /Im1 (needs `image`). */
  pattern?: boolean;
}

/** Builds a PDF from raw content streams, for the image-only and resource-limit cases. */
export async function makeRawPdf(pages: RawPage[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const ctx = pdf.context;
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
  for (const p of pages) {
    const page = pdf.addPage([612, 792]);
    const xobjects: Record<string, PDFRef> = {};
    if (p.image) {
      const { width, height } = p.image;
      xobjects.Im1 = ctx.register(
        ctx.stream(new Uint8Array(width * height).fill(128), {
          Type: 'XObject',
          Subtype: 'Image',
          Width: width,
          Height: height,
          ColorSpace: 'DeviceGray',
          BitsPerComponent: 8,
        }),
      );
    }
    if (p.formText)
      xobjects.Fm1 = ctx.register(
        ctx.stream('BT /F1 12 Tf 72 700 Td (Text inside a form XObject) Tj ET', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 612, 792],
          Resources: { Font: { F1: font } },
        }),
      );
    const patterns: Record<string, PDFRef> = {};
    if (p.pattern)
      patterns.P1 = ctx.register(
        ctx.stream('q 100 0 0 100 0 0 cm /Im1 Do Q', {
          Type: 'Pattern',
          PatternType: 1,
          PaintType: 1,
          TilingType: 1,
          BBox: [0, 0, 100, 100],
          XStep: 100,
          YStep: 100,
          Resources: { XObject: { ...xobjects } },
        }),
      );
    page.node.set(
      PDFName.of('Resources'),
      ctx.obj({ Font: { F1: font }, XObject: xobjects, Pattern: patterns }),
    );
    const body = typeof p.content === 'string' ? Buffer.from(p.content, 'latin1') : p.content;
    page.node.set(
      PDFName.of('Contents'),
      ctx.register(ctx.stream(body, p.filter ? { Filter: p.filter } : {})),
    );
  }
  return pdf.save({ useObjectStreams: false });
}

/** A one-page PDF whose content stream inflates to `bytes` zeros (a decompression bomb). */
export const makeFlateBomb = (bytes: number) =>
  makeRawPdf([{ content: deflateSync(Buffer.alloc(bytes)), filter: 'FlateDecode' }]);

/** A 10 x 10 grey inline image (BI ... ID data EI), as content stream bytes. */
export const INLINE_IMAGE = Buffer.concat([
  Buffer.from('q 100 0 0 100 50 50 cm BI /W 10 /H 10 /CS /G /BPC 8 ID ', 'latin1'),
  Buffer.alloc(100, 0x80),
  Buffer.from(' EI Q', 'latin1'),
]);

/** Fills the page with the tiling pattern /P1. */
export const FILL_PATTERN = '/Pattern cs /P1 scn 0 0 612 792 re f';

/** Draws /Im1 over the whole page. */
export const DRAW_IMAGE = 'q 612 0 0 792 0 0 cm /Im1 Do Q';

export interface Summary {
  clause: string;
  testNumber: number;
  status: 'passed' | 'failed';
  passedChecks?: number;
  failedChecks?: number;
  checks?: { status: string; context: string; errorMessage?: string }[];
}

/** A veraPDF 1.30 JSON report with the given rule summaries. */
export function verapdfReport(summaries: Summary[], version = '1.30.3'): string {
  return JSON.stringify({
    report: {
      buildInformation: {
        releaseDetails: [
          { id: 'core', version },
          { id: 'apps', version },
        ],
      },
      jobs: [
        {
          itemDetails: { name: 'STDIN', size: -1 },
          validationResult: [
            {
              jobEndStatus: 'normal',
              compliant: !summaries.some((s) => s.status === 'failed'),
              details: {
                ruleSummaries: summaries.map((s) => ({
                  specification: 'ISO 14289-1:2014',
                  passedChecks: s.status === 'passed' ? 1 : 0,
                  failedChecks: s.status === 'failed' ? (s.checks?.length ?? 1) : 0,
                  ...s,
                })),
              },
            },
          ],
        },
      ],
      batchSummary: { failedParsingJobs: 0, failedEncryptedJobs: 0 },
    },
  });
}

export const result = (stdout: string, exitCode: number | null = 1): ProcessResult => ({
  exitCode,
  stdout,
  stderr: '',
  timedOut: false,
  truncated: false,
});

/** A runner that answers every PDF with the same output. */
export function fakeRunner(
  output: ProcessResult | (() => Promise<ProcessResult>),
): VerapdfRunner & {
  calls: Uint8Array[];
} {
  const calls: Uint8Array[] = [];
  return {
    kind: 'custom',
    description: 'fake',
    warnings: [],
    calls,
    async run(pdf) {
      calls.push(pdf);
      return typeof output === 'function' ? output() : output;
    },
  };
}

export interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  stdin: Buffer[];
  child: FakeChild;
}

export type FakeChild = ChildProcess & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  /** Ends the process with the given output and exit code. */
  exit(code: number | null, stdout?: string, stderr?: string): void;
  killedWith?: NodeJS.Signals | number;
};

/**
 * A spawn stand-in. `behave` decides what each call does; by default the
 * process exits 0 with no output. Killing a fake process ends it.
 */
export function fakeSpawn(behave: (call: SpawnCall) => void = (c) => c.child.exit(0)): {
  spawn: SpawnFn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const child = new EventEmitter() as FakeChild;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    let ended = false;
    Object.assign(child, { stdout, stderr, stdin, pid: 4242 });
    child.exit = (code, out = '', err = '') => {
      if (ended) return;
      ended = true;
      setImmediate(() => {
        stdout.end(out);
        stderr.end(err);
        setImmediate(() => child.emit('close', code));
      });
    };
    child.kill = ((signal?: NodeJS.Signals | number) => {
      child.killedWith = signal ?? 'SIGTERM';
      child.exit(null);
      return true;
    }) as ChildProcess['kill'];
    const call: SpawnCall = { command, args, options, stdin: [], child };
    stdin.on('data', (b: Buffer) => call.stdin.push(b));
    calls.push(call);
    setImmediate(() => behave(call));
    return child;
  };
  return { spawn, calls };
}
