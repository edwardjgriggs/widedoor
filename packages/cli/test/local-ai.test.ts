import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FindingSchema, findingId, getProfile, type Asset, type Finding } from '@widedoor/core';
import { TOKEN_HEADER, buildScanReport, serializeJson } from '@widedoor/report';
import { AiConfigSchema, loadReportFile, startLocalServer, type AiConfig } from '@widedoor/server';
import { PREVIEW_NONCE, type ProviderAnswer } from '@widedoor/ai';
// Test code only: the package index does not export the fake provider.
import { createFakeProvider } from '../../ai/src/providers/fake.ts';
import { UsageError, parseCommand } from '../src/args.ts';
import { localAi, type AiHooks, type AiModule } from '../src/ai.ts';

/*
 * widedoor ui's AI capability (Task 3b.8): localAi decides whether there is
 * one and builds it; the local server gets it as an object and never sees
 * the key or @widedoor/ai. The fake provider comes in only through the
 * programmatic hook: no flag, variable or config key reaches it. Nothing
 * here opens a socket past 127.0.0.1.
 */

const FAKE_KEY = 'sk-ant-api03-FAKE-UI-KEY-e5f6a7b8-DO-NOT-SHOW';
const TOKEN = 'localai-token_0123456789abcdefghijklmnopqrstuvwxyzAB';
const root = mkdtempSync(join(tmpdir(), 'widedoor-local-ai-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'WIDEDOOR_AI_PROVIDER']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

const ON: AiConfig = AiConfigSchema.parse({ enabled: true });

const answer = (summary: string): ProviderAnswer => ({
  status: 'ok',
  text: JSON.stringify({
    kind: 'web-patch',
    summary,
    patch: '<img src="/a.png" alt="Logo">',
    notes: null,
  }),
  modelAnswered: 'claude-opus-5-5',
  usage: { inputTokens: 10, outputTokens: 5 },
});

/** Seams that count loads of @widedoor/ai; with a provider when given one. */
function seams(provider?: ReturnType<typeof createFakeProvider>) {
  let loads = 0;
  const hooks: AiHooks = {
    loadAi: async () => {
      loads++;
      return (await import('@widedoor/ai')) as AiModule;
    },
    ...(provider ? { provider: () => provider } : {}),
  };
  return { hooks, loads: () => loads };
}

describe('localAi', () => {
  it('is off without ai.enabled, and does not load @widedoor/ai', async () => {
    for (const config of [
      undefined,
      AiConfigSchema.parse({}),
      AiConfigSchema.parse({ enabled: false }),
    ]) {
      const s = seams(createFakeProvider(() => answer('x')));
      expect(await localAi(config, s.hooks)).toEqual({
        unavailable: 'AI fix suggestions are off: set ai.enabled in widedoor.config.yaml.',
      });
      expect(s.loads()).toBe(0);
    }
  });

  it('names the missing key variable, and does not load @widedoor/ai', async () => {
    const s = seams();
    expect(await localAi(ON, s.hooks)).toEqual({
      unavailable: 'AI fix suggestions need ANTHROPIC_API_KEY in the environment of widedoor ui.',
    });
    process.env.OPENAI_API_KEY = '   ';
    expect(
      await localAi(
        AiConfigSchema.parse({ enabled: true, provider: 'openai', model: 'gpt-x' }),
        s.hooks,
      ),
    ).toEqual({
      unavailable: 'AI fix suggestions need OPENAI_API_KEY in the environment of widedoor ui.',
    });
    expect(s.loads()).toBe(0);
  });

  it('says openai needs a model', async () => {
    process.env.OPENAI_API_KEY = FAKE_KEY;
    const r = await localAi(AiConfigSchema.parse({ enabled: true, provider: 'openai' }));
    expect(r).toEqual({ unavailable: expect.stringMatching(/provider openai need a model/) });
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
  });

  it('builds the real provider from the key without sending anything', async () => {
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    const s = seams();
    const r = await localAi(
      AiConfigSchema.parse({ enabled: true, model: 'claude-x', maxGroups: 3 }),
      s.hooks,
    );
    if (!('ai' in r)) throw new Error('expected a capability');
    expect(s.loads()).toBe(1);
    expect(r.ai.provider).toBe('anthropic');
    expect(r.ai.model).toBe('claude-x');
    expect(r.ai.maxGroups).toBe(3);
    // The capability is the server's view: no key on it, at any depth that serializes.
    expect(JSON.stringify(r.ai)).not.toContain(FAKE_KEY);
    expect(Object.keys(r.ai).sort()).toEqual([
      'allowSignedIn',
      'maxGroups',
      'maxInputTokensTotal',
      'model',
      'preview',
      'provider',
      'renderHtml',
      'suggest',
    ]);
  });

  it('takes the fake provider only through the programmatic hook', async () => {
    const provider = createFakeProvider(() => answer('Add alt text.'));
    const r = await localAi(ON, seams(provider).hooks);
    if (!('ai' in r)) throw new Error('expected a capability');
    expect(r.ai.model).toBe('fake-model');
  });
});

describe('no flag, variable or config key selects a fake provider', () => {
  it('the config refuses provider fake', () => {
    expect(AiConfigSchema.safeParse({ enabled: true, provider: 'fake' }).success).toBe(false);
  });

  it('the --ai-provider flag refuses fake', () => {
    expect(() => parseCommand(['suggest', '--report', 'r.json', '--ai-provider', 'fake'])).toThrow(
      UsageError,
    );
  });

  it('a variable does not stand in for the hook', async () => {
    process.env.WIDEDOOR_AI_PROVIDER = 'fake';
    expect(await localAi(ON)).toEqual({
      unavailable: 'AI fix suggestions need ANTHROPIC_API_KEY in the environment of widedoor ui.',
    });
  });

  it('no CLI source names the fake provider', () => {
    const dir = join(import.meta.dirname, '..', 'src');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts')))
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(
        /createFakeProvider|providers\/fake/,
      );
  });
});

const PAGE: Asset = {
  kind: 'web',
  uri: 'https://shop.example/account?session=URL-SECRET',
  contentHash: `sha256:${'a'.repeat(64)}`,
};

function finding(i: number, snippet: string): Finding {
  const location = { selector: `img.i${i}` };
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(PAGE.uri, location, 'axe-core', 'image-alt'),
    asset: PAGE,
    location,
    source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId: 'image-alt' },
    criteria: { wcag: ['1.1.1'] },
    outcome: 'fail',
    impact: 'critical',
    evidence: { snippet },
  });
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

