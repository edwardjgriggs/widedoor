import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { constants } from 'node:fs';
import { glob, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  loadStandardsData,
  type Asset,
  type Finding,
  type VerapdfMap,
  type WidedoorMap,
} from '@widedoor/core';
import { inspectPdf } from './inspect.js';
import {
  DEFAULT_LONG_DOCUMENT_PAGES,
  normalizeVerapdfReport,
  parseVerapdfOutput,
  truncateSnippet,
  widedoorFindings,
  type InformationalResult,
} from './normalize.js';
import {
  VERAPDF_VERSION,
  resolveRunner,
  type DockerRunnerOptions,
  type LocalRunnerOptions,
  type RunnerChoice,
  type RunnerKind,
  type SpawnFn,
  type VerapdfRunner,
} from './verapdf.js';

/** Version of the Widedoor PDF checks: the @widedoor/pdf package version. */
export const WIDEDOOR_PDF_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export type PdfScanErrorCode =
  | 'file-not-found'
  | 'not-a-file'
  | 'file-too-large'
  | 'too-many-pages'
  | 'malformed-pdf'
  | 'encrypted-pdf'
  | 'timeout'
  | 'resource-limit'
  | 'output-too-large'
  | 'verapdf-unavailable'
  | 'verapdf-failed'
  | 'scan-failed';

/** A scan error is run metadata, never a Finding; the asset rolls up as Not Evaluated. */
export interface PdfScanError {
  uri: string;
  code: PdfScanErrorCode;
  /** Which engine failed, when one did. */
  engine?: 'verapdf' | 'widedoor';
  /** First line of the underlying error message. */
  message: string;
}

export interface PdfFileScan {
  /** The file as given. */
  path: string;
  /** Present when the file was scanned: its uri and the sha256 of its bytes. */
  asset?: Asset;
  findings: Finding[];
  /** veraPDF rules with no WCAG relation (verapdf-map.yaml `unmapped`). */
  informational: InformationalResult[];
  /** Set when the file could not be scanned; findings are then empty. */
  error?: PdfScanError;
}

export interface PdfScannerOptions {
  /** Which veraPDF to run. Default "auto": a local CLI at the pinned version, else the Docker image. */
  verapdf?: RunnerChoice;
  local?: LocalRunnerOptions;
  docker?: DockerRunnerOptions;
  /** Asset uris are paths relative to this directory (forward slashes). Default process.cwd(). */
  baseDir?: string;
  /** Largest PDF read, in bytes. Default 100 MiB. */
  maxFileBytes?: number;
  /** PDFs with more pages are not scanned. Default 2000. */
  maxPages?: number;
  /** Wall-clock limit for one veraPDF run, in milliseconds. Default 120000. */
  verapdfTimeoutMs?: number;
  /** Largest veraPDF report read, in bytes. Default 64 MiB. */
  maxOutputBytes?: number;
  /** Failed checks veraPDF lists per rule (the rest are counted). Default 100. */
  maxFailuresDisplayed?: number;
  /** Wall-clock limit for the Widedoor checks of one PDF, in milliseconds. Default 60000. */
  inspectTimeoutMs?: number;
  /** Heap cap of the PDF reader thread, in MiB. Default 1024. */
  inspectHeapMb?: number;
  /** Resident memory cap of the PDF reader process, in MiB. Default 2048. */
  inspectMaxRssMb?: number;
  /** Starts the PDF reader process (a caller can track it to stop it on an interrupt). Default node:child_process spawn. */
  readerSpawn?: SpawnFn;
  /** Page count from which a PDF should have bookmarks. Default 10. */
  longDocumentPages?: number;
  /** Mapping data; defaults to the files shipped in @widedoor/core. */
  verapdfMap?: VerapdfMap;
  widedoorMap?: WidedoorMap;
}

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0] ?? '';

