import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FindingSchema } from '@widedoor/core';
import {
  PdfScanner,
  inspectPdf,
  pdfUri,
  resolvePdfScope,
  scanPdfs,
  type InspectLimits,
  type PdfFileScan,
} from '../src/index.ts';
import {
  DRAW_IMAGE,
  FILL_PATTERN,
  INLINE_IMAGE,
  fakeRunner,
  makeFlateBomb,
  makePdf,
  makeRawPdf,
  result,
  verapdfReport,
} from './fixtures.ts';

const corpus = fileURLToPath(new URL('../../../corpus/', import.meta.url));
const limits: InspectLimits = {
  maxPages: 2000,
  timeoutMs: 30_000,
  maxHeapMb: 512,
  maxRssMb: 2048,
};
const report = verapdfReport([
  { clause: '6.2', testNumber: 1, status: 'passed' },
  {
    clause: '7.1',
    testNumber: 8,
    status: 'failed',
    checks: [{ status: 'failed', context: 'root/document[0]' }],
  },
]);
const okRunner = () => fakeRunner(result(report));

interface ExpectedFile {
  expected: { engine: string; ruleId: string; outcome: string }[];
  error?: { code: string };
}
const expectedFor = (item: string): ExpectedFile =>
  JSON.parse(readFileSync(join(corpus, `expected/${item.replace(/\.pdf$/, '')}.json`), 'utf8'));
const triples = (scan: PdfFileScan, engine: string) =>
  [
    ...new Set(
      scan.findings
        .filter((f) => f.source.engine === engine)
        .map((f) => `${f.source.ruleId} ${f.outcome}`),
    ),
  ].sort();

describe('Widedoor checks on the corpus PDFs (offline)', () => {
  const items = ['clean-pdfua', 'malformed', 'scanned-image-only', 'tagged-broken', 'untagged'].map(
    (n) => `pdf/${n}.pdf`,
  );
  let scanner: PdfScanner;
  beforeAll(async () => {
    scanner = await PdfScanner.create({ verapdf: okRunner(), baseDir: corpus });
  });

  // veraPDF entries need the engine (test:docker, corpus:verify); the Widedoor ones do not.
  it.each(items)('%s gives exactly the expected Widedoor entries', async (item) => {
    const expected = expectedFor(item);
    const scan = await scanner.scanFile(item);
    if (expected.error) {
      expect(scan.error?.code).toBe(expected.error.code);
      expect(scan.error?.engine).toBe('widedoor');
      expect(scan.findings).toEqual([]);
      return;
    }
    expect(scan.error).toBeUndefined();
    const want = expected.expected
      .filter((e) => e.engine === 'widedoor')
      .map((e) => `${e.ruleId} ${e.outcome}`)
      .sort();
    expect(triples(scan, 'widedoor')).toEqual(want);
  });
});

