import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { plural, visibleText } from '@widedoor/report/browser';
import type {
  AiAvailability,
  AiSuggestionEntry,
  AiSuggestionsDoc,
} from '../../server/src/ai-types.ts';
import {
  download,
  failure,
  previewSuggestions,
  runSuggestions,
  type SuggestionsPreview,
} from './api.js';

/*
 * AI fix suggestions on the Report screen, shown only when GET /api/ai says
 * they are available (widedoor ui was started with ai.enabled and a key; the
 * key stays in the terminal's process). Nothing is sent before a confirm step
 * that names the provider and the model and shows exactly what would be sent
 * (the server's dry run); Cancel has the focus. Results render as text only,
 * with the AI-generated label on every entry and patches in <pre>; there is
 * no link and no "apply" button. Focus never drops to the page (WCAG 2.4.3):
 * Cancel returns it to the button that opened the step, Send moves it to the
 * status line, then to the results heading or the error.
 */

const t = (value: unknown) => visibleText(value);

/** What the user asked for: the findings named, or every failed finding; n tells two asks apart. */
export interface SuggestionsRequest {
  findingIds?: readonly string[];
  n: number;
}

export interface SuggestionsPanelProps {
  availability: AiAvailability;
  /** The dry run waiting for a decision, and what it covers. */
  confirm?: { preview: SuggestionsPreview; scope: string } | undefined;
  busy: boolean;
  result?: AiSuggestionsDoc | undefined;
  error?: string | undefined;
  status: string;
  cancelRef?: RefObject<HTMLButtonElement | null>;
  /** Focus targets: "Suggest fixes for all", the status line, the results heading, the error. */
  allRef?: RefObject<HTMLButtonElement | null>;
  statusRef?: RefObject<HTMLParagraphElement | null>;
  resultsRef?: RefObject<HTMLHeadingElement | null>;
  errorRef?: RefObject<HTMLParagraphElement | null>;
  onAll: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onDownload: (format: 'ai-suggestions.json' | 'ai-suggestions.html') => void;
}

function Entry({ e, label }: { e: AiSuggestionEntry; label: string }) {
  const s = e.suggestion;
  const r = e.request;
  return (
    <li className="finding">
      <h4>
        {t(r.ruleId)}: {e.status}
      </h4>
      <p className="label">{label}</p>
      <p>Applies to {plural(e.findingIds.length, 'finding', 'findings')}.</p>
      {s?.kind === 'web-patch' && (
        <>
          <p>{t(s.summary)}</p>
          <p>Replacement markup for the flagged element:</p>
          <pre>
            <code>{t(s.patch)}</code>
          </pre>
          {s.notes !== undefined && <p className="notes">{t(s.notes)}</p>}
        </>
      )}
      {s?.kind === 'pdf-steps' && (
        <>
          <p>
            {t(s.summary)} ({t(s.tool)})
          </p>
          <ol>
            {s.steps.map((step, i) => (
              <li key={i}>{t(step)}</li>
            ))}
          </ol>
        </>
      )}
      {!s && <p>{t(e.reason ?? 'No suggestion.')}</p>}
      {e.delivered ? (
        <details>
          <summary>What was sent</summary>
          <dl>
            <dt>Rule</dt>
            <dd>{t(r.ruleId)}</dd>
            <dt>Criteria</dt>
            <dd>{t(r.criteria.join(', '))}</dd>
            {r.selector !== undefined && (
              <>
                <dt>Selector</dt>
                <dd>{t(r.selector)}</dd>
              </>
            )}
            {r.page !== undefined && (
              <>
                <dt>Page</dt>
                <dd>{r.page}</dd>
              </>
            )}
            {r.structPath !== undefined && (
              <>
                <dt>Structure path</dt>
                <dd>{t(r.structPath)}</dd>
              </>
            )}
          </dl>
          {r.snippet !== undefined && (
            <pre>
              <code>{t(r.snippet)}</code>
            </pre>
          )}
        </details>
      ) : (
        <p>Not sent; nothing of it left this machine.</p>
      )}
    </li>
  );
}

