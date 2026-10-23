import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { PROFILE_IDS, type PdfDocumentType, type ProfileId } from '@widedoor/core';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_FAIL_ON,
  DEFAULT_MEMORY_MB,
  DEFAULT_OUT,
  DEFAULT_PROFILE,
  FAIL_ON,
  FORMATS,
  UsageError,
  type FailOn,
  type Format,
  type ScanArgs,
} from './args.js';
import { formatIssues } from './issues.js';
import { safeText } from './text.js';

/** A config file (or review file) that cannot be used; exit code 2. */
export class ConfigError extends Error {
  constructor(
    readonly file: string,
    readonly problems: readonly string[],
  ) {
    super(`${file}: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

const MAX_CONFIG_BYTES = 1024 * 1024;

/** Pages scanned per run when neither web.maxPages nor web.crawl.maxPages is set. */
export const DEFAULT_MAX_PAGES = 50;

/** Environment variable that names a storage state file (a CI workflow, not the repo, picks the credentials). */
export const STORAGE_STATE_ENV = 'WIDEDOOR_STORAGE_STATE';

/**
 * Reads a small regular file that the repo controls: never through a link,
 * never a device or FIFO, at most max bytes (checked on the open file).
 * Returns undefined when the file does not exist. Throws ConfigError.
 */
export function readRepoFile(file: string, max: number): string | undefined {
  let link;
  try {
    link = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError(file, ['the file could not be read']);
  }
  if (link.isSymbolicLink())
    throw new ConfigError(file, ['a symbolic link; Widedoor reads only regular files here']);
  if (!link.isFile()) throw new ConfigError(file, ['not a regular file']);
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    throw new ConfigError(file, ['the file could not be read']);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== link.ino || stat.dev !== link.dev)
      throw new ConfigError(file, ['the file changed while it was being read']);
    const buffer = Buffer.alloc(Math.min(stat.size, max) + 1);
    let length = 0;
    for (;;) {
      const n = readSync(fd, buffer, length, buffer.length - length, length);
      if (n === 0) break;
      length += n;
      if (length > max) throw new ConfigError(file, [`the file is over ${max / 1024 / 1024} MiB`]);
      if (length === buffer.length) break;
    }
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Parses YAML strictly: duplicate keys, syntax errors and warnings (an
 * unknown tag such as !!js/function) are all problems, and nothing is
 * printed by the parser itself. Throws ConfigError.
 */
export function parseRepoYaml(file: string, text: string): unknown {
  const doc = parseDocument(text, { uniqueKeys: true, logLevel: 'silent', prettyErrors: false });
  const problems = [...doc.errors, ...doc.warnings].map(
    (e) => `not valid YAML: ${safeText(String(e.message).split('\n')[0], 300)}`,
  );
  if (problems.length > 0) throw new ConfigError(file, problems);
  try {
    return doc.toJS({ maxAliasCount: 100 });
  } catch (e) {
    throw new ConfigError(file, [
      `not valid YAML: ${safeText(String((e as Error).message).split('\n')[0], 300)}`,
    ]);
  }
}

export const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

const httpUrl = z.string().refine(isHttpUrl, 'expected an http or https URL');

/** A glob relative to the config folder that cannot climb out of it. */
const includePattern = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !isAbsolute(p) &&
      !/^[\\/]/.test(p) &&
      !/^[a-z]:/i.test(p) &&
      !/[{}[\]]/.test(p) &&
      !p.split(/[\\/]/).includes('..'),
    'must be a relative pattern inside the config folder (no leading slash, drive, braces, brackets or "..")',
  );

/** widedoor.config.yaml (spec section 6). Unknown keys are errors, so a typo never silently widens or narrows a scan. */
export const ConfigSchema = z.strictObject({
  // YAML reads a bare 508 as a number.
  profile: z.preprocess((v) => (v === 508 ? '508' : v), z.enum(PROFILE_IDS)).optional(),
  web: z
    .strictObject({
      urls: z.array(httpUrl).optional(),
      sitemap: httpUrl.optional(),
      /** Pages scanned at most per run, with or without a crawl (default 50). crawl.maxPages wins when set. */
      maxPages: z.int().min(1).max(100_000).optional(),
      crawl: z
        .strictObject({
          sameOrigin: z.boolean().optional(),
          maxPages: z.int().min(1).max(100_000).optional(),
        })
        .optional(),
      /** Playwright storage state (cookies, localStorage). CLI and local only; never read by Widedoor itself. */
      auth: z.strictObject({ storageState: z.string().min(1) }).optional(),
      actions: z
        .array(z.unknown())
        .max(0, 'scripted actions are not supported yet; leave web.actions empty')
        .optional(),
    })
    .optional(),
  pdf: z
    .strictObject({
      include: z.array(includePattern).optional(),
      /**
       * Spec D20: whether PDFs count as non-web documents (the default; the
       * E205.4 exceptions apply under Section 508) or as web content (they do not).
       */
      documentType: z.enum(['non-web', 'web']).optional(),
    })
    .optional(),
  report: z
    .strictObject({
      formats: z
        .array(z.enum(FORMATS))
        .min(1)
        .transform((f) => [...new Set(f)])
        .optional(),
      failOn: z.enum(FAIL_ON).optional(),
    })
    .optional(),
  ai: z
    .strictObject({
      enabled: z
        .boolean()
        .refine((on) => !on, 'AI fix suggestions are not supported yet; set ai.enabled to false')
        .optional(),
      provider: z.enum(['anthropic', 'openai']).optional(),
    })
    .optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  /** Absolute path of the config file. */
  file: string;
  /** Folder relative paths in the config resolve against. */
  dir: string;
  config: Config;
}

/** Reads and validates a config file. Throws ConfigError. */
export function loadConfig(path: string): LoadedConfig {
  const file = resolve(path);
  const text = readRepoFile(file, MAX_CONFIG_BYTES);
  if (text === undefined) throw new ConfigError(file, ['no such file']);
  const raw = parseRepoYaml(file, text);
  const parsed = ConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new ConfigError(file, formatIssues(parsed.error.issues));
  return { file, dir: dirname(file), config: parsed.data };
}

export interface WebPlan {
  urls: string[];
  sitemap?: string;
  /** Present when links are followed. */
  crawl?: { sameOrigin: boolean; maxPages: number };
  /** The page cap for the run, and the setting it came from (named when listed pages are left out). */
  maxPages: number;
  maxPagesSetting: 'web.crawl.maxPages' | 'web.maxPages' | 'default';
  /** Absolute path; checked to exist. */
  storageState?: string;
}

export interface PdfPlan {
  /** Folder files and patterns are relative to; asset uris are relative to it. */
  baseDir: string;
  files: string[];
  include: string[];
}

/** Everything a scan needs, resolved from the command line and the config. */
export interface ScanPlan {
  profile: ProfileId;
  /** pdf.documentType (spec D20); default non-web. */
  pdfDocumentType: PdfDocumentType;
  formats: Format[];
  failOn: FailOn;
  /** Absolute report folder. */
  out: string;
  web?: WebPlan;
  pdf?: PdfPlan;
  /** Folders below which every component of out is link-checked: the working folder and the config folder. */
  outRoots: string[];
  /** Folder that holds widedoor-review/. */
  reviewDir: string;
  unsafeNoSandbox: boolean;
  concurrency: number;
  memoryMb: number;
  configFile?: string;
}

const isFileAt = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The storage state file: --storage-state, else WIDEDOOR_STORAGE_STATE (both
 * relative to the working folder, chosen by whoever runs the scan), else the
 * config's web.auth.storageState, which must stay inside the config folder
 * (a repo must not point a scan at credentials elsewhere on the machine).
 * Missing files are reported without echoing a resolved path.
 */
function resolveStorageState(
  args: ScanArgs,
  loaded: LoadedConfig | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const fromRunner = args.storageState ?? (env[STORAGE_STATE_ENV] || undefined);
  if (fromRunner !== undefined) {
    const abs = resolve(cwd, fromRunner);
    if (!isFileAt(abs))
      throw new UsageError(
        `${args.storageState !== undefined ? '--storage-state' : STORAGE_STATE_ENV}: no such file`,
      );
    return abs;
  }
  const configured = loaded?.config.web?.auth?.storageState;
  if (configured === undefined || !loaded) return undefined;
  const fail = (why: string) => new ConfigError(loaded.file, [`web.auth.storageState: ${why}`]);
  const abs = resolve(loaded.dir, configured);
  const inside = (root: string, path: string) => {
    const rel = relative(root, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  if (!inside(loaded.dir, abs))
    throw fail(
      `must be inside the config folder; use --storage-state or ${STORAGE_STATE_ENV} for a file elsewhere`,
    );
  if (!isFileAt(abs)) throw fail('no such file');
  if (!inside(realpathSync(loaded.dir), realpathSync(abs)))
    throw fail(
      `must be inside the config folder; use --storage-state or ${STORAGE_STATE_ENV} for a file elsewhere`,
    );
  return abs;
}

export type Target = { kind: 'url'; url: string } | { kind: 'file'; path: string };

/** A command-line target: an http(s) URL or a local PDF file. Throws UsageError. */
export function classifyTarget(target: string): Target {
  // A Windows drive path (C:\x.pdf, C:/x.pdf) is a file, not a URL with scheme "c".
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) {
    if (isHttpUrl(target)) return { kind: 'url', url: target };
    throw new UsageError(
      `cannot scan "${target}": the CLI scans http and https URLs and local PDF files`,
    );
  }
  if (extname(target).toLowerCase() !== '.pdf')
    throw new UsageError(
      `cannot scan "${target}": local files must be PDFs (web pages are scanned by http or https URL)`,
    );
  return { kind: 'file', path: target };
}

/**
 * Combines the command line with the config. Targets on the command line
 * replace the config's scope (web.urls, web.sitemap and pdf.include); crawl
 * rules, auth, profile and report settings still come from the config, and
 * flags override the config. Throws UsageError or ConfigError.
 */
export function buildPlan(
  args: ScanArgs,
  loaded: LoadedConfig | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ScanPlan {
  const config = loaded?.config ?? {};
  const targets = args.targets.map(classifyTarget);
  const fromArgs = targets.length > 0;
  const urls = fromArgs
    ? targets.flatMap((t) => (t.kind === 'url' ? [t.url] : []))
    : [...(config.web?.urls ?? [])];
  const sitemap = fromArgs ? undefined : config.web?.sitemap;

  let web: WebPlan | undefined;
  if (urls.length > 0 || sitemap !== undefined) {
    // The page cap: web.crawl.maxPages when set (the more specific setting), else web.maxPages, else 50.
    const crawl = config.web?.crawl;
    const cap =
      crawl?.maxPages !== undefined
        ? { maxPages: crawl.maxPages, maxPagesSetting: 'web.crawl.maxPages' as const }
        : config.web?.maxPages !== undefined
          ? { maxPages: config.web.maxPages, maxPagesSetting: 'web.maxPages' as const }
          : { maxPages: DEFAULT_MAX_PAGES, maxPagesSetting: 'default' as const };
    web = { urls, ...cap };
    if (sitemap !== undefined) web.sitemap = sitemap;
    if (crawl !== undefined)
      web.crawl = { sameOrigin: crawl.sameOrigin ?? true, maxPages: cap.maxPages };
    const storageState = resolveStorageState(args, loaded, cwd, env);
    if (storageState !== undefined) web.storageState = storageState;
  }

  let pdf: PdfPlan | undefined;
  if (fromArgs) {
    const files = targets.flatMap((t) => (t.kind === 'file' ? [t.path] : []));
    if (files.length > 0) pdf = { baseDir: cwd, files, include: [] };
  } else if ((config.pdf?.include ?? []).length > 0 && loaded) {
    pdf = { baseDir: loaded.dir, files: [], include: [...(config.pdf?.include ?? [])] };
  }

  if (!web && !pdf)
    throw new UsageError(
      loaded
        ? `${loaded.file} names nothing to scan: add web.urls, web.sitemap or pdf.include`
        : 'nothing to scan',
    );

  return {
    profile: args.profile ?? config.profile ?? DEFAULT_PROFILE,
    pdfDocumentType: config.pdf?.documentType ?? 'non-web',
    formats: args.formats ?? config.report?.formats ?? [...FORMATS],
    failOn: args.failOn ?? config.report?.failOn ?? DEFAULT_FAIL_ON,
    out: resolve(cwd, args.out ?? DEFAULT_OUT),
    ...(web ? { web } : {}),
    ...(pdf ? { pdf } : {}),
    reviewDir: loaded?.dir ?? cwd,
    outRoots: loaded ? [cwd, loaded.dir] : [cwd],
    unsafeNoSandbox: args.unsafeNoSandbox,
    concurrency: args.concurrency ?? DEFAULT_CONCURRENCY,
    memoryMb: args.memoryMb ?? DEFAULT_MEMORY_MB,
    ...(loaded ? { configFile: loaded.file } : {}),
  };
}