describe('PdfScanner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'widedoor-pdf-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = async (name: string, bytes: Uint8Array | Promise<Uint8Array>) => {
    writeFileSync(join(dir, name), await bytes);
    return name;
  };

  it('anchors every finding to the sha256 of the file bytes and a baseDir-relative uri', async () => {
    const name = await write('doc.pdf', makePdf({ title: 'Doc', lang: 'en' }));
    const runner = okRunner();
    const scanner = await PdfScanner.create({ verapdf: runner, baseDir: dir });
    const scan = await scanner.scanFile(name);
    const hash = `sha256:${createHash('sha256')
      .update(readFileSync(join(dir, name)))
      .digest('hex')}`;
    expect(scan.asset).toEqual({ kind: 'pdf', uri: 'doc.pdf', contentHash: hash });
    expect(scan.findings.length).toBeGreaterThan(0);
    for (const f of scan.findings) {
      expect(FindingSchema.safeParse(f).success).toBe(true);
      expect(f.asset.contentHash).toBe(hash);
    }
    expect(triples(scan, 'verapdf')).toEqual(['6.2-1 pass']);
    expect(scan.informational.map((i) => `${i.ruleId} ${i.outcome}`)).toEqual(['7.1-8 fail']);
    expect(Buffer.from(runner.calls[0]!).equals(readFileSync(join(dir, name)))).toBe(true);
  });

  it('finds image-only pages, skips blank ones and wants bookmarks from 10 pages', async () => {
    const scanner = await PdfScanner.create({ verapdf: okRunner(), baseDir: dir });
    const long = await scanner.scanFile(
      await write('long.pdf', makePdf({ pages: 12, imagePages: [2, 5], blankPages: [7] })),
    );
    expect(triples(long, 'widedoor')).toEqual([
      'pdf-bookmarks needs-review',
      'pdf-image-only fail',
      'pdf-language fail',
      'pdf-title-displayed fail',
    ]);
    const pages = long.findings
      .filter((f) => f.source.ruleId === 'pdf-image-only')
      .map((f) => ('page' in f.location ? f.location.page : undefined));
    expect(pages).toEqual([2, 5]);

    const marked = await scanner.scanFile(
      await write('marked.pdf', makePdf({ pages: 12, bookmarks: true, title: 'T', lang: 'en' })),
    );
    expect(triples(marked, 'widedoor')).toEqual([
      'pdf-bookmarks pass',
      'pdf-image-only pass',
      'pdf-language pass',
      'pdf-title-displayed pass',
    ]);
    const hidden = await scanner.scanFile(
      await write('hidden.pdf', makePdf({ title: 'T', displayDocTitle: false, lang: 'en' })),
    );
    expect(triples(hidden, 'widedoor')).toContain('pdf-title-displayed fail');
  });

  it('takes the long-document threshold from options', async () => {
    const scanner = await PdfScanner.create({
      verapdf: okRunner(),
      baseDir: dir,
      longDocumentPages: 3,
    });
    const scan = await scanner.scanFile(await write('three.pdf', makePdf({ pages: 3 })));
    expect(triples(scan, 'widedoor')).toContain('pdf-bookmarks needs-review');
  });

  it('refuses limits that are not positive integers', async () => {
    for (const bad of [{ longDocumentPages: 0 }, { maxPages: 1.5 }, { verapdfTimeoutMs: -1 }])
      await expect(PdfScanner.create({ verapdf: okRunner(), ...bad })).rejects.toThrow(
        /must be a positive integer/,
      );
  });

  it('reports file problems and limits as run-metadata errors, never findings', async () => {
    mkdirSync(join(dir, 'folder.pdf'), { recursive: true });
    const five = await write('five.pdf', makePdf({ pages: 5 }));
    const scanner = await PdfScanner.create({
      verapdf: okRunner(),
      baseDir: dir,
      maxFileBytes: 20_000,
      maxPages: 4,
    });
    const big = await write('big.pdf', new Uint8Array(50_000));
    const cases: [string, string][] = [
      ['missing.pdf', 'file-not-found'],
      ['folder.pdf', 'not-a-file'],
      [big, 'file-too-large'],
      [five, 'too-many-pages'],
    ];
    for (const [file, code] of cases) {
      const scan = await scanner.scanFile(file);
      expect(scan.error?.code, file).toBe(code);
      expect(scan.error?.uri, file).toBe(file);
      expect(scan.findings, file).toEqual([]);
    }
  });

  it('turns veraPDF failures into errors on the asset', async () => {
    const name = await write('ok.pdf', makePdf());
    const cases: [ReturnType<typeof fakeRunner>, string][] = [
      [fakeRunner({ ...result(''), timedOut: true }), 'timeout'],
      [fakeRunner({ ...result(''), truncated: true }), 'output-too-large'],
      [fakeRunner(result('STDIN is not a valid PDF document.', 7)), 'malformed-pdf'],
      [
        fakeRunner(result(verapdfReport([{ clause: '99.1', testNumber: 1, status: 'passed' }]))),
        'scan-failed',
      ],
      [fakeRunner(() => Promise.reject(new Error('spawn docker ENOENT'))), 'verapdf-failed'],
    ];
    for (const [runner, code] of cases) {
      const scan = await (
        await PdfScanner.create({ verapdf: runner, baseDir: dir })
      ).scanFile(name);
      expect(scan.error?.code, code).toBe(code);
      expect(scan.findings).toEqual([]);
    }
  });

  it('does not start veraPDF on a file the reader cannot open', async () => {
    const runner = okRunner();
    const scanner = await PdfScanner.create({ verapdf: runner, baseDir: corpus });
    const scan = await scanner.scanFile('pdf/malformed.pdf');
    expect(scan.error).toMatchObject({
      code: 'malformed-pdf',
      engine: 'widedoor',
      uri: 'pdf/malformed.pdf',
    });
    expect(runner.calls).toEqual([]);
  });

  it('starts the PDF reader through readerSpawn when one is given', async () => {
    const commands: string[] = [];
    const scanner = await PdfScanner.create({
      verapdf: okRunner(),
      baseDir: dir,
      readerSpawn: (command, args, options) => {
        commands.push(command);
        return spawn(command, args, options);
      },
    });
    const scan = await scanner.scanFile(await write('spawned.pdf', makePdf({ title: 'S' })));
    expect(scan.error).toBeUndefined();
    expect(commands).toEqual([process.execPath]);
  });

  it('gives every file a verapdf-unavailable error that names the image when no runner exists', async () => {
    const result = await scanPdfs(
      { files: ['pdf/untagged.pdf'] },
      {
        verapdf: 'docker',
        baseDir: corpus,
        docker: { docker: 'widedoor-no-such-docker' },
      },
    );
    expect(result.engines.verapdf.runner).toBeNull();
    expect(result.findings).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'verapdf-unavailable', engine: 'verapdf' });
    expect(result.errors[0]?.message).toContain('docker pull verapdf/cli:v1.30.3');
  });
});

