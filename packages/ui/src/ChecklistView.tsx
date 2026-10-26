import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Finding } from '@widedoor/core/browser';
import {
  assetKindText,
  conditionText,
  engineName,
  overriddenFails,
  plural,
  visibleText,
  type ScanReport,
} from '@widedoor/report/browser';
import { ITEM_STATUSES, failure, getChecklist, type ChecklistEntry } from './api.js';
import { ReviewsNote } from './ExportView.js';
import { Initial } from './initial.js';
import type { ReviewsState } from './load.js';
import { OUTCOME_LABEL, ReviewForm, type Overridable } from './ReviewForm.js';

/*
 * The Checklist screen: the manual review items of the report widedoor ui
 * holds, grouped by page or file and then by criterion, with a status
 * filter. Each item shows its ICT Testing Baseline tests, steps, condition,
 * related automated findings and its record in the review files (sent with
 * the checklist, so it is never an older copy from the report), and opens the review form
 * under itself. After a result is recorded the checklist is read again and
 * focus moves to the item's new status. Every string is shown as text only.
 */

const t = (value: unknown) => visibleText(value);

export type StatusFilter = 'all' | ChecklistEntry['status'];

export const STATUS_TEXT: Record<ChecklistEntry['status'], string> = {
  open: 'Open: not reviewed yet',
  done: 'Done: a current manual result decides it',
  expired: 'Expired: the page or file changed since the review',
  'failed-automated':
    'Failed an automated check: a review is optional, and can set aside a false positive',
};

const FILTER_LABEL: Record<StatusFilter, string> = {
  all: 'Every status',
  open: 'Open',
  done: 'Done',
  expired: 'Expired',
  'failed-automated': 'Failed an automated check',
};

const OUTCOME_TEXT: Record<Finding['outcome'], string> = {
  pass: 'pass',
  fail: 'fail',
  'needs-review': 'needs review',
  'not-applicable': 'not applicable',
  'not-tested': 'not tested',
};

export const criterionText = (c: ChecklistEntry['criterion']) =>
  `${c.type === 'wcag' ? 'WCAG' : 'Section 508'} ${c.id} ${c.title}`;

interface Group {
  key: string;
  heading: string;
  kind?: string;
  items: ChecklistEntry[];
}

