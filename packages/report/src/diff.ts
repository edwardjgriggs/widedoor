import { z } from 'zod';
import {
  CONFORMANCE_LEVELS,
  PROFILE_IDS,
  STANDARD_IDS,
  currentHashes,
  isCurrentRecord,
  type Finding,
} from '@widedoor/core/browser';
import { knownUris, ordinal, type ScanReport } from './model.js';
import { overriddenFails } from './overrides.js';

/*
 * Two reports compared: which fail and needs-review records are new, fixed
 * or unchanged, and which criteria changed level. A record counts while it
 * is current and not overridden, keyed by finding id and asset uri. A
 * manual record current in one report and expired in the other is not
 * compared (review-expired); one expired in both is left out. Only records for an asset scanned in both
 * reports are compared: a page that disappeared, errored or is new gives
 * no fixed and no new entries, only not-compared ones. Criteria are compared
 * per standard view when both reports used the same profile. Every list is
 * sorted, so the same inputs give the same bytes. No Node built-ins.
 */

const nonEmpty = z.string().min(1);
const OUTCOMES = ['fail', 'needs-review'] as const;

export const DIFF_NOT_COMPARED_FINDING_REASONS = [
  'missing-before',
  'missing-after',
  'not-scanned-before',
  'not-scanned-after',
  'review-expired',
] as const;
export const DIFF_NOT_COMPARED_CRITERION_REASONS = [
  'profile-mismatch',
  'view-missing',
  'criterion-missing',
] as const;

const entry = {
  id: nonEmpty,
  uri: nonEmpty,
  ruleId: nonEmpty,
  outcome: z.enum(OUTCOMES),
};

export const DiffFindingSchema = z.strictObject({
  ...entry,
  /** Unchanged entries whose outcome moved between fail and needs-review: the before outcome. */
  beforeOutcome: z.enum(OUTCOMES).optional(),
  /** Fixed entries that are still reported but a reviewer set aside in after. */
  fixedBy: z.literal('override').optional(),
});
export type DiffFinding = z.infer<typeof DiffFindingSchema>;

export const DiffNotComparedFindingSchema = z.strictObject({
  ...entry,
  /**
   * Which report lacks the asset, and whether it is absent or listed but not
   * scanned; or review-expired, a manual record current in one report only.
   */
  reason: z.enum(DIFF_NOT_COMPARED_FINDING_REASONS),
});
export type DiffNotComparedFinding = z.infer<typeof DiffNotComparedFindingSchema>;

const side = z.strictObject({
  startedAt: z.iso.datetime(),
  profile: z.strictObject({
    id: z.enum(PROFILE_IDS),
    pdfDocumentType: z.enum(['non-web', 'web']),
  }),
});

export const ReportDiffSchema = z.strictObject({
  schemaVersion: z.literal(1),
  before: side,
  after: side,
  findings: z.strictObject({
    new: z.array(DiffFindingSchema),
    fixed: z.array(DiffFindingSchema),
    unchanged: z.array(DiffFindingSchema),
    notCompared: z.array(DiffNotComparedFindingSchema),
  }),
  criteria: z.strictObject({
    changed: z.array(
      z.strictObject({
        standard: z.enum(STANDARD_IDS),
        id: nonEmpty,
        before: z.enum(CONFORMANCE_LEVELS),
        after: z.enum(CONFORMANCE_LEVELS),
      }),
    ),
    notCompared: z.array(
      z.strictObject({
        standard: z.enum(STANDARD_IDS),
        id: nonEmpty,
        reason: z.enum(DIFF_NOT_COMPARED_CRITERION_REASONS),
      }),
    ),
  }),
});
export type ReportDiff = z.infer<typeof ReportDiffSchema>;

type Entry = Pick<DiffFinding, 'id' | 'uri' | 'ruleId' | 'outcome'>;

const key = (uri: string, id: string) => `${uri}\u0000${id}`;

const toEntry = (f: Finding): Entry => ({
  id: f.id,
  uri: f.asset.uri,
  ruleId: f.source.ruleId,
  outcome: f.outcome as Entry['outcome'],
});

/** Uris of the assets a report scanned: listed in assets, and not in errors or skipped. */
function scannedUris(r: ScanReport): Set<string> {
  const unscanned = new Set([...r.errors.map((e) => e.uri), ...r.skipped.map((s) => s.uri)]);
  return new Set(r.assets.map((a) => a.uri).filter((uri) => !unscanned.has(uri)));
}

/**
 * The records a report is compared on, by uri and id. Current fail and
 * needs-review records are deduped first, one per key (a fail wins over a
 * needs-review); a kept record that is an overridden fail goes to
 * overriddenKeys instead of the set. expiredKeys holds the keys of manual
 * records, of any outcome, that are no longer current.
 */
