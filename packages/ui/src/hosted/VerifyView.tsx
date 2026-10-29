import { useContext, useEffect, useId, useRef, useState } from 'react';
import { visibleText } from '@widedoor/report/browser';
import { HostedError, createVerification, type Created } from './api.js';
import { runCheck } from './flows.js';
import { HostedInitial } from './initial.js';
import { VERIFIED_MAX_PAGES } from './limits.js';
import type { PollEnv } from './poll.js';
import { useRetryGate } from './retry.js';
import { forgetVerification, saveVerification } from './storage.js';
import {
  TOKEN_NOTE,
  VERIFY_TIMEOUT,
  isUsable,
  localTime,
  refusalText,
  retryText,
  triedText,
  type VerificationState,
} from './text.js';

/*
 * "Scan more of a site you own", collapsed until opened (or while there is a
 * verification). The user names a host and gets its token, shown in the
 * three ways the API gives it to publish, each with a Copy button (the text
 * stays selectable when the clipboard is off). Check asks the API: DNS TXT
 * answers at once, the other two are checked by a scan machine while the
 * page polls (R48). What each method found is listed as text. The
 * verification is kept in this tab's session storage without its token
 * (R47), so after a reload the methods are not shown again. Server text is
 * shown through visibleText only.
 */

const t = (value: unknown) => visibleText(value);

/** What the section says besides the verification itself. */
export interface VerifyNote {
  /** The live region's text. */
  status?: string | undefined;
  /** A refusal or failure, in the alert. */
  error?: string | undefined;
  /** The host field's own error. */
  hostError?: string | undefined;
  /** Polling ran out of time. */
  timedOut?: boolean | undefined;
  /** Until when a 429 or 503 asked the page to wait (render tests). */
  retryAt?: number | undefined;
}

export interface VerifyViewProps {
  verification: VerificationState | undefined;
  onVerification: (v: VerificationState | undefined) => void;
  env: () => PollEnv;
}

export const STATUS_TEXT = {
  pending: 'Not checked yet.',
  checking: 'Checking. This can take a minute or two.',
  verified: 'Verified.',
  failed: 'Not verified yet.',
  expired: 'This verification has expired.',
} as const;

export const GONE = 'The scanner no longer knows that verification. Start a new one.';

/** One value to publish, as selectable text with its Copy button. */
function Copyable({
  label,
  value,
  onCopied,
}: {
  label: string;
  value: string;
  onCopied: (text: string) => void;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      onCopied(`Copied the ${label}.`);
    } catch {
      onCopied(`Copying did not work. Select the ${label} and copy it.`);
    }
  };
  return (
    <div className="copyable">
      <code>{t(value)}</code>
      <button type="button" onClick={() => void copy()}>
        Copy the {label}
      </button>
    </div>
  );
}