/** The panel itself, from its state: rendered statically by the tests. */
export function SuggestionsPanel({
  availability,
  confirm,
  busy,
  result,
  error,
  status,
  cancelRef,
  allRef,
  statusRef,
  resultsRef,
  errorRef,
  onAll,
  onConfirm,
  onCancel,
  onDownload,
}: SuggestionsPanelProps) {
  const confirmId = useId();
  if (!availability.available) return null;
  const provider = `${t(availability.provider ?? '')} (${t(availability.model ?? '')})`;
  return (
    <section aria-labelledby="ai" className="tools">
      <h2 id="ai">AI fix suggestions</h2>
      <p>
        Asks {provider} for a fix for failed checks. Only redacted snippets are sent: no page
        address, no full page and no PDF text. Suggestions are AI-generated: review them before use.
        They never change the report.
      </p>
      <div className="actions">
        <button type="button" ref={allRef} onClick={onAll} disabled={busy || confirm !== undefined}>
          Suggest fixes for all
        </button>
      </div>
      <p role="status" ref={statusRef} tabIndex={-1}>
        {status}
      </p>
      {error && (
        <p role="alert" className="error" ref={errorRef} tabIndex={-1}>
          {t(error)}
        </p>
      )}
      {confirm && (
        <section aria-labelledby={confirmId} className="confirm">
          <h3 id={confirmId}>Send to {provider}?</h3>
          <p>
            This sends {plural(confirm.preview.messages.length, 'request', 'requests')} for{' '}
            {t(confirm.scope)}, about {confirm.preview.estimatedInputTokens} input tokens.
            {confirm.preview.skipped > 0 &&
              ` ${plural(confirm.preview.skipped, 'group is', 'groups are')} past the group limit and would not be sent.`}
          </p>
          <details>
            <summary>Exactly what will be sent</summary>
            <p>
              Each request carries a fresh random nonce in place of the zeros shown here; nothing
              else changes.
            </p>
            <p>Instructions:</p>
            <pre>
              <code>{t(confirm.preview.system)}</code>
            </pre>
            {confirm.preview.messages.map((m, i) => (
              <div key={i}>
                <p>
                  Request {i + 1} of {confirm.preview.messages.length}:
                </p>
                <pre>
                  <code>{t(m)}</code>
                </pre>
              </div>
            ))}
          </details>
          <div className="actions">
            <button type="button" ref={cancelRef} onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={confirm.preview.messages.length === 0}
            >
              Send {plural(confirm.preview.messages.length, 'request', 'requests')}
            </button>
          </div>
        </section>
      )}
      {result && (
        <section aria-labelledby="ai-results">
          <h3 id="ai-results" ref={resultsRef} tabIndex={-1}>
            Suggestions
          </h3>
          <p className="label">{result.label}</p>
          <p>
            {plural(result.totals.requests, 'request', 'requests')} sent to {t(result.provider)} (
            {t(result.modelAnswered ?? result.model)}).
            {result.totals.skippedGroups > 0 &&
              ` ${plural(result.totals.skippedGroups, 'group was', 'groups were')} past the group limit and not sent.`}
          </p>
          <ol className="findings">
            {result.entries.map((e) => (
              <Entry key={e.group} e={e} label={result.label} />
            ))}
          </ol>
          <div className="actions">
            <button type="button" onClick={() => onDownload('ai-suggestions.json')}>
              Download ai-suggestions.json
            </button>
            <button type="button" onClick={() => onDownload('ai-suggestions.html')}>
              Download ai-suggestions.html
            </button>
          </div>
        </section>
      )}
    </section>
  );
}

/**
 * The panel with its calls: a request (from a finding's button or "Suggest
 * fixes for all") runs the dry run and opens the confirm step; Send asks the
 * server for the suggestions.
 */