describe('inspectPdf limits', () => {
  it('stops a read that passes its time budget', async () => {
    const bytes = await makePdf({ pages: 200 });
    const r = await inspectPdf(bytes, { ...limits, timeoutMs: 1 });
    expect(r).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('reads a 100-page document well within the default budget', async () => {
    const bytes = await makePdf({ pages: 100 });
    const started = Date.now();
    const r = await inspectPdf(bytes, limits);
    expect(r.ok && r.inspection.pages).toBe(100);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('refuses an empty file without crashing', async () => {
    const r = await inspectPdf(new Uint8Array(0), limits);
    expect(r.ok).toBe(false);
  });

  it('kills a decompression bomb at the memory cap and keeps the scanner alive', async () => {
    // 1 MiB on disk, 1 GiB once its content stream is inflated.
    const bomb = await makeFlateBomb(1024 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    const before = process.memoryUsage.rss();
    const r = await inspectPdf(bomb, { ...limits, maxRssMb: 256 });
    expect(r).toMatchObject({ ok: false, code: 'resource-limit' });
    // The inflated bytes lived and died in the reader process, not here.
    expect(process.memoryUsage.rss() - before).toBeLessThan(200 * 1024 * 1024);
    const next = await inspectPdf(await makePdf(), limits);
    expect(next.ok).toBe(true);
  });

  it('reports the bomb as a resource-limit error on the asset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'widedoor-bomb-'));
    try {
      writeFileSync(join(dir, 'bomb.pdf'), await makeFlateBomb(1024 * 1024 * 1024));
      const result = await scanPdfs(
        { files: ['bomb.pdf'] },
        { verapdf: okRunner(), baseDir: dir, inspectMaxRssMb: 256 },
      );
      expect(result.errors).toEqual([
        {
          uri: 'bomb.pdf',
          code: 'resource-limit',
          engine: 'widedoor',
          message: 'reading the PDF passed its memory cap',
        },
      ]);
      expect(result.findings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('image-only detection (no image is decoded)', () => {
  const pages = async (...raw: Parameters<typeof makeRawPdf>[0]) => {
    const r = await inspectPdf(await makeRawPdf(raw), limits);
    if (!r.ok) throw new Error(r.message);
    return r.inspection.imageOnlyPages;
  };
  const image = { width: 200, height: 200 };
  const text = (mode: number) => `BT ${mode} Tr /F1 12 Tf 72 700 Td (Quarterly report) Tj ET`;

  it('flags a page that only draws an image, whatever its size', async () => {
    expect(await pages({ content: DRAW_IMAGE, image })).toEqual([1]);
    // Far over any decode budget: still found, because it is never decoded.
    expect(await pages({ content: DRAW_IMAGE, image: { width: 4000, height: 4000 } })).toEqual([1]);
  });

  it('passes an image with a text layer, visible or invisible (OCR, render mode 3)', async () => {
    expect(await pages({ content: `${DRAW_IMAGE} ${text(0)}`, image })).toEqual([]);
    expect(await pages({ content: `${DRAW_IMAGE} ${text(3)}`, image })).toEqual([]);
  });

  it('passes an image whose text sits in a form XObject', async () => {
    expect(await pages({ content: `${DRAW_IMAGE} /Fm1 Do`, image, formText: true })).toEqual([]);
  });

  it('passes vector-only and blank pages, and lists image pages by number', async () => {
    expect(
      await pages(
        { content: '0 0 m 300 300 l S' },
        { content: '' },
        { content: DRAW_IMAGE, image },
        { content: `  ${text(0)}` },
      ),
    ).toEqual([3]);
  });

  it('flags an inline image and an image drawn through a tiling pattern', async () => {
    expect(await pages({ content: INLINE_IMAGE })).toEqual([1]);
    expect(await pages({ content: FILL_PATTERN, image, pattern: true })).toEqual([1]);
    // The same pattern with real text on the page is not image-only.
    expect(await pages({ content: `${FILL_PATTERN} ${text(0)}`, image, pattern: true })).toEqual(
      [],
    );
  });

  it('flags a whitespace-only text layer over an image', async () => {
    expect(
      await pages({ content: `${DRAW_IMAGE} BT /F1 12 Tf 72 700 Td (   ) Tj ET`, image }),
    ).toEqual([1]);
  });
});

describe('scope', () => {
  it('records paths relative to baseDir, absolute outside it', () => {
    const base = join(tmpdir(), 'base');
    expect(pdfUri('a/b.pdf', base)).toBe('a/b.pdf');
    expect(pdfUri(join(base, 'c.pdf'), base)).toBe('c.pdf');
    expect(pdfUri('../out.pdf', base)).toBe(join(tmpdir(), 'out.pdf').split('\\').join('/'));
  });

  // POSIX only: Windows needs extra privileges for symbolic links and has no mkfifo.
  it.skipIf(process.platform === 'win32')(
    'drops glob matches that link out of baseDir and never blocks on a FIFO',
    async () => {
      const outside = mkdtempSync(join(tmpdir(), 'widedoor-outside-'));
      const dir = mkdtempSync(join(tmpdir(), 'widedoor-links-'));
      try {
        writeFileSync(join(outside, 'secret.pdf'), '');
        writeFileSync(join(dir, 'own.pdf'), '');
        symlinkSync(join(outside, 'secret.pdf'), join(dir, 'link.pdf'));
        expect(await resolvePdfScope({ include: ['*.pdf'] }, dir)).toEqual(['own.pdf']);
        expect(spawnSync('mkfifo', [join(dir, 'pipe.pdf')]).status).toBe(0);
        const scanner = await PdfScanner.create({ verapdf: okRunner(), baseDir: dir });
        expect((await scanner.scanFile('pipe.pdf')).error?.code).toBe('not-a-file');
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it('refuses glob patterns that leave baseDir', async () => {
    for (const pattern of [
      '../*.pdf',
      'docs/../../x.pdf',
      join(tmpdir(), '*.pdf'),
      '{../outside,sub}/*.pdf',
      '[.][.]/outside/*.pdf',
      '.[.]/outside/*.pdf',
      'C:foo/*.pdf',
    ])
      await expect(resolvePdfScope({ include: [pattern] }, tmpdir()), pattern).rejects.toThrow(
        /stay inside baseDir/,
      );
  });

  it('validates concurrency', async () => {
    for (const concurrency of [0, Number.NaN, 1.5])
      await expect(scanPdfs({}, { verapdf: okRunner(), concurrency })).rejects.toThrow(
        /concurrency must be a positive integer/,
      );
  });

  it('expands globs, dedupes paths and skips node_modules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'widedoor-scope-'));
    try {
      for (const f of ['a.pdf', 'sub/b.pdf', 'node_modules/x/c.pdf', 'notes.txt']) {
        mkdirSync(join(dir, f, '..'), { recursive: true });
        writeFileSync(join(dir, f), '');
      }
      expect(await resolvePdfScope({ files: ['a.pdf'], include: ['**/*.pdf'] }, dir)).toEqual([
        'a.pdf',
        'sub/b.pdf',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
