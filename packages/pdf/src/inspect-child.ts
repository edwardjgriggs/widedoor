import { writeSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { StructTreeNode } from 'pdfjs-dist/types/src/display/api.js';

/*
 * Reads one untrusted PDF with pdf.js in its own Node process: the PDF comes
 * in on stdin, one JSON reply goes out on stdout. The parent sets the V8 heap
 * cap (--max-old-space-size) and the deadline; a watchdog thread here kills the
 * process when its resident memory passes the cap, which also covers the
 * ArrayBuffers of decoded streams that the heap cap does not count.
 *
 * pdf.js runs with no font loading, no fetches, no XFA and no image decoding
 * (maxImageSize 0: every image is refused unread, and the refusal is how an
 * image draw is seen); pdf.js 6 has no eval path left (isEvalSupported is gone).
 * Its optional native canvas package is blocked from loading: nothing here
 * renders. This file must stay loadable by Node's type stripping (tests run it
 * from source): type-only imports, no enums.
 */

/** What the Widedoor PDF checks need from a document. */
export interface PdfInspection {
  pages: number;
  /** Info dictionary Title, or XMP dc:title, trimmed and capped; null when neither is set. */
  title: string | null;
  displayDocTitle: boolean;
  /** Catalog /Lang as written (capped), or null. */
  lang: string | null;
  /** Top-level outline (bookmark) entries. */
  outlineItems: number;
  /** MarkInfo Marked is true, or the structure tree has elements. */
  tagged: boolean;
  /** Structure types used, after role mapping (Root excluded). */
  structureTypes: string[];
  /** The structure walk hit its node budget, so structureTypes may be incomplete. */
  structureTruncated: boolean;
  /** 1-based pages that draw an image and have no text layer. */
  imageOnlyPages: number[];
}

export type InspectErrorCode = 'malformed-pdf' | 'encrypted-pdf' | 'too-many-pages' | 'scan-failed';

export type InspectReply =
  { ok: true; inspection: PdfInspection } | { ok: false; code: InspectErrorCode; message: string };

/** Marker the watchdog writes to stderr before it kills the process. */
export const RESOURCE_LIMIT_MARKER = 'widedoor-reader: resource limit';

/** Structure nodes visited per document at most; deeper trees are read in part. */
const MAX_STRUCT_NODES = 200_000;
/** Longest title or /Lang kept from the PDF. */
const MAX_TEXT = 1024;
/**
 * pdf.js's own warning, exactly, when it refuses an image over maxImageSize
 * (here: every image, before decoding). Each one is an image draw. Warnings
 * that quote PDF data have other prefixes, so a PDF cannot forge this line.
 */
const IMAGE_REFUSED = 'Warning: Image exceeded maximum allowed size and was removed.';
let imageRefusals = 0;

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0] ?? '';

const str = (v: unknown) =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, MAX_TEXT) : null;

function prefValue(prefs: unknown, key: string): unknown {
  if (prefs instanceof Map) return prefs.get(key);
  if (prefs && typeof prefs === 'object') return (prefs as Record<string, unknown>)[key];
  return undefined;
}

function collectRoles(node: StructTreeNode | null, roles: Set<string>, budget: { n: number }) {
  const stack: unknown[] = node ? [node] : [];
  while (stack.length > 0) {
    if (budget.n-- <= 0) return;
    const n = stack.pop() as Partial<StructTreeNode>;
    if (typeof n.role === 'string' && n.role !== 'Root') roles.add(n.role.slice(0, 64));
    if (Array.isArray(n.children)) for (const c of n.children) stack.push(c);
  }
}

const OPTIONS = {
  disableFontFace: true,
  useSystemFonts: false,
  useWorkerFetch: false,
  enableXfa: false,
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  disableAutoFetch: true,
  disableStream: true,
  disableRange: true,
  // Every image is refused before it is decoded; image presence is read from that refusal.
  maxImageSize: 0,
  stopAtErrors: false,
  // Warnings, so the refusals reach the console hook in main().
  verbosity: 1,
};

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