function comparisonSet(r: ScanReport) {
  const hashes = currentHashes(r.assets);
  const overridden = overriddenFails(r);
  const kept = new Map<string, Finding>();
  const expiredKeys = new Set<string>();
  for (const f of r.findings) {
    const k = key(f.asset.uri, f.id);
    if (!isCurrentRecord(f, hashes)) {
      expiredKeys.add(k);
      continue;
    }
    if (f.outcome !== 'fail' && f.outcome !== 'needs-review') continue;
    const seen = kept.get(k);
    if (!seen || (seen.outcome === 'needs-review' && f.outcome === 'fail')) kept.set(k, f);
  }
  const set = new Map<string, Entry>();
  const overriddenKeys = new Set<string>();
  for (const [k, f] of kept)
    if (overridden(f)) overriddenKeys.add(k);
    else set.set(k, toEntry(f));
  return { set, overriddenKeys, expiredKeys };
}

const byUriThenId = (a: Entry, b: Entry) => ordinal(a.uri, b.uri) || ordinal(a.id, b.id);
const byStandardThenId = (
  a: { standard: string; id: string },
  b: { standard: string; id: string },
) => ordinal(a.standard, b.standard) || ordinal(a.id, b.id);

function diffFindings(before: ScanReport, after: ScanReport): ReportDiff['findings'] {
  const scanned = { before: scannedUris(before), after: scannedUris(after) };
  const known = { before: knownUris(before), after: knownUris(after) };
  const b = comparisonSet(before);
  const a = comparisonSet(after);
  const out: ReportDiff['findings'] = { new: [], fixed: [], unchanged: [], notCompared: [] };
  for (const k of new Set([...b.set.keys(), ...a.set.keys()])) {
    const was = b.set.get(k);
    const is = a.set.get(k);
    const shown = (is ?? was) as Entry;
    const { uri } = shown;
    if (!scanned.before.has(uri) || !scanned.after.has(uri)) {
      const where = !scanned.before.has(uri) ? 'before' : 'after';
      const state = known[where].has(uri) ? 'not-scanned' : 'missing';
      out.notCompared.push({ ...shown, reason: `${state}-${where}` });
    } else if ((!was && b.expiredKeys.has(k)) || (!is && a.expiredKeys.has(k)))
      // Current in one report, a stale review in the other: nothing says what changed.
      out.notCompared.push({ ...shown, reason: 'review-expired' });
    else if (was && is)
      out.unchanged.push(was.outcome === is.outcome ? is : { ...is, beforeOutcome: was.outcome });
    else if (is) out.new.push(is);
    // Set aside by a reviewer in after: only a fail is fixed by the override.
    else if (was)
      out.fixed.push(
        was.outcome === 'fail' && a.overriddenKeys.has(k) ? { ...was, fixedBy: 'override' } : was,
      );
  }
  out.new.sort(byUriThenId);
  out.fixed.sort(byUriThenId);
  out.unchanged.sort(byUriThenId);
  out.notCompared.sort(byUriThenId);
  return out;
}

const views = (r: ScanReport) =>
  new Map(r.rollup.standards.map((s) => [s.standard, new Map(s.criteria.map((c) => [c.id, c]))]));

function diffCriteria(before: ScanReport, after: ScanReport): ReportDiff['criteria'] {
  const out: ReportDiff['criteria'] = { changed: [], notCompared: [] };
  const b = views(before);
  const a = views(after);
  const mismatch =
    before.profile.id !== after.profile.id ||
    before.profile.pdfDocumentType !== after.profile.pdfDocumentType;
  for (const standard of STANDARD_IDS) {
    const was = b.get(standard);
    const is = a.get(standard);
    const ids = new Set([...(was?.keys() ?? []), ...(is?.keys() ?? [])]);
    for (const id of ids) {
      const then = was?.get(id);
      const now = is?.get(id);
      if (mismatch) out.notCompared.push({ standard, id, reason: 'profile-mismatch' });
      else if (!was || !is) out.notCompared.push({ standard, id, reason: 'view-missing' });
      else if (!then || !now) out.notCompared.push({ standard, id, reason: 'criterion-missing' });
      else if (then.level !== now.level)
        out.changed.push({ standard, id, before: then.level, after: now.level });
    }
  }
  out.changed.sort(byStandardThenId);
  out.notCompared.sort(byStandardThenId);
  return out;
}

const sideOf = (r: ScanReport): ReportDiff['before'] => ({
  startedAt: r.startedAt,
  profile: { id: r.profile.id, pdfDocumentType: r.profile.pdfDocumentType },
});

/** Compares two reports (validated with parseJsonReport or built by buildScanReport). */
export function diffReports(before: ScanReport, after: ScanReport): ReportDiff {
  return {
    schemaVersion: 1,
    before: sideOf(before),
    after: sideOf(after),
    findings: diffFindings(before, after),
    criteria: diffCriteria(before, after),
  };
}
