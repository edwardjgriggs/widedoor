import { z } from 'zod';
import type { ChecklistItemStatus, Outcome, ProfileId } from '@widedoor/core/browser';
import { CODE_HEADER, TOKEN_HEADER } from '@widedoor/report/browser';
// Types only, from the server's browser-safe copy (no runtime code; @widedoor/ai never reaches the bundle).
import type { AiAvailability, AiProviderId, AiSuggestionsDoc } from '../../server/src/ai-types.ts';

/*
 * The only module that talks to the widedoor ui server. Every call carries
 * the per-run token (the browser adds this page's own Origin to each POST and
 * DELETE). A refusal becomes an ApiError that holds the server's short
 * message, which the screens show as text only. A 401 means the session has
 * ended: the listeners are told once, and every later call fails at once,
 * without a request. Answers go through Zod schemas before any screen reads
 * them.
 */

export const SESSION_ENDED = "This page's session has ended. Run widedoor ui again.";
export const NOT_RUNNING = 'The widedoor ui server is not running.';
export const UNREADABLE = 'The server sent an answer this page cannot read.';
export const SERVER_ERROR = 'Server error. The widedoor ui terminal shows the cause.';
/** An error in this page itself, not from the server: the terminal has nothing on it. */
export const CLIENT_ERROR = 'this page hit an error it did not expect. Reload it and try again.';
const ABORTED = 'it was cancelled.';

/**
 * A call that did not succeed: status is the HTTP status, or 0 when no
 * answer came (the server is not running, the answer could not be read, or
 * the page cancelled the call: aborted).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly aborted = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Whether a call failed because the page cancelled it. */
export const isAborted = (e: unknown): boolean => e instanceof ApiError && e.aborted;

/**
 * The message to show for a failed call, after what was being done ("The
 * scan could not start"). The server's own words for a refusal, its fixed
 * text for a 5xx, and a page-side text for anything that is not a call error.
 */
export function failure(what: string, e: unknown): string {
  if (e instanceof ApiError && e.status === 401) return SESSION_ENDED;
  const why = e instanceof ApiError ? e.message : CLIENT_ERROR;
  return `${what}: ${why}${/[.!?]$/.test(why) ? '' : '.'}`;
}

const TOKEN_KEY = 'widedoor-token';

export const REFUSED =
  'The server refused the request. Open the link widedoor ui printed in the terminal again.';