async function inspect(pdfjs: Pdfjs, bytes: Uint8Array, maxPages: number): Promise<InspectReply> {
  const task = pdfjs.getDocument({ ...OPTIONS, data: new Uint8Array(bytes) });
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'PasswordException')
        return { ok: false, code: 'encrypted-pdf', message: 'the PDF needs a password to open' };
      if (name === 'InvalidPDFException' || name === 'FormatError')
        return { ok: false, code: 'malformed-pdf', message: 'pdf.js could not parse the PDF' };
      throw e;
    }
    if (doc.numPages > maxPages)
      return {
        ok: false,
        code: 'too-many-pages',
        message: `the PDF has ${doc.numPages} pages, over maxPages (${maxPages})`,
      };
    const { info, metadata } = (await doc.getMetadata()) as {
      info: Record<string, unknown>;
      metadata: { get(name: string): unknown } | null;
    };
    const prefs = await doc.getViewerPreferences();
    const outline = await doc.getOutline();
    const markInfo = (await doc.getMarkInfo()) as { Marked?: boolean } | null;

    const roles = new Set<string>();
    const budget = { n: MAX_STRUCT_NODES };
    const imageOnlyPages: number[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      if (budget.n > 0) collectRoles(await page.getStructTree(), roles, budget);
      const text = await page.getTextContent();
      const hasText = text.items.some((item) => 'str' in item && item.str.trim() !== '');
      if (!hasText) {
        // Pages are read one at a time, so every refusal counted here is this page's.
        const before = imageRefusals;
        await page.getOperatorList();
        if (imageRefusals > before) imageOnlyPages.push(i);
      }
      page.cleanup();
    }
    return {
      ok: true,
      inspection: {
        pages: doc.numPages,
        title: str(info?.Title) ?? str(metadata?.get('dc:title')),
        displayDocTitle: prefValue(prefs, 'DisplayDocTitle') === true,
        lang: typeof info?.Language === 'string' ? info.Language.slice(0, MAX_TEXT) : null,
        outlineItems: outline?.length ?? 0,
        tagged: markInfo?.Marked === true || roles.size > 0,
        structureTypes: [...roles].sort(),
        structureTruncated: budget.n <= 0,
        imageOnlyPages,
      },
    };
  } catch (e) {
    return { ok: false, code: 'scan-failed', message: firstLine(e).slice(0, 200) };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

const WATCHDOG = `
const { workerData } = require('node:worker_threads');
const { writeSync } = require('node:fs');
const die = (marker) => {
  if (marker) try { writeSync(2, marker + String.fromCharCode(10)); } catch {}
  process.kill(process.pid, 'SIGKILL');
};
const parentAlive = () => {
  try { process.kill(workerData.parentPid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const started = Date.now();
let ticks = 0;
setInterval(() => {
  if (process.memoryUsage.rss() > workerData.maxRssBytes) die(workerData.marker);
  // Its own deadline and a parent check, so a reader whose scanner died does not run on.
  if (Date.now() - started > workerData.deadlineMs) die();
  if (++ticks % 20 === 0 && !parentAlive()) die();
}, 25);
`;

async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function main() {
  const [maxPages, maxRssMb, deadlineMs] = process.argv.slice(2).map(Number);
  // A thread, so it keeps sampling while pdf.js holds the main thread in a long synchronous decode.
  new Worker(WATCHDOG, {
    eval: true,
    workerData: {
      maxRssBytes: (maxRssMb ?? 2048) * 1024 * 1024,
      marker: RESOURCE_LIMIT_MARKER,
      // The parent kills at its deadline; this one is the backstop if the parent is gone.
      deadlineMs: (deadlineMs ?? 60_000) + 5_000,
      parentPid: process.ppid,
    },
  }).unref();
  // pdf.js logs through console; stdout carries only the reply.
  for (const level of ['log', 'info', 'error', 'debug'] as const) console[level] = () => {};
  console.warn = (...args: unknown[]) => {
    if (args.length === 1 && args[0] === IMAGE_REFUSED) imageRefusals++;
  };
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@napi-rs/canvas' || specifier.startsWith('@napi-rs/canvas-'))
        throw new Error('the native canvas package is not loaded by the Widedoor PDF reader');
      return next(specifier, context);
    },
  });
  const pdfjs: Pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const reply = await inspect(pdfjs, await readStdin(), maxPages ?? 2000);
  process.stdout.write(`${JSON.stringify(reply)}\n`, () => process.exit(0));
}

// Only as a process entry point: the parent imports this module for its types and marker.
if (import.meta.main)
  main().catch((e: unknown) => {
    writeSync(2, `widedoor-reader: ${firstLine(e)}\n`);
    process.exit(70);
  });
