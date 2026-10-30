import { realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  ConfigError,
  MODEL_ID,
  MODEL_ID_RULE,
  PROFILE_IDS,
  formatIssues,
  getProfile,
  parseRepoYaml,
  readRepoFile,
  type PdfDocumentType,
  type ProfileId,
} from '@widedoor/core';
import { isAcrDate, type AcrMeta } from '@widedoor/report';
import { DEFAULT_MAX_PDF_BYTES, isPdfUrl } from '@widedoor/web';
import {
  ACR_FORMATS,
  DEFAULT_CONCURRENCY,
  DEFAULT_FORMATS,
  DEFAULT_FAIL_ON,
  DEFAULT_MEMORY_MB,
  DEFAULT_OUT,
  DEFAULT_PROFILE,
  FAIL_ON,
  FORMATS,
  UsageError,
  type FailOn,
  type Format,
} from './settings.js';

export { ConfigError, parseRepoYaml, readRepoFile };

const MAX_CONFIG_BYTES = 1024 * 1024;

/** Pages scanned per run when neither web.maxPages nor web.crawl.maxPages is set. */
export const DEFAULT_MAX_PAGES = 50;

/** Largest pdf.maxBytes: the PDF scanner reads at most 100 MiB of a file. */
export const MAX_PDF_BYTES = 100 * 1024 * 1024;

/** Environment variable that names a storage state file (a CI workflow, not the repo, picks the credentials). */
export const STORAGE_STATE_ENV = 'WIDEDOOR_STORAGE_STATE';

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

/** Text in the acr block; a bare number (version: 2.10) is refused rather than read as 2.1. */
const acrText = z
  .string({ error: 'must be text; quote a value YAML would read as a number, such as "2.10"' })
  .trim()
  .min(1);

/** widedoor.config.yaml (spec section 6). Unknown keys are errors, so a typo never silently widens or narrows a scan. */
/** The refusal for a key-shaped field anywhere in the ai block. */
export const AI_KEY_IN_CONFIG =
  'API keys come from ANTHROPIC_API_KEY or OPENAI_API_KEY, never the config file';

/**
 * The ai block's limit ranges and defaults; @widedoor/ai's AiLimitsSchema holds
 * the same (a CLI test checks they agree). The server never imports
 * @widedoor/ai: the hosted tier must not load it (D16).
 */
export const AI_LIMIT_RANGES = {
  maxGroups: { min: 1, max: 200 },
  maxRequestsPerMinute: { min: 1, max: 60 },
  concurrency: { min: 1, max: 4 },
  maxOutputTokens: { min: 256, max: 16_384 },
  maxInputTokensTotal: { min: 1000, max: 5_000_000 },
} as const;

const AI_FIELDS = new Set([
  'enabled',
  'allowSignedIn',
  'provider',
  'model',
  ...Object.keys(AI_LIMIT_RANGES),
]);
const KEY_SHAPED = /key|token|secret|passw|credential|auth|bearer/i;

/** Every path in the ai block that names a credential: any unknown key-shaped name, at any depth. */
function keyShapedPaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const here = [...path, k];
    const named = (path.length > 0 || !AI_FIELDS.has(k)) && KEY_SHAPED.test(k) ? [here] : [];
    return [...named, ...keyShapedPaths(v, here)];
  });
}

/**
 * Whether a model id looks like a pasted key: an sk- or sk_ prefix, a
 * credential word (the field-name test above), or a long run of letters and
 * digits with no separator, which no model id has. Refused with
 * AI_KEY_IN_CONFIG, which never echoes the value.
 */
export const keyShapedModel = (model: string) =>
  /^sk[-_]/i.test(model) || KEY_SHAPED.test(model) || /[A-Za-z0-9]{32,}/.test(model);

const aiLimit = (name: keyof typeof AI_LIMIT_RANGES) =>
  z.int().min(AI_LIMIT_RANGES[name].min).max(AI_LIMIT_RANGES[name].max).optional();

/**
 * The ai block (spec section 9, D16): off unless enabled; the provider's key
 * comes from the environment only, so a key-shaped field is refused with
 * AI_KEY_IN_CONFIG before the strict shape check.
 */
