import { useContext, useEffect, useRef, useState } from 'react';
import { visibleText } from '@widedoor/report/browser';
import { download, failure, getAcrState, type AcrState } from './api.js';
import { Initial } from './initial.js';
import type { ReviewsState } from './load.js';

/*
 * The Export screen: whether an ACR would be a draft or complete, and every
 * reason it is not complete, before one download button per format. The ACR
 * state comes from the server, which builds it with the same ACR builder as
 * the exports. Each download is fetched with the token and saved through an
 * object URL (api.ts).
 */

const t = (value: unknown) => visibleText(value);

/** Every export format and its file name, as GET /api/export/:format names it (export.test.tsx checks both). */
export const EXPORTS: readonly { format: string; file: string; label: string }[] = [
  { format: 'html', file: 'report.html', label: 'HTML report' },
  { format: 'json', file: 'report.json', label: 'JSON report' },
  { format: 'sarif', file: 'report.sarif', label: 'SARIF' },
  { format: 'junit', file: 'report.junit.xml', label: 'JUnit XML' },
  { format: 'openacr', file: 'report.openacr.yaml', label: 'ACR as OpenACR YAML' },
  { format: 'vpat-html', file: 'report.vpat.html', label: 'ACR as VPAT HTML' },
  { format: 'vpat-docx', file: 'report.vpat.docx', label: 'ACR as VPAT Word document' },
];

export const LIVE_NOTE =
  'This report is kept only while widedoor ui runs. Export it to keep a copy.';
export const AS_SCANNED_NOTE =
  'Reviews recorded after this report was made are not in it. Run a new scan to include them.';

/** What the Report, Checklist and Export screens say about a served report: memory only, or as scanned. */
export function ReviewsNote({ reviews }: { reviews: ReviewsState | undefined }) {
  if (reviews === undefined) return null;
  return <p className="note">{reviews === 'live' ? LIVE_NOTE : AS_SCANNED_NOTE}</p>;
}

export type AcrView =
  { kind: 'loading' } | { kind: 'ready'; state: AcrState } | { kind: 'refused'; message: string };

export interface ExportViewProps {
  /** Changes when a scan finishes: the ACR state is read again, in place. */
  generation?: number;
  /** The reviews state of the report widedoor ui holds; none when it holds none. */
  reviews?: ReviewsState;
  /** True when the Report screen shows a file the user opened, not the served report. */
  fileShown?: boolean;
}

export function ExportView({ reviews, fileShown, generation = 0 }: ExportViewProps) {
  const initial = useContext(Initial).export;
  const [acr, setAcr] = useState<AcrView>(initial?.acr ?? { kind: 'loading' });
  const [status, setStatus] = useState(initial?.status ?? '');
  const [error, setError] = useState(initial?.error ?? '');
  // The file being downloaded, if any.
  const busy = useRef<string>(undefined);
  const live = useRef(true);

  // Each read is numbered; only the answer to the latest is shown.
  const reads = useRef(0);
  const seenGeneration = useRef(generation);

  const check = () => {
    const read = ++reads.current;
    const current = () => live.current && read === reads.current;
    setAcr({ kind: 'loading' });
    void getAcrState().then(
      (state) => current() && setAcr({ kind: 'ready', state }),
      (e: unknown) =>
        current() && setAcr({ kind: 'refused', message: failure('An ACR cannot be exported', e) }),
    );
  };

  useEffect(() => {
    live.current = true;
    if (initial?.acr === undefined) check();
    return () => {
      live.current = false;
    };
    // Read when the screen opens; Check again reads it once more.
  }, []);

  // A scan finished: read the ACR state again, in place (buttons and focus stay).
  useEffect(() => {
    if (generation === seenGeneration.current) return;
    seenGeneration.current = generation;
    check();
  }, [generation]);

  const save = async (x: (typeof EXPORTS)[number]) => {
    if (busy.current !== undefined) {
      setStatus(`Already downloading ${busy.current}. Wait for it to finish.`);
      return;
    }
    busy.current = x.file;
    setError('');
    setStatus(`Preparing ${x.file}.`);
    try {
      await download(x.format, x.file);
      if (live.current) setStatus(`Downloaded ${x.file}.`);
    } catch (e) {
      if (live.current) {
        setStatus('');
        setError(failure(`${x.file} could not be exported`, e));
      }
    } finally {
      busy.current = undefined;
    }
  };

  return (
    <>
      <ReviewsNote reviews={reviews} />
      {fileShown && (
        <p className="note">
          The Report screen shows a file you opened. The exports are of the report widedoor ui
          holds, from its last scan or --report.
        </p>
      )}
      <section aria-labelledby="acr-state" className="tools">
        <h2 id="acr-state">Accessibility Conformance Report (ACR)</h2>
        <div className="actions">
          <button type="button" onClick={check}>
            Check the ACR again
          </button>
        </div>
        {acr.kind === 'loading' ? (
          <p>Checking whether the ACR is complete.</p>
        ) : acr.kind === 'refused' ? (
          <p>{t(acr.message)}</p>
        ) : acr.state.complete ? (
          <p className="label">The ACR is complete.</p>
        ) : (
          <>
            <p className="label">The ACR is a draft. It is not complete because:</p>
            <ul>
              {acr.state.incomplete.map((reason, i) => (
                <li key={i}>{t(reason)}</li>
              ))}
            </ul>
          </>
        )}
      </section>
      <section aria-labelledby="downloads" className="tools">
        <h2 id="downloads">Download</h2>
        <ul className="downloads">
          {EXPORTS.map((x) => (
            <li key={x.format}>
              <button type="button" onClick={() => void save(x)}>
                {x.label} ({x.file})
              </button>
            </li>
          ))}
        </ul>
        <p role="status">{t(status)}</p>
        <p role="alert" className="error">
          {t(error)}
        </p>
      </section>
    </>
  );
}
