import { CHECKLIST_STATUSES } from '@widedoor/core';
import {
  IMPACT_ORDER,
  levelsText,
  notEvaluated,
  summarize,
  type ScanReport,
} from '@widedoor/report';
import type { FailOn } from './args.js';
import type { ExitDecision } from './policy.js';
import { plural, safeText } from './text.js';

export interface SummaryIo {
  out(line: string): void;
}

const MAX_LISTED = 20;

/** Prints the console summary. Every scanned string goes through safeText. */
export function printSummary(
  report: ScanReport,
  run: { written: readonly string[]; decision: ExitDecision; failOn: FailOn },
  io: SummaryIo,
): void {
  const s = summarize(report);
  const web = report.assets.filter((a) => a.kind === 'web').length;
  const lines: string[] = [];
  lines.push(
    `Scanned ${plural(s.assets, 'page or file', 'pages and files')} (${web} web, ${s.assets - web} PDF); ` +
      `${plural(s.errors, 'scan error', 'scan errors')}, ${s.skipped} skipped.`,
  );
  const o = s.outcomes;
  lines.push(
    `Results: ${o.fail} fail, ${o['needs-review']} needs review, ${o.pass} pass, ` +
      `${o['not-applicable']} not applicable, ${o['not-tested']} not tested.`,
  );
  const impacts = (counts: Record<string, number>) =>
    IMPACT_ORDER.filter((i) => i !== 'unrated' || counts[i]! > 0)
      .map((i) => `${counts[i]} ${i}`)
      .join(', ');
  lines.push(`Failed checks by impact: ${impacts(s.failsByImpact)}.`);
  lines.push(`Needs review by impact: ${impacts(s.needsReviewByImpact)}.`);
  if (s.overridden > 0)
    lines.push(
      `Set aside by a reviewer: ${plural(s.overridden, 'automated fail', 'automated fails')} (overridden as false positives; not counted as fails).`,
    );
  // Says which Supports rest on the errata basis, so 4.1.1 never reads as tested.
  for (const c of s.criteria) lines.push(`Criteria, ${safeText(levelsText(c), 1000)}`);
  if (report.checklist) {
    const c = report.checklist;
    const counts = CHECKLIST_STATUSES.map((st) => `${c.byStatus[st]} ${st}`).join(', ');
    lines.push(
      `Manual review checklist: ${plural(c.total, 'item', 'items')} (${counts}); widedoor review list shows them.`,
    );
    if (c.unscanned > 0)
      lines.push(
        `Manual review: ${plural(c.unscanned, 'page or file was', 'pages or files were')} not scanned and need a rescan before review.`,
      );
  }

  const gaps = notEvaluated(report);
  if (gaps.length > 0) {
    const ids = gaps.slice(0, MAX_LISTED).map((g) => g.id);
    const more = gaps.length > MAX_LISTED ? `, and ${gaps.length - MAX_LISTED} more` : '';
    lines.push(
      `Criteria Not Evaluated: ${gaps.length} (${safeText(ids.join(', '))}${more}). They need a manual review or a scan of every page and file.`,
    );
  } else {
    lines.push('Criteria Not Evaluated: none.');
  }

  // One line per distinct problem, so a missing veraPDF reads once, not once per file.
  const groups = new Map<string, ScanReport['errors']>();
  for (const e of report.errors) {
    const key = `${e.code}\u0000${e.message}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  for (const [first, ...rest] of groups.values()) {
    if (!first) continue;
    const others = rest.length > 0 ? ` (and ${plural(rest.length, 'other', 'others')})` : '';
    lines.push(
      `Scan error: ${safeText(first.uri, 300)}${others}: ${safeText(first.code, 60)}: ${safeText(first.message, 300)}`,
    );
  }
  for (const k of report.skipped.slice(0, MAX_LISTED))
    lines.push(`Skipped: ${safeText(k.uri, 300)} (${safeText(k.reason, 60)})`);
  if (report.skipped.length > MAX_LISTED)
    lines.push(`Skipped: ${report.skipped.length - MAX_LISTED} more, listed in the JSON report.`);
  if (report.scope.web?.truncated)
    lines.push('Scope gap: the page limit stopped the crawl with pages still queued.');
  for (const w of report.warnings) lines.push(`Warning: ${safeText(w, 300)}`);

  lines.push('Reports:');
  for (const file of run.written) lines.push(`  ${safeText(file, 1000)}`);
  lines.push(`Exit ${run.decision.code}: ${run.decision.reason}.`);
  for (const line of lines) io.out(line);
}
