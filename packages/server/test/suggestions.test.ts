import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { FindingSchema, findingId, type Asset } from '@widedoor/core';
import { TOKEN_HEADER, type ScanReport } from '@widedoor/report';
import type { AiPreview, AiSuggestionsDoc } from '../src/ai-types.ts';
import {
  AI_SIGNED_IN,
  AI_SPENT,
  startLocalServer,
  type LocalAi,
  type UiServer,
} from '../src/app.ts';
import { buildReport, type ScanInputs, type ScanOutcome } from '../src/engine.ts';
import { reportBodyOf } from '../src/report-file.ts';
import { SECURITY_HEADERS } from '../src/security.ts';
import type { StaticFile } from '../src/static-files.ts';

/*
 * AI fix suggestions in the local server (Task 3b.8). The server never loads
 * @widedoor/ai (this test does not either): the CLI hands it a LocalAi, faked
 * here. Checked: GET /api/ai with and without it, the strict body of POST
 * /api/suggestions, the token and origin checks, dry run, one run at a time,
 * the two exports, and that a new scan or the server's close aborts a run and
 * drops its results. A fake key in the environment shows nowhere.
 */

const TOKEN = 'ai-token_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH';
const FAKE_KEY = 'sk-ant-api03-FAKE-SERVER-KEY-DO-NOT-SHOW';
const FILES = new Map<string, StaticFile>([
  ['/index.html', { body: new Uint8Array(Buffer.from('<!doctype html>')), type: 'text/html' }],
]);
const tmp = mkdtempSync(join(tmpdir(), 'widedoor-ai-server-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const A: Asset = { kind: 'web', uri: 'https://site.example/a', contentHash: hash('a') };

function inputs(): ScanInputs {
  const location = { selector: 'img.logo' };
  const fail = FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(A.uri, location, 'axe-core', 'image-alt'),
    asset: A,
    location,
    source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId: 'image-alt' },
    criteria: { wcag: ['1.1.1'] },
    outcome: 'fail',
    impact: 'critical',
    evidence: { snippet: '<img class="logo" src="/logo.png">' },
  });
  return {
    profile: '508+wcag21aa',
    pdfDocumentType: 'non-web',
    startedAt: new Date('2026-10-29T12:00:00.000Z'),
    finishedAt: new Date('2026-10-29T12:01:00.000Z'),
    scope: { web: { urls: [A.uri], truncated: false } },
    web: {
      engine: { name: 'axe-core', version: '4.14.0' },
      assets: [A],
      findings: [fail],
      errors: [],
      skipped: [],
      warnings: [],
      truncated: false,
    },
  };
}
const REPORT = buildReport(inputs(), []).report;
const FAIL_ID = REPORT.findings[0]!.id;

const doc = (report: ScanReport): AiSuggestionsDoc => ({
  schemaVersion: 1,
  $id: 'urn:widedoor:schema:ai-suggestions:v1',
  label: 'AI-generated. Review before use. Suggestions do not change any result in the report.',
  provider: 'anthropic',
  model: 'fake-model',
  createdAt: '2026-10-29T13:00:00.000Z',
  report: { startedAt: report.startedAt, findings: report.findings.length },
  limits: {
    maxGroups: 25,
    maxRequestsPerMinute: 10,
    concurrency: 2,
    maxOutputTokens: 4096,
    maxInputTokensTotal: 200000,
  },
  entries: [],
  totals: { requests: 0, inputTokens: 0, outputTokens: 0, skippedGroups: 0 },
});

