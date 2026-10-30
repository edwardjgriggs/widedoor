import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import {
  ATTACHMENT_DIR,
  ConfigError,
  ReviewInputError,
  firstLine,
  loadReviews,
  reviewChecklist,
  safeJson,
  safeText,
} from '@widedoor/core';
import { AttachmentLoader, buildAcr, type AcrMeta, type ScanReport } from '@widedoor/report';
import type { AiAvailability, AiPreview, AiProviderId, AiSuggestionsDoc } from './ai-types.js';
import { acrMeta } from './config.js';
import { buildReport, type performScan } from './engine.js';
import { Jobs } from './jobs.js';
import { reportBodyOf, type CurrentReport } from './report-file.js';
import { rootRelative, withoutPaths } from './paths.js';
import { Refusals, type RefusalKind } from './refusals.js';
import { buildReportFiles } from './report-files.js';
import {
  checklistNotes,
  itemsWithRecords,
  recordManualReview,
  reviewFilesFingerprint,
} from './reviews.js';
import {
  RequestError,
  ReviewBodySchema,
  ScanBodySchema,
  SuggestionsBodySchema,
  hasType,
  readBody,
  readJson,
} from './requests.js';
import { loadRootConfig, planScan, removeWorkDir, runScanJob, type LocalRoot } from './scan-job.js';
import {
  CODE_HEADER,
  LOOPBACK,
  SECURITY_HEADERS,
  TOKEN_HEADER,
  hostAllowed,
  originAllowed,
  secured,
  tokenMatches,
} from './security.js';
import { ACR_FORMATS, FORMATS, UsageError, type Format } from './settings.js';
import type { StaticFile } from './static-files.js';
import {
  UPLOAD_KINDS,
  UploadError,
  Uploads,
  maxUploadBytes,
  type UploadKind,
  type UploadTimer,
} from './uploads.js';

/*
 * The widedoor ui server (ledger ruling for Task 1.5, Task 2.10). It binds
 * 127.0.0.1 on a random port and serves the built viewer, read into memory
 * at start, and the API behind a per-run token: the current report, scan
 * jobs, uploads, the review checklist, review records, whether an ACR would
 * be complete, and exports. Requests
 * whose Host header is not this server (DNS rebinding) are refused. Every
 * response, refusals and 404s included, carries the CSP and the other
 * security headers.
 *
 * The opened link carries a one-time code, not the token: the page trades it
 * for the token once (POST /api/session). A code read later from the
 * opener's command line (visible to other local users on POSIX) is dead.
 *
 * Every POST and DELETE must also come from this server's own origin
 * (Origin header) and carry a JSON body (uploads: the file itself), checked
 * in this order: Host, token, Origin, content type, size, schema.
 *
 * A scan job's report keeps what it was built from, so a recorded review is
 * applied to it at once (the report is rebuilt); a report file is shown as
 * scanned. The log hook gets one line per scan started and ended (with the
 * cause of a failure), review recorded, export served and wrong access code,
 * the counts of refused requests (Refusals), and the cause of every server
 * error (escaped first lines only; never a code, a token or a scanned string
 * beyond ids). A 500 body never carries the cause, and no refusal or job
 * error names an absolute path (withoutPaths).
 */

/** The body of every 500: the cause goes to the log, never to the page. */
export const SERVER_ERROR = 'Server error. The widedoor ui terminal shows the cause.';

/** Uploads read at once; one more is refused with 429, so buffered bodies stay bounded. */
export const MAX_UPLOADS_IN_FLIGHT = 4;