export const AiConfigSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    for (const path of keyShapedPaths(value))
      ctx.addIssue({ code: 'custom', message: AI_KEY_IN_CONFIG, path, continue: false });
  })
  .pipe(
    z.strictObject({
      enabled: z.boolean().optional(),
      /** AI for a signed-in scan (storage state): off unless set, since its snippets can hold personal data. */
      allowSignedIn: z.boolean().optional(),
      provider: z.enum(['anthropic', 'openai']).optional(),
      model: z
        .string()
        .refine((m) => !keyShapedModel(m), { message: AI_KEY_IN_CONFIG, abort: true })
        .regex(MODEL_ID, `must be ${MODEL_ID_RULE}`)
        .optional(),
      maxGroups: aiLimit('maxGroups'),
      maxRequestsPerMinute: aiLimit('maxRequestsPerMinute'),
      concurrency: aiLimit('concurrency'),
      maxOutputTokens: aiLimit('maxOutputTokens'),
      maxInputTokensTotal: aiLimit('maxInputTokensTotal'),
    }),
  );
export type AiConfig = z.infer<typeof AiConfigSchema>;

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
      /** PDFs to fetch and scan by URL; the body must be a PDF whatever the URL ends in. */
      urls: z.array(httpUrl).optional(),
      /** Largest PDF fetched by URL (listed or found by a crawl), in bytes. Default 50 MiB. */
      maxBytes: z.int().min(1).max(MAX_PDF_BYTES).optional(),
      /**
       * Fetch PDFs by URL (pdf.urls, .pdf URLs, crawled links). Default: on,
       * except inside Widedoor's image, where veraPDF would parse them in the
       * networked container; off, each is a scope gap.
       */
      fetch: z.boolean().optional(),
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
  /** ACR metadata (Task 2.7). Only product.name is required, and only for an ACR format; the rest leave the ACR a draft. */
  acr: z
    .strictObject({
      vendor: z.strictObject({ name: acrText.optional(), contact: acrText.optional() }).optional(),
      product: z
        .strictObject({
          name: acrText.optional(),
          version: acrText.optional(),
          description: acrText.optional(),
        })
        .optional(),
      notes: acrText.optional(),
      reportDate: z
        .string()
        .refine(isAcrDate, 'must be a date written YYYY-MM-DD, for example "2026-10-23"')
        .optional(),
    })
    .optional(),
  ai: AiConfigSchema.optional(),
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
  /** PDFs fetched by URL (pdf.urls, or command-line URLs ending in .pdf). */
  urls: string[];
}

