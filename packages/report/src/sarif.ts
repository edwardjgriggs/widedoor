import {
  currentHashes,
  isCurrentRecord,
  loadStandardsData,
  type Finding,
  type Impact,
  type StandardsData,
} from '@widedoor/core';
import { axeRuleUrl, understandingUrl } from './links.js';
import { ordinal, type ScanReport } from './model.js';
import { loadPlainData, plainFor, type PlainData } from './plain.js';

/*
 * SARIF 2.1.0 for developer tooling such as GitHub code scanning: one run,
 * one result per current fail record (an expired manual review is not a
 * result), one rule per engine and rule id. Scan errors are error-level tool
 * notifications; skipped pages and scope gaps are note-level ones, and
 * run.properties.scopeComplete says whether anything was left out. Web results
 * carry the page URL and a logical location (the CSS selector); PDF results
 * carry the file and, when known, the page in the physical location's
 * properties (SARIF has no page field) and the tag path as a logical location.
 */

export const SARIF_SCHEMA_URI =
  'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';

export interface SarifOptions {
  plain?: PlainData;
  data?: StandardsData;
}

type Level = 'error' | 'warning' | 'note';

const LEVEL: Record<Impact, Level> = {
  critical: 'error',
  serious: 'error',
  moderate: 'warning',
  minor: 'note',
};

/** A fail with no impact is an error, as it trips the exit gate at every threshold. */
const levelOf = (impact: Impact | undefined): Level => (impact ? LEVEL[impact] : 'error');

/** Skipped pages listed as notifications at most; the rest are counted in one more. */
export const MAX_SKIPPED_NOTIFICATIONS = 20;