export function SuggestionsView({
  availability,
  request,
  onRequest,
  onLock,
}: {
  availability: AiAvailability;
  request?: SuggestionsRequest | undefined;
  onRequest: (request: SuggestionsRequest) => void;
  /** Told when a suggestion starts being prepared, confirmed or run (true) and when that ends. */
  onLock?: (locked: boolean) => void;
}) {
  const [confirm, setConfirm] = useState<SuggestionsPanelProps['confirm']>();
  const [asked, setAsked] = useState<readonly string[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiSuggestionsDoc>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState('');
  const [focusTo, setFocusTo] = useState<'opener' | 'status' | 'results' | 'error'>();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const allRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const resultsRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  // The control that asked: a finding's button or "Suggest fixes for all".
  const openerRef = useRef<HTMLElement | null>(null);
  const lockRef = useRef(onLock);
  lockRef.current = onLock;
  // Each change of state goes with its lock change in one render, so a button the step
  // re-enables is enabled by the time the focus moves back to it.
  const lock = (locked: boolean) => lockRef.current?.(locked);

  useEffect(() => {
    if (!request || !availability.available) return;
    let live = true;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    lock(true);
    setError(undefined);
    setBusy(true);
    setStatus('Working out what would be sent.');
    previewSuggestions(request.findingIds).then(
      (preview) => {
        if (!live) return;
        setAsked(request.findingIds);
        setConfirm({
          preview,
          scope:
            request.findingIds === undefined
              ? 'every failed check'
              : plural(request.findingIds.length, 'finding', 'findings'),
        });
        setStatus('Check what will be sent, then send it or cancel.');
        setBusy(false);
      },
      (e: unknown) => {
        if (!live) return;
        setError(failure('The suggestions could not be prepared', e));
        setStatus('');
        setBusy(false);
        lock(false);
        setFocusTo('error');
      },
    );
    return () => {
      live = false;
    };
  }, [request, availability.available]);

  // Cancel has the focus when the confirm step opens.
  useEffect(() => {
    if (confirm) cancelRef.current?.focus();
  }, [confirm]);

  // Focus moves once the render that shows its target is on the page.
  useEffect(() => {
    if (focusTo === undefined) return;
    const opener = openerRef.current;
    const target =
      focusTo === 'opener'
        ? opener?.isConnected && !opener.matches(':disabled')
          ? opener
          : allRef.current
        : focusTo === 'status'
          ? statusRef.current
          : focusTo === 'results'
            ? resultsRef.current
            : errorRef.current;
    target?.focus();
    setFocusTo(undefined);
  }, [focusTo]);

  const onConfirm = async () => {
    setConfirm(undefined);
    setBusy(true);
    setStatus('Asking for suggestions. This can take a minute.');
    setFocusTo('status');
    try {
      const doc = await runSuggestions(asked);
      setResult(doc);
      const ok = doc.entries.filter((e) => e.status === 'ok').length;
      setStatus(`Suggestions ready: ${ok} of ${doc.entries.length} groups got one.`);
      setFocusTo('results');
    } catch (e) {
      setError(failure('The suggestions could not be made', e));
      setStatus('');
      setFocusTo('error');
    } finally {
      setBusy(false);
      lock(false);
    }
  };

  const onCancel = () => {
    setConfirm(undefined);
    setStatus('Cancelled; nothing was sent.');
    lock(false);
    setFocusTo('opener');
  };

  const onDownload = (format: 'ai-suggestions.json' | 'ai-suggestions.html') => {
    download(format, format).catch((e: unknown) =>
      setError(failure(`${format} could not be downloaded`, e)),
    );
  };

  return (
    <SuggestionsPanel
      availability={availability}
      confirm={confirm}
      busy={busy}
      result={result}
      error={error}
      status={status}
      cancelRef={cancelRef}
      allRef={allRef}
      statusRef={statusRef}
      resultsRef={resultsRef}
      errorRef={errorRef}
      onAll={() => onRequest({ n: (request?.n ?? 0) + 1 })}
      onConfirm={() => void onConfirm()}
      onCancel={onCancel}
      onDownload={onDownload}
    />
  );
}
