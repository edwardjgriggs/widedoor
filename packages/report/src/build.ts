import {
  checklistSummary,
  decidingRulesFrom,
  errataFrom,
  loadStandardsData,
  rollup,
  type Asset,
  type Finding,
  type Profile,
  type StandardsData,
} from '@widedoor/core';
import {
  DISCLAIMER,
  SCOPE_ERROR_CODES,
  ScanReportCheckedSchema,
  type EngineRun,
  type Informational,
  type ReportScope,
  type RunError,
  type ScanReport,
  type SkippedAsset,
} from './model.js';
import { overrideEntries } from './overrides.js';
import { WIDEDOOR_VERSION } from './version.js';

/*
 * Assembles a ScanReport from adapter results. The inputs are structural, so
 * this package does not depend on the adapters: a WebScanResult from
 * @widedoor/web and a PdfScanResult from @widedoor/pdf fit them as they are.
 */

export interface WebRunInput {
  engine: { name: 'axe-core'; version: string };
  assets: readonly Asset[];
  findings: readonly Finding[];
  errors: readonly { uri: string; code: string; message: string }[];
  skipped: readonly { url: string; finalUrl: string; reason: string }[];
  warnings: readonly string[];
  truncated: boolean;
  /** Scope gaps the web run found (a sitemap read in part, links past a cap). */
  scopeGaps?: readonly string[];
  /** Per-page results; only the document title is read from them. */
  pages?: readonly { asset?: Asset; title?: string }[];
}

export interface PdfRunInput {
  engines: {
    verapdf: { version: string; runner: string | null; description: string | null };
    widedoor: { version: string };
  };
  assets: readonly Asset[];
  findings: readonly Finding[];
  informational: readonly Informational[];
  errors: readonly {
    uri: string;
    code: string;
    engine?: 'verapdf' | 'widedoor';
    message: string;
  }[];
  warnings: readonly string[];
  /** Scope gaps on the PDF side (pdf.include matching nothing). */
  scopeGaps?: readonly string[];
}

export interface BuildReportInput {
  profile: Profile;
  startedAt: Date | string;
  finishedAt: Date | string;
  /** What was asked for. scope.web.truncated is taken from the web run when there is one. */
  scope: ReportScope;
  web?: WebRunInput;
  pdf?: PdfRunInput;
  /** Manual review records (engine "manual"). */
  reviews?: readonly Finding[];
  /** Run warnings beyond the adapters' own (manual review records left out, for example). */
  warnings?: readonly string[];
  /**
   * Mapping data for deciding rules and the errata basis, and the Baseline and manual steps the
   * checklist summary needs; defaults to the data shipped in @widedoor/core.
   */
  data?: Pick<
    StandardsData,
    'axe' | 'verapdf' | 'widedoor' | 'errata' | 'baseline' | 'manualSteps'
  >;
  /** Defaults to WIDEDOOR_VERSION; tests pin it. */
  toolVersion?: string;
}

const iso = (t: Date | string) => (typeof t === 'string' ? t : t.toISOString());

/**
 * Builds and validates a ScanReport. Throws a ZodError if any part is malformed
 * or a record is for an asset the runs do not list (scanned, errored or skipped).
 */
export function buildScanReport(input: BuildReportInput): ScanReport {
  const { web, pdf, profile } = input;
  const engines: EngineRun[] = [];
  if (web) engines.push({ name: 'axe-core', version: web.engine.version });
  if (pdf) {
    const v = pdf.engines.verapdf;
    engines.push({
      name: 'verapdf',
      version: v.version,
      ...(v.runner ? { runner: v.runner } : {}),
      ...(v.description ? { description: v.description } : {}),
    });
    engines.push({ name: 'widedoor', version: pdf.engines.widedoor.version });
  }

  const assets = [...(web?.assets ?? []), ...(pdf?.assets ?? [])];
  const automated = [...(web?.findings ?? []), ...(pdf?.findings ?? [])];
  const reviews = [...(input.reviews ?? [])];
  const errors: RunError[] = [
    ...(web?.errors ?? []).map((e) => ({ kind: 'web' as const, ...e })),
    ...(pdf?.errors ?? []).map((e) => ({ kind: 'pdf' as const, ...e })),
  ];
  const skipped: SkippedAsset[] = (web?.skipped ?? []).map((s) => ({
    uri: s.url,
    finalUri: s.finalUrl,
    reason: s.reason,
  }));
  const scope: ReportScope = {
    ...input.scope,
    ...(input.scope.web && web ? { web: { ...input.scope.web, truncated: web.truncated } } : {}),
  };

  // Every asset in run metadata enters the roll-up: one that errored or was skipped is Not Evaluated.
  const unscanned = [
    ...errors
      .filter((e) => !SCOPE_ERROR_CODES.has(e.code))
      .map((e) => ({ uri: e.uri, kind: e.kind })),
    ...skipped.map((s) => ({ uri: s.uri, kind: 'web' as const })),
  ];
  const scopeGaps = [
    ...errors
      .filter((e) => SCOPE_ERROR_CODES.has(e.code))
      .map((e) => `${e.uri} could not be read (${e.code})`),
    ...(web?.truncated ? ['the page limit stopped the crawl with pages still queued'] : []),
    ...(web?.scopeGaps ?? []),
    ...(pdf?.scopeGaps ?? []),
  ];
  const data = input.data ?? loadStandardsData();
  const result = rollup({
    findings: automated,
    reviews,
    profile,
    assets,
    decidingRules: decidingRulesFrom(data),
    errata: errataFrom(data),
    unscanned,
    scopeGaps,
  });
  // Counts only: the items are built on demand (widedoor review list), never stored.
  const progress = checklistSummary({
    report: {
      assets,
      findings: [...automated, ...reviews],
      rollup: result,
      profile: { id: profile.id },
    },
    data,
  });
  const titles = (web?.pages ?? []).flatMap((p) =>
    p.asset && p.title !== undefined ? [{ uri: p.asset.uri, title: p.title }] : [],
  );

  return ScanReportCheckedSchema.parse({
    schemaVersion: 1,
    tool: { name: 'widedoor', version: input.toolVersion ?? WIDEDOOR_VERSION },
    engines,
    profile: { id: profile.id, pdfDocumentType: profile.pdfDocumentType },
    startedAt: iso(input.startedAt),
    finishedAt: iso(input.finishedAt),
    scope,
    assets,
    titles,
    findings: [...automated, ...reviews],
    informational: [...(pdf?.informational ?? [])],
    errors,
    skipped,
    warnings: [...(web?.warnings ?? []), ...(pdf?.warnings ?? []), ...(input.warnings ?? [])],
    ...(scopeGaps.length > 0 ? { scopeGaps } : {}),
    rollup: result,
    checklist: {
      total: progress.total,
      byStatus: progress.byStatus,
      unscanned: progress.unscanned.length,
    },
    overrides: overrideEntries({ rollup: result, findings: [...automated, ...reviews], assets }),
    disclaimer: DISCLAIMER,
  });
}