export function VerifyView({ verification, onVerification, env }: VerifyViewProps) {
  const initial = useContext(HostedInitial);
  const [open, setOpen] = useState(initial.verification !== undefined);
  const [host, setHost] = useState('');
  const [created, setCreated] = useState<Created | undefined>(initial.created);
  const [note, setNote] = useState<VerifyNote>(initial.verify ?? {});
  const [busy, setBusy] = useState(false);
  const gate = useRetryGate(initial.verify?.retryAt);
  // A machine check is being polled.
  const [polling, setPolling] = useState(false);
  const hostId = useId();
  const hostHint = useId();
  const hostErrorId = useId();
  const stopPoll = useRef<() => void>(undefined);
  // Counts checks: a check whose number is no longer current (a newer check, or the
  // verification was dropped) changes nothing, and its poller is stopped.
  const checkRun = useRef(0);
  // A create on its way, set before any await so a second press sends nothing.
  const creating = useRef(false);
  const live = useRef(true);
  const hostInput = useRef<HTMLInputElement>(null);
  // The verification's own line, focused when a check settles it (its button goes away).
  const stateLine = useRef<HTMLParagraphElement>(null);
  const refocus = useRef(false);
  // The latest verification, for callbacks of a check started earlier.
  const current = useRef(verification);
  current.current = verification;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      stopPoll.current?.();
    };
  }, []);

  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    stateLine.current?.focus();
  });

  // A verification restored from storage opens the section (once per verification).
  const shownId = verification?.id;
  useEffect(() => {
    if (shownId !== undefined) setOpen(true);
  }, [shownId]);

  const update = (next: Partial<VerificationState>) => {
    const v = current.current;
    if (v === undefined) return;
    const merged = { ...v, ...next };
    current.current = merged;
    onVerification(merged);
    if (merged.status === 'verified' || merged.status === 'expired') refocus.current = true;
    if (merged.status === 'expired') forgetVerification();
  };

  const copied = (text: string) => setNote((n) => ({ ...n, status: text }));

  /** Forgets the verification here and in storage. */
  const drop = () => {
    // Any check in flight is abandoned: its answers are ignored and its poller stopped.
    checkRun.current++;
    stopPoll.current?.();
    stopPoll.current = undefined;
    setBusy(false);
    setPolling(false);
    forgetVerification();
    setCreated(undefined);
    onVerification(undefined);
  };

  /** The API no longer knows the verification (it was dropped): start over. */
  const gone = () => {
    drop();
    setNote({ error: GONE });
  };

  const startOver = () => {
    drop();
    setNote({});
    // The host field comes back on the next render.
    setTimeout(() => hostInput.current?.focus(), 0);
  };

  /** A refusal for the alert; a Retry-After also holds the buttons until it ends. */
  const refused = (e: unknown) => {
    if (e instanceof HostedError && e.retryAfterS !== undefined) gate.wait(e.retryAfterS);
    setNote({ error: refusalText(e) });
  };

  /** The answer to a press while the server asked the page to wait. */
  const stillWaiting = () => setNote({ error: retryText(gate.left()) });

  const create = async () => {
    if (creating.current) return;
    if (gate.waiting) return stillWaiting();
    const value = host.trim();
    if (value === '') {
      setNote({ hostError: 'Enter a host name, such as example.org.' });
      hostInput.current?.focus();
      return;
    }
    creating.current = true;
    setBusy(true);
    setNote({ status: 'Asking for a verification token.' });
    try {
      const made = await createVerification(value);
      if (!live.current) return;
      setCreated(made);
      const v: VerificationState = {
        id: made.id,
        host: made.host,
        expiresAt: made.expiresAt,
        status: 'pending',
      };
      current.current = v;
      onVerification(v);
      saveVerification(v);
      setNote({ status: `Here is the token for ${t(made.host)}. Publish it one way, then check.` });
    } catch (e) {
      if (!live.current) return;
      // A refusal of the host itself (400) belongs to the field; anything else is an alert.
      if (e instanceof HostedError && e.status === 400) {
        setNote({ hostError: t(e.message) });
        hostInput.current?.focus();
      } else refused(e);
    } finally {
      creating.current = false;
      if (live.current) setBusy(false);
    }
  };

  const check = async () => {
    const v = current.current;
    if (v === undefined || busy || polling) return;
    if (gate.waiting) return stillWaiting();
    stopPoll.current?.();
    const run = ++checkRun.current;
    const { id } = v;
    // Every answer of this check acts only while it is the current check of this verification.
    const mine = () => live.current && checkRun.current === run && current.current?.id === id;
    setBusy(true);
    setNote({ status: 'Checking.' });
    try {
      const stop = await runCheck(
        id,
        {
          status: (status) => {
            if (!mine()) return;
            update({ status });
            setPolling(status === 'checking');
            setNote({ status: STATUS_TEXT[status] });
          },
          view: (view) => {
            if (!mine()) return;
            update({
              status: view.status,
              expiresAt: view.expiresAt,
              ...(view.tried ? { tried: view.tried } : {}),
            });
            if (view.status !== 'checking') setPolling(false);
            setNote({ status: STATUS_TEXT[view.status] });
          },
          timeout: () => {
            if (!mine()) return;
            // The scanner may still finish it; Check again asks once more.
            setPolling(false);
            setNote({ timedOut: true, status: VERIFY_TIMEOUT });
          },
          error: (e) => {
            if (mine() && e.status === 404) gone();
          },
        },
        env(),
      );
      if (mine()) stopPoll.current = stop;
      else stop();
    } catch (e) {
      if (!mine()) return;
      if (e instanceof HostedError && e.status === 404) gone();
      else refused(e);
    } finally {
      if (live.current && checkRun.current === run) setBusy(false);
    }
  };

  const v = verification;
  const methods = created !== undefined && created.id === v?.id ? created.methods : undefined;
  // A verified one past its expiry reads expired before the API says so.
  const shown = v && (v.status === 'verified' && !isUsable(v, Date.now()) ? 'expired' : v.status);
  const checkable = shown === 'pending' || shown === 'failed' || shown === 'checking';

  return (
    <section aria-labelledby="verify-title" className="tools">
      <h2 id="verify-title">Scan more of a site you own</h2>
      <p>
        Prove that you control a site, and scans of it can cover up to {VERIFIED_MAX_PAGES} pages. A
        verification covers one exact host name: www.example.org and example.org are separate.
      </p>
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>Verify a host name</summary>
        {/* Rendered only while open, so nothing hidden can hold focus. */}
        {!open ? null : v === undefined || shown === undefined ? (
          <>
            <label htmlFor={hostId}>Host name</label>
            <p id={hostHint} className="hint">
              Such as example.org: no https://, no path.
            </p>
            <input
              id={hostId}
              ref={hostInput}
              type="text"
              value={host}
              spellCheck={false}
              autoCapitalize="off"
              aria-invalid={note.hostError !== undefined ? true : undefined}
              aria-describedby={
                note.hostError !== undefined ? `${hostHint} ${hostErrorId}` : hostHint
              }
              onChange={(e) => {
                setHost(e.target.value);
                setNote((n) => ({ ...n, hostError: undefined }));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create();
              }}
            />
            {note.hostError !== undefined && (
              <p id={hostErrorId} className="error">
                {note.hostError}
              </p>
            )}
            <div className="actions">
              <button
                type="button"
                aria-disabled={busy || gate.waiting}
                onClick={() => void create()}
              >
                Get a verification token
              </button>
            </div>
          </>
        ) : (
          <>
            <p ref={stateLine} tabIndex={-1}>
              Verification of <strong>{t(v.host)}</strong>: {STATUS_TEXT[shown]}
              {shown !== 'expired' && ` It expires ${localTime(v.expiresAt)}.`}
            </p>
            {shown === 'verified' && (
              <p>
                Scans of URLs on {t(v.host)} can now cover up to {VERIFIED_MAX_PAGES} pages: the
                scan form offers it.
              </p>
            )}
            {methods ? (
              <>
                <p>{TOKEN_NOTE}</p>
                <h3>Publish the token one way</h3>
                <h4>DNS TXT record</h4>
                <p>Add a TXT record with this name and value at your DNS provider.</p>
                <Copyable label="record name" value={methods.dnsTxt.name} onCopied={copied} />
                <Copyable label="record value" value={methods.dnsTxt.value} onCopied={copied} />
                <h4>Meta tag</h4>
                <p>Put this tag in the head of your home page, before the body.</p>
                <Copyable label="meta tag" value={methods.metaTag} onCopied={copied} />
                <h4>Well-known file</h4>
                <p>
                  Publish a plain text file at {t(methods.wellKnown.url)} whose first line is the
                  token.
                </p>
                <Copyable label="token" value={methods.wellKnown.body} onCopied={copied} />
              </>
            ) : (
              checkable && (
                <p>
                  The token was shown when this verification was made. If you no longer have it,
                  start a new verification.
                </p>
              )
            )}
            {v.tried !== undefined && v.tried.length > 0 && shown !== 'checking' && (
              <>
                <h3>What was tried</h3>
                <ul>
                  {v.tried.map((tried, i) => (
                    <li key={i}>{triedText(tried)}</li>
                  ))}
                </ul>
              </>
            )}
            <div className="actions">
              {checkable && (
                // Stays while a check runs (aria-disabled), so focus is never lost.
                <button
                  type="button"
                  aria-disabled={busy || polling || gate.waiting}
                  onClick={() => void check()}
                >
                  {shown === 'pending' && !note.timedOut ? 'Check now' : 'Check again'}
                </button>
              )}
              {/* Also abandons a check in flight (drop). */}
              <button type="button" onClick={startOver}>
                Start a new verification
              </button>
            </div>
          </>
        )}
      </details>
      <p role="status" className="progress">
        {note.status ?? ''}
      </p>
      <p role="alert" className="error">
        {note.error ?? ''}
      </p>
    </section>
  );
}
