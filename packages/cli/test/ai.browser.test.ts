import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeProvider } from '@widedoor/ai';
import { main, type Io } from '../src/main.ts';
import { BIN, CORPUS, buildCli, serveHtml, type CliRun, type StaticServer } from './helpers.ts';

/*
 * AI fix suggestions around a real scan (Chromium against corpus pages on
 * 127.0.0.1). The built bin runs with a module hook that fails any attempt
 * to load @widedoor/ai, which proves a plain scan never loads it (ruling 6)
 * and that an AI failure leaves the scan's exit code alone. The scan with
 * --ai-fixes runs in process, with a fake provider through main's test seam:
 * no request ever reaches a real provider.
 */

const TIMEOUT = 120_000;
const sandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1' ? ['--unsafe-no-sandbox'] : [];
const FAKE_KEY = 'sk-ant-api03-FAKE-BROWSER-KEY-DO-NOT-PRINT';
let site: StaticServer;
let tmp: string;

/** A module hook (node --import) under which resolving @widedoor/ai throws AI_LOADED. */
const NO_AI_HOOK = `data:text/javascript,${encodeURIComponent(
  `import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(
  "export async function resolve(s, c, next) { if (s === '@widedoor/ai' || s.startsWith('@widedoor/ai/')) throw new Error('AI_LOADED'); return next(s, c); }"
));`,
)}`;

function runWithoutAi(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliRun> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', NO_AI_HOOK, BIN, ...args], {
      cwd: tmp,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.once('error', fail);
    child.once('close', (code, signal) => done({ code, signal, stdout, stderr }));
  });
}

beforeAll(async () => {
  buildCli();
  site = await serveHtml(join(CORPUS, 'web'));
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-ai-cli-'));
}, TIMEOUT);

afterAll(async () => {
  await site?.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('scans and @widedoor/ai', () => {
  it(
    'a plain scan never loads @widedoor/ai',
    async () => {
      const out = join(tmp, 'plain');
      const r = await runWithoutAi([
        'scan',
        `${site.origin}/alt-fail.html`,
        '--out',
        out,
        ...sandbox,
      ]);
      expect(r.stderr).not.toContain('AI_LOADED');
      expect(r.code).toBe(1);
      expect(existsSync(join(out, 'report.json'))).toBe(true);
      expect(readdirSync(out).filter((n) => n.startsWith('ai-'))).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'a failed AI step (here the hook refusing the load) leaves the exit code and the reports alone',
    async () => {
      const out = join(tmp, 'dry');
      const r = await runWithoutAi([
        'scan',
        `${site.origin}/alt-fail.html`,
        '--out',
        out,
        '--ai-dry-run',
        ...sandbox,
      ]);
      // The positive control for the test above: the hook does catch a load.
      expect(r.stderr).toContain('AI fix suggestions failed: AI_LOADED');
      expect(r.code).toBe(1);
      expect(existsSync(join(out, 'report.json'))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    '--ai-fixes writes the reports, then the sidecars, with the scan exit code and no key anywhere',
    async () => {
      const saved = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = FAKE_KEY;
      const out = join(tmp, 'ai');
      const lines: string[] = [];
      const io: Io = { out: (l) => void lines.push(l), err: (l) => void lines.push(l), cwd: tmp };
      const provider = createFakeProvider(() => ({
        status: 'ok',
        text: JSON.stringify({
          kind: 'web-patch',
          summary: 'Add a text alternative.',
          patch: '<img src="photo.png" alt="A product photo">',
          notes: null,
        }),
        modelAnswered: 'claude-opus-5-5',
        usage: { inputTokens: 10, outputTokens: 5 },
      }));
      try {
        const code = await main(
          ['scan', `${site.origin}/alt-fail.html`, '--out', out, '--ai-fixes', ...sandbox],
          io,
          { ai: { provider: () => provider } },
        );
        expect(code).toBe(1);
      } finally {
        if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = saved;
      }
      expect(provider.calls.length).toBeGreaterThan(0);
      for (const call of provider.calls) expect(call.user).not.toContain(site.origin);
      const names = readdirSync(out);
      expect(names).toEqual(
        expect.arrayContaining(['report.json', 'ai-suggestions.json', 'ai-suggestions.html']),
      );
      const doc = JSON.parse(readFileSync(join(out, 'ai-suggestions.json'), 'utf8'));
      expect(doc.entries.length).toBe(provider.calls.length);
      const everything = [
        ...lines,
        ...names
          .filter((n) => !n.includes('evidence'))
          .flatMap((n) => {
            const path = join(out, n);
            try {
              return [readFileSync(path, 'utf8')];
            } catch {
              return [];
            }
          }),
      ].join('\n');
      expect(everything).not.toContain(FAKE_KEY);
    },
    TIMEOUT,
  );

  // 3b.7 fix round 1 item 1: Ctrl+C during the AI step.
  it(
    'a stop signal during the suggestions aborts them, still writes the document and keeps the scan exit code',
    async () => {
      const saved = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = FAKE_KEY;
      const out = join(tmp, 'ai-stopped');
      const lines: string[] = [];
      const io: Io = { out: (l) => void lines.push(l), err: (l) => void lines.push(l), cwd: tmp };
      // The stop-signal seam: the test fires what Ctrl+C would.
      let fire: (signal: string) => void = () => undefined;
      const provider = createFakeProvider(() => {
        fire('SIGINT');
        return {
          status: 'ok',
          text: JSON.stringify({
            kind: 'web-patch',
            summary: 's',
            patch: '<img alt="x">',
            notes: null,
          }),
          modelAnswered: 'claude-opus-5-5',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      });
      let code: number;
      try {
        code = await main(
          ['scan', `${site.origin}/alt-fail.html`, '--out', out, '--ai-fixes', ...sandbox],
          io,
          {
            ai: {
              provider: () => provider,
              onStop: (onSignal) => {
                fire = onSignal;
                return () => undefined;
              },
            },
          },
        );
      } finally {
        if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = saved;
      }
      // The scan's own code (a fail), not the stop's 2, and no process.exit.
      expect(code).toBe(1);
      expect(provider.calls).toHaveLength(1);
      expect(lines.join('\n')).toContain(
        'widedoor: interrupted (SIGINT); finishing the suggestions document.',
      );
      expect(lines.join('\n')).not.toContain('No report was written');
      expect(readdirSync(out)).toEqual(
        expect.arrayContaining(['report.json', 'ai-suggestions.json', 'ai-suggestions.html']),
      );
      const doc = JSON.parse(readFileSync(join(out, 'ai-suggestions.json'), 'utf8')) as {
        entries: { status: string; reason?: string }[];
      };
      expect(doc.entries.length).toBeGreaterThan(0);
      for (const e of doc.entries)
        expect(e.reason === 'cancelled' || e.status === 'not-sent', JSON.stringify(e)).toBe(true);
      expect(readdirSync(out).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    },
    TIMEOUT,
  );
});