const sha256 = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** The uri a PDF is recorded under: relative to baseDir with forward slashes, or absolute outside it. */
export function pdfUri(path: string, baseDir: string): string {
  const abs = resolve(baseDir, path);
  const rel = relative(resolve(baseDir), abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return abs.split(sep).join('/');
  return rel.split(sep).join('/');
}

const POSITIVE_INTEGER_OPTIONS = [
  'maxFileBytes',
  'maxPages',
  'verapdfTimeoutMs',
  'maxOutputBytes',
  'maxFailuresDisplayed',
  'inspectTimeoutMs',
  'inspectHeapMb',
  'inspectMaxRssMb',
  'longDocumentPages',
] as const satisfies readonly (keyof PdfScannerOptions)[];

class FileTooLarge extends Error {}

const FS_ERRORS: Record<string, string> = {
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  EBUSY: 'the file is locked',
  ELOOP: 'too many symbolic links',
  ENAMETOOLONG: 'the path is too long',
  EAGAIN: 'the file is not ready to read',
};

/** Reads at most max bytes, so a file that grows after a size check is still capped. */
async function readCapped(path: string, max: number): Promise<Uint8Array> {
  // stat first: opening a FIFO or device would block before any check could run.
  if (!(await stat(path)).isFile())
    throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' });
  const flags = process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NONBLOCK;
  const file = await open(path, flags);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' });
    if (stat.size > max) throw new FileTooLarge();
    const buffer = Buffer.alloc(Math.min(stat.size, max) + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > max) throw new FileTooLarge();
      if (length === buffer.length) break;
    }
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}

/**
 * Scans PDFs with veraPDF (PDF/UA-1) and the Widedoor PDF checks. The runner
 * is resolved once in create(); without one, every file gets a
 * verapdf-unavailable error that names the Docker image to pull.
 */
export class PdfScanner {
  /** Run-metadata warnings, for example that veraPDF ran outside Docker. */
  readonly warnings: string[];

  private constructor(
    readonly runner: VerapdfRunner | undefined,
    private readonly unavailable: string | undefined,
    warnings: string[],
    private readonly maps: { verapdf: VerapdfMap; widedoor: WidedoorMap },
    private readonly options: PdfScannerOptions,
  ) {
    this.warnings = [...warnings, ...(runner?.warnings ?? [])];
  }

  static async create(options: PdfScannerOptions = {}): Promise<PdfScanner> {
    for (const key of POSITIVE_INTEGER_OPTIONS) {
      const value = options[key];
      if (value !== undefined && (!Number.isInteger(value) || value < 1))
        throw new Error(`${key} must be a positive integer, got ${value}`);
    }
    const data = options.verapdfMap && options.widedoorMap ? undefined : loadStandardsData();
    const maps = {
      verapdf: options.verapdfMap ?? data!.verapdf,
      widedoor: options.widedoorMap ?? data!.widedoor,
    };
    const resolved = await resolveRunner(options.verapdf ?? 'auto', {
      ...(options.local ? { local: options.local } : {}),
      ...(options.docker ? { docker: options.docker } : {}),
    });
    return resolved.ok
      ? new PdfScanner(resolved.runner, undefined, resolved.warnings, maps, options)
      : new PdfScanner(undefined, resolved.message, resolved.warnings, maps, options);
  }

  get runnerKind(): RunnerKind | null {
    return this.runner?.kind ?? null;
  }

