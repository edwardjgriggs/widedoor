import { relative, resolve } from 'node:path';
import {
  CHECKLIST_STATUSES,
  ReviewInputError,
  loadReviews,
  reviewChecklist,
  safeJson,
  type ChecklistItem,
  type ReviewChecklist,
} from '@widedoor/core';
import type { ScanReport } from '@widedoor/report';
import {
  ReportFileError,
  checklistNotes,
  loadConfig,
  readReport,
  recordManualReview,
} from '@widedoor/server';
import type { ReviewArgs, ReviewListArgs, ReviewRecordArgs } from './args.js';
import type { Io } from './main.js';
import { EXIT_ERROR, EXIT_OK } from './policy.js';
import { plural, safeText } from './text.js';

/*
 * widedoor review list and record. Both read widedoor-review/ where a scan
 * does (the folder of --config, else the working folder) through
 * @widedoor/core, which owns the files (recordReview is the only writer;
 * widedoor ui records through it too). Everything printed from a report or a review file goes
 * through safeText, and JSON output escapes the same characters as \u
 * sequences, so a hand-edited file cannot drive the terminal.
 */

const criterionOf = (i: ChecklistItem) =>
  `${i.criterion.type === 'wcag' ? 'WCAG' : '508'} ${i.criterion.id} ${i.criterion.title}`;

function printList(args: ReviewListArgs, state: ReviewChecklist, report: ScanReport, io: Io) {
  const items =
    args.status === 'all' ? state.items : state.items.filter((i) => i.status === args.status);
  // What a scan warns about too (GET /api/checklist lists the same).
  const { notApplied, warnings } = checklistNotes(state, report);
  if (args.format === 'json') {
    io.out(safeJson({ summary: state.summary, items, notApplied, warnings }));
    return;
  }
  const { summary } = state;
  const counts = CHECKLIST_STATUSES.map((s) => `${summary.byStatus[s]} ${s}`).join(', ');
  io.out(`Checklist: ${plural(summary.total, 'item', 'items')} (${counts})`);
  if (summary.unscanned.length > 0)
    io.out(
      `${plural(summary.unscanned.length, 'page or file was', 'pages or files were')} not scanned and need a rescan before review.`,
    );
  if (args.status !== 'all') io.out(`Showing ${items.length} ${args.status}.`);
  const anchor = report.assets[0]?.uri;
  for (const i of items) {
    io.out('');
    io.out(`${i.id}  ${i.status}  ${safeText(criterionOf(i), 300)}`);
    io.out(
      i.asset
        ? `  ${safeText(i.asset.uri, 1000)} (${i.asset.kind})`
        : `  product scope (recorded against ${safeText(anchor ?? 'no asset', 1000)})`,
    );
    if (i.related.length > 0) io.out(`  related: ${i.related.join(', ')}`);
  }
  if (notApplied.length > 0) {
    io.out('');
    io.out(`Records not applied (${notApplied.length}):`);
    for (const r of notApplied)
      io.out(
        `  ${r.id} (${safeText(r.ruleId, 100)} on ${safeText(r.uri, 1000)}): ${r.reason}: ${safeText(r.detail, 1000)}`,
      );
  }
  for (const w of warnings) io.out(`Warning: ${w}.`);
}

async function record(args: ReviewRecordArgs, report: ScanReport, dir: string, io: Io) {
  const { file, record } = await recordManualReview(dir, {
    report,
    item: args.item,
    outcome: args.outcome,
    reviewer: args.reviewer,
    notes: args.notes,
    attach: args.attach.map((a) => resolve(io.cwd, a)),
    overrides: args.overrides,
  });
  io.out(`widedoor: recorded ${args.item} in ${safeText(relative(io.cwd, file), 1000)}`);
  io.out(`  record ${record.id} for ${safeText(record.asset.uri, 1000)} (${record.asset.kind})`);
  const overrides = 'review' in record ? (record.review.overrides ?? []) : [];
  if (overrides.length > 0) io.out(`  overrides: ${overrides.join(', ')}`);
}

/** Runs widedoor review list or record; returns the exit code. ConfigError reaches main. */
export async function runReview(args: ReviewArgs, io: Io): Promise<number> {
  let report: ScanReport;
  try {
    report = readReport(resolve(io.cwd, args.report));
  } catch (e) {
    if (!(e instanceof ReportFileError)) throw e;
    io.err(`widedoor: ${safeText(args.report, 1000)} cannot be used: ${safeText(e.message, 1000)}`);
    return EXIT_ERROR;
  }
  // The same folder a scan reads: the config's, else the working folder.
  const dir = args.config !== undefined ? loadConfig(resolve(io.cwd, args.config)).dir : io.cwd;
  try {
    if (args.action === 'list') {
      const { reviews } = await loadReviews(dir);
      printList(args, reviewChecklist(report, reviews), report, io);
    } else await record(args, report, dir, io);
    return EXIT_OK;
  } catch (e) {
    if (!(e instanceof ReviewInputError)) throw e;
    io.err(`widedoor: ${safeText(e.message, 1000)}`);
    return EXIT_ERROR;
  }
}