/** Everything a scan needs, resolved from the command line and the config. */
export interface ScanPlan {
  profile: ProfileId;
  /** pdf.documentType (spec D20); default non-web. */
  pdfDocumentType: PdfDocumentType;
  /** pdf.maxBytes: the cap for every PDF fetched by URL, listed or found by a crawl. */
  pdfMaxBytes: number;
  /** pdf.fetch when set; unset, the run decides from the veraPDF runner (pdfFetchDecision). */
  pdfFetch?: boolean;
  formats: Format[];
  /** The config's acr block, set when an ACR format is requested (acr.product.name is then present). */
  acr?: AcrMeta;
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

/** What a scan asks for beyond the config: the CLI's targets and flags, or a scan request's fields. */
export interface PlanArgs {
  /** URLs and PDF files, as given. */
  targets: string[];
  profile?: ProfileId;
  formats?: Format[];
  out?: string;
  /** Playwright storage state file, from the command line (beats the environment and the config). */
  storageState?: string;
  failOn?: FailOn;
  unsafeNoSandbox: boolean;
  concurrency?: number;
  memoryMb?: number;
  /** A lower page cap for this run (a scan request's maxPages); never above the config's. */
  maxPages?: number;
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
  args: PlanArgs,
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

export type Target =
  { kind: 'url'; url: string } | { kind: 'pdf-url'; url: string } | { kind: 'file'; path: string };

/**
 * A command-line target: an http(s) URL (a PDF when its path ends in .pdf;
 * a page the server answers with a PDF is handed on by the web scan) or a
 * local PDF file. Throws UsageError.
 */
export function classifyTarget(target: string): Target {
  // A Windows drive path (C:\x.pdf, C:/x.pdf) is a file, not a URL with scheme "c".
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) {
    if (isHttpUrl(target))
      return isPdfUrl(target) ? { kind: 'pdf-url', url: target } : { kind: 'url', url: target };
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

/** How acrMeta's refusals name what needs the metadata, and the config file. */
export interface AcrNaming {
  /** Starts the refusal, verb included, for example "the ACR formats (...) need". */
  needs: string;
  /** The config file as the reader knows it (widedoor ui: relative to its root). */
  file?: string;
  /** How to choose a profile with the Section 508 view. */
  profileHint: string;
}

/**
 * The ACR metadata for a run that writes an ACR format. Throws UsageError when
 * the profile has no Section 508 view (naming the profiles that have it) or
 * acr.product.name is not set. naming changes the wording (widedoor ui);
 * the CLI's names the format and the config's path.
 */
export function acrMeta(
  formats: readonly Format[],
  profile: ProfileId,
  loaded: LoadedConfig | undefined,
  naming?: AcrNaming,
): AcrMeta | undefined {
  const format = formats.find((f) => ACR_FORMATS.includes(f));
  if (format === undefined) return undefined;
  const has508 = (id: ProfileId) =>
    getProfile(id).assets.web.standards.some((s) => s.standard === '508');
  const needs = naming?.needs ?? `the ${format} format needs`;
  if (!has508(profile))
    throw new UsageError(
      `${needs} the Section 508 view, which profile ${profile} does not have; ${naming?.profileHint ?? 'use --profile'} ${PROFILE_IDS.filter(has508).join(' or ')}`,
    );
  const acr = loaded?.config.acr;
  const name = acr?.product?.name;
  if (name === undefined)
    throw new UsageError(
      `${needs} acr.product.name in ${loaded ? (naming?.file ?? loaded.file) : 'a config file (none was given or found)'}`,
    );
  // Keys that are set, so AcrMeta never holds an explicit undefined.
  const set = <T extends object>(o: T | undefined) =>
    Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as {
      [K in keyof T]?: Exclude<T[K], undefined>;
    };
  const vendor = set(acr?.vendor);
  const { notes, reportDate } = set(acr);
  return {
    ...(Object.keys(vendor).length > 0 ? { vendor } : {}),
    product: { ...set(acr?.product), name },
    ...(notes !== undefined ? { notes } : {}),
    ...(reportDate !== undefined ? { reportDate } : {}),
  };
}

/**
 * Combines the command line with the config. Targets on the command line
 * replace the config's scope (web.urls, web.sitemap, pdf.include and pdf.urls); crawl
 * rules, auth, profile and report settings still come from the config, and
 * flags override the config. Throws UsageError or ConfigError.
 */
export function buildPlan(
  args: PlanArgs,
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
    if (args.maxPages !== undefined) {
      if (args.maxPages > cap.maxPages)
        throw new UsageError(
          `maxPages must be at most ${cap.maxPages}${cap.maxPagesSetting === 'default' ? ' (the default page cap)' : ` (${cap.maxPagesSetting} in the config)`}`,
        );
      cap.maxPages = args.maxPages;
    }
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
    const pdfUrls = targets.flatMap((t) => (t.kind === 'pdf-url' ? [t.url] : []));
    if (files.length > 0 || pdfUrls.length > 0)
      pdf = { baseDir: cwd, files, include: [], urls: pdfUrls };
  } else if (loaded) {
    const include = [...(config.pdf?.include ?? [])];
    const pdfUrls = [...(config.pdf?.urls ?? [])];
    if (include.length > 0 || pdfUrls.length > 0)
      pdf = { baseDir: loaded.dir, files: [], include, urls: pdfUrls };
  }

  if (!web && !pdf)
    throw new UsageError(
      loaded
        ? `${loaded.file} names nothing to scan: add web.urls, web.sitemap, pdf.include or pdf.urls`
        : 'nothing to scan',
    );

  const profile = args.profile ?? config.profile ?? DEFAULT_PROFILE;
  const formats = args.formats ?? config.report?.formats ?? [...DEFAULT_FORMATS];
  const acr = acrMeta(formats, profile, loaded);
  return {
    profile,
    pdfDocumentType: config.pdf?.documentType ?? 'non-web',
    pdfMaxBytes: config.pdf?.maxBytes ?? DEFAULT_MAX_PDF_BYTES,
    ...(config.pdf?.fetch !== undefined ? { pdfFetch: config.pdf.fetch } : {}),
    formats,
    ...(acr ? { acr } : {}),
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