/** A fake capability that records its calls; suggest waits for release() when hold is set. */
function fakeAi(
  options: {
    hold?: boolean;
    inputTokens?: number;
    cap?: number;
    allowSignedIn?: boolean;
    throws?: boolean;
  } = {},
) {
  const calls = {
    suggest: [] as (readonly string[] | undefined)[],
    preview: 0,
    budgets: [] as (number | undefined)[],
  };
  const signals: AbortSignal[] = [];
  let release: () => void = () => {};
  const ai: LocalAi = {
    provider: 'anthropic',
    model: 'fake-model',
    maxGroups: 2,
    maxInputTokensTotal: options.cap ?? 200000,
    allowSignedIn: options.allowSignedIn ?? false,
    async suggest(report, { findingIds, signal, log, budget, onSpent }) {
      calls.suggest.push(findingIds);
      calls.budgets.push(budget);
      onSpent?.(options.inputTokens ?? 0);
      if (options.throws) throw new Error('the run failed');
      signals.push(signal);
      if (options.hold)
        await new Promise<void>((done) => {
          release = done;
          signal.addEventListener('abort', () => done(), { once: true });
        });
      const d = doc(report);
      const spent = { ...d, totals: { ...d.totals, inputTokens: options.inputTokens ?? 0 } };
      log?.(
        `ai_run status=${signal.aborted ? 'aborted' : 'done'} sent=0 input_tokens=${spent.totals.inputTokens} output_tokens=0`,
      );
      log?.('ai_request group=x status=ok');
      return spent;
    },
    preview(_report, { findingIds }): AiPreview {
      calls.preview++;
      return {
        system: 'SYSTEM',
        messages: [`MESSAGE for ${findingIds?.join(',') ?? 'all'}`],
        estimatedInputTokens: 42,
        skipped: 0,
      };
    },
    renderHtml: () => '<!doctype html><title>AI fix suggestions</title><p>rendered</p>',
  };
  return { ai, calls, signals, release: () => release() };
}

const servers: UiServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

let n = 0;
async function setup(
  options: {
    ai?: LocalAi;
    aiUnavailable?: string;
    engine?: () => Promise<ScanOutcome>;
    signedIn?: boolean;
  } = {},
) {
  const root = join(tmp, `r${n++}`);
  mkdirSync(root, { recursive: true });
  const logs: string[] = [];
  const server = await startLocalServer({
    files: FILES,
    root: { dir: root },
    token: TOKEN,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
    log: (line) => void logs.push(line),
    current: {
      report: REPORT,
      body: reportBodyOf(REPORT, join(root, 'no-evidence'), root),
      evidenceDir: join(root, 'no-evidence'),
      ...(options.signedIn ? { signedIn: true } : {}),
    },
    performScan:
      options.engine ??
      (async () => {
        const i = inputs();
        const { report } = buildReport(
          { ...i, startedAt: new Date('2026-10-29T14:00:00.000Z') },
          [],
        );
        return { kind: 'done', report, inputs: i, restricted: false, unscannedListed: 0 };
      }),
    ...(options.ai ? { ai: options.ai } : {}),
    ...(options.aiUnavailable !== undefined ? { aiUnavailable: options.aiUnavailable } : {}),
  });
  servers.push(server);
  return { server, logs };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

function call(
  server: UiServer,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string | undefined> } = {},
): Promise<Reply> {
  const raw = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string | undefined> = {
    host: `127.0.0.1:${server.port}`,
    [TOKEN_HEADER]: TOKEN,
    ...(method !== 'GET' ? { origin: `http://127.0.0.1:${server.port}` } : {}),
    ...(raw !== undefined
      ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) }
      : {}),
    ...options.headers,
  };
  const set = Object.fromEntries(
    Object.entries(headers).filter((e): e is [string, string] => e[1] !== undefined),
  );
  return new Promise((done, fail) => {
    const req = request(
      { host: '127.0.0.1', port: server.port, method, path, headers: set, setHost: false },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.once('error', fail);
    if (raw !== undefined) req.write(raw);
    req.end();
  });
}

const all = (replies: Reply[], logs: string[]) =>
  [...replies.map((r) => `${JSON.stringify(r.headers)}\n${r.text}`), ...logs].join('\n');

