import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ATTACHMENT_DIR,
  REVIEW_DIR,
  keptFailWarning,
  manualRuleId,
  outOfProfileWarning,
  recordReview,
  type ChecklistItem,
  type Finding,
  type RecordInput,
  type ReviewChecklist,
} from '@widedoor/core';
import { WIDEDOOR_VERSION, type ScanReport } from '@widedoor/report';

/**
 * A cheap fingerprint of widedoor-review/ under dir: each entry of the
 * folder and of attachments/ with its type, size and modification time,
 * sorted. It changes whenever a record or an attachment is written, by
 * widedoor review record or by the server. Never throws; a missing folder
 * has an empty fingerprint.
 */
export async function reviewFilesFingerprint(dir: string): Promise<string> {
  const lines: string[] = [];
  for (const folder of [REVIEW_DIR, ATTACHMENT_DIR]) {
    let names: string[];
    try {
      names = await readdir(join(dir, folder));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const s = await lstat(join(dir, folder, name));
        lines.push(
          `${folder}/${name} ${s.isFile() ? 'f' : s.isDirectory() ? 'd' : 'o'} ${s.size} ${s.mtimeMs}`,
        );
      } catch {
        lines.push(`${folder}/${name} gone`);
      }
    }
  }
  return lines.sort().join('\n');
}

/*
 * Manual reviews, as widedoor review and the widedoor ui API share them:
 * both record through recordReview in @widedoor/core (its validation and its
 * lock, so a CLI write and a server write never lose a record) and list the
 * checklist with the same records-not-applied and warnings.
 */

/** Records one result for a checklist item (recordReview, stamped with this Widedoor version). Throws ReviewInputError. */
export const recordManualReview = (
  dir: string,
  input: Omit<RecordInput, 'version'>,
): Promise<{ file: string; record: Finding }> =>
  recordReview(dir, { ...input, version: WIDEDOOR_VERSION });

export interface NotAppliedView {
  id: string;
  uri: string;
  ruleId: string;
  reason: string;
  detail: string;
}

/**
 * The records a checklist could not apply, and the warnings a scan would
 * give for them: a kept manual fail with no checklist item (ruling 9) and a
 * record for a criterion the profile does not have.
 */
export function checklistNotes(
  state: ReviewChecklist,
  report: Pick<ScanReport, 'profile'>,
): { notApplied: NotAppliedView[]; warnings: string[] } {
  return {
    notApplied: state.notApplied.map(({ record, reason, detail }) => ({
      id: record.id,
      uri: record.asset.uri,
      ruleId: record.source.ruleId,
      reason,
      detail,
    })),
    warnings: state.notApplied.flatMap((n) =>
      n.reason === 'out-of-profile'
        ? [outOfProfileWarning(n.record, report.profile.id)]
        : n.reason === 'no-item' && n.record.outcome === 'fail'
          ? [`${keptFailWarning(n.record)}; a scan applies it`]
          : [],
    ),
  };
}

/** The record of a checklist item in the review files, as the Checklist screen shows it. */
export interface RecordSummary {
  outcome: Finding['outcome'];
  reviewer: string;
  date: string;
  notes?: string;
  /** Automated fails the record sets aside. */
  overrides: number;
  attachments: number;
  /** False when the page or file changed since the review (the item is expired). */
  current: boolean;
}

/**
 * Each item with the record the review files hold for it now, so the
 * Checklist screen never shows a record from a report that is older than the
 * files. The checklist applies at most one record per item (screenReviews
 * drops the superseded ones); the item names it in review only while it is
 * current.
 */
export function itemsWithRecords(
  state: ReviewChecklist,
): (ChecklistItem & { record?: RecordSummary })[] {
  return state.items.map((item) => {
    const ruleId = manualRuleId(item.criterion.type, item.criterion.id);
    const f = state.applied.find(
      (r) =>
        r.source.ruleId === ruleId && (item.scope === 'product' || r.asset.uri === item.asset?.uri),
    );
    if (!f || !('review' in f)) return item;
    const r = f.review;
    const record: RecordSummary = {
      outcome: f.outcome,
      reviewer: r.reviewer,
      date: r.date,
      ...(r.notes !== undefined ? { notes: r.notes } : {}),
      overrides: r.overrides?.length ?? 0,
      attachments: r.attachments?.length ?? 0,
      current: item.review === f.id,
    };
    return { ...item, record };
  });
}
