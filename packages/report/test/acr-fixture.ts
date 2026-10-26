import {
  FindingSchema,
  findingId,
  getProfile,
  type Asset,
  type Finding,
  type Location,
  type ProfileId,
} from '@widedoor/core';
import { buildScanReport, type AcrMeta, type ScanReport } from '../src/index.ts';
import { PAYLOAD } from './fixture.ts';

/*
 * Scans for the ACR tests: one web page and one PDF under a Section 508
 * profile. decidedReport adds a current manual pass for every row of the 508
 * view on every asset, so nothing is Not Evaluated and the ACR can be complete.
 */

const hash = (c: string) => `sha256:${c.repeat(64)}`;
export const PAGE: Asset = {
  kind: 'web',
  uri: 'https://example.com/apply',
  contentHash: hash('a'),
};
export const PDF: Asset = { kind: 'pdf', uri: 'docs/form.pdf', contentHash: hash('b') };

export const META: AcrMeta = {
  vendor: { name: 'Example Agency', contact: 'accessibility@example.gov' },
  product: { name: 'Permit portal', version: '2.1', description: 'Online permit applications.' },
  notes: 'Tested on the staging site.',
};

/** U+FFFE and U+FFFF, which XML 1.0 and YAML 1.2 do not allow. */
export const NONCHARACTERS = String.fromCharCode(0xfffe, 0xffff);
/** NONCHARACTERS as safe text writes them. */
export const NONCHARACTERS_SAFE = [0xfffe, 0xffff].map((c) => `\\u${c.toString(16)}`).join('');

/** Vendor, product and notes with a hostile payload and terminal controls in each. */
export const HOSTILE_META: AcrMeta = {
  vendor: { name: `Evil\u001b[31m ${PAYLOAD}`, contact: `x@example.com\nkey: injected` },
  product: {
    name: `Portal${String.fromCharCode(0x202e)} ${PAYLOAD}`,
    description: `Line one\nkey: value ${PAYLOAD}${NONCHARACTERS}`,
  },
  notes: `---\nchapters: {}\n${PAYLOAD}\u0007`,
};

export function automated(
  asset: Asset,
  location: Location,
  engine: 'axe-core' | 'verapdf',
  ruleId: string,
  rest: Partial<Finding>,
): Finding {
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(asset.uri, location, engine, ruleId),
    asset,
    location,
    source: { engine, engineVersion: engine === 'axe-core' ? '4.14.0' : '1.30.3', ruleId },
    criteria: { wcag: ['1.1.1'] },
    outcome: 'fail',
    ...rest,
  });
}

/** A current manual record for one criterion (rule wcag-<sc> or 508-<provision>, page-level location). */
export function manual(
  asset: Asset,
  criterion: { type: 'wcag' | 'section508'; id: string },
  outcome: 'pass' | 'fail' | 'not-applicable',
  review: Record<string, unknown> = {},
): Finding {
  const location: Location = asset.kind === 'web' ? { selector: 'html' } : {};
  const ruleId = `${criterion.type === 'wcag' ? 'wcag' : '508'}-${criterion.id}`;
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(asset.uri, location, 'manual', ruleId),
    asset,
    location,
    source: { engine: 'manual', engineVersion: '0.2.0', ruleId },
    criteria: criterion.type === 'wcag' ? { wcag: [criterion.id] } : { section508: [criterion.id] },
    outcome,
    review: {
      reviewer: 'Ann Lee',
      date: '2026-10-23',
      // What a review file anchors on: a scanned web page's normalized review hash.
      expiresOnChangeOf: asset.reviewHash ?? asset.contentHash,
      ...review,
    },
  });
}

export interface ScanOptions {
  profile?: ProfileId;
  findings?: readonly Finding[];
  reviews?: readonly Finding[];
  assets?: readonly Asset[];
  scopeGaps?: readonly string[];
  webErrors?: { uri: string; code: string; message: string }[];
}