function storedToken(): string | undefined {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export type TokenResult = { token: string } | { message: string };

/**
 * The per-run token. The opened link carries a one-time code, which is
 * removed from the address bar and traded for the token once; the token then
 * stays in this tab's session storage, so a reload keeps working.
 */
async function getToken(): Promise<TokenResult> {
  const code = new URLSearchParams(window.location.search).get('code');
  if (!code) {
    const token = storedToken();
    return token
      ? { token }
      : {
          message:
            'Open a Widedoor JSON report below, or open the link widedoor ui printed (it carries an access code).',
        };
  }
  window.history.replaceState(null, '', window.location.pathname);
  let res: Response;
  try {
    res = await fetch('/api/session', {
      method: 'POST',
      headers: { [CODE_HEADER]: code },
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch {
    return { message: 'The widedoor ui server is not running. Open a report below.' };
  }
  if (!res.ok) {
    // A reload of a tab that already traded its code still has the token.
    const token = storedToken();
    if (token) return { token };
    // Only a 401 means the code was refused; anything else is some other refusal.
    return {
      message:
        res.status === 401
          ? 'This link was already used. Each link opens the viewer once: reload the tab it opened, or restart widedoor ui for a new link.'
          : REFUSED,
    };
  }
  let body: { token?: unknown } | null;
  try {
    body = (await res.json()) as { token?: unknown } | null;
  } catch {
    return { message: `${UNREADABLE} Open the link widedoor ui printed in the terminal again.` };
  }
  if (typeof body?.token !== 'string' || body.token === '')
    return { message: 'The server sent no access token.' };
  try {
    window.sessionStorage.setItem(TOKEN_KEY, body.token);
  } catch {
    // Storage can be off; the token then lasts until a reload.
  }
  return { token: body.token };
}

let token: Promise<TokenResult> | undefined;

/** The token, traded for once per page. */
export const session = (): Promise<TokenResult> => (token ??= getToken());

let ended = false;
const endListeners = new Set<() => void>();

/** Calls listener once when the session ends (a 401); returns the unsubscribe. */
export function onSessionEnded(listener: () => void): () => void {
  endListeners.add(listener);
  return () => void endListeners.delete(listener);
}

export const sessionEnded = (): boolean => ended;

function endSession(): void {
  if (ended) return;
  ended = true;
  for (const listener of [...endListeners]) listener();
}

/** Longest server message kept; the server's own refusals are far shorter. */
const MAX_MESSAGE = 1000;

interface CallInit {
  method?: 'GET' | 'POST' | 'DELETE';
  /** A JSON body. */
  json?: unknown;
  /** A raw body (an upload), sent as type. */
  raw?: { body: Blob; type: string };
  /** Cancels the call; it then fails with an aborted ApiError. */
  signal?: AbortSignal;
}

/** One call with the token. Resolves with a 2xx response; throws ApiError otherwise. */
async function call(path: string, init: CallInit = {}): Promise<Response> {
  if (ended) throw new ApiError(401, SESSION_ENDED);
  const got = await session();
  if (!('token' in got)) throw new ApiError(0, got.message);
  const headers: Record<string, string> = { [TOKEN_HEADER]: got.token };
  let body: string | Blob | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.raw) {
    headers['content-type'] = init.raw.type;
    body = init.raw.body;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {}),
      cache: 'no-store',
      credentials: 'omit',
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch {
    if (init.signal?.aborted) throw new ApiError(0, ABORTED, true);
    throw new ApiError(0, NOT_RUNNING);
  }
  if (res.status === 401) {
    endSession();
    throw new ApiError(401, SESSION_ENDED);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).trim().slice(0, MAX_MESSAGE);
    throw new ApiError(res.status, res.status >= 500 ? SERVER_ERROR : text || REFUSED);
  }
  return res;
}

async function parsed<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  try {
    return schema.parse(await res.json());
  } catch {
    throw new ApiError(0, UNREADABLE);
  }
}

/** The served report's body, unparsed (load.ts checks it), or undefined when there is none (204). */
export async function reportBody(): Promise<unknown> {
  const res = await call('/api/report');
  if (res.status === 204) return undefined;
  try {
    return await res.json();
  } catch {
    throw new ApiError(0, UNREADABLE);
  }
}

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;

const JobSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/),
  status: z.enum(JOB_STATUSES),
  progress: z.object({ done: z.int(), known: z.int(), current: z.string().optional() }),
  error: z.string().optional(),
  cancelling: z.boolean().optional(),
});
export type Job = z.infer<typeof JobSchema>;

export interface ScanRequest {
  urls?: string[];
  pdfs?: string[];
  profile?: ProfileId;
}

export const startScan = async (request: ScanRequest): Promise<Job> =>
  parsed(await call('/api/scans', { method: 'POST', json: request }), JobSchema);

export const getScan = async (id: string): Promise<Job> =>
  parsed(await call(`/api/scans/${encodeURIComponent(id)}`), JobSchema);

export const cancelScan = async (id: string): Promise<Job> =>
  parsed(await call(`/api/scans/${encodeURIComponent(id)}`, { method: 'DELETE' }), JobSchema);

const UploadSchema = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) });

/**
 * Holds a file on the server for a scan (pdf) or a review (image); resolves
 * with its upload id. The server deletes an upload nothing uses within 15
 * minutes.
 */
export async function upload(
  kind: 'pdf' | 'image',
  file: Blob,
  name?: string,
  signal?: AbortSignal,
): Promise<string> {
  const query = new URLSearchParams({ kind, ...(name !== undefined ? { name } : {}) });
  const res = await call(`/api/uploads?${query}`, {
    method: 'POST',
    raw: { body: file, type: file.type || 'application/octet-stream' },
    ...(signal ? { signal } : {}),
  });
  return (await parsed(res, UploadSchema)).id;
}

