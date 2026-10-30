import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import type { Finding } from '@widedoor/core/browser';
import {
  IMPACT_LABEL,
  IMPACT_ORDER,
  listedFindings,
  overriddenFails,
  plural,
  visibleText,
  type ImpactOrUnrated,
  type ScanReport,
} from '@widedoor/report/browser';
import {
  SESSION_ENDED,
  getAi,
  onSessionEnded,
  sessionEnded,
  type ViewedAvailability,
} from './api.js';
import { ChecklistView } from './ChecklistView.js';
import { ExportView, ReviewsNote } from './ExportView.js';
import { Initial } from './initial.js';
import { fetchServedReport, readReportFile, type Loaded } from './load.js';
import type { UiData } from './data.js';
import { ReportView, reportLead } from './ReportView.js';
import { ScanView, type ScanEnd } from './ScanView.js';
import { SuggestionsView, type SuggestionsRequest } from './SuggestionsView.js';

/*
 * The viewer shell: four screens behind a nav of buttons (no router). Report
 * loads the report widedoor ui serves (if any), lets the user open a JSON
 * report file instead, and filters the listed findings by outcome and
 * impact; its sections are ReportView. Scan, Checklist and Export drive the
 * server's API. A screen change moves focus to the page heading. Report and
 * Scan stay mounted while hidden, so a running scan and the filters carry on.
 * A finished scan's report replaces what Report shows, Checklist and Export
 * read theirs again, and the end of a scan is announced on any screen. A
 * recorded review updates the served report but never replaces a file the
 * user opened. Once the session ends (a 401), every screen but Report says
 * so and stops.
 */

export const SCREENS = ['report', 'scan', 'checklist', 'export'] as const;
export type Screen = (typeof SCREENS)[number];

const NAV_LABEL: Record<Screen, string> = {
  report: 'Report',
  scan: 'Scan',
  checklist: 'Checklist',
  export: 'Export',
};

const TITLE: Record<Exclude<Screen, 'report'>, string> = {
  scan: 'Scan pages and PDFs',
  checklist: 'Manual review checklist',
  export: 'Export the report',
};

const LEAD: Record<Exclude<Screen, 'report'>, string> = {
  scan: 'Scan web pages and PDF files with the settings in widedoor.config.yaml. The report stays in memory until you export it.',
  checklist:
    'The checks no tool can make, for each page and file of the report widedoor ui holds. Record each result here.',
  export: 'Download the report widedoor ui holds, in any format.',
};

type OutcomeFilter = 'all' | 'fail' | 'needs-review';
type ImpactFilter = 'all' | ImpactOrUnrated;

function matches(f: Finding, outcome: OutcomeFilter, impact: ImpactFilter): boolean {
  return (
    (outcome === 'all' || f.outcome === outcome) &&
    (impact === 'all' || (f.impact ?? 'unrated') === impact)
  );
}