function call(port: number, method: string, path: string, body?: object): Promise<Reply> {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((done, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          [TOKEN_HEADER]: TOKEN,
          ...(method !== 'GET' ? { origin: `http://127.0.0.1:${port}` } : {}),
          ...(raw !== undefined ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.once('error', fail);
    req.end(raw);
  });
}

// 3b.8 fix round 1 item 3.
describe('a run for the findings named', () => {
  const MORE = { selector: 'a.more' };
  const linkFail = FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(PAGE.uri, MORE, 'axe-core', 'link-name'),
    asset: PAGE,
    location: MORE,
    source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId: 'link-name' },
    criteria: { wcag: ['2.4.4'] },
    outcome: 'fail',
    impact: 'serious',
    evidence: { snippet: '<a class="more"></a>' },
  });
  // A reviewer set the link fail aside: the roll-up records the override.
  const setAside = FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(PAGE.uri, MORE, 'manual', 'link-purpose'),
    asset: PAGE,
    location: MORE,
    source: { engine: 'manual', engineVersion: '0.0.0', ruleId: 'link-purpose' },
    criteria: { wcag: ['2.4.4'] },
    outcome: 'pass',
    review: {
      reviewer: 'Reviewer',
      date: '2026-10-29',
      notes: 'The link text is clear in context.',
      expiresOnChangeOf: PAGE.contentHash,
      overrides: [linkFail.id],
    },
  });
  const report = buildScanReport({
    profile: getProfile('wcag21aa'),
    startedAt: '2026-10-29T12:00:00.000Z',
    finishedAt: '2026-10-29T12:05:00.000Z',
    toolVersion: '0.0.0',
    scope: { web: { urls: [PAGE.uri], truncated: false } },
    web: {
      engine: { name: 'axe-core', version: '4.14.0' },
      assets: [PAGE],
      findings: [finding(0, '<img src="/a.png">'), finding(1, '<img src="/b.png">'), linkFail],
      errors: [],
      skipped: [],
      warnings: [],
      truncated: false,
    },
    reviews: [setAside],
  });

  it('records the whole report in the document, not the filtered findings', async () => {
    const provider = createFakeProvider(() => answer('Add alt text.'));
    const made = await localAi(ON, { provider: () => provider });
    if (!('ai' in made)) throw new Error('expected a capability');
    const one = finding(0, '').id;
    const doc = await made.ai.suggest(report, {
      findingIds: [one],
      signal: new AbortController().signal,
    });
    expect(doc.entries.map((e) => e.findingIds)).toEqual([[one]]);
    expect(doc.report).toEqual({
      startedAt: report.startedAt,
      findings: report.findings.length,
    });
    expect(report.findings.length).toBeGreaterThan(1);
  });

  it('cannot send a fail a reviewer set aside by naming its id', async () => {
    const provider = createFakeProvider(() => answer('Fix the link.'));
    const made = await localAi(ON, { provider: () => provider });
    if (!('ai' in made)) throw new Error('expected a capability');
    expect(report.findings.some((f) => f.id === linkFail.id)).toBe(true);
    expect(made.ai.preview(report, { findingIds: [linkFail.id] }).messages).toEqual([]);
    const doc = await made.ai.suggest(report, {
      findingIds: [linkFail.id],
      signal: new AbortController().signal,
    });
    expect(doc.entries).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('the real capability in the local server', () => {
  it('previews, suggests for the findings named, and exports, with the key nowhere', async () => {
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    const report = buildScanReport({
      profile: getProfile('wcag21aa'),
      startedAt: '2026-10-29T12:00:00.000Z',
      finishedAt: '2026-10-29T12:05:00.000Z',
      toolVersion: '0.0.0',
      scope: { web: { urls: [PAGE.uri], truncated: false } },
      web: {
        engine: { name: 'axe-core', version: '4.14.0' },
        assets: [PAGE],
        findings: [finding(0, '<img src="/a.png">'), finding(1, '<img src="/b.png">')],
        errors: [],
        skipped: [],
        warnings: [],
        truncated: false,
      },
    });
    writeFileSync(join(root, 'report.json'), serializeJson(report));
    const provider = createFakeProvider(() => answer('Add alt text.'));
    const made = await localAi(ON, { provider: () => provider });
    if (!('ai' in made)) throw new Error('expected a capability');
    const logs: string[] = [];
    const server = await startLocalServer({
      files: new Map([['/index.html', { body: new Uint8Array(1), type: 'text/html' }]]),
      root: { dir: root },
      current: loadReportFile(join(root, 'report.json'), root),
      token: TOKEN,
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      log: (line) => void logs.push(line),
      ai: made.ai,
    });
    const replies: Reply[] = [];
    try {
      const id = report.findings[1]!.id;
      const dry = await call(server.port, 'POST', '/api/suggestions', {
        dryRun: true,
        findingIds: [id],
      });
      replies.push(dry);
      expect(dry.status).toBe(200);
      const preview = JSON.parse(dry.text);
      expect(preview.messages).toHaveLength(1);
      expect(preview.messages[0]).toContain('img.i1');
      expect(preview.messages[0]).not.toContain('URL-SECRET');
      expect(provider.calls).toHaveLength(0);

      const run = await call(server.port, 'POST', '/api/suggestions', { findingIds: [id] });
      replies.push(run);
      expect(run.status).toBe(200);
      const doc = JSON.parse(run.text);
      expect(doc.entries).toHaveLength(1);
      expect(doc.entries[0].findingIds).toEqual([id]);
      expect(doc.entries[0].suggestion.summary).toBe('Add alt text.');
      expect(provider.calls).toHaveLength(1);
      // What was sent is the preview, but with a fresh nonce in place of PREVIEW_NONCE.
      const sent = provider.calls[0]!.user;
      expect(sent).not.toContain(PREVIEW_NONCE);
      const nonce = /nonce="([0-9a-f]{32})"/.exec(sent)?.[1] ?? '';
      expect(sent.split(nonce).join(PREVIEW_NONCE)).toBe(preview.messages[0]);

      const json = await call(server.port, 'GET', '/api/export/ai-suggestions.json');
      const html = await call(server.port, 'GET', '/api/export/ai-suggestions.html');
      replies.push(json, html);
      expect(JSON.parse(json.text)).toEqual(doc);
      expect(html.text).toContain('AI-generated. Review before use.');
      replies.push(await call(server.port, 'GET', '/api/ai'));
    } finally {
      await server.close();
    }
    const everything = [
      ...replies.map((r) => `${JSON.stringify(r.headers)}\n${r.text}`),
      ...logs,
    ].join('\n');
    expect(everything).not.toContain(FAKE_KEY);
    expect(logs.some((l) => /AI suggestions: 1 groups?, 1 with a suggestion/.test(l))).toBe(true);
  });
});
