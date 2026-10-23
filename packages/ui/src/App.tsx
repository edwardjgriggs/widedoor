import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import type { Finding } from '@widedoor/core/browser';
import {
  IMPACT_LABEL,
  IMPACT_ORDER,
  listedFindings,
  plural,
  visibleText,
  type ImpactOrUnrated,
  type ScanReport,
} from '@widedoor/report/browser';
import { fetchServedReport, readReportFile, type Loaded } from './load.js';
import type { UiData } from './data.js';
import { ReportView, reportLead } from './ReportView.js';

/*
 * The viewer shell: loads the report widedoor ui serves (if any), lets the
 * user open a JSON report file instead, and filters the listed findings by
 * outcome and impact. The report sections themselves are ReportView.
 */

type OutcomeFilter = 'all' | 'fail' | 'needs-review';
type ImpactFilter = 'all' | ImpactOrUnrated;

type State =
  { kind: 'loading' } | { kind: 'empty'; message: string } | { kind: 'ready'; loaded: Loaded };

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
  const listed = listedFindings(report.findings, report.assets);
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

export function App({ data }: { data: UiData }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');
  const [impact, setImpact] = useState<ImpactFilter>('all');
  const fileId = useId();
  // Once the user opens a file, a late answer from the server must not replace it.
  const fileOpened = useRef(false);

  useEffect(() => {
    let live = true;
    fetchServedReport().then((result) => {
      if (!live || fileOpened.current) return;
      if (result.ok) setState({ kind: 'ready', loaded: result.loaded });
      else setState({ kind: 'empty', message: result.message });
    });
    return () => {
      live = false;
    };
  }, []);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    const result = await readReportFile(file);
    // Clear the input, so picking the same file again fires a change event.
    input.value = '';
    if (result.ok) {
      fileOpened.current = true;
      setError(undefined);
      setOutcome('all');
      setImpact('all');
      setState({ kind: 'ready', loaded: result.loaded });
    } else setError(result.message);
  };

  const filtered = outcome !== 'all' || impact !== 'all';
  const report = state.kind === 'ready' ? state.loaded.report : undefined;

  return (
    <>
      <header>
        <h1>Accessibility report</h1>
        <p className="lead">
          {report
            ? reportLead(report)
            : state.kind === 'empty'
              ? visibleText(state.message)
              : 'Loading the report.'}
        </p>
      </header>
      <main>
        <section aria-labelledby="open" className="tools">
          <h2 id="open">Open a report</h2>
          <p role="status">
            {state.kind === 'ready'
              ? state.loaded.source === 'server'
                ? 'Showing the report given to widedoor ui.'
                : `Showing the file ${visibleText(state.loaded.name)}.`
              : ''}
          </p>
          <label htmlFor={fileId}>Widedoor JSON report (report.json)</label>
          <input id={fileId} type="file" accept=".json,application/json" onChange={onFile} />
          {error && (
            <p role="alert" className="error">
              {visibleText(error)}
            </p>
          )}
        </section>
        {state.kind === 'ready' && report && (
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
              screenshots={state.loaded.screenshots}
              {...(filtered
                ? { findings: report.findings.filter((f) => matches(f, outcome, impact)) }
                : {})}
            />
          </>
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