describe('without an AI capability', () => {
  it('GET /api/ai says why, and the suggestion routes are 404', async () => {
    const { server } = await setup({
      aiUnavailable: 'AI fix suggestions are off: set ai.enabled.',
    });
    const ai = await call(server, 'GET', '/api/ai');
    expect(ai.status).toBe(200);
    expect(JSON.parse(ai.text)).toEqual({
      available: false,
      reason: 'AI fix suggestions are off: set ai.enabled.',
    });
    expect((await call(server, 'POST', '/api/suggestions', { body: {} })).status).toBe(404);
    expect((await call(server, 'GET', '/api/export/ai-suggestions.json')).status).toBe(404);
    expect((await call(server, 'GET', '/api/export/ai-suggestions.html')).status).toBe(404);
  });

  it('has a default reason', async () => {
    const { server } = await setup();
    expect(JSON.parse((await call(server, 'GET', '/api/ai')).text)).toEqual({
      available: false,
      reason: 'AI fix suggestions are off.',
    });
  });
});

describe('with an AI capability', () => {
  it('GET /api/ai names the provider and the model, never a key', async () => {
    const { server } = await setup({ ai: fakeAi().ai });
    const r = await call(server, 'GET', '/api/ai');
    expect(JSON.parse(r.text)).toEqual({
      available: true,
      provider: 'anthropic',
      model: 'fake-model',
    });
    expect(r.text).not.toContain(FAKE_KEY);
  });

  it('needs the token and the page origin like every /api route', async () => {
    const { server } = await setup({ ai: fakeAi().ai });
    expect(
      (await call(server, 'GET', '/api/ai', { headers: { [TOKEN_HEADER]: undefined } })).status,
    ).toBe(401);
    expect(
      (
        await call(server, 'POST', '/api/suggestions', {
          body: {},
          headers: { [TOKEN_HEADER]: 'wrong' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(server, 'POST', '/api/suggestions', {
          body: {},
          headers: { origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
  });

  it('refuses a body that is not strict, too long, or names findings the report lacks', async () => {
    const f = fakeAi();
    const { server } = await setup({ ai: f.ai });
    const bad = [
      { body: { dryRun: true, extra: 1 }, status: 400 },
      { body: { findingIds: ['x'] }, status: 400 },
      { body: { findingIds: [] }, status: 400 },
      { body: { findingIds: [FAIL_ID, FAIL_ID] }, status: 400 },
      {
        // Final fix round 1 item 17: the message says what is checked (findings, not groups).
        body: { findingIds: ['wd_0000000000000001', 'wd_0000000000000002', 'wd_0000000000000003'] },
        status: 400,
        text: 'name at most 2 findings: ai.maxGroups caps a run',
      },
      { body: { findingIds: ['wd_0000000000000001'] }, status: 400 },
      { body: { dryRun: 'yes' }, status: 400 },
    ];
    for (const { body, status, text } of bad as { body: object; status: number; text?: string }[]) {
      const res = await call(server, 'POST', '/api/suggestions', { body });
      expect(res.status, JSON.stringify(body)).toBe(status);
      if (text !== undefined) expect(res.text).toContain(text);
    }
    const wrongType = await call(server, 'POST', '/api/suggestions', {
      body: {},
      headers: { 'content-type': 'text/plain' },
    });
    expect(wrongType.status).toBe(415);
    expect(f.calls.suggest).toEqual([]);
    expect(f.calls.preview).toBe(0);
  });

  it('a dry run previews and sends nothing', async () => {
    const f = fakeAi();
    const { server } = await setup({ ai: f.ai });
    const r = await call(server, 'POST', '/api/suggestions', {
      body: { dryRun: true, findingIds: [FAIL_ID] },
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({
      dryRun: true,
      provider: 'anthropic',
      model: 'fake-model',
      system: 'SYSTEM',
      messages: [`MESSAGE for ${FAIL_ID}`],
      estimatedInputTokens: 42,
      skipped: 0,
    });
    expect(f.calls.suggest).toEqual([]);
  });

  it('runs once at a time, keeps the result for the exports, and serves them as downloads', async () => {
    const f = fakeAi({ hold: true });
    const { server, logs } = await setup({ ai: f.ai });
    const first = call(server, 'POST', '/api/suggestions', { body: { findingIds: [FAIL_ID] } });
    await new Promise((done) => setTimeout(done, 50));
    const second = await call(server, 'POST', '/api/suggestions', { body: {} });
    expect(second.status).toBe(409);
    expect((await call(server, 'GET', '/api/export/ai-suggestions.json')).status).toBe(404);
    f.release();
    const done = await first;
    expect(done.status).toBe(200);
    expect(JSON.parse(done.text).label).toMatch(/^AI-generated/);
    expect(f.calls.suggest).toEqual([[FAIL_ID]]);

    const json = await call(server, 'GET', '/api/export/ai-suggestions.json');
    expect(json.status).toBe(200);
    expect(json.headers['content-disposition']).toBe('attachment; filename="ai-suggestions.json"');
    expect(json.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(json.text).model).toBe('fake-model');
    const page = await call(server, 'GET', '/api/export/ai-suggestions.html');
    expect(page.status).toBe(200);
    expect(page.headers['content-disposition']).toBe('attachment; filename="ai-suggestions.html"');
    expect(page.text).toContain('rendered');
    for (const r of [json, page])
      for (const [name, value] of Object.entries(SECURITY_HEADERS))
        expect(r.headers[name]).toBe(value);
    expect(all([done, json, page], logs)).not.toContain(FAKE_KEY);
  });

  it('a new scan aborts a running suggestion and drops the results', async () => {
    const f = fakeAi({ hold: true });
    const { server } = await setup({ ai: f.ai });
    // A finished run first, so there are results to drop.
    const held = call(server, 'POST', '/api/suggestions', { body: {} });
    await new Promise((done) => setTimeout(done, 50));
    f.release();
    expect((await held).status).toBe(200);
    expect((await call(server, 'GET', '/api/export/ai-suggestions.json')).status).toBe(200);
    // A second run, held, then a scan.
    const running = call(server, 'POST', '/api/suggestions', { body: {} });
    await new Promise((done) => setTimeout(done, 50));
    const scan = await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } });
    expect(scan.status).toBe(202);
    await running;
    expect(f.signals.at(-1)?.aborted).toBe(true);
    for (let i = 0; i < 200; i++) {
      const job = JSON.parse(
        (await call(server, 'GET', `/api/scans/${JSON.parse(scan.text).id}`)).text,
      );
      if (job.status === 'done') break;
      await new Promise((done) => setTimeout(done, 10));
    }
    expect((await call(server, 'GET', '/api/export/ai-suggestions.json')).status).toBe(404);
  });

  it("the server's close aborts a running suggestion", async () => {
    const f = fakeAi({ hold: true });
    const { server } = await setup({ ai: f.ai });
    const running = call(server, 'POST', '/api/suggestions', { body: {} }).catch(() => undefined);
    await new Promise((done) => setTimeout(done, 50));
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    await running;
    expect(f.signals[0]?.aborted).toBe(true);
  });

  // 3b.8 fix round 1 item 6: a closed tab stops the run.
  it('a client that disconnects aborts its run, and its partial document is kept', async () => {
    const f = fakeAi({ hold: true });
    const { server } = await setup({ ai: f.ai });
    const raw = JSON.stringify({});
    const req = request({
      host: '127.0.0.1',
      port: server.port,
      method: 'POST',
      path: '/api/suggestions',
      setHost: false,
      headers: {
        host: `127.0.0.1:${server.port}`,
        origin: `http://127.0.0.1:${server.port}`,
        [TOKEN_HEADER]: TOKEN,
        'content-type': 'application/json',
        'content-length': String(raw.length),
      },
    });
    req.on('error', () => undefined);
    req.end(raw);
    for (let i = 0; i < 200 && f.signals.length === 0; i++)
      await new Promise((done) => setTimeout(done, 10));
    expect(f.signals).toHaveLength(1);
    expect(f.signals[0]?.aborted).toBe(false);
    req.destroy();
    for (let i = 0; i < 200 && !f.signals[0]?.aborted; i++)
      await new Promise((done) => setTimeout(done, 10));
    expect(f.signals[0]?.aborted).toBe(true);
    // The run has ended, and a new run may start (not 409). Its document is kept: an aborted
    // run still records what was sent (Phase 3b final fix round 1 item 4).
    await new Promise((done) => setTimeout(done, 20));
    expect((await call(server, 'GET', '/api/export/ai-suggestions.json')).status).toBe(200);
    const next = call(server, 'POST', '/api/suggestions', { body: {} });
    await new Promise((done) => setTimeout(done, 50));
    f.release();
    expect((await next).status).toBe(200);
  });
});

// Phase 3b final fix round 1, items 4, 5 and 8.
describe('final fix round 1', () => {
  it('logs the run line of every run, and no other runner line', async () => {
    const f = fakeAi({ inputTokens: 1234 });
    const { server, logs } = await setup({ ai: f.ai });
    expect((await call(server, 'POST', '/api/suggestions', { body: {} })).status).toBe(200);
    expect(logs).toContain(
      'widedoor ui: ai_run status=done sent=0 input_tokens=1234 output_tokens=0',
    );
    expect(logs.some((l) => l.includes('ai_request'))).toBe(false);
  });

  it('gives each run what is left of the session cap, and refuses below the smallest budget', async () => {
    // Item 27: at 199k of 200k used, the next run can spend at most 1k.
    const f = fakeAi({ inputTokens: 199_000, cap: 200_000 });
    const { server } = await setup({ ai: f.ai });
    expect((await call(server, 'POST', '/api/suggestions', { body: {} })).status).toBe(200);
    expect((await call(server, 'POST', '/api/suggestions', { body: {} })).status).toBe(200);
    expect(f.calls.budgets).toEqual([200_000, 1000]);
    // Now past the cap: refused until widedoor ui restarts.
    const third = await call(server, 'POST', '/api/suggestions', { body: {} });
    expect(third.status).toBe(429);
    expect(third.text).toBe(AI_SPENT);
    expect(f.calls.suggest).toHaveLength(2);
    // A dry run sends nothing and stays allowed.
    expect(
      (await call(server, 'POST', '/api/suggestions', { body: { dryRun: true } })).status,
    ).toBe(200);
  });

  it('refuses when less than the smallest budget is left, and counts a run that threw', async () => {
    const f = fakeAi({ inputTokens: 199_500, cap: 200_000, throws: true });
    const { server } = await setup({ ai: f.ai });
    const failed = await call(server, 'POST', '/api/suggestions', { body: {} });
    expect(failed.status).toBe(500);
    // 500 left is under the 1000 floor: the thrown run's spend still counted.
    const next = await call(server, 'POST', '/api/suggestions', { body: {} });
    expect(next.status).toBe(429);
    expect(next.text).toBe(AI_SPENT);
    expect(f.calls.suggest).toHaveLength(1);
  });

  it('keeps AI off for a signed-in scan without ai.allowSignedIn, dry run allowed', async () => {
    const f = fakeAi();
    const { server } = await setup({ ai: f.ai, signedIn: true });
    expect(JSON.parse((await call(server, 'GET', '/api/ai')).text)).toEqual({
      available: false,
      reason: AI_SIGNED_IN,
    });
    const run = await call(server, 'POST', '/api/suggestions', { body: {} });
    expect(run.status).toBe(403);
    expect(run.text).toBe(AI_SIGNED_IN);
    expect(
      (await call(server, 'POST', '/api/suggestions', { body: { dryRun: true } })).status,
    ).toBe(200);
    expect(f.calls.suggest).toEqual([]);
  });

  it('allows AI for a signed-in scan with ai.allowSignedIn', async () => {
    const f = fakeAi({ allowSignedIn: true });
    const { server } = await setup({ ai: f.ai, signedIn: true });
    expect(JSON.parse((await call(server, 'GET', '/api/ai')).text).available).toBe(true);
    expect((await call(server, 'POST', '/api/suggestions', { body: {} })).status).toBe(200);
  });
});