/** The checklist item statuses (core CHECKLIST_STATUSES; api.test.ts checks they agree). */
export const ITEM_STATUSES = [
  'open',
  'done',
  'expired',
  'failed-automated',
] as const satisfies readonly ChecklistItemStatus[];

/** Every finding outcome (core Outcome); a hand-edited record may carry any of them. */
const RECORD_OUTCOMES = [
  'pass',
  'fail',
  'needs-review',
  'not-applicable',
  'not-tested',
] as const satisfies readonly Outcome[];

const ChecklistItemSchema = z.object({
  id: z.string(),
  scope: z.enum(['asset', 'product']),
  asset: z.object({ uri: z.string(), kind: z.enum(['web', 'pdf']) }).optional(),
  criterion: z.object({ type: z.enum(['wcag', 'section508']), id: z.string(), title: z.string() }),
  baselineTests: z.array(z.string()),
  steps: z.array(z.string()),
  related: z.array(z.string()),
  condition: z.object({ provision: z.string(), text: z.string() }).optional(),
  status: z.enum(ITEM_STATUSES),
  review: z.string().optional(),
  /** The item's record in the review files now (server itemsWithRecords), current or expired. */
  record: z
    .object({
      outcome: z.enum(RECORD_OUTCOMES),
      reviewer: z.string(),
      date: z.string(),
      notes: z.string().optional(),
      overrides: z.int(),
      attachments: z.int(),
      current: z.boolean(),
    })
    .optional(),
});
export type ChecklistEntry = z.infer<typeof ChecklistItemSchema>;

const ChecklistSchema = z.object({
  summary: z.object({ total: z.int() }),
  items: z.array(ChecklistItemSchema),
  warnings: z.array(z.string()),
});
export type Checklist = z.infer<typeof ChecklistSchema>;

export const getChecklist = async (): Promise<Checklist> =>
  parsed(await call('/api/checklist'), ChecklistSchema);

/** Manual review outcomes (core MANUAL_OUTCOMES, which is Node-only; api.test.ts checks they agree). */
export const OUTCOMES = ['pass', 'fail', 'not-applicable'] as const;

export interface ReviewRequest {
  item: string;
  outcome: (typeof OUTCOMES)[number];
  reviewer: string;
  notes?: string;
  attachments?: string[];
  overrides?: string[];
}

const RecordedSchema = z.object({ id: z.string() });

/** Records a manual result; resolves with the new record's id. */
export const recordReview = async (review: ReviewRequest): Promise<string> =>
  (await parsed(await call('/api/reviews', { method: 'POST', json: review }), RecordedSchema)).id;

const AcrStateSchema = z.object({
  complete: z.boolean(),
  incomplete: z.array(z.string()),
  undecided: z.int(),
});
export type AcrState = z.infer<typeof AcrStateSchema>;

/** Whether an ACR export would be complete, and why not (the server's ACR builder decides). */
export const getAcrState = async (): Promise<AcrState> =>
  parsed(await call('/api/acr'), AcrStateSchema);

/**
 * Downloads an export: fetched with the token, then saved through a
 * temporary link to an object URL. The Blob is application/octet-stream
 * whatever the format, so it can only ever be saved, never shown as a
 * document; the file name keeps the extension. The URL is revoked on the
 * next task, after the click has started the download, and always.
 */