/** Exports: the media type each format is sent as. */
const EXPORT_TYPES: Readonly<Record<Format, string>> = {
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  sarif: 'application/sarif+json; charset=utf-8',
  junit: 'application/xml; charset=utf-8',
  openacr: 'application/yaml; charset=utf-8',
  'vpat-html': 'text/html; charset=utf-8',
  'vpat-docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** What an upload may be sent as, by kind. */
const UPLOAD_TYPES: Readonly<Record<UploadKind, readonly string[]>> = {
  pdf: ['application/pdf', 'application/octet-stream'],
  image: ['image/png', 'image/jpeg', 'application/octet-stream'],
};
const ANY_UPLOAD_TYPE = [...new Set(Object.values(UPLOAD_TYPES).flat())];

/**
 * AI fix suggestions, given to the local server by the CLI (widedoor ui)
 * when ai.enabled and a provider key are set. The server never loads
 * @widedoor/ai or sees a key: it only calls this object (D16, ruling 1).
 */
export interface LocalAi {
  provider: AiProviderId;
  model: string;
  /** The most finding ids one request may name (ai.maxGroups). */
  maxGroups: number;
  /** Suggests fixes for the report's fails, or only for findingIds; aborted through signal. */
  suggest(
    report: ScanReport,
    options: { findingIds?: readonly string[]; signal: AbortSignal },
  ): Promise<AiSuggestionsDoc>;
  /** What suggest would send, without sending anything. */
  preview(report: ScanReport, options: { findingIds?: readonly string[] }): AiPreview;
  /** ai-suggestions.html for a document suggest returned. */
  renderHtml(doc: AiSuggestionsDoc): string;
}

/** What the server works on; scan jobs and reviews change it. */
export interface LocalState {
  root: LocalRoot;
  current?: CurrentReport;
  jobs: Jobs;
  uploads: Uploads;
  /** Environment buildPlan reads (WIDEDOOR_STORAGE_STATE). */
  env: NodeJS.ProcessEnv;
  /** For tests; the real engine otherwise. */
  performScan?: typeof performScan;
  /** AI fix suggestions, when the CLI turned them on. */
  ai?: LocalAi;
  /** Why AI fix suggestions are off, for GET /api/ai. */
  aiUnavailable?: string;
  /** The suggestion run in progress; a new scan or the server's close aborts it. */
  aiRun?: AbortController | undefined;
  /** The last suggestions, for the current scan's report; a new scan drops them. */
  aiResult?: AiSuggestionsDoc | undefined;
}

/** Why AI is off when the CLI gave no reason. */
export const AI_OFF = 'AI fix suggestions are off.';

export interface LocalAppOptions {
  files: ReadonlyMap<string, StaticFile>;
  state: LocalState;
  token: string;
  /** The one-time code the opened link holds; POST /api/session trades it for the token once. */
  code: string;
  /** The port the server listens on (known only after listen). */
  port: () => number;
  /** Called when the right code comes again after it was traded: someone else may hold the token. */
  onCodeReuse?: () => void;
  /** Gets each log line, already escaped and starting "widedoor ui: " (runUi prints them on stderr). */
  log?: (line: string) => void;
  /** For tests; Date.now otherwise (the wrong-code log limit reads it). */
  now?: () => number;
  /** Counts refused requests; one that logs through log otherwise. */
  refusals?: Refusals;
}

/** Wrong access codes are logged at most once in this long; the next line counts the rest. */
export const WRONG_CODE_LOG_MS = 10_000;

type Status = 400 | 401 | 403 | 404 | 408 | 409 | 413 | 415 | 422 | 429 | 500;

const text = (body: string, status: Status) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

/** A refusal whose message may quote a request or a file: escaped, one line. */
const refusal = (message: string, status: Status) => text(safeText(message, 1000), status);

/** The check a refused body failed, by its status (no body here is read with a deadline yet). */
const bodyRefusal = (status: RequestError['status']): RefusalKind =>
  status === 415 ? 'type' : status === 413 ? 'size' : status === 408 ? 'timeout' : 'schema';

/** JSON with every unsafe character of scanned or review-file text escaped (safeJson). */
const json = (value: unknown, status: 200 | 201 | 202 = 200) =>
  new Response(safeJson(value, 0), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export function createLocalApp(options: LocalAppOptions): Hono {
  const { files, state, token, code, port, onCodeReuse } = options;
  const log = (line: string) => options.log?.(`widedoor ui: ${line}`);
  const now = options.now ?? Date.now;
  const refusals = options.refusals ?? new Refusals(log, now);
  /** A refusal naming files root-relative, or by name outside the root, never by absolute path. */
  const refuse = (message: string, status: Status) =>
    refusal(
      withoutPaths(message, state.root.dir, {
        folders: [state.uploads.dir, tmpdir()],
        home: homedir(),
      }),
      status,
    );
  /** Counts a refusal of kind, then refuses. */
  const refused = (kind: RefusalKind, message: string, status: Status) => {
    refusals.count(kind);
    return refuse(message, status);
  };
  const configProblem = (e: ConfigError) =>
    refuse(`${rootRelative(state.root.dir, e.file)} is not usable: ${e.problems.join('; ')}`, 422);
  /** Logs the cause of a server error and answers the fixed 500. */
  const failed = (what: string, e: unknown) => {
    log(`${safeText(what, 200)}: ${safeText(firstLine(e), 1000)}`);
    return text(SERVER_ERROR, 500);
  };
  let codeUsed = false;
  let uploading = 0;
  // Rebuilds run one after another, each with the review files as they are then.
  let rebuilding: Promise<void> = Promise.resolve();
  // The review files each live report was last built (or tried) with.
  const builtWith = new WeakMap<CurrentReport, string>();
  /** Applies the review files to the current report again, when it is a scan job's. */
  const rebuild = () =>
    (rebuilding = rebuilding.then(async () => {
      const current = state.current;
      if (current?.inputs === undefined) return;
      // Taken first: a write during the rebuild changes it again and is picked up next time.
      const files = await reviewFilesFingerprint(state.root.dir);
      try {
        const { reviews } = await loadReviews(state.root.dir);
        const { report } = buildReport(current.inputs, reviews);
        // A scan that finished meanwhile replaced the report: leave it.
        if (state.current !== current) return;
        const rebuilt = {
          ...current,
          report,
          body: reportBodyOf(report, current.evidenceDir, state.root.dir, 'live'),
        };
        builtWith.set(rebuilt, files);
        state.current = rebuilt;
      } catch (e) {
        // Not tried again (or logged again) until the review files change.
        builtWith.set(current, files);
        log(
          `the report could not be rebuilt with the recorded reviews, so it shows them as before: ${safeText(firstLine(e), 1000)}`,
        );
      }
    }));
  /**
   * Rebuilds a live report when widedoor-review/ changed since it was built,
   * by widedoor review record for one, so what is served matches the files.
   */
  const fresh = async () => {
    const current = state.current;
    if (current?.inputs === undefined) return;
    if (builtWith.get(current) === (await reviewFilesFingerprint(state.root.dir))) return;
    await rebuild();
  };
  // Wrong access codes are logged at most once per WRONG_CODE_LOG_MS, with a count of the rest.
  let wrongCodeLogged = -Infinity;
  let wrongCodesSince = 0;
  const wrongCode = () => {
    const t = now();
    if (t - wrongCodeLogged < WRONG_CODE_LOG_MS) {
      wrongCodesSince++;
      return;
    }
    const more =
      wrongCodesSince > 0
        ? ` (${wrongCodesSince} more wrong code${wrongCodesSince === 1 ? '' : 's'} since the last line)`
        : '';
    log(`refused a wrong access code${more}; if it was not a typo, someone else may be trying it`);
    wrongCodeLogged = t;
    wrongCodesSince = 0;
  };
  // Which job made the current report, so GET /api/scans/:id can include it.
  let currentJob: string | undefined;
  const app = new Hono();
  app.use(async (c, next) => {
    if (!hostAllowed(c.req.header('host'), port()))
      return refused('host', 'Forbidden: unexpected Host.', 403);
    await next();
  });
  app.post('/api/session', (c) => {
    if (!originAllowed(c.req.header('origin'), c.req.header('host')))
      return refused('origin', 'Forbidden: the request did not come from this page.', 403);
    const right = tokenMatches(c.req.header(CODE_HEADER), code);
    if (codeUsed || !right) {
      // The right code again: onCodeReuse warns. A wrong one is logged (never the code itself).
      if (codeUsed && right) onCodeReuse?.();
      else wrongCode();
      return text('Unauthorized: this link was already used or is wrong.', 401);
    }
    codeUsed = true;
    return new Response(JSON.stringify({ token }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });
  app.use('/api/*', async (c, next) => {
    if (!tokenMatches(c.req.header(TOKEN_HEADER), token))
      return refused('token', 'Unauthorized: open the link widedoor ui printed.', 401);
    // A page on another origin cannot change anything, even with the token.
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD')
      if (!originAllowed(c.req.header('origin'), c.req.header('host')))
        return refused('origin', 'Forbidden: the request did not come from this page.', 403);
    await next();
  });

  app.get('/api/report', async () => {
    await fresh();
    return state.current === undefined
      ? new Response(null, { status: 204 })
      : new Response(state.current.body, {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
  });

  app.post('/api/scans', async (c) => {
    let planned;
    try {
      const body = await readJson(c.req.raw, ScanBodySchema);
      if (state.jobs.busy)
        return refuse('a scan is already running; wait for it or cancel it', 409);
      planned = planScan(body, state.root, state.uploads, state.env);
    } catch (e) {
      if (e instanceof RequestError) return refused(bodyRefusal(e.status), e.message, e.status);
      if (e instanceof UsageError) return refuse(e.message, 400);
      if (e instanceof ConfigError) return configProblem(e);
      throw e;
    }
    const view = state.jobs.start((context) =>
      runScanJob(planned, context, {
        uploads: state.uploads,
        setCurrent: (current) => {
          const replaced = state.current?.workDir;
          state.current = current;
          // Suggestions belong to the report they were made for.
          state.aiResult = undefined;
          state.aiRun?.abort();
          currentJob = view?.id;
          if (replaced !== undefined && replaced !== current.workDir) void removeWorkDir(replaced);
        },
        ...(state.performScan ? { performScan: state.performScan } : {}),
      }),
    );
    if (view === undefined)
      return refuse('a scan is already running; wait for it or cancel it', 409);
    // A new scan stops a suggestion run for the report it will replace.
    state.aiRun?.abort();
    const { plan, pdfs } = planned;
    log(
      `scan ${view.id} started (${plan.web?.urls.length ?? 0} URLs, ${pdfs.length} uploaded PDFs, ${plan.pdf?.urls.length ?? 0} PDF URLs)`,
    );
    return json(view, 202);
  });
  app.get('/api/scans/:id', async (c) => {
    const view = state.jobs.get(c.req.param('id'));
    if (view === undefined) return refuse('Not found: no such scan.', 404);
    if (view.status === 'done' && currentJob === view.id) await fresh();
    const report =
      view.status === 'done' && currentJob === view.id ? state.current?.report : undefined;
    return json(report ? { ...view, report } : view);
  });
  app.delete('/api/scans/:id', (c) => {
    const result = state.jobs.cancel(c.req.param('id'));
    if (result === 'unknown') return refuse('Not found: no such scan.', 404);
    if (result === 'over') return refuse('the scan has already ended', 409);
    return json(result, 202);
  });

  app.post('/api/uploads', async (c) => {
    // Content type, then the kind, then whether they fit, then size (the ruling 5 order).
    const type = c.req.header('content-type') ?? null;
    if (!hasType(type, ANY_UPLOAD_TYPE))
      return refused('type', `an upload must be sent as ${ANY_UPLOAD_TYPE.join(' or ')}`, 415);
    const kind = c.req.query('kind');
    if (!UPLOAD_KINDS.includes(kind as UploadKind))
      return refused('schema', `kind must be one of ${UPLOAD_KINDS.join(', ')}`, 400);
    const k = kind as UploadKind;
    if (!hasType(type, UPLOAD_TYPES[k]))
      return refused('type', `a ${k} upload must be sent as ${UPLOAD_TYPES[k].join(' or ')}`, 415);
    if (uploading >= MAX_UPLOADS_IN_FLIGHT)
      return refused(
        'rate',
        `at most ${MAX_UPLOADS_IN_FLIGHT} uploads at once; send this one when another finishes`,
        429,
      );
    // Held back before the body is read; a body with no length reserves the most it may be.
    const declared = Number(c.req.header('content-length'));
    const reservation = state.uploads.reserve(
      c.req.header('content-length') !== undefined && Number.isFinite(declared) && declared >= 0
        ? Math.min(declared, maxUploadBytes(k))
        : maxUploadBytes(k),
    );
    if (reservation === undefined)
      return refused('size', 'too many uploads are held; record or scan them first', 413);
    const name = c.req.query('name');
    uploading++;
    try {
      const body = await readBody(c.req.raw, maxUploadBytes(k));
      const upload = await state.uploads.add(k, body, name, reservation);
      return json(
        {
          id: upload.id,
          kind: upload.kind,
          bytes: upload.bytes,
          ...(upload.name ? { name: upload.name } : {}),
        },
        201,
      );
    } catch (e) {
      if (e instanceof RequestError)
        return refused('size', `the ${k} is over ${maxUploadBytes(k) / 1024 / 1024} MiB`, 413);
      if (e instanceof UploadError)
        return refused(e.status === 413 ? 'size' : 'schema', e.message, e.status);
      throw e;
    } finally {
      uploading--;
      reservation.release();
    }
  });

  app.get('/api/checklist', async () => {
    const current = state.current;
    if (current === undefined) return refuse('there is no report yet; scan or open one first', 409);
    let reviews;
    try {
      ({ reviews } = await loadReviews(state.root.dir));
    } catch (e) {
      if (e instanceof ConfigError) return configProblem(e);
      if (e instanceof ReviewInputError) return refuse(e.message, 422);
      throw e;
    }
    const checklist = reviewChecklist(current.report, reviews);
    return json({
      summary: checklist.summary,
      items: itemsWithRecords(checklist),
      ...checklistNotes(checklist, current.report),
    });
  });

  app.post('/api/reviews', async (c) => {
    const current = state.current;
    let body;
    try {
      body = await readJson(c.req.raw, ReviewBodySchema);
    } catch (e) {
      if (e instanceof RequestError) return refused(bodyRefusal(e.status), e.message, e.status);
      throw e;
    }
    if (current === undefined) return refuse('there is no report yet; scan or open one first', 409);
    const images = [];
    for (const id of body.attachments ?? []) {
      const upload = state.uploads.get(id, 'image');
      if (!upload) return refuse(`there is no image upload ${id}`, 400);
      images.push(upload);
    }
    // In use while the record is written; a refused review leaves them to expire as before.
    state.uploads.claim(images.map((i) => i.id));
    let recorded = false;
    try {
      const { file, record } = await recordManualReview(state.root.dir, {
        report: current.report,
        item: body.item,
        outcome: body.outcome,
        reviewer: body.reviewer,
        notes: body.notes,
        attach: images.map((i) => i.path),
        overrides: body.overrides,
      });
      recorded = true;
      await state.uploads.delete(images.map((i) => i.id));
      log(`review recorded for item ${safeText(body.item, 100)} (record ${record.id})`);
      // The report, its checklist and its exports show the review without a rescan.
      await rebuild();
      return json(
        {
          file: relative(state.root.dir, file).split(sep).join('/'),
          id: record.id,
          asset: { uri: record.asset.uri, kind: record.asset.kind },
          overrides: 'review' in record ? (record.review.overrides ?? []) : [],
        },
        201,
      );
    } catch (e) {
      if (e instanceof ReviewInputError) return refuse(e.message, 400);
      if (e instanceof ConfigError) return configProblem(e);
      throw e;
    } finally {
      if (!recorded) state.uploads.unclaim(images.map((i) => i.id));
    }
  });

  app.get('/api/attachments/:name', (c) => {
    const loaded = new AttachmentLoader(join(state.root.dir, ATTACHMENT_DIR)).load(
      `attachments/${c.req.param('name')}`,
    );
    if (!loaded.ok) return refuse(`Not found: ${loaded.reason}.`, 404);
    const [, type, data] = /^data:([^;]+);base64,(.*)$/.exec(loaded.dataUri) ?? [];
    if (type === undefined || data === undefined)
      return failed('GET /api/attachments', new Error('the attachment loader gave no data URI'));
    return new Response(Buffer.from(data, 'base64'), {
      headers: { 'content-type': type, 'content-disposition': 'attachment' },
    });
  });

  /** The config's ACR metadata for an export of format, or the 422 that says why it cannot be made. */
  const acrFor = (format: Format, report: ScanReport): AcrMeta | undefined | Response => {
    try {
      const loaded = loadRootConfig(state.root);
      return acrMeta([format], report.profile.id, loaded, {
        needs: 'the ACR formats (openacr, vpat-html and vpat-docx) need',
        ...(loaded ? { file: rootRelative(state.root.dir, loaded.file) } : {}),
        profileHint: 'scan with profile',
      });
    } catch (e) {
      if (e instanceof UsageError) return refuse(e.message, 422);
      if (e instanceof ConfigError) return configProblem(e);
      throw e;
    }
  };

  // Whether an ACR export would be complete, and why not, before the page offers the download.
  app.get('/api/acr', async () => {
    await fresh();
    const current = state.current;
    if (current === undefined) return refuse('there is no report yet; scan or open one first', 409);
    const acr = acrFor('openacr', current.report);
    if (acr instanceof Response) return acr;
    if (acr === undefined) return failed('GET /api/acr', new Error('no ACR metadata was built'));
    const { complete, incomplete, undecided } = buildAcr(current.report, acr);
    return json({ complete, incomplete, undecided });
  });

  // AI fix suggestions: only when the CLI gave the server an AI capability (it holds the key).
  app.get('/api/ai', () => {
    const body: AiAvailability = state.ai
      ? { available: true, provider: state.ai.provider, model: state.ai.model }
      : { available: false, reason: state.aiUnavailable ?? AI_OFF };
    return json(body);
  });

  app.post('/api/suggestions', async (c) => {
    const ai = state.ai;
    if (!ai) return text('Not found.', 404);
    let body;
    try {
      body = await readJson(c.req.raw, SuggestionsBodySchema);
    } catch (e) {
      if (e instanceof RequestError) return refused(bodyRefusal(e.status), e.message, e.status);
      throw e;
    }
    const current = state.current;
    if (current === undefined) return refuse('there is no report yet; scan or open one first', 409);
    const ids = body.findingIds;
    if (ids !== undefined) {
      if (ids.length > ai.maxGroups)
        return refused('schema', `name at most ${ai.maxGroups} findings (ai.maxGroups)`, 400);
      const known = new Set(current.report.findings.map((f) => f.id));
      const unknown = ids.find((id) => !known.has(id));
      if (unknown !== undefined)
        return refused('schema', `the report has no finding ${unknown}`, 400);
    }
    const options = ids !== undefined ? { findingIds: ids } : {};
    if (body.dryRun) {
      const preview = ai.preview(current.report, options);
      return json({ dryRun: true, provider: ai.provider, model: ai.model, ...preview });
    }
    if (state.aiRun) return refuse('AI suggestions are already running; wait for them', 409);
    const run = new AbortController();
    state.aiRun = run;
    // A closed tab stops the requests still to be sent; the partial result is not kept.
    const gone = () => run.abort();
    c.req.raw.signal.addEventListener('abort', gone, { once: true });
    try {
      const doc = await ai.suggest(current.report, { ...options, signal: run.signal });
      // Kept only for the report it was made for, and only when the run was not stopped.
      if (!run.signal.aborted && state.current?.report.startedAt === current.report.startedAt)
        state.aiResult = doc;
      const ok = doc.entries.filter((e) => e.status === 'ok').length;
      log(`AI suggestions: ${doc.entries.length} groups, ${ok} with a suggestion`);
      return json(doc);
    } finally {
      c.req.raw.signal.removeEventListener('abort', gone);
      if (state.aiRun === run) state.aiRun = undefined;
    }
  });

  app.get('/api/export/ai-suggestions.json', () => {
    if (!state.ai || !state.aiResult) return refuse('Not found: no AI suggestions yet.', 404);
    log('export served (ai-suggestions.json)');
    return new Response(`${JSON.stringify(state.aiResult, null, 2)}\n`, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="ai-suggestions.json"',
      },
    });
  });

  app.get('/api/export/ai-suggestions.html', () => {
    if (!state.ai || !state.aiResult) return refuse('Not found: no AI suggestions yet.', 404);
    log('export served (ai-suggestions.html)');
    return new Response(state.ai.renderHtml(state.aiResult), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': 'attachment; filename="ai-suggestions.html"',
      },
    });
  });

  app.get('/api/export/:format', async (c) => {
    const format = c.req.param('format') as Format;
    if (!FORMATS.includes(format)) return refuse('Not found: no such export format.', 404);
    await fresh();
    const current = state.current;
    if (current === undefined) return refuse('there is no report yet; scan or open one first', 409);
    const acr = ACR_FORMATS.includes(format) ? acrFor(format, current.report) : undefined;
    if (acr instanceof Response) return acr;
    const [file] = await buildReportFiles(current.report, {
      formats: [format],
      ...(acr ? { acr } : {}),
      evidenceDir: current.evidenceDir,
      reviewDir: state.root.dir,
    });
    if (!file) return failed(`GET /api/export/${format}`, new Error('no file was built'));
    log(`export served (${format})`);
    return new Response(file.data, {
      headers: {
        'content-type': EXPORT_TYPES[format],
        'content-disposition': `attachment; filename="${file.name}"`,
      },
    });
  });

  app.all('/api/*', () => text('Not found.', 404));
  app.get('*', (c: Context) => {
    const path = new URL(c.req.url).pathname;
    const file = files.get(path === '/' ? '/index.html' : path);
    // The build also holds the hosted scanner's page, which is not served here.
    if (!file || path === '/hosted.html') return text('Not found.', 404);
    return new Response(file.body, { headers: { 'content-type': file.type } });
  });
  app.notFound(() => text('Not found.', 404));
  app.onError((e, c) => failed(`${c.req.method} ${new URL(c.req.url).pathname}`, e));
  return app;
}

export interface UiServer {
  /** The link to open: loopback address, port and the one-time code. */
  url: string;
  port: number;
  address: AddressInfo;
  token: string;
  code: string;
  /** Stops listening, cancels a running scan and removes the uploads. */
  close(): Promise<void>;
  /** Cancels a running scan job synchronously (its processes and containers), for an exit handler. */
  abort(): void;
}

export interface LocalServerOptions {
  files: ReadonlyMap<string, StaticFile>;
  /** The report to show first; without it GET /api/report answers 204 until a scan finishes. */
  current?: CurrentReport;
  /** Default: the working folder, with its widedoor.config.yaml when present. */
  root?: LocalRoot;
  env?: NodeJS.ProcessEnv;
  /** For tests; a random 256-bit token otherwise. */
  token?: string;
  /** For tests; a random 256-bit code otherwise. */
  code?: string;
  onCodeReuse?: () => void;
  /** Gets each log line (see createLocalApp). */
  log?: (line: string) => void;
  /** For tests; the real engine otherwise. */
  performScan?: typeof performScan;
  /** For tests; MAX_HELD_UPLOAD_BYTES otherwise. */
  maxHeldUploadBytes?: number;
  /** For tests; real timers otherwise (an unused upload expires after UNUSED_UPLOAD_MS). */
  uploadTimer?: UploadTimer;
  /** For tests; Date.now otherwise. */
  now?: () => number;
  /** AI fix suggestions (the CLI builds this when ai.enabled and a key are set). */
  ai?: LocalAi;
  /** Why AI fix suggestions are off, shown by GET /api/ai. */
  aiUnavailable?: string;
}

/** How long close waits for a cancelled scan to stop before it goes on. */
const CLOSE_WAIT_MS = 15_000;

export async function startLocalServer(options: LocalServerOptions): Promise<UiServer> {
  const token = options.token ?? randomBytes(32).toString('base64url');
  const code = options.code ?? randomBytes(32).toString('base64url');
  const log = (line: string) => options.log?.(`widedoor ui: ${line}`);
  const refusals = new Refusals(log, options.now);
  const state: LocalState = {
    root: options.root ?? { dir: process.cwd() },
    ...(options.current ? { current: options.current } : {}),
    // A failed job's cause (it may name local paths) goes to the log, not to the page.
    jobs: new Jobs((view, cause) =>
      log(
        `scan ${view.id} ${view.status === 'done' ? 'finished' : view.status}${cause !== undefined ? `: ${safeText(cause, 1000)}` : ''}`,
      ),
    ),
    uploads: await Uploads.create(options.maxHeldUploadBytes, options.uploadTimer),
    env: options.env ?? process.env,
    ...(options.performScan ? { performScan: options.performScan } : {}),
    ...(options.ai ? { ai: options.ai } : {}),
    ...(options.aiUnavailable !== undefined ? { aiUnavailable: options.aiUnavailable } : {}),
  };
  let port = 0;
  const app = createLocalApp({
    files: options.files,
    state,
    token,
    code,
    port: () => port,
    refusals,
    ...(options.onCodeReuse ? { onCodeReuse: options.onCodeReuse } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const listener = getRequestListener(async (req, env) => secured(await app.fetch(req, env)), {
    overrideGlobalObjects: false,
    // A request node-server cannot turn into a Request (no or a malformed Host header).
    errorHandler: () =>
      secured(
        new Response('Bad request.', {
          status: 400,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      ),
  });
  // Without a Host header the request still reaches the listener, which refuses it with the headers.
  const server = createServer({ requireHostHeader: false }, listener);
  // A request Node cannot parse at all gets a bare 400 that still carries the headers.
  server.on('clientError', (_, socket) => {
    if (!socket.writable) return void socket.destroy();
    const headers = Object.entries(SECURITY_HEADERS)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('');
    socket.end(
      `HTTP/1.1 400 Bad Request\r\n${headers}content-length: 0\r\nconnection: close\r\n\r\n`,
    );
  });
  try {
    await new Promise<void>((ready, fail) => {
      server.once('error', fail);
      server.listen(0, LOOPBACK, () => {
        server.off('error', fail);
        ready();
      });
    });
  } catch (e) {
    await state.uploads.close();
    throw e;
  }
  const address = server.address() as AddressInfo;
  port = address.port;
  return {
    url: `http://${LOOPBACK}:${port}/?code=${code}`,
    port,
    address,
    token,
    code,
    abort: () => state.jobs.abort(),
    close: async () => {
      await new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      });
      state.jobs.abort();
      state.aiRun?.abort();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        state.jobs.idle(),
        new Promise((done) => (timer = setTimeout(done, CLOSE_WAIT_MS))),
      ]);
      clearTimeout(timer);
      await state.uploads.close();
      // Refusals counted since the last line still reach the log.
      refusals.flush();
    },
  };
}
