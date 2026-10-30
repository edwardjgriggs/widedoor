import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PinnedResolver } from '@widedoor/web/egress';
import { childEnv } from '../src/hosted/agent-bin.ts';
import { createHostedApi, type HostedApi } from '../src/hosted/api.ts';
import { FakeClock, fakeFly } from './hosted-api-fixtures.ts';

/*
 * The hosted service has no AI (Task 3b.8, D16): its API answers 404 on every
 * AI route, the scan child's environment comes from an allow list without
 * any provider variable, and nothing the built hosted entries import reaches
 * @widedoor/ai or a provider SDK. @widedoor/server itself never depends on
 * @widedoor/ai; the CLI hands the local server its capability.
 */

const SERVER = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN = 'https://widedoor.example.net';
const FORBIDDEN = /^(@widedoor\/ai|@anthropic-ai\/|openai)(\/|$)/;

let opened: HostedApi[] = [];
afterEach(() => {
  for (const api of opened) api.stop();
  opened = [];
});

function hostedApi() {
  const clock = new FakeClock();
  const api = createHostedApi({
    fly: fakeFly().client,
    image: 'registry.fly.io/widedoor-scan:deployment-01',
    controlUrl: 'http://[fdaa:0:1::2]:8081',
    publicOrigin: ORIGIN,
    contactUrl: `${ORIGIN}/about-scanner`,
    resolver: () => new PinnedResolver({ lookup: () => Promise.resolve([]) }),
    trustMissingClientIp: true,
    now: clock.now,
    schedule: clock.schedule,
    log: () => undefined,
  });
  opened.push(api);
  return api;
}

describe('the hosted API', () => {
  const routes: [string, string][] = [
    ['GET', '/api/ai'],
    ['POST', '/api/suggestions'],
    ['GET', '/api/export/ai-suggestions.json'],
    ['GET', '/api/export/ai-suggestions.html'],
  ];

  it.each(routes)('answers 404 on %s %s, public and control', async (method, path) => {
    const api = hostedApi();
    const init = {
      method,
      headers: {
        origin: ORIGIN,
        'fly-client-ip': '198.51.100.7',
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify({ dryRun: true }) } : {}),
    };
    for (const app of [api.publicApp, api.controlApp]) {
      const res = await app.request(path, init);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toMatch(/anthropic|openai|suggestion/i);
    }
  });
});

describe('the scan child environment', () => {
  it('passes no provider key or setting, as root or as the same user', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/agent',
      ANTHROPIC_API_KEY: 'sk-ant-api03-FAKE-HOSTED-KEY',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
      ANTHROPIC_CUSTOM_HEADERS: 'x: y',
      OPENAI_API_KEY: 'sk-FAKE-HOSTED-KEY',
      OPENAI_BASE_URL: 'https://proxy.example',
      OPENAI_ORG_ID: 'org-x',
      openai_api_key: 'sk-lower-case',
    };
    for (const isRoot of [true, false]) {
      const out = childEnv(env, isRoot, 'http://127.0.0.1:3128', undefined);
      expect(Object.keys(out).filter((k) => /^(ANTHROPIC|OPENAI)_/i.test(k))).toEqual([]);
      expect(JSON.stringify(out)).not.toMatch(/FAKE-HOSTED-KEY|sk-lower-case|proxy\.example/);
      expect(out.PATH).toBe('/usr/bin');
    }
  });
});

/** Every bare specifier the module graph from entry reaches, following @widedoor/* into their builds. */
function bareImports(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const pending = [...entries];
  const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const [, spec] of text.matchAll(SPEC)) {
      if (spec === undefined || spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) {
        pending.push(resolve(dirname(file), spec));
        continue;
      }
      bare.add(spec);
      if (spec.startsWith('@widedoor/')) pending.push(createRequire(file).resolve(spec));
    }
  }
  return bare;
}

describe('the built hosted entries', () => {
  const entries = ['api-bin', 'agent-bin', 'agent-child'].map((name) =>
    join(SERVER, 'dist', 'hosted', `${name}.js`),
  );

  it('reach no @widedoor/ai, @anthropic-ai or openai module', () => {
    for (const entry of entries) {
      if (!existsSync(entry)) throw new Error(`${entry} is missing: run npm run build first`);
      const source = entry.replace(/[\\/]dist[\\/]/, '/src/').replace(/\.js$/, '.ts');
      if (statSync(entry).mtimeMs < statSync(source).mtimeMs)
        throw new Error(`${entry} is older than its source: run npm run build first`);
    }
    const bare = bareImports(entries);
    // The walk saw the workspace packages, so it is following imports at all.
    expect([...bare].filter((s) => s.startsWith('@widedoor/')).length).toBeGreaterThan(2);
    expect([...bare].filter((s) => FORBIDDEN.test(s))).toEqual([]);
  });
});

describe('@widedoor/server', () => {
  it('does not depend on @widedoor/ai or a provider SDK in any form', () => {
    const pkg = JSON.parse(readFileSync(join(SERVER, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ])
      expect(
        Object.keys(pkg[field] ?? {}).filter((d) => FORBIDDEN.test(d)),
        field,
      ).toEqual([]);
  });

  it('never imports them, not even for types', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true }))
        if (name.isDirectory()) walk(join(dir, name.name));
        else if (name.name.endsWith('.ts')) files.push(join(dir, name.name));
    };
    walk(join(SERVER, 'src'));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files)
      expect(readFileSync(file, 'utf8'), file).not.toMatch(
        /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](?:@widedoor\/ai|@anthropic-ai\/[^'"]*|openai(?:\/[^'"]*)?|[^'"]*\/ai\/(?:src|dist)\/[^'"]*)['"]/,
      );
  });
});