export async function download(format: string, fileName: string): Promise<void> {
  const res = await call(`/api/export/${encodeURIComponent(format)}`);
  const blob = new Blob([await res.arrayBuffer()], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

// AI fix suggestions (only when widedoor ui was started with ai.enabled and a provider key).

/**
 * A provider id by shape, not by name: the page only shows it as text, and the
 * bundle must not hold a provider's name (the build test looks for one).
 */
const ProviderSchema = z.custom<AiProviderId>(
  (v) => typeof v === 'string' && /^[a-z]{1,20}$/.test(v),
);

const AvailabilitySchema: z.ZodType<AiAvailability> = z.object({
  available: z.boolean(),
  provider: ProviderSchema.optional(),
  model: z.string().optional(),
  reason: z.string().optional(),
});

/** Whether the server can suggest fixes, with which provider and model, or why not. */
export const getAi = async (): Promise<AiAvailability> =>
  parsed(await call('/api/ai'), AvailabilitySchema);

const PreviewSchema = z.object({
  dryRun: z.literal(true),
  provider: ProviderSchema,
  model: z.string(),
  system: z.string(),
  messages: z.array(z.string()),
  estimatedInputTokens: z.int(),
  skipped: z.int(),
});
export type SuggestionsPreview = z.infer<typeof PreviewSchema>;

const SentSchema = z.object({
  ruleId: z.string(),
  criteria: z.array(z.string()),
  assetKind: z.enum(['web', 'pdf']),
  selector: z.string().optional(),
  snippet: z.string().optional(),
  page: z.int().optional(),
  structPath: z.string().optional(),
  plain: z.object({ what: z.string(), fix: z.string() }).optional(),
  redactions: z.array(z.object({ kind: z.string(), count: z.int() })),
});

const SuggestionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('web-patch'),
    summary: z.string(),
    patch: z.string(),
    notes: z.string().optional(),
  }),
  z.object({
    kind: z.literal('pdf-steps'),
    summary: z.string(),
    tool: z.enum(['word', 'indesign', 'acrobat', 'other']),
    steps: z.array(z.string()),
  }),
]);

const UsageSchema = z.object({ inputTokens: z.int(), outputTokens: z.int() });

const AiSuggestionsSchema: z.ZodType<AiSuggestionsDoc> = z.object({
  schemaVersion: z.literal(1),
  $id: z.literal('urn:widedoor:schema:ai-suggestions:v1'),
  label: z.literal(
    'AI-generated. Review before use. Suggestions do not change any result in the report.',
  ),
  provider: ProviderSchema,
  model: z.string(),
  modelAnswered: z.string().optional(),
  createdAt: z.string(),
  report: z.object({ startedAt: z.string(), findings: z.int() }),
  limits: z.object({
    maxGroups: z.int(),
    maxRequestsPerMinute: z.int(),
    concurrency: z.int(),
    maxOutputTokens: z.int(),
    maxInputTokensTotal: z.int(),
  }),
  entries: z.array(
    z.object({
      group: z.string(),
      findingIds: z.array(z.string()),
      request: SentSchema,
      delivered: z.boolean(),
      status: z.enum(['ok', 'refused', 'invalid', 'error', 'skipped-budget', 'not-sent']),
      suggestion: SuggestionSchema.optional(),
      reason: z.string().optional(),
      usage: UsageSchema.optional(),
    }),
  ),
  totals: z.object({
    requests: z.int(),
    inputTokens: z.int(),
    outputTokens: z.int(),
    skippedGroups: z.int(),
  }),
});

const suggestionsBody = (findingIds: readonly string[] | undefined, dryRun: boolean) => ({
  ...(findingIds !== undefined ? { findingIds } : {}),
  ...(dryRun ? { dryRun: true } : {}),
});

/** Exactly what a run for findingIds (or every failed finding) would send; sends nothing. */
export const previewSuggestions = async (
  findingIds?: readonly string[],
): Promise<SuggestionsPreview> =>
  parsed(
    await call('/api/suggestions', { method: 'POST', json: suggestionsBody(findingIds, true) }),
    PreviewSchema,
  );

/** Asks the provider for fix suggestions; resolves with the suggestions document. */
export const runSuggestions = async (findingIds?: readonly string[]): Promise<AiSuggestionsDoc> =>
  parsed(
    await call('/api/suggestions', { method: 'POST', json: suggestionsBody(findingIds, false) }),
    AiSuggestionsSchema,
  );
