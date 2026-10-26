import { currentHashes, isCurrentRecord, type Impact } from '@widedoor/core';
import { NO_OVERRIDES, overriddenFails, type ScanReport } from '@widedoor/report';
import type { FailOn } from './args.js';
import { plural } from './text.js';

/*
 * Exit policy (ledger rulings, Task 1.4 and the Phase 1 final wave): 2 when
 * any in-scope asset could not be scanned, when the page cap left listed
 * pages (or sitemap pages without a crawl) unscanned, or when nothing was
 * scanned at all; 1 when a current fail record has an impact at or above the
 * threshold; 0 otherwise. Needs-review never counts, nor does an automated
 * fail a reviewer set aside as a false positive (overriddenFails) unless
 * the run ignores overrides, and a crawl stopped by the page cap is a scope
 * gap, not an error.
 */

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_ERROR = 2;

const RANK: Record<Impact, number> = { minor: 1, moderate: 2, serious: 3, critical: 4 };

export interface ExitDecision {
  code: 0 | 1 | 2;
  reason: string;
}

/** Whether a fail record trips the threshold. A fail with no impact counts, so an unrated failure never passes CI silently. */
export function tripsThreshold(impact: Impact | undefined, failOn: FailOn): boolean {
  if (failOn === 'none') return false;
  return impact === undefined || RANK[impact] >= RANK[failOn];
}

/** What the gate reads of a report; without a roll-up nothing is overridden. */
export type GateReport = Pick<ScanReport, 'findings' | 'assets'> &
  Partial<Pick<ScanReport, 'rollup'>>;

/**
 * The fail records that count. A manual record counts only while its review
 * still matches the asset's current content hash (an expired review no longer
 * describes the asset; the roll-up lists it as expired). An automated fail
 * the roll-up lists as overridden in every criterion it counts in does not,
 * unless ignoreOverrides is set (the review files are not trusted).
 */
export function countingFails(report: GateReport, ignoreOverrides = false): ScanReport['findings'] {
  const hashes = currentHashes(report.assets);
  const overridden =
    report.rollup && !ignoreOverrides ? overriddenFails({ rollup: report.rollup }) : NO_OVERRIDES;
  return report.findings.filter(
    (f) => f.outcome === 'fail' && isCurrentRecord(f, hashes) && !overridden(f),
  );
}

export interface GateOptions {
  /** Count automated fails that review records override (--ignore-overrides). */
  ignoreOverrides?: boolean;
}

export interface ScopeCap {
  /** Listed pages (and sitemap pages without a crawl) the page cap left unscanned. */
  unscannedListed: number;
  maxPages?: number;
  /** The setting to raise. */
  maxPagesSetting?: 'web.crawl.maxPages' | 'web.maxPages' | 'default';
}

export function exitDecision(
  report: GateReport & Pick<ScanReport, 'errors' | 'skipped'>,
  failOn: FailOn,
  cap: ScopeCap = { unscannedListed: 0 },
  options: GateOptions = {},
): ExitDecision {
  if (report.errors.length > 0)
    return {
      code: EXIT_ERROR,
      reason: `${plural(report.errors.length, 'scan error', 'scan errors')}: part of the scope was not scanned`,
    };
  if (cap.unscannedListed > 0) {
    const setting =
      cap.maxPagesSetting === 'web.crawl.maxPages' ? 'web.crawl.maxPages' : 'web.maxPages';
    return {
      code: EXIT_ERROR,
      reason: `${plural(cap.unscannedListed, 'listed page was', 'listed pages were')} not scanned: the page limit${cap.maxPages !== undefined ? ` (${cap.maxPages})` : ''} was reached; raise ${setting} in widedoor.config.yaml`,
    };
  }
  // Skipped pages alone (a PDF URL, an off-origin redirect) are not a scan.
  if (report.assets.length === 0) return { code: EXIT_ERROR, reason: 'nothing was scanned' };
  const fails = countingFails(report, options.ignoreOverrides).filter((f) =>
    tripsThreshold(f.impact, failOn),
  );
  if (failOn === 'none')
    return { code: EXIT_OK, reason: 'the fail threshold is off (--fail-on none)' };
  if (fails.length > 0)
    return {
      code: EXIT_FAIL,
      reason: `${plural(fails.length, 'failed check', 'failed checks')} at or above ${failOn}${options.ignoreOverrides ? ' (review overrides ignored)' : ''}`,
    };
  return { code: EXIT_OK, reason: `no failed check at or above ${failOn}` };
}
