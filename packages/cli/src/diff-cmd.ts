import { resolve } from 'node:path';
import { safeJson } from '@widedoor/core';
import { diffReports, ordinal, type ReportDiff, type ScanReport } from '@widedoor/report';
import { ReportFileError, readReport } from '@widedoor/server';
import type { DiffArgs } from './args.js';
import type { Io } from './main.js';
import { EXIT_ERROR, EXIT_FAIL, EXIT_OK } from './policy.js';
import { plural, safeText } from './text.js';

/*
 * widedoor diff: two JSON reports (read as review does, through
 * parseJsonReport) compared by diffReports in @widedoor/report. Uris, rule
 * ids and criterion ids come from the reports, so the text output passes
 * them through safeText and the JSON output escapes the same characters.
 */

/** How many uris the not-compared summary names. */
const SHOWN_URIS = 5;

const REASONS: Record<
  | ReportDiff['findings']['notCompared'][number]['reason']
  | ReportDiff['criteria']['notCompared'][number]['reason'],
  string
> = {
  'missing-before': 'not in before',
  'missing-after': 'not in after',
  'not-scanned-before': 'not scanned in before',
  'not-scanned-after': 'not scanned in after',
  'review-expired': 'a manual review expired in one report',
  'profile-mismatch': 'the profiles differ',
  'view-missing': 'the standard is in one report only',
  'criterion-missing': 'the criterion is in one report only',
};

function byReason(list: readonly { reason: keyof typeof REASONS }[]): string {
  const counts = new Map<keyof typeof REASONS, number>();
  for (const { reason } of list) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => ordinal(a, b))
    .map(([reason, n]) => `${n} ${REASONS[reason]}`)
    .join(', ');
}

const side = (s: ReportDiff['before']) =>
  `${s.startedAt} (${s.profile.id}, PDFs as ${s.profile.pdfDocumentType})`;

const line = (e: ReportDiff['findings']['new'][number]) =>
  `  ${safeText(e.uri, 1000)}  ${safeText(e.ruleId, 100)}  ${e.outcome}${e.fixedBy === 'override' ? ' (override)' : ''}`;

function printText(diff: ReportDiff, io: Io) {
  const { findings, criteria } = diff;
  io.out(`Before: ${side(diff.before)}`);
  io.out(`After:  ${side(diff.after)}`);
  io.out(
    `Results: ${findings.new.length} new, ${findings.fixed.length} fixed, ${findings.unchanged.length} unchanged, ${findings.notCompared.length} not compared`,
  );
  io.out(
    `Criteria: ${criteria.changed.length} changed, ${criteria.notCompared.length} not compared`,
  );
  for (const [title, list] of [
    ['New', findings.new],
    ['Fixed', findings.fixed],
  ] as const) {
    if (list.length === 0) continue;
    io.out('');
    io.out(`${title} (${list.length}):`);
    for (const e of list) io.out(line(e));
  }
  if (criteria.changed.length > 0) {
    io.out('');
    io.out(`Changed criteria (${criteria.changed.length}):`);
    for (const c of criteria.changed)
      io.out(`  ${c.standard} ${safeText(c.id, 100)}: ${c.before} -> ${c.after}`);
  }
  if (findings.notCompared.length === 0 && criteria.notCompared.length === 0) return;
  io.out('');
  io.out('Not compared:');
  if (findings.notCompared.length > 0) {
    io.out(
      `  ${plural(findings.notCompared.length, 'result', 'results')}: ${byReason(findings.notCompared)}`,
    );
    const uris = [...new Set(findings.notCompared.map((e) => e.uri))];
    const more = uris.length > SHOWN_URIS ? `, and ${uris.length - SHOWN_URIS} more` : '';
    io.out(
      `    on ${uris
        .slice(0, SHOWN_URIS)
        .map((u) => safeText(u, 1000))
        .join(', ')}${more}`,
    );
  }
  if (criteria.notCompared.length > 0)
    io.out(
      `  ${plural(criteria.notCompared.length, 'criterion', 'criteria')}: ${byReason(criteria.notCompared)}`,
    );
}

/** Runs widedoor diff; returns the exit code. */
export function runDiff(args: DiffArgs, io: Io): number {
  const reports: ScanReport[] = [];
  for (const file of [args.before, args.after]) {
    try {
      reports.push(readReport(resolve(io.cwd, file)));
    } catch (e) {
      if (!(e instanceof ReportFileError)) throw e;
      io.err(`widedoor: ${safeText(file, 1000)} cannot be used: ${safeText(e.message, 1000)}`);
      return EXIT_ERROR;
    }
  }
  const diff = diffReports(reports[0] as ScanReport, reports[1] as ScanReport);
  if (args.format === 'json') io.out(safeJson(diff));
  else printText(diff, io);
  const newFails = diff.findings.new.filter((e) => e.outcome === 'fail').length;
  if (args.failOnNew && newFails > 0) {
    io.err(
      `widedoor: ${plural(newFails, 'new failed check', 'new failed checks')} (--fail-on-new)`,
    );
    return EXIT_FAIL;
  }
  return EXIT_OK;
}
