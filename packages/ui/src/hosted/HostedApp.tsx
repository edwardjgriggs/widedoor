import { useContext, useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import type { ProfileId } from '@widedoor/core/browser';
import { DISCLAIMER, visibleText } from '@widedoor/report/browser';
import type { UiData } from '../data.js';
import type { Loaded } from '../load.js';
import { PROFILES } from '../profiles.js';
import { ReportView, reportLead } from '../ReportView.js';
import {
  HostedError,
  cancelScan,
  fetchReport,
  getVerification,
  isEnded,
  reportPath,
  startScan,
  type ScanJob,
  type ScanTarget,
} from './api.js';
import { followScan } from './flows.js';
import { HostedInitial } from './initial.js';
import { browserEnv, type PollEnv } from './poll.js';
import { useRetryGate } from './retry.js';
import { SiteLink } from './SiteLink.js';
import { forgetVerification, loadVerification } from './storage.js';
import {
  DOWNLOAD_NOTE,
  LIMITS_TEXT,
  UPLOAD_TIME_TEXT,
  VERIFIED_OPTION,
  coversUrl,
  endedText,
  isUsable,
  localTime,
  pdfError,
  refusalText,
  retryText,
  scanStatusText,
  urlError,
  urlTarget,
} from './text.js';
import { VerifyView } from './VerifyView.js';

/*
 * The hosted page (Task 12): scan one URL or one PDF on the open tier, or a
 * URL on a verified host on the verified tier, follow it, and read its report
 * here (ReportView, from the JSON report load.ts validated) or download it.
 * One section holds the scan: its heading names the state and takes focus
 * when the state changes, and one polite status region under it says what is
 * happening, changing only when the state does. The form checks what it can
 * before sending; the server's refusal is shown when it differs. A busy or
 * rate-limited answer says when to try again, and the page sends nothing
 * before then. It talks only to the hosted API on its own origin (api.ts) and
 * stores only a verification (storage.ts). Every string from the server or a
 * report is shown as text only.
 */

const t = (value: unknown) => visibleText(value);

/** The local Scan screen's profiles, less "as in widedoor.config.yaml" (there is no config here). */
export const HOSTED_PROFILES = PROFILES.filter(
  (p): p is { id: ProfileId; label: string } => p.id !== '',
);
/** What the local screen's config default comes to, and the API's own default. */
export const DEFAULT_PROFILE: ProfileId = '508+wcag21aa';

export interface ScanForm {
  mode: 'url' | 'pdf';
  url: string;
  file?: File | undefined;
  profile: ProfileId;
  /** The user asked for the verified tier (sent only for a URL its verification covers). */
  useVerified: boolean;
  /** The field's error: a client-side check, or the server's refusal of the input. */
  fieldError?: string | undefined;
  /** A refusal that is not about the input: busy, rate limited, no answer. */
  alert?: string | undefined;
  /** Until when a 429 or 503 asked the page to wait (render tests; see retry.ts). */
  retryAt?: number | undefined;
}

export type ScanPhase =
  | { kind: 'form' }
  | { kind: 'following'; job: ScanJob; cancelling?: boolean; error?: string }
  | { kind: 'done'; job: ScanJob; report?: Loaded; reportError?: string }
  | { kind: 'ended'; job: ScanJob };

const EMPTY_FORM: ScanForm = { mode: 'url', url: '', profile: DEFAULT_PROFILE, useVerified: false };

/** The scan section's heading for each state. */
function titleOf(phase: ScanPhase): string {
  if (phase.kind === 'form') return 'Scan a page or a PDF';
  if (phase.kind === 'following') return 'Scan in progress';
  if (phase.kind === 'done') return 'Your report';
  if (phase.job.status === 'cancelled') return 'Scan cancelled';
  if (phase.job.status === 'expired') return 'Scan results expired';
  return 'The scan did not finish';
}

export interface HostedAppProps {
  data: UiData;
  /** The clock, timers and visibility polling uses. Default: the page's own. */
  env?: () => PollEnv;
}

export function HostedApp({ data, env = browserEnv }: HostedAppProps) {
  const initial = useContext(HostedInitial);
  const [form, setForm] = useState<ScanForm>({ ...EMPTY_FORM, ...initial.form });
  const [phase, setPhase] = useState<ScanPhase>(initial.phase ?? { kind: 'form' });
  const [sending, setSending] = useState<string>();
  const [verification, setVerification] = useState(initial.verification);
  const gate = useRetryGate(initial.form?.retryAt);
  // A start in progress, set before any await so a second press (or Enter) sends nothing.
  const submitting = useRef(false);
  const modeName = useId();
  const urlId = useId();
  const urlHint = useId();
  const fileId = useId();
  const fileHint = useId();
  const fieldErrorId = useId();
  const profileId = useId();
  const tierId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stopFollow = useRef<() => void>(undefined);
  // The job whose end was handled: a late answer for it is ignored.
  const endedId = useRef<string>(undefined);
  const live = useRef(true);
  // Focus moves on a state change, not on the first render.
  const moved = useRef(false);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      stopFollow.current?.();
    };
  }, []);

  // A verification made earlier in this tab, and how it stands now.
  useEffect(() => {
    if (initial.verification !== undefined) return;
    const stored = loadVerification();
    if (stored === undefined) return;
    setVerification({ ...stored, status: 'pending' });
    getVerification(stored.id).then(
      (view) => {
        if (!live.current) return;
        if (view.status === 'expired') forgetVerification();
        setVerification({
          id: view.id,
          host: view.host,
          expiresAt: view.expiresAt,
          status: view.status,
          ...(view.tried ? { tried: view.tried } : {}),
        });
      },
      (e: unknown) => {
        if (!live.current || !(e instanceof HostedError) || e.status !== 404) return;
        forgetVerification();
        setVerification(undefined);
      },
    );
  }, [initial.verification]);

  useEffect(() => {
    if (!moved.current) return;
    if (phase.kind === 'form')
      (form.mode === 'url' ? urlInput.current : fileInput.current)?.focus();
    else heading.current?.focus();
    // Only a change of state moves focus, not each poll.
  }, [phase.kind]);

  const changeForm = (next: Partial<ScanForm>) =>
    setForm((f) => ({ ...f, ...next, fieldError: undefined }));

  const reportArrived = (job: ScanJob) => {
    void fetchReport(job.id).then((result) => {
      if (!live.current) return;
      setPhase((p) =>
        p.kind === 'done' && p.job.id === job.id
          ? result.ok
            ? { kind: 'done', job, report: result.loaded }
            : { kind: 'done', job, reportError: result.message }
          : p,
      );
    });
  };

  /** A scan's state, from a poll, the start or a cancel. */
  const onJob = (job: ScanJob) => {
    if (!live.current || endedId.current === job.id) return;
    if (!isEnded(job.status)) {
      setPhase((p) => ({
        kind: 'following',
        job,
        ...(p.kind === 'following' && p.cancelling ? { cancelling: true } : {}),
      }));
      return;
    }
    endedId.current = job.id;
    stopFollow.current?.();
    moved.current = true;
    if (job.status === 'done') {
      setPhase({ kind: 'done', job });
      reportArrived(job);
    } else setPhase({ kind: 'ended', job });
  };

  /** The scanner no longer knows the scan (it restarted, or the record was dropped). */
  const lost = (job: ScanJob) =>
    onJob({
      ...job,
      status: 'failed',
      message: 'The scanner no longer knows this scan. Start a new one.',
    });

  const follow = (job: ScanJob) => {
    stopFollow.current?.();
    stopFollow.current = followScan(
      job.id,
      {
        view: onJob,
        error: (e) => {
          if (!live.current) return;
          if (e.status === 404) return lost(job);
          setPhase((p) =>
            p.kind === 'following' ? { ...p, error: `${t(e.message)} The page keeps trying.` } : p,
          );
        },
      },
      env(),
    );
  };

  /** Sends the scan request; nothing else may start until it has an answer. */
  const submit = async () => {
    if (submitting.current) return;
    if (gate.waiting) {
      setForm((f) => ({ ...f, alert: retryText(gate.left()) }));
      return;
    }
    submitting.current = true;
    try {
      await send();
    } finally {
      submitting.current = false;
    }
  };

  const send = async () => {
    const now = Date.now();
    let target: ScanTarget;
    if (form.mode === 'url') {
      const error = urlError(form.url);
      if (error) {
        setForm((f) => ({ ...f, fieldError: error, alert: undefined }));
        urlInput.current?.focus();
        return;
      }
      target = urlTarget(form.url, form.useVerified, verification, now);
    } else {
      const error = await pdfError(form.file);
      if (error || form.file === undefined) {
        setForm((f) => ({ ...f, fieldError: error, alert: undefined }));
        fileInput.current?.focus();
        return;
      }
      target = { kind: 'pdf', file: form.file };
    }
    setForm((f) => ({ ...f, fieldError: undefined, alert: undefined }));
    setSending(target.kind === 'pdf' ? 'Uploading the PDF.' : 'Sending the scan request.');
    let job: ScanJob;
    try {
      job = await startScan(target, form.profile);
    } catch (e) {
      if (!live.current) return;
      setSending(undefined);
      // The server's refusal of the input itself belongs to the field.
      if (e instanceof HostedError && [400, 413, 415].includes(e.status)) {
        setForm((f) => ({ ...f, fieldError: t(e.message) }));
        (form.mode === 'url' ? urlInput.current : fileInput.current)?.focus();
        return;
      }
      if (e instanceof HostedError && e.retryAfterS !== undefined) gate.wait(e.retryAfterS);
      setForm((f) => ({ ...f, alert: refusalText(e) }));
      return;
    }
    if (!live.current) return;
    setSending(undefined);
    endedId.current = undefined;
    moved.current = true;
    onJob(job);
    if (!isEnded(job.status)) follow(job);
  };

  const cancel = async () => {
    if (phase.kind !== 'following' || phase.cancelling) return;
    const { job } = phase;
    setPhase({ ...phase, cancelling: true });
    let after: ScanJob;
    try {
      after = await cancelScan(job.id);
    } catch (e) {
      if (!live.current) return;
      if (e instanceof HostedError && e.status === 404) return lost(job);
      setPhase((p) =>
        p.kind === 'following'
          ? {
              kind: 'following',
              job: p.job,
              error: `The scan could not be cancelled. ${refusalText(e)}`,
            }
          : p,
      );
      return;
    }
    onJob(after);
  };

  const startAgain = () => {
    stopFollow.current?.();
    moved.current = true;
    setForm((f) => ({ ...f, fieldError: undefined, alert: undefined }));
    setPhase({ kind: 'form' });
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    changeForm(file ? { file } : { file: undefined });
  };

  const now = Date.now();
  const usable = isUsable(verification, now) ? verification : undefined;
  const covered = form.mode === 'url' && coversUrl(usable, form.url, now);
  const job = phase.kind === 'form' ? undefined : phase.job;
  const status =
    phase.kind === 'form'
      ? (sending ?? '')
      : phase.kind === 'done'
        ? phase.report
          ? 'The scan finished. Its report is below.'
          : phase.reportError !== undefined
            ? 'The scan finished, but its report could not be shown here. Download it instead.'
            : 'The scan finished. Loading its report.'
        : scanStatusText(phase.job, phase.kind === 'following' && phase.cancelling);
  const alert =
    phase.kind === 'form'
      ? form.alert
      : phase.kind === 'following'
        ? phase.error
        : phase.kind === 'done'
          ? phase.reportError
          : undefined;
  const fieldDescribed = (hint: string) =>
    form.fieldError !== undefined ? `${hint} ${fieldErrorId}` : hint;

  return (
    <>
      <header>
        <h1>Widedoor accessibility scanner</h1>
        <p className="lead">
          Widedoor checks a web page or a PDF against Section 508 and WCAG 2.1 AA. Its report says
          what it found, and what a person still needs to check by hand.
        </p>
      </header>
      <main>
        <section aria-labelledby="scan-title" className="tools">
          <h2 id="scan-title" ref={heading} tabIndex={-1}>
            {titleOf(phase)}
          </h2>
          <p role="status" className="progress">
            {status}
          </p>
          {phase.kind === 'form' && (
            <>
              <p>{LIMITS_TEXT}</p>
              <fieldset>
                <legend>What to scan</legend>
                <div className="choice">
                  <input
                    id={`${modeName}-url`}
                    type="radio"
                    name={modeName}
                    value="url"
                    checked={form.mode === 'url'}
                    onChange={() => changeForm({ mode: 'url' })}
                  />
                  <label htmlFor={`${modeName}-url`}>A web page</label>
                </div>
                <div className="choice">
                  <input
                    id={`${modeName}-pdf`}
                    type="radio"
                    name={modeName}
                    value="pdf"
                    checked={form.mode === 'pdf'}
                    onChange={() => changeForm({ mode: 'pdf' })}
                  />
                  <label htmlFor={`${modeName}-pdf`}>A PDF file</label>
                </div>
              </fieldset>
              {form.mode === 'url' ? (
                <>
                  <label htmlFor={urlId}>Web page URL</label>
                  <p id={urlHint} className="hint">
                    The full address, such as https://example.org/. Pages it links to on the same
                    site are scanned too.
                  </p>
                  <input
                    id={urlId}
                    ref={urlInput}
                    type="url"
                    value={form.url}
                    spellCheck={false}
                    autoCapitalize="off"
                    aria-invalid={form.fieldError !== undefined ? true : undefined}
                    aria-describedby={fieldDescribed(urlHint)}
                    onChange={(e) => changeForm({ url: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submit();
                    }}
                  />
                </>
              ) : (
                <>
                  <label htmlFor={fileId}>PDF file</label>
                  <p id={fileHint} className="hint">
                    {UPLOAD_TIME_TEXT}
                  </p>
                  <input
                    id={fileId}
                    ref={fileInput}
                    type="file"
                    accept=".pdf,application/pdf"
                    aria-invalid={form.fieldError !== undefined ? true : undefined}
                    aria-describedby={fieldDescribed(fileHint)}
                    onChange={onFile}
                  />
                </>
              )}
              {form.fieldError !== undefined && (
                <p id={fieldErrorId} className="error">
                  {form.fieldError}
                </p>
              )}
              {form.mode === 'url' && usable && (
                <div className="choice">
                  {covered ? (
                    <>
                      <input
                        id={tierId}
                        type="checkbox"
                        checked={form.useVerified}
                        onChange={(e) => changeForm({ useVerified: e.target.checked })}
                      />
                      <label htmlFor={tierId}>{VERIFIED_OPTION}</label>
                      <p className="hint">
                        Your verification of {t(usable.host)} lasts until{' '}
                        {localTime(usable.expiresAt)}.
                      </p>
                    </>
                  ) : (
                    <p className="hint">
                      Your verification covers {t(usable.host)} only: a URL on that host can be
                      scanned on the verified tier.
                    </p>
                  )}
                </div>
              )}
              <label htmlFor={profileId}>Profile</label>
              <select
                id={profileId}
                value={form.profile}
                onChange={(e) => changeForm({ profile: e.target.value as ProfileId })}
              >
                {HOSTED_PROFILES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  aria-disabled={sending !== undefined || gate.waiting}
                  onClick={() => void submit()}
                >
                  Start scan
                </button>
              </div>
            </>
          )}
          {phase.kind === 'following' && (
            <div className="actions">
              <button
                type="button"
                aria-disabled={phase.cancelling === true}
                onClick={() => void cancel()}
              >
                Cancel scan
              </button>
            </div>
          )}
          {phase.kind === 'done' && job && (
            <>
              {phase.report && <p>{reportLead(phase.report.report)}</p>}
              <ul className="downloads">
                <li>
                  <SiteLink href={reportPath(job.id, 'json')}>Download the JSON report</SiteLink>
                </li>
                <li>
                  <SiteLink href={reportPath(job.id, 'html')}>Download the HTML report</SiteLink>
                </li>
              </ul>
              <p className="hint">{DOWNLOAD_NOTE}</p>
            </>
          )}
          {phase.kind === 'ended' && <p>{endedText(phase.job)}</p>}
          {(phase.kind === 'done' || phase.kind === 'ended') && (
            <div className="actions">
              <button type="button" onClick={startAgain}>
                Start a new scan
              </button>
            </div>
          )}
          <p role="alert" className="error">
            {alert ?? ''}
          </p>
        </section>
        {phase.kind === 'done' && phase.report && (
          <>
            <p className="disclaimer">{DISCLAIMER}</p>
            <ReportView
              report={phase.report.report}
              data={data}
              screenshots={phase.report.screenshots}
              attachments={phase.report.attachments}
            />
          </>
        )}
        <VerifyView verification={verification} onVerification={setVerification} env={env} />
      </main>
      <footer>
        <ul className="downloads">
          <li>
            <SiteLink href="/about-scanner">About the scanner</SiteLink>
          </li>
          <li>
            <SiteLink href="/THIRD-PARTY-LICENSES.txt">Third-party licenses</SiteLink>
          </li>
        </ul>
      </footer>
    </>
  );
}