  /**
   * Scans one PDF, recorded under uri (default: its path, see pdfUri). Never
   * throws for file problems; they come back as `error`.
   */
  async scanFile(
    path: string,
    uri = pdfUri(path, this.options.baseDir ?? process.cwd()),
  ): Promise<PdfFileScan> {
    const o = this.options;
    const fail = (code: PdfScanErrorCode, message: string, engine?: PdfScanError['engine']) => ({
      path,
      findings: [],
      informational: [],
      // Messages can quote the PDF (pdf.js errors): same treatment as snippets.
      error: { uri, code, ...(engine ? { engine } : {}), message: truncateSnippet(message) },
    });

    let bytes: Uint8Array;
    try {
      bytes = await readCapped(
        resolve(o.baseDir ?? process.cwd(), path),
        o.maxFileBytes ?? 100 * 1024 * 1024,
      );
    } catch (e) {
      if (e instanceof FileTooLarge) return fail('file-too-large', 'the file is over maxFileBytes');
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return fail('file-not-found', 'no such file');
      if (code === 'ENOTFILE' || code === 'EISDIR') return fail('not-a-file', 'not a regular file');
      // Fixed text: fs messages carry the absolute host path.
      return fail('scan-failed', FS_ERRORS[code ?? ''] ?? 'the file could not be read');
    }
    if (!this.runner) return fail('verapdf-unavailable', this.unavailable ?? '', 'verapdf');
    const contentHash = sha256(bytes);
    const asset: Asset = { kind: 'pdf', uri, contentHash, reviewHash: contentHash };

    // The cheap reader goes first: a file it cannot open is not worth a JVM.
    const inspected = await inspectPdf(
      bytes,
      {
        maxPages: o.maxPages ?? 2000,
        timeoutMs: o.inspectTimeoutMs ?? 60_000,
        maxHeapMb: o.inspectHeapMb ?? 1024,
        maxRssMb: o.inspectMaxRssMb ?? 2048,
      },
      o.readerSpawn,
    );
    if (!inspected.ok) return fail(inspected.code, inspected.message, 'widedoor');

    let run;
    try {
      run = await this.runner.run(bytes, {
        timeoutMs: o.verapdfTimeoutMs ?? 120_000,
        maxOutputBytes: o.maxOutputBytes ?? 64 * 1024 * 1024,
        maxFailuresDisplayed: o.maxFailuresDisplayed ?? 100,
      });
    } catch {
      return fail('verapdf-failed', 'veraPDF did not start', 'verapdf');
    }
    const parsed = parseVerapdfOutput(run);
    if (!parsed.ok) return fail(parsed.code, parsed.message, 'verapdf');

    try {
      const vera = normalizeVerapdfReport(parsed.report, asset, this.maps.verapdf);
      const own = widedoorFindings(
        inspected.inspection,
        asset,
        this.maps.widedoor,
        WIDEDOOR_PDF_VERSION,
        {
          longDocumentPages: o.longDocumentPages ?? DEFAULT_LONG_DOCUMENT_PAGES,
        },
      );
      return {
        path,
        asset,
        findings: [...vera.findings, ...own],
        informational: vera.informational,
      };
    } catch (e) {
      return fail('scan-failed', firstLine(e));
    }
  }
}

export interface PdfScope {
  /** PDF paths, relative to baseDir or absolute. */
  files?: readonly string[];
  /** Glob patterns relative to baseDir (spec config `pdf.include`); node_modules is skipped. */
  include?: readonly string[];
  /** PDFs fetched by URL, scanned after the rest under their URL. */
  fetched?: readonly PdfSource[];
}

/**
 * A PDF the scan fetches only when a worker is ready for it: load returns the
 * file to read and the uri to record it under (undefined when it could not be
 * had; the caller reports that), and release runs once the file is scanned.
 */
export interface PdfSource {
  /** What progress names while the file is fetched and scanned (its URL). */
  url?: string;
  load(): Promise<{ path: string; uri: string } | undefined>;
  release?(): Promise<void>;
}

export interface PdfScanOptions extends PdfScannerOptions {
  /** PDFs scanned in parallel. Default 2. */
  concurrency?: number;
  /**
   * A scanner already made with PdfScanner.create (so the caller can see its
   * runner first). It must have the same baseDir; the scanner options here
   * are then not used again.
   */
  scanner?: PdfScanner;
  /**
   * Stops the scan: no file is started after it fires and scanPdfs rejects
   * with its reason. The processes of the files in flight are the caller's
   * to stop (through the spawn functions it passed).
   */
  signal?: AbortSignal;
  /** Told when a file starts and when it is done: files done, files in scope, and the file started (as given, or its URL). */
  onProgress?: (progress: { done: number; known: number; current?: string }) => void;
}

export interface PdfScanResult {
  engines: {
    verapdf: {
      name: 'verapdf';
      version: string;
      runner: RunnerKind | null;
      description: string | null;
    };
    widedoor: { name: 'widedoor'; version: string };
  };
  files: PdfFileScan[];
  assets: Asset[];
  findings: Finding[];
  informational: InformationalResult[];
  errors: PdfScanError[];
  warnings: string[];
}