/** Items by page or file (product items last), each group in the server's order. */
export function groupItems(items: readonly ChecklistEntry[]): Group[] {
  const groups = new Map<string, Group>();
  for (const item of items) {
    const key = item.scope === 'product' || !item.asset ? '\u0000product' : item.asset.uri;
    let group = groups.get(key);
    if (!group) {
      group =
        item.scope === 'product' || !item.asset
          ? { key, heading: 'The product as a whole', items: [] }
          : { key, heading: item.asset.uri, kind: item.asset.kind, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()].sort(
    (a, b) => Number(a.kind === undefined) - Number(b.kind === undefined),
  );
}

/** "axe-core image-alt: fail", for a related finding id; the id alone when the report lacks it. */
function relatedText(
  id: string,
  byId: ReadonlyMap<string, Finding>,
  overridden: ((f: Finding) => boolean) | undefined,
): string {
  const f = byId.get(id);
  if (!f) return id;
  const set = f.outcome === 'fail' && overridden?.(f);
  return `${engineName(f.source.engine)} ${f.source.ruleId}: ${OUTCOME_TEXT[f.outcome]}${set ? ' (set aside by a reviewer)' : ''}`;
}

/** The item's record in the review files now (never the report's copy), as one line. */
export function recordLine(r: ChecklistEntry['record']): string | undefined {
  if (!r) return undefined;
  const outcome =
    r.outcome in OUTCOME_LABEL
      ? OUTCOME_LABEL[r.outcome as keyof typeof OUTCOME_LABEL]
      : OUTCOME_TEXT[r.outcome];
  return `${r.current ? 'Recorded' : 'Recorded before the page or file changed (expired)'}: ${outcome}, by ${r.reviewer} on ${r.date}${r.notes ? `. Notes: ${r.notes}` : ''}${r.overrides ? `. Sets aside ${plural(r.overrides, 'automated fail', 'automated fails')}` : ''}${r.attachments ? `. ${plural(r.attachments, 'image', 'images')} attached` : ''}.`;
}

/** The related automated fails a review of the item may set aside. */
function overridableOf(item: ChecklistEntry, byId: ReadonlyMap<string, Finding>): Overridable[] {
  return item.related.flatMap((id) => {
    const f = byId.get(id);
    if (!f || f.outcome !== 'fail' || f.source.engine === 'manual') return [];
    return [
      {
        id,
        label: `${engineName(f.source.engine)} ${f.source.ruleId} on ${f.asset.uri}`,
      },
    ];
  });
}

/** The toggle's name: the criterion and the page or file, so every toggle's name is its own. */
export const toggleText = (item: ChecklistEntry) =>
  `Record a result for ${criterionText(item.criterion)} on ${item.scope === 'product' || !item.asset ? 'the product as a whole' : item.asset.uri}`;

export interface ChecklistViewProps {
  /** The report widedoor ui holds, for related findings (records come with the checklist). */
  report?: ScanReport;
  /** The reviews state of that report; none when it holds none. */
  reviews?: ReviewsState;
  /** True when the Report screen shows a file the user opened, not that report. */
  fileShown?: boolean;
  /** Called after a result is recorded, so the app loads the rebuilt report; resolves with why that failed, if it did. */
  onRecorded: () => Promise<string | undefined>;
  /**
   * Changes when a scan finishes. The checklist is read again then, unless a
   * review form is open: the form and what was typed stay, and a note says
   * to refresh.
   */
  generation?: number;
}

export const NEW_SCAN_NOTE = 'A new scan finished. Refresh the checklist to see its items.';

export function ChecklistView({
  report,
  reviews,
  fileShown,
  onRecorded,
  generation = 0,
}: ChecklistViewProps) {
  const initial = useContext(Initial).checklist;
  const [checklist, setChecklist] = useState(initial?.checklist);
  const [error, setError] = useState(initial?.error);
  const [filter, setFilter] = useState<StatusFilter>(initial?.filter ?? 'all');
  const [open, setOpen] = useState(initial?.open);
  const [focusItem, setFocusItem] = useState<string>();
  // A scan finished while a form was open: the items shown are the previous scan's.
  const [stale, setStale] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const seenGeneration = useRef(generation);
  const filterId = useId();
  const statusRefs = useRef(new Map<string, HTMLParagraphElement>());
  const toggleRefs = useRef(new Map<string, HTMLButtonElement>());
  const countRef = useRef<HTMLParagraphElement>(null);
  const live = useRef(true);

  const load = async () => {
    try {
      const got = await getChecklist();
      if (!live.current) return;
      setChecklist(got);
      setError(undefined);
      setStale(false);
    } catch (e) {
      if (live.current) setError(failure('The checklist could not be loaded', e));
    }
  };

  useEffect(() => {
    live.current = true;
    if (initial?.checklist === undefined) void load();
    return () => {
      live.current = false;
    };
    // Loaded once when the screen opens; a recorded result loads it again.
  }, []);

  // A scan finished: read again in place, or keep the open form and say so.
  useEffect(() => {
    if (generation === seenGeneration.current) return;
    seenGeneration.current = generation;
    if (openRef.current === undefined) void load();
    else setStale(true);
  }, [generation]);

  // After a record: focus the item's new status text, or the count when the filter hides it.
  useEffect(() => {
    if (focusItem === undefined || checklist === undefined) return;
    (statusRefs.current.get(focusItem) ?? countRef.current)?.focus();
    setFocusItem(undefined);
  }, [checklist, focusItem]);

  const recorded = async (item: string) => {
    // The status text stays mounted: focus it now, so focus never drops while the form closes.
    statusRefs.current.get(item)?.focus();
    setOpen(undefined);
    const why = await onRecorded();
    await load();
    // The record is written; only the report could not be read again.
    if (why !== undefined && live.current) setError(why);
    setFocusItem(item);
  };

  const byId = useMemo(() => new Map((report?.findings ?? []).map((f) => [f.id, f])), [report]);
  const overridden = useMemo(() => (report ? overriddenFails(report) : undefined), [report]);
  const items = checklist?.items ?? [];
  const shown = items.filter((i) => filter === 'all' || i.status === filter);
  const count = (s: StatusFilter) =>
    s === 'all' ? items.length : items.filter((i) => i.status === s).length;

  return (
    <>
      <ReviewsNote reviews={reviews} />
      {fileShown && (
        <p className="note">
          The Report screen shows a file you opened. The checklist is of the report widedoor ui
          holds, from its last scan or --report, and results are recorded against it.
        </p>
      )}
      <section aria-labelledby="ck-filter" className="tools">
        <h2 id="ck-filter">Filter the checklist</h2>
        <div className="actions">
          <button type="button" onClick={() => void load()}>
            Refresh the checklist
          </button>
        </div>
        <p role="status">{stale ? NEW_SCAN_NOTE : ''}</p>
        <label htmlFor={filterId}>Status</label>
        <select
          id={filterId}
          value={filter}
          onChange={(e) => setFilter(e.target.value as StatusFilter)}
        >
          {(['all', ...ITEM_STATUSES] as const).map((s) => (
            <option key={s} value={s}>
              {FILTER_LABEL[s]} ({count(s)})
            </option>
          ))}
        </select>
        <p role="status" ref={countRef} tabIndex={-1}>
          {checklist
            ? `Showing ${shown.length} of ${plural(items.length, 'item', 'items')}.`
            : error
              ? ''
              : 'Loading the checklist.'}
        </p>
      </section>
      <p role="alert" className="error">
        {t(error ?? '')}
      </p>
      {checklist && checklist.warnings.length > 0 && (
        <section aria-labelledby="ck-warnings">
          <h2 id="ck-warnings">Records not applied</h2>
          <ul>
            {checklist.warnings.map((w, i) => (
              <li key={i}>{t(w)}</li>
            ))}
          </ul>
        </section>
      )}
      {checklist && (
        <section aria-labelledby="ck-items">
          <h2 id="ck-items">Items to check by hand</h2>
          {items.length === 0 ? (
            <p>Nothing in this report needs a check by hand.</p>
          ) : shown.length === 0 ? (
            <p>No items match the filter.</p>
          ) : (
            groupItems(shown).map((g, gi) => (
              <section key={g.key} aria-labelledby={`ck-group-${gi}`}>
                <h3 id={`ck-group-${gi}`} className={g.kind ? 'uri' : undefined}>
                  {t(g.heading)}
                </h3>
                {g.kind && <p className="lead">{assetKindText(g.kind)}</p>}
                <ul className="items">
                  {g.items.map((item) => {
                    const formId = `review-${item.id}`;
                    const record = recordLine(item.record);
                    return (
                      <li key={item.id} className="item">
                        <h4>{t(criterionText(item.criterion))}</h4>
                        <p
                          className="label"
                          tabIndex={-1}
                          ref={(el) => {
                            if (el) statusRefs.current.set(item.id, el);
                            else statusRefs.current.delete(item.id);
                          }}
                        >
                          Status: {STATUS_TEXT[item.status]}
                        </p>
                        {record && <p>{t(record)}</p>}
                        {item.condition && <p>{t(conditionText(item.condition))}</p>}
                        <p>
                          ICT Testing Baseline tests:{' '}
                          {item.baselineTests.length > 0
                            ? t(item.baselineTests.join(', '))
                            : 'none listed'}
                        </p>
                        {item.steps.length > 0 && (
                          <>
                            <p>Steps:</p>
                            <ol>
                              {item.steps.map((s, i) => (
                                <li key={i}>{t(s)}</li>
                              ))}
                            </ol>
                          </>
                        )}
                        {item.related.length > 0 ? (
                          <>
                            <p>Related automated findings:</p>
                            <ul>
                              {item.related.map((id) => (
                                <li key={id}>{t(relatedText(id, byId, overridden))}</li>
                              ))}
                            </ul>
                          </>
                        ) : (
                          <p>Related automated findings: none.</p>
                        )}
                        <button
                          type="button"
                          ref={(el) => {
                            if (el) toggleRefs.current.set(item.id, el);
                            else toggleRefs.current.delete(item.id);
                          }}
                          aria-expanded={open === item.id}
                          aria-controls={open === item.id ? formId : undefined}
                          onClick={() => setOpen(open === item.id ? undefined : item.id)}
                        >
                          {t(toggleText(item))}
                        </button>
                        {open === item.id && (
                          <ReviewForm
                            id={formId}
                            item={item}
                            overridable={overridableOf(item, byId)}
                            onRecorded={(id) => void recorded(id)}
                            onCancel={() => {
                              setOpen(undefined);
                              toggleRefs.current.get(item.id)?.focus();
                            }}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </section>
      )}
    </>
  );
}
