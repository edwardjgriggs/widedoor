import { useContext, useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import type { ProfileId } from '@widedoor/core/browser';
import { plural, visibleText } from '@widedoor/report/browser';
import {
  ApiError,
  cancelScan,
  failure,
  getScan,
  isAborted,
  startScan,
  upload,
  type Job,
} from './api.js';
import { Initial } from './initial.js';

/*
 * The Scan screen: URLs and PDF files to scan with a profile, as a scan job
 * of widedoor ui. Each PDF is uploaded before the scan starts, and Cancel
 * stops the uploads too (a job whose start answer comes after a Cancel is
 * cancelled at once). Progress goes to a polite status region and errors
 * to an alert; the job is polled about once a second until it is done,
 * failed or cancelled, and a failed poll is tried again a few times before
 * the screen says so (Cancel stays usable). Every string from the server or
 * a file name is shown through visibleText, as text only.
 */

const t = (value: unknown) => visibleText(value);

/** The profile choices; '' leaves the profile to widedoor.config.yaml (and its default). */
export const PROFILES: readonly { id: ProfileId | ''; label: string }[] = [
  { id: '', label: 'As in widedoor.config.yaml' },
  { id: '508+wcag21aa', label: 'Section 508 and WCAG 2.1 AA (508+wcag21aa)' },
  { id: '508', label: 'Section 508 (508)' },
  { id: 'wcag21aa', label: 'WCAG 2.1 AA (wcag21aa)' },
];

/** How often a running scan is asked for its progress. */
export const POLL_MS = 1000;
/** Failed polls in a row tried again (after 1, 2 and 4 s) before the screen gives up following. */
export const POLL_RETRIES = 3;

export type FileState =
  | { status: 'waiting' }
  | { status: 'uploading' }
  | { status: 'uploaded'; id: string }
  | { status: 'refused'; message: string };

export interface PdfEntry {
  file: File;
  state: FileState;
}

export interface ScanState {
  phase: 'idle' | 'uploading' | 'scanning';
  job?: Job;
  /** The status region's text. */
  status: string;
  /** The alert region's text. */
  error?: string;
}

export const DONE_TEXT =
  'The scan finished. The Report screen shows its report, and the Checklist screen its items to check by hand.';
export const DONE_NOT_LOADED =
  'The scan finished, but its report could not be loaded. The Report screen says why.';
export const CANCELLED_EARLY = 'The scan was cancelled before it started.';

/** The URLs in the box: one per line, trimmed, blank lines dropped. */
export const urlLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** A file name the server takes for a PDF upload (letters, digits, dots, dashes, underscores). */
export function pdfName(name: string): string | undefined {
  const base = name
    .replace(/\.pdf$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 80);
  return base === '' ? undefined : `${base}.pdf`;
}

/**
 * The upload names of the files of one scan: pdfName, made unique (the
 * server refuses two with one name, case aside) with -2, -3 and so on.
 */
export function pdfNames(names: readonly string[]): (string | undefined)[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const base = pdfName(name);
    if (base === undefined) return undefined;
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++)
      candidate = `${base.slice(0, -4)}-${n}.pdf`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

/** The status line for a job that has not ended. */
export function progressText(job: Job): string {
  if (job.cancelling) return 'Cancelling the scan.';
  if (job.status === 'queued') return 'The scan is queued.';
  const { done, known, current } = job.progress;
  if (current === undefined)
    return known === 0 ? 'Starting the scan.' : `Scanned ${done} of ${known}.`;
  return `Scanning ${Math.min(done + 1, known)} of ${known}: ${t(current)}`;
}

/** A server message as a sentence: capital first letter, full stop at the end. */
const sentence = (text: string) => {
  const s = t(text);
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}`;
};

const fileStateText = (state: FileState): string =>
  state.status === 'waiting'
    ? 'waiting'
    : state.status === 'uploading'
      ? 'uploading'
      : state.status === 'uploaded'
        ? 'uploaded'
        : 'refused (see the message below)';

export type ScanEnd = 'done' | 'failed' | 'cancelled';

export interface ScanViewProps {
  /**
   * Called once a job ends. For a done job it loads the new report and
   * resolves with whether that worked; the screen words its status by it.
   */
  onEnded: (end: ScanEnd) => Promise<boolean>;
}

export function ScanView({ onEnded }: ScanViewProps) {
  const initial = useContext(Initial).scan;
  const [urls, setUrls] = useState(initial?.urls ?? '');
  const [profile, setProfile] = useState(initial?.profile ?? '');
  const [pdfs, setPdfs] = useState<PdfEntry[]>(initial?.pdfs ?? []);
  const [state, setState] = useState<ScanState>(initial?.state ?? { phase: 'idle', status: '' });
  const urlsId = useId();
  const countId = useId();
  const pdfId = useId();
  const profileId = useId();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A start in progress (uploads, then the start request), which Cancel aborts.
  const starting = useRef<AbortController>(undefined);
  // The job whose end was handled: a late poll answer for it is ignored, so onEnded runs once.
  const ended = useRef<string>(undefined);
  // Failed polls in a row.
  const failedPolls = useRef(0);
  // False once the screen is gone (the session ended), so no late answer sets state.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimeout(timer.current);
      starting.current?.abort();
    };
  }, []);

  const busy = state.phase !== 'idle';
  const listed = urlLines(urls);
  const setFile = (file: File, next: FileState) =>
    setPdfs((list) => list.map((p) => (p.file === file ? { file, state: next } : p)));
  /** After a finished or failed job the server has deleted its uploads; a cancelled one keeps them. */
  const forgetUploads = () =>
    setPdfs((list) => list.map((p) => ({ file: p.file, state: { status: 'waiting' } })));

  const pollLater = (id: string, ms = POLL_MS) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void poll(id), ms);
  };

  const follow = async (job: Job) => {
    if (!live.current || ended.current === job.id) return;
    failedPolls.current = 0;
    if (job.status === 'queued' || job.status === 'running') {
      setState({ phase: 'scanning', job, status: progressText(job) });
      pollLater(job.id);
      return;
    }
    ended.current = job.id;
    if (job.status === 'done') {
      forgetUploads();
      setState({ phase: 'idle', job, status: 'The scan finished. Loading its report.' });
      const loaded = await onEnded('done');
      if (live.current)
        setState({ phase: 'idle', job, status: loaded ? DONE_TEXT : DONE_NOT_LOADED });
    } else if (job.status === 'cancelled') {
      setState({ phase: 'idle', job, status: 'The scan was cancelled.' });
      void onEnded('cancelled');
    } else {
      forgetUploads();
      setState({ phase: 'idle', job, status: '', error: sentence(job.error ?? 'the scan failed') });
      void onEnded('failed');
    }
  };

  const poll = async (id: string) => {
    let job: Job;
    try {
      job = await getScan(id);
    } catch (e) {
      if (!live.current) return;
      if (e instanceof ApiError && e.status === 401) return;
      if (++failedPolls.current <= POLL_RETRIES) {
        pollLater(id, POLL_MS * 2 ** (failedPolls.current - 1));
        return;
      }
      // Still scanning as far as anyone knows: Cancel stays usable, and starts following again.
      setState((s) => ({
        ...s,
        status: '',
        error: `${failure('The scan could not be followed', e)} Cancel it, or reload the page to see how it ended.`,
      }));
      return;
    }
    await follow(job);
  };

  const start = async () => {
    if (busy) return;
    const controller = new AbortController();
    starting.current = controller;
    ended.current = undefined;
    setState({ phase: 'uploading', status: '' });
    const ids: string[] = [];
    const names = pdfNames(pdfs.map((p) => p.file.name));
    for (const [i, entry] of pdfs.entries()) {
      if (entry.state.status === 'uploaded') {
        ids.push(entry.state.id);
        continue;
      }
      setFile(entry.file, { status: 'uploading' });
      setState({
        phase: 'uploading',
        status: `Uploading PDF ${i + 1} of ${pdfs.length}: ${t(entry.file.name)}`,
      });
      try {
        const id = await upload('pdf', entry.file, names[i], controller.signal);
        ids.push(id);
        setFile(entry.file, { status: 'uploaded', id });
      } catch (e) {
        if (!live.current) return;
        if (isAborted(e)) {
          setFile(entry.file, { status: 'waiting' });
          setState({ phase: 'idle', status: CANCELLED_EARLY });
          return;
        }
        const message = failure(`${entry.file.name} could not be uploaded`, e);
        setFile(entry.file, { status: 'refused', message });
        setState({ phase: 'idle', status: '', error: message });
        return;
      }
      if (!live.current) return;
    }
    if (controller.signal.aborted) {
      starting.current = undefined;
      setState({ phase: 'idle', status: CANCELLED_EARLY });
      return;
    }
    let job: Job;
    try {
      job = await startScan({
        ...(listed.length > 0 ? { urls: listed } : {}),
        ...(ids.length > 0 ? { pdfs: ids } : {}),
        ...(profile !== '' ? { profile: profile as ProfileId } : {}),
      });
    } catch (e) {
      starting.current = undefined;
      if (live.current)
        setState({ phase: 'idle', status: '', error: failure('The scan could not start', e) });
      return;
    }
    starting.current = undefined;
    if (!live.current) return;
    // Cancel came while the start request was on its way: the job exists, so cancel it now.
    if (controller.signal.aborted) {
      setState({ phase: 'scanning', job, status: 'Cancelling the scan.' });
      try {
        await cancelScan(job.id);
      } catch {
        // Ended already (409), or the next poll says how it went.
      }
      if (live.current) pollLater(job.id, 0);
      return;
    }
    await follow(job);
  };

  const cancel = async () => {
    if (state.phase === 'uploading') {
      starting.current?.abort();
      return;
    }
    const id = state.job?.id;
    if (state.phase !== 'scanning' || id === undefined) return;
    try {
      const job = await cancelScan(id);
      if (live.current && job.status !== 'done')
        setState((s) =>
          s.phase === 'scanning' ? { ...s, status: progressText(job), error: '' } : s,
        );
    } catch (e) {
      // 409: it ended meanwhile; following it again says how.
      if (!(e instanceof ApiError && e.status === 409)) {
        if (live.current)
          setState((s) => ({ ...s, error: failure('The scan could not be cancelled', e) }));
        return;
      }
    }
    if (live.current) {
      failedPolls.current = 0;
      pollLater(id, 0);
    }
  };

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    setPdfs(files.map((file) => ({ file, state: { status: 'waiting' } })));
  };

  return (
    <>
      <section aria-labelledby="scan-what" className="tools">
        <h2 id="scan-what">What to scan</h2>
        <p>
          Leave both the URLs and the PDF files empty to scan the scope in widedoor.config.yaml.
          Everything else (sign-in, crawl rules, page caps) comes from that file.
        </p>
        <label htmlFor={urlsId}>Web page URLs, one per line</label>
        <textarea
          id={urlsId}
          rows={6}
          value={urls}
          disabled={busy}
          spellCheck={false}
          aria-describedby={countId}
          onChange={(e) => setUrls(e.target.value)}
        />
        <p id={countId}>{plural(listed.length, 'URL', 'URLs')} listed.</p>
        <label htmlFor={pdfId}>PDF files</label>
        <input
          id={pdfId}
          type="file"
          multiple
          accept=".pdf,application/pdf"
          disabled={busy}
          onChange={onFiles}
        />
        {pdfs.length > 0 && (
          <ul className="files">
            {pdfs.map((p, i) => (
              <li key={i}>
                {t(p.file.name)}: {fileStateText(p.state)}
              </li>
            ))}
          </ul>
        )}
        <label htmlFor={profileId}>Profile</label>
        <select
          id={profileId}
          value={profile}
          disabled={busy}
          onChange={(e) => setProfile(e.target.value)}
        >
          {PROFILES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <div className="actions">
          <button type="button" aria-disabled={busy} onClick={() => void start()}>
            Start scan
          </button>
          <button type="button" aria-disabled={!busy} onClick={() => void cancel()}>
            Cancel scan
          </button>
        </div>
      </section>
      <p role="status" className="progress">
        {t(state.status)}
      </p>
      <p role="alert" className="error">
        {t(state.error ?? '')}
      </p>
    </>
  );
}
