import {
  keptFailWarning,
  outOfProfileWarning,
  plural,
  safeText,
  screenItemless,
  screenReviews,
  type Finding,
  type NotApplied,
  type ProfileId,
  type ReviewScope,
} from '@widedoor/core';
import type { ScanReport } from '@widedoor/report';

/*
 * Which manual review records a scan uses, and the warnings for the rest:
 * the same screen as widedoor review list (screenReviews: records for assets
 * outside the run, of the wrong kind, with a foreign override or replaced by
 * a newer one are left out), then the no-item rule (ruling 9, fix round 1):
 * a manual fail on a profile row with no checklist item is kept with a
 * warning; any other record with no item, and any record for a criterion
 * the profile does not have, is left out. The warnings go to stderr and into
 * the report, capped like the console lines.
 */

/** Left-out review records named one by one before the rest are counted. */
const MAX_REVIEW_WARNINGS = 20;

/** At most MAX_REVIEW_WARNINGS lines, then one that counts the rest. */
function capped(lines: readonly string[], more: (n: number) => string): string[] {
  return lines.length > MAX_REVIEW_WARNINGS
    ? [...lines.slice(0, MAX_REVIEW_WARNINGS), more(lines.length - MAX_REVIEW_WARNINGS)]
    : [...lines];
}

/**
 * Warning lines for left-out review records and kept manual fails; they hold
 * review-file content, so it goes through safeText (core escapes the
 * out-of-profile and kept-fail lines itself).
 */
export function reviewWarnings(
  notApplied: readonly NotApplied[],
  kept: readonly Finding[],
  profile: ProfileId,
): string[] {
  const left = notApplied.map(({ record, reason, detail }) =>
    reason === 'out-of-profile'
      ? outOfProfileWarning(record, profile)
      : `manual review record ${record.id} (${safeText(record.source.ruleId, 100)}) was left out: ${reason}: ${safeText(detail, 1000)}`,
  );
  return [
    ...capped(
      left,
      (n) =>
        `${plural(n, 'more manual review record was', 'more manual review records were')} left out; run widedoor review list for all of them`,
    ),
    ...capped(
      kept.map(keptFailWarning),
      (n) =>
        `${plural(n, 'more manual fail', 'more manual fails')} with no checklist item ${n === 1 ? 'was' : 'were'} kept; run widedoor review list for all of them`,
    ),
  ];
}

/**
 * Screens the records for a run and builds its report with the ones that
 * count. build is called once, or twice when the no-item rule changes
 * anything (rare): the rule needs the report's roll-up.
 */
export function screenScanReviews(
  reviews: readonly Finding[],
  scope: ReviewScope,
  profile: ProfileId,
  build: (applied: readonly Finding[], warnings: readonly string[]) => ScanReport,
): { report: ScanReport; warnings: string[] } {
  const screened = screenReviews(reviews, scope);
  let warnings = reviewWarnings(screened.notApplied, [], profile);
  let report = build(screened.applied, warnings);
  const itemless = screenItemless(report, screened.applied);
  if (itemless.kept.length > 0 || itemless.dropped.length > 0) {
    const leftOut = new Map(
      [...screened.notApplied, ...itemless.dropped].map((n) => [n.record, n]),
    );
    const notApplied = reviews.flatMap((f) => {
      const n = leftOut.get(f);
      return n ? [n] : [];
    });
    warnings = reviewWarnings(notApplied, itemless.kept, profile);
    report = build(itemless.applied, warnings);
  }
  return { report, warnings };
}
