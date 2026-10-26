import { useContext, useId, useRef, useState, type ChangeEvent } from 'react';
import { visibleText } from '@widedoor/report/browser';
import { OUTCOMES, failure, recordReview, upload, type ChecklistEntry } from './api.js';
import { Initial } from './initial.js';

/*
 * The review form, opened inline under a checklist item: the outcome, notes,
 * the reviewer's name (remembered in this browser), an override checkbox per
 * related automated fail, and images to attach. Images are uploaded first;
 * the server's refusal is shown as text. A missing outcome or name marks its
 * field invalid, points it at the message and moves focus there; the alert
 * is rendered again for each attempt, so the same message is announced
 * again. Nothing here is a <form>: the CSP has form-action 'none', and the
 * buttons record through api.ts.
 */

const t = (value: unknown) => visibleText(value);

export const OUTCOME_LABEL: Record<(typeof OUTCOMES)[number], string> = {
  pass: 'Pass',
  fail: 'Fail',
  'not-applicable': 'Not applicable',
};

/** Where the reviewer's name is remembered. Storage can be off or blocked; every access is guarded. */
export const REVIEWER_KEY = 'widedoor-reviewer';

export function rememberedReviewer(): string {
  try {
    return window.localStorage.getItem(REVIEWER_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberReviewer(name: string): void {
  try {
    window.localStorage.setItem(REVIEWER_KEY, name);
  } catch {
    // Not remembered; the form still works.
  }
}

/** An automated fail the review may set aside, with the label that names its rule and asset. */
export interface Overridable {
  id: string;
  label: string;
}

type ImageState =
  | { status: 'waiting' }
  | { status: 'uploaded'; id: string }
  | { status: 'refused'; message: string };

interface ImageEntry {
  file: File;
  state: ImageState;
}

type Invalid = 'outcome' | 'reviewer' | undefined;

export interface ReviewFormProps {
  /** The id the item's toggle button points to (aria-controls). */
  id: string;
  item: ChecklistEntry;
  /** The related automated fails, each a checkbox. */
  overridable: readonly Overridable[];
  /** Called with the item's id once the record is written (201). */
  onRecorded: (item: string) => void;
  onCancel: () => void;
}

export function ReviewForm({ id, item, overridable, onRecorded, onCancel }: ReviewFormProps) {
  const initial = useContext(Initial).review;
  const [outcome, setOutcome] = useState(initial?.outcome);
  const [notes, setNotes] = useState('');
  const [reviewer, setReviewer] = useState(() => initial?.reviewer ?? rememberedReviewer());
  const [overrides, setOverrides] = useState<ReadonlySet<string>>(new Set());
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [error, setError] = useState(initial?.error ?? '');
  const [invalid, setInvalid] = useState<Invalid>();
  // Each attempt renders the alert afresh, so a repeated message is announced again.
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const name = useId();
  const errorId = useId();
  const notesId = useId();
  const notesHint = useId();
  const reviewerId = useId();
  const imagesId = useId();
  const firstRadio = useRef<HTMLInputElement>(null);
  const reviewerRef = useRef<HTMLInputElement>(null);

  const toggle = (fail: string, on: boolean) =>
    setOverrides((set) => {
      const next = new Set(set);
      if (on) next.add(fail);
      else next.delete(fail);
      return next;
    });
  const onImages = (e: ChangeEvent<HTMLInputElement>) =>
    setImages([...(e.target.files ?? [])].map((file) => ({ file, state: { status: 'waiting' } })));
  const setImage = (file: File, state: ImageState) =>
    setImages((list) => list.map((x) => (x.file === file ? { file, state } : x)));
  const refuse = (message: string, field?: Invalid) => {
    setAttempt((n) => n + 1);
    setError(message);
    setInvalid(field);
    if (field === 'outcome') firstRadio.current?.focus();
    if (field === 'reviewer') reviewerRef.current?.focus();
  };

  const submit = async () => {
    if (busy) return;
    if (outcome === undefined) return refuse('Choose an outcome.', 'outcome');
    if (reviewer.trim() === '') return refuse('Enter the reviewer name.', 'reviewer');
    setBusy(true);
    setError('');
    setInvalid(undefined);
    const attachments: string[] = [];
    for (const image of images) {
      if (image.state.status === 'uploaded') {
        attachments.push(image.state.id);
        continue;
      }
      try {
        const uploaded = await upload('image', image.file);
        attachments.push(uploaded);
        setImage(image.file, { status: 'uploaded', id: uploaded });
      } catch (e) {
        const message = failure(`${image.file.name} could not be attached`, e);
        setImage(image.file, { status: 'refused', message });
        refuse(message);
        setBusy(false);
        return;
      }
    }
    try {
      await recordReview({
        item: item.id,
        outcome,
        reviewer: reviewer.trim(),
        ...(notes.trim() !== '' ? { notes: notes.trim() } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(overrides.size > 0 ? { overrides: [...overrides] } : {}),
      });
    } catch (e) {
      refuse(failure('The result could not be recorded', e));
      setBusy(false);
      return;
    }
    rememberReviewer(reviewer.trim());
    onRecorded(item.id);
  };

  const describedBy = (field: Invalid, ...ids: string[]) =>
    [...ids, ...(invalid === field ? [errorId] : [])].join(' ') || undefined;

  return (
    <div id={id} className="review">
      <fieldset>
        <legend>Outcome</legend>
        {OUTCOMES.map((o, i) => (
          <div key={o} className="choice">
            <input
              type="radio"
              id={`${name}-${o}`}
              ref={i === 0 ? firstRadio : undefined}
              name={name}
              value={o}
              checked={outcome === o}
              aria-invalid={invalid === 'outcome' || undefined}
              aria-describedby={describedBy('outcome')}
              onChange={() => {
                setOutcome(o);
                if (invalid === 'outcome') setInvalid(undefined);
              }}
            />
            <label htmlFor={`${name}-${o}`}>{OUTCOME_LABEL[o]}</label>
          </div>
        ))}
      </fieldset>
      <label htmlFor={notesId}>Notes</label>
      <textarea
        id={notesId}
        rows={4}
        value={notes}
        aria-describedby={notesHint}
        onChange={(e) => setNotes(e.target.value)}
      />
      <p id={notesHint} className="hint">
        Needed for Not applicable (say why) and for setting aside an automated fail.
      </p>
      <label htmlFor={reviewerId}>Reviewer name</label>
      <input
        id={reviewerId}
        ref={reviewerRef}
        type="text"
        autoComplete="name"
        value={reviewer}
        aria-invalid={invalid === 'reviewer' || undefined}
        aria-describedby={describedBy('reviewer')}
        onChange={(e) => {
          setReviewer(e.target.value);
          if (invalid === 'reviewer') setInvalid(undefined);
        }}
      />
      {overridable.length > 0 && (
        <fieldset>
          <legend>Automated fails to set aside as false positives (with a Pass)</legend>
          {overridable.map((f) => (
            <div key={f.id} className="choice">
              <input
                type="checkbox"
                id={`${name}-${f.id}`}
                checked={overrides.has(f.id)}
                onChange={(e) => toggle(f.id, e.target.checked)}
              />
              <label htmlFor={`${name}-${f.id}`}>{t(f.label)}</label>
            </div>
          ))}
        </fieldset>
      )}
      <label htmlFor={imagesId}>Images to attach (PNG or JPEG, optional)</label>
      <input
        id={imagesId}
        type="file"
        multiple
        accept=".png,.jpg,.jpeg,image/png,image/jpeg"
        onChange={onImages}
      />
      {images.length > 0 && (
        <ul className="files">
          {images.map((x, i) => (
            <li key={i}>
              {t(x.file.name)}:{' '}
              {x.state.status === 'waiting'
                ? 'not uploaded yet'
                : x.state.status === 'uploaded'
                  ? 'uploaded'
                  : 'refused (see the message below)'}
            </li>
          ))}
        </ul>
      )}
      <p key={attempt} id={errorId} role="alert" className="error">
        {t(error)}
      </p>
      <div className="actions">
        <button type="button" aria-disabled={busy} onClick={() => void submit()}>
          Record result
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