function Filters({
  report,
  outcome,
  impact,
  onOutcome,
  onImpact,
}: {
  report: ScanReport;
  outcome: OutcomeFilter;
  impact: ImpactFilter;
  onOutcome: (v: OutcomeFilter) => void;
  onImpact: (v: ImpactFilter) => void;
}) {
  const outcomeId = useId();
  const impactId = useId();
  const listed = listedFindings(report.findings, report.assets, overriddenFails(report));
  const showing = listed.filter((f) => matches(f, outcome, impact)).length;
  return (
    <section aria-labelledby="filter" className="tools">
      <h2 id="filter">Filter findings</h2>
      <div className="fields">
        <div>
          <label htmlFor={outcomeId}>Outcome</label>
          <select
            id={outcomeId}
            value={outcome}
            onChange={(e) => onOutcome(e.target.value as OutcomeFilter)}
          >
            <option value="all">Problems and items to check by hand</option>
            <option value="fail">Problems only</option>
            <option value="needs-review">Items to check by hand only</option>
          </select>
        </div>
        <div>
          <label htmlFor={impactId}>Impact</label>
          <select
            id={impactId}
            value={impact}
            onChange={(e) => onImpact(e.target.value as ImpactFilter)}
          >
            <option value="all">Any impact</option>
            {IMPACT_ORDER.map((i) => (
              <option key={i} value={i}>
                {IMPACT_LABEL[i]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p role="status">
        Showing {showing} of {plural(listed.length, 'listed finding', 'listed findings')}. The
        summary, the results by criterion and the methodology always cover the whole report.
      </p>
    </section>
  );
}

/** What a reload of the served report is for: a finished scan replaces what Report shows; a review does not replace an opened file. */
type ReloadFor = 'scan' | 'review';

const SCAN_ANNOUNCE: Record<ScanEnd, string> = {
  done: 'Scan finished.',
  failed: 'Scan failed. The Scan screen says why.',
  cancelled: 'Scan cancelled.',
};

export function App({ data }: { data: UiData }) {
  const [screen, setScreen] = useState<Screen>(useContext(Initial).screen ?? 'report');
  const [ended, setEnded] = useState(sessionEnded);
  // The report widedoor ui holds, as last loaded; and why there is none.
  const [served, setServed] = useState<Loaded>();
  const [empty, setEmpty] = useState<string>();
  // A report file the user opened, shown instead of the served one.
  const [file, setFile] = useState<Loaded>();
  const opened = useRef(file);
  opened.current = file;
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // Bumped when a scan's report is loaded, so Checklist and Export read theirs again.
  const [generation, setGeneration] = useState(0);
  // Scan results announced while another screen is shown.
  const [announcement, setAnnouncement] = useState('');
  // AI fix suggestions: whether the server offers them, and the last ask.
  const [ai, setAi] = useState<ViewedAvailability>({ available: false });
  const [suggest, setSuggest] = useState<SuggestionsRequest>();
  // While a suggestion is prepared, confirmed or run, the per-finding buttons are disabled.
  const [aiLocked, setAiLocked] = useState(false);
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');
  const [impact, setImpact] = useState<ImpactFilter>('all');
  const fileId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // Focus moves to the heading on a screen change, not on the first render.
  const moved = useRef(false);
  // The screen shown now, for callbacks made by a scan started earlier.
  const current = useRef(screen);
  current.current = screen;
  const announceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => onSessionEnded(() => setEnded(true)), []);
  useEffect(() => () => clearTimeout(announceTimer.current), []);

  useEffect(() => {
    if (moved.current) heading.current?.focus();
  }, [screen]);

  const show = (next: Screen) => {
    moved.current = true;
    if (next === screen) heading.current?.focus();
    else setScreen(next);
  };

  // Asked once the served report is there: a page opened without the server never asks.
  // Asked again whenever the served report changes (a new scan, a loaded or replaced report):
  // availability follows the report (a signed-in one needs ai.allowSignedIn). A review
  // rebuild keeps the same report, and the answer.
  const servedReport = served?.report.startedAt;
  useEffect(() => {
    if (servedReport === undefined) return;
    let live = true;
    getAi().then(
      (got) => live && setAi(got),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [servedReport]);

  useEffect(() => {
    let live = true;
    fetchServedReport().then(
      (result) => {
        if (!live) return;
        if (result.ok) setServed(result.loaded);
        else setEmpty(result.message);
      },
      () => live && setEmpty('The page could not load the report. Reload it and try again.'),
    );
    return () => {
      live = false;
    };
  }, []);

  /**
   * Loads the served report again; resolves with why that failed, if it did
   * (shown on Report, and by the caller). A finished scan always moves
   * Checklist and Export on, even when its report could not be loaded.
   */
  const reload = useCallback(async (reason: ReloadFor): Promise<string | undefined> => {
    const result = await fetchServedReport().catch(() => ({
      ok: false as const,
      message: 'The page could not load the report. Reload it and try again.',
    }));
    if (reason === 'scan') {
      setGeneration((g) => g + 1);
      // Suggestions belong to the report they were asked for (the server drops its own too).
      setSuggest(undefined);
      setAiLocked(false);
    }
    if (!result.ok) {
      const why = `The report widedoor ui holds could not be loaded again. ${result.message}`;
      setError(why);
      return why;
    }
    setServed(result.loaded);
    setEmpty(undefined);
    setError(undefined);
    if (reason === 'scan') {
      setFile(undefined);
      setNotice(undefined);
    } else if (opened.current)
      setNotice(
        'The report widedoor ui holds was updated with the review. The Report screen still shows the file you opened.',
      );
    return undefined;
  }, []);

  /** Says a scan ended on whatever screen is shown (the Scan screen says it itself). */
  const announce = (text: string) => {
    if (current.current === 'scan') return;
    // Cleared first, so the same words twice are announced twice.
    setAnnouncement('');
    clearTimeout(announceTimer.current);
    announceTimer.current = setTimeout(() => setAnnouncement(text), 100);
  };

  const scanEnded = async (end: ScanEnd): Promise<boolean> => {
    const loaded = end === 'done' ? (await reload('scan')) === undefined : true;
    announce(
      end === 'done' && !loaded
        ? 'Scan finished, but its report could not be loaded. The Report screen says why.'
        : SCAN_ANNOUNCE[end],
    );
    return loaded;
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const picked = input.files?.[0];
    if (!picked) return;
    const result = await readReportFile(picked);
    // Clear the input, so picking the same file again fires a change event.
    input.value = '';
    if (result.ok) {
      setError(undefined);
      setNotice(undefined);
      setOutcome('all');
      setImpact('all');
      setFile(result.loaded);
    } else setError(result.message);
  };

  const showServed = () => {
    setFile(undefined);
    setNotice(undefined);
    setOutcome('all');
    setImpact('all');
    // The button goes away with the file: focus the page heading, never the body.
    heading.current?.focus();
  };

  const filtered = outcome !== 'all' || impact !== 'all';
  const loaded = file ?? served;
  const report = loaded?.report;

  return (
    <>
      <header>
        <nav aria-label="Screens">
          <ul className="nav">
            {SCREENS.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  aria-current={s === screen ? 'page' : undefined}
                  onClick={() => show(s)}
                >
                  {NAV_LABEL[s]}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <h1 ref={heading} tabIndex={-1}>
          {screen === 'report' ? 'Accessibility report' : TITLE[screen]}
        </h1>
        <p className="lead">
          {screen !== 'report'
            ? LEAD[screen]
            : report
              ? reportLead(report)
              : empty !== undefined
                ? visibleText(empty)
                : 'Loading the report.'}
        </p>
      </header>
      <main>
        <p role="status" className="visually-hidden">
          {announcement}
        </p>
        {ended && (
          <p role="alert" className="error">
            {SESSION_ENDED}
          </p>
        )}
        <div hidden={screen !== 'report'}>
          {!file && <ReviewsNote reviews={served?.reviews} />}
          <section aria-labelledby="open" className="tools">
            <h2 id="open">Open a report</h2>
            <p role="status">
              {file
                ? `Showing the file ${visibleText(file.name)}.`
                : served
                  ? 'Showing the report given to widedoor ui.'
                  : ''}
              {notice ? ` ${notice}` : ''}
            </p>
            {file && served && (
              <div className="actions">
                <button type="button" onClick={showServed}>
                  Show the report widedoor ui holds
                </button>
              </div>
            )}
            <label htmlFor={fileId}>Widedoor JSON report (report.json)</label>
            <input id={fileId} type="file" accept=".json,application/json" onChange={onFile} />
            {error && (
              <p role="alert" className="error">
                {visibleText(error)}
              </p>
            )}
          </section>
          {!file && served && !ended && (
            <SuggestionsView
              key={generation}
              availability={ai}
              request={suggest}
              onRequest={setSuggest}
              onLock={setAiLocked}
            />
          )}
          {loaded && report && (
            <>
              <Filters
                report={report}
                outcome={outcome}
                impact={impact}
                onOutcome={setOutcome}
                onImpact={setImpact}
              />
              <ReportView
                report={report}
                data={data}
                screenshots={loaded.screenshots}
                attachments={loaded.attachments}
                {...(filtered
                  ? { findings: report.findings.filter((f) => matches(f, outcome, impact)) }
                  : {})}
                {...(ai.available && !file && !ended
                  ? {
                      onSuggest: (f: Finding) =>
                        setSuggest((prev) => ({ findingIds: [f.id], n: (prev?.n ?? 0) + 1 })),
                      suggestDisabled: aiLocked,
                    }
                  : {})}
              />
            </>
          )}
        </div>
        {!ended && (
          <div hidden={screen !== 'scan'}>
            <ScanView onEnded={scanEnded} />
          </div>
        )}
        {!ended && screen === 'checklist' && (
          <ChecklistView
            generation={generation}
            {...(served ? { report: served.report } : {})}
            {...(served?.reviews ? { reviews: served.reviews } : {})}
            fileShown={file !== undefined}
            onRecorded={() => reload('review')}
          />
        )}
        {!ended && screen === 'export' && (
          <ExportView
            generation={generation}
            {...(served?.reviews ? { reviews: served.reviews } : {})}
            fileShown={file !== undefined}
          />
        )}
      </main>
      <footer>
        <p>
          {report
            ? `Made with Widedoor ${visibleText(report.tool.version)}.`
            : 'Widedoor report viewer.'}
        </p>
      </footer>
    </>
  );
}