/** A SARIF artifact URI: http(s) and file URLs normalized, paths as file URLs or encoded relative references. */
export function artifactUri(uri: string): string {
  // The URL parser percent-encodes what a URI may not hold (quotes, angle brackets, spaces).
  if (/^(?:https?|file):/i.test(uri) && URL.canParse(uri)) return new URL(uri).href;
  const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/');
  const path = uri.replace(/\\/g, '/');
  // The same on every OS: a Windows drive path and a POSIX absolute path both become file URLs.
  if (/^[A-Za-z]:\//.test(path)) return `file:///${path.slice(0, 2)}${encode(path.slice(2))}`;
  if (path.startsWith('/')) return `file://${encode(path)}`;
  return encode(path);
}

interface Rule {
  id: string;
  first: Finding;
  wcag: Set<string>;
  section508: Set<string>;
  worst: Level;
}

/**
 * Plain text for a SARIF message string. SARIF 2.1.0 reads {n} as a placeholder
 * (3.11.5) and [text](target) as an embedded link (3.11.6) in message text, so
 * literal braces are doubled and brackets and backslashes are escaped. Scanned
 * strings (selectors, tag paths, error messages) pass through this; the full
 * snippet stays unescaped in properties, which no consumer interprets.
 */
export const sarifText = (text: string) =>
  text.replace(/[{}]/g, (c) => c + c).replace(/[[\]\\]/g, (c) => `\\${c}`);

/** A uri a notification may point at: http(s), file, or a plain relative path with no scheme. */
const locatable = (uri: string) =>
  uri !== '' &&
  (/^(?:https?|file):/i.test(uri) ||
    !/^[a-z][a-z0-9+.-]*:/i.test(uri) ||
    /^[a-z]:[\\/]/i.test(uri));

const severity = (l: Level) => ['error', 'warning', 'note'].indexOf(l);

function where(f: Finding): Record<string, unknown> {
  const physical = { artifactLocation: { uri: artifactUri(f.asset.uri) } };
  const loc = f.location;
  if ('selector' in loc)
    return {
      physicalLocation: physical,
      logicalLocations: [{ fullyQualifiedName: loc.selector, kind: 'element' }],
    };
  return {
    physicalLocation: {
      ...physical,
      ...(loc.page !== undefined ? { properties: { page: loc.page } } : {}),
    },
    ...(loc.structPath !== undefined
      ? { logicalLocations: [{ fullyQualifiedName: loc.structPath, kind: 'element' }] }
      : {}),
  };
}

const locationText = (f: Finding) => {
  const loc = f.location;
  if ('selector' in loc) return `element ${loc.selector}`;
  if (loc.page !== undefined) return `page ${loc.page}`;
  return loc.structPath !== undefined ? `tag ${loc.structPath}` : 'the whole file';
};

/** Builds the SARIF log object. Serialize it with JSON.stringify. */
export function toSarif(report: ScanReport, options: SarifOptions = {}): Record<string, unknown> {
  const plain = options.plain ?? loadPlainData();
  const data = options.data ?? loadStandardsData();
  const wcagTitle = new Map(data.wcag.criteria.map((c) => [c.id, c.title]));
  const hashes = currentHashes(report.assets);
  const fails = report.findings.filter((f) => f.outcome === 'fail' && isCurrentRecord(f, hashes));

  const rules = new Map<string, Rule>();
  for (const f of fails) {
    const id = `${f.source.engine}/${f.source.ruleId}`;
    let rule = rules.get(id);
    if (!rule) {
      rule = { id, first: f, wcag: new Set(), section508: new Set(), worst: 'note' };
      rules.set(id, rule);
    }
    for (const sc of f.criteria.wcag ?? []) rule.wcag.add(sc);
    for (const p of f.criteria.section508 ?? []) rule.section508.add(p);
    const level = levelOf(f.impact);
    if (severity(level) < severity(rule.worst)) rule.worst = level;
  }
  const ordered = [...rules.values()].sort((a, b) => ordinal(a.id, b.id));
  const index = new Map(ordered.map((r, i) => [r.id, i]));

  const descriptors = ordered.map((r) => {
    const { engine, ruleId, engineVersion } = r.first.source;
    const p = plainFor(r.first, plain);
    const wcag = [...r.wcag];
    const section508 = [...r.section508];
    const firstTitle = wcag.map((sc) => wcagTitle.get(sc)).find((t) => t !== undefined);
    const helpUri =
      engine === 'axe-core'
        ? axeRuleUrl(ruleId, engineVersion)
        : firstTitle !== undefined
          ? understandingUrl(firstTitle)
          : undefined;
    const name = p?.what ?? `${engine} rule ${ruleId}`;
    return {
      id: r.id,
      name: ruleId,
      shortDescription: { text: sarifText(name) },
      fullDescription: { text: sarifText(p ? `${p.what} ${p.who}` : name) },
      help: { text: sarifText(p?.fix ?? `See the ${engine} documentation for rule ${ruleId}.`) },
      ...(helpUri ? { helpUri } : {}),
      defaultConfiguration: { level: r.worst },
      properties: {
        tags: ['accessibility', ...wcag.map((sc) => `WCAG ${sc}`)],
        engine,
        wcag,
        ...(section508.length > 0 ? { section508 } : {}),
      },
    };
  });

  const results = fails.map((f) => {
    const id = `${f.source.engine}/${f.source.ruleId}`;
    const p = plainFor(f, plain);
    return {
      ruleId: id,
      ruleIndex: index.get(id),
      kind: 'fail',
      level: levelOf(f.impact),
      message: {
        text: sarifText(
          `${p?.what ?? `${f.source.engine} rule ${f.source.ruleId} failed.`} At ${locationText(f)}.`,
        ),
      },
      locations: [where(f)],
      // Not unique: records can share a finding id. It is the stable identity of the issue across scans.
      partialFingerprints: { 'widedoorFindingId/v1': f.id },
      properties: {
        widedoorFindingId: f.id,
        engineVersion: f.source.engineVersion,
        contentHash: f.asset.contentHash,
        ...(f.impact ? { impact: f.impact } : {}),
        ...(f.evidence?.snippet !== undefined ? { snippet: f.evidence.snippet } : {}),
        ...(f.evidence?.viewport ? { viewport: f.evidence.viewport } : {}),
      },
    };
  });

  // A uri that is not a location (javascript:, mailto: and the like) goes in the message only.
  const notifications = report.errors.map((e) => ({
    level: 'error',
    message: {
      text: sarifText(`${e.code}: ${e.message}${locatable(e.uri) ? '' : ` (${e.uri})`}`),
    },
    ...(locatable(e.uri)
      ? { locations: [{ physicalLocation: { artifactLocation: { uri: artifactUri(e.uri) } } }] }
      : {}),
    properties: { code: e.code, uri: e.uri, ...(e.engine ? { engine: e.engine } : {}) },
  }));
  const skips: { level: Level; message: { text: string }; properties: Record<string, unknown> }[] =
    report.skipped.slice(0, MAX_SKIPPED_NOTIFICATIONS).map((s) => ({
      level: 'note',
      message: {
        text: sarifText(
          `not scanned (${s.reason}): ${s.uri}${s.finalUri !== s.uri ? ` (went to ${s.finalUri})` : ''}`,
        ),
      },
      properties: { code: s.reason, uri: s.uri, finalUri: s.finalUri },
    }));
  const moreSkips = report.skipped.length - skips.length;
  if (moreSkips > 0)
    skips.push({
      level: 'note',
      message: {
        text: `${moreSkips} more skipped page(s) or file(s) are listed in the JSON report.`,
      },
      properties: { code: 'skipped-more', count: moreSkips },
    });
  const gaps = (report.scopeGaps ?? []).map((gap) => ({
    level: 'note',
    message: { text: sarifText(`scope incomplete: ${gap}`) },
    properties: { code: 'scope-gap' },
  }));
  const allNotifications = [...notifications, ...skips, ...gaps];
  const scopeComplete =
    report.errors.length === 0 &&
    report.skipped.length === 0 &&
    (report.scopeGaps ?? []).length === 0 &&
    !report.scope.web?.truncated;
  const extensions = report.engines.map((e) => ({
    name: e.name === 'verapdf' ? 'veraPDF' : e.name === 'widedoor' ? 'Widedoor PDF checks' : e.name,
    version: e.version,
  }));

  return {
    $schema: SARIF_SCHEMA_URI,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Widedoor',
            version: report.tool.version,
            rules: descriptors,
          },
          extensions,
        },
        invocations: [
          {
            executionSuccessful: report.errors.length === 0,
            startTimeUtc: report.startedAt,
            endTimeUtc: report.finishedAt,
            ...(allNotifications.length > 0
              ? { toolExecutionNotifications: allNotifications }
              : {}),
          },
        ],
        results,
        properties: {
          disclaimer: report.disclaimer,
          profile: report.profile.id,
          pdfDocumentType: report.profile.pdfDocumentType,
          engines: report.engines,
          scopeComplete,
        },
      },
    ],
  };
}

export const serializeSarif = (report: ScanReport, options?: SarifOptions) =>
  `${JSON.stringify(toSarif(report, options), null, 2)}\n`;