const isInside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * The files a scope names, deduped by resolved path, in scope order (globs
 * sorted). Glob patterns must be relative and stay inside baseDir, and a match
 * whose real path (after symbolic links) leaves baseDir is dropped; files
 * listed explicitly are taken as given.
 */
export async function resolvePdfScope(scope: PdfScope, baseDir: string): Promise<string[]> {
  const root = await realpath(baseDir).catch(() => resolve(baseDir));
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    const key = resolve(baseDir, p);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  (scope.files ?? []).forEach(add);
  for (const pattern of scope.include ?? []) {
    // Braces expand to alternatives and brackets to character classes (so {../x,y} and
    // [.][.]/x would climb out); a drive letter names another root.
    if (
      isAbsolute(pattern) ||
      /^[a-z]:/i.test(pattern) ||
      /[{}[\]]/.test(pattern) ||
      pattern.split(/[\\/]/).includes('..')
    )
      throw new Error(`include pattern must stay inside baseDir: ${pattern}`);
    const matches: string[] = [];
    for await (const m of glob(pattern, {
      cwd: baseDir,
      exclude: (name: string) => name === 'node_modules',
    })) {
      const real = await realpath(resolve(baseDir, m)).catch(() => undefined);
      if (real !== undefined && isInside(root, real)) matches.push(m.split(sep).join('/'));
    }
    matches.sort().forEach(add);
  }
  return out;
}

/** Resolves the scope and scans every PDF in it. */
export async function scanPdfs(
  scope: PdfScope,
  options: PdfScanOptions = {},
): Promise<PdfScanResult> {
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error(`concurrency must be a positive integer, got ${concurrency}`);
  const baseDir = options.baseDir ?? process.cwd();
  const paths = await resolvePdfScope(scope, baseDir);
  const fetched = scope.fetched ?? [];
  const total = paths.length + fetched.length;
  const scanner = options.scanner ?? (await PdfScanner.create({ ...options, baseDir }));
  const scans: (PdfFileScan | undefined)[] = new Array(total);
  const { signal, onProgress } = options;
  let next = 0;
  let done = 0;
  const progress = (current?: string) =>
    onProgress?.({ done, known: total, ...(current !== undefined ? { current } : {}) });
  const worker = async () => {
    while (next < total && !signal?.aborted) {
      const i = next++;
      if (i < paths.length) {
        progress(paths[i]);
        scans[i] = await scanner.scanFile(paths[i] as string);
        done++;
        progress();
        continue;
      }
      // Fetched now, not up front: at most one file per worker waits on disk.
      const source = fetched[i - paths.length] as PdfSource;
      progress(source.url);
      const loaded = await source.load();
      if (loaded !== undefined) {
        try {
          scans[i] = await scanner.scanFile(loaded.path, loaded.uri);
        } finally {
          await source.release?.();
        }
      }
      done++;
      progress();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  signal?.throwIfAborted();

  const assets: Asset[] = [];
  const findings: Finding[] = [];
  const informational: InformationalResult[] = [];
  const errors: PdfScanError[] = [];
  const seen = new Set<string>();
  const files: PdfFileScan[] = [];
  for (const scan of scans) {
    if (!scan) continue;
    if (scan.error) errors.push(scan.error);
    // Paths that resolve alike are deduped in resolvePdfScope; this drops two spellings
    // that map to one uri. A link or a case-only difference on Windows still counts twice.
    if (scan.asset && seen.has(scan.asset.uri)) continue;
    if (scan.asset) {
      seen.add(scan.asset.uri);
      assets.push(scan.asset);
    }
    findings.push(...scan.findings);
    informational.push(...scan.informational);
    files.push(scan);
  }
  return {
    engines: {
      verapdf: {
        name: 'verapdf',
        version: VERAPDF_VERSION,
        runner: scanner.runnerKind,
        description: scanner.runner?.description ?? null,
      },
      widedoor: { name: 'widedoor', version: WIDEDOOR_PDF_VERSION },
    },
    files,
    assets,
    findings,
    informational,
    errors,
    warnings: [...scanner.warnings],
  };
}