export function acrReport(options: ScanOptions = {}): ScanReport {
  const assets = options.assets ?? [PAGE, PDF];
  const web = assets.filter((a) => a.kind === 'web');
  const pdf = assets.filter((a) => a.kind === 'pdf');
  const findings = options.findings ?? [];
  return buildScanReport({
    profile: getProfile(options.profile ?? '508'),
    startedAt: '2026-10-23T12:00:00.000Z',
    finishedAt: '2026-10-23T12:05:00.000Z',
    toolVersion: '0.0.0',
    scope: {
      ...(web.length > 0 ? { web: { urls: web.map((a) => a.uri), truncated: false } } : {}),
      ...(pdf.length > 0 ? { pdf: { files: pdf.map((a) => a.uri), include: [] } } : {}),
    },
    ...(web.length > 0 || options.webErrors
      ? {
          web: {
            engine: { name: 'axe-core', version: '4.14.0' },
            assets: web,
            findings: findings.filter((f) => f.asset.kind === 'web'),
            errors: options.webErrors ?? [],
            skipped: [],
            warnings: [],
            truncated: false,
            ...(options.scopeGaps ? { scopeGaps: options.scopeGaps } : {}),
          },
        }
      : {}),
    ...(pdf.length > 0
      ? {
          pdf: {
            engines: {
              verapdf: { version: '1.30.3', runner: 'docker', description: null },
              widedoor: { version: '0.0.0' },
            },
            assets: pdf,
            findings: findings.filter((f) => f.asset.kind === 'pdf'),
            informational: [],
            errors: [],
            warnings: [],
          },
        }
      : {}),
    reviews: options.reviews ?? [],
  });
}

/** A second web page, for records that cover some pages but not all. */
export const PAGE2: Asset = {
  kind: 'web',
  uri: 'https://example.com/status',
  contentHash: hash('c'),
};

/** Reviewer notes with markup, a javascript: URL, a bidi override and a control character. */
export const HOSTILE_NOTES = `<b>bold</b> <a href="javascript:alert(3)">x</a> ${PAYLOAD}${String.fromCharCode(0x202e)}\u0007`;
/** HOSTILE_NOTES as safe text writes them. */
export const HOSTILE_NOTES_SAFE = `<b>bold</b> <a href="javascript:alert(3)">x</a> ${PAYLOAD}\\u202e\\x07`;

/**
 * A scan with hostile reviewer notes on both reference rows: a 504.2 N/A on
 * one of two pages (the row stays undecided) and a 602.3 fail (decided).
 */
export const hostileReferenceReport = () =>
  acrReport({
    assets: [PAGE, PAGE2, PDF],
    reviews: [
      manual(PAGE, { type: 'section508', id: '504.2' }, 'not-applicable', {
        notes: HOSTILE_NOTES,
      }),
      manual(PAGE, { type: 'section508', id: '602.3' }, 'fail', { notes: HOSTILE_NOTES }),
    ],
  });

/** Manual passes for every row of the 508 view on every asset (product rows once, on the page). */
export function passEverything(assets: readonly Asset[] = [PAGE, PDF]): Finding[] {
  const view = acrReport({ assets }).rollup.standards.find((s) => s.standard === '508');
  if (!view) throw new Error('no 508 view');
  return view.criteria.flatMap((c) => {
    const criterion = { type: c.type, id: c.id };
    if (c.scope === 'product') return [manual(assets[0] as Asset, criterion, 'pass')];
    return c.assets
      .filter((d) => d.reason !== 'profile-not-applicable')
      .flatMap((d) => {
        const asset = assets.find((a) => a.uri === d.uri);
        return asset ? [manual(asset, criterion, 'pass')] : [];
      });
  });
}

/** Every row of the 508 view decided by a manual pass, on the page and the PDF. */
export const decidedReport = (options: ScanOptions = {}) =>
  acrReport({
    ...options,
    reviews: [...passEverything(options.assets), ...(options.reviews ?? [])],
  });
