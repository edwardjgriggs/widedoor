import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseJsonReport } from '@widedoor/report';
import { META, MODERN_VERSIONS, serveMcp, toolContext } from '../src/mcp/server.ts';
import type { ToolContext } from '../src/mcp/tools.ts';
import { BIN, CORPUS, buildCli, runCli, serveHtml, type StaticServer } from './helpers.ts';

/*
 * widedoor mcp scanning for real (Chromium against a corpus page on
 * 127.0.0.1), in process: with --allow-local the summary's findings are the
 * ones widedoor scan finds on the same page; by default the same URL is
 * refused naming the policy; and even with the up-front check skipped (as a
 * redirect would skip it), the egress proxy keeps a public-only scan off
 * 127.0.0.1.
 */

const TIMEOUT = 240_000;
const unsafeNoSandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1';
let tmp: string;
let site: StaticServer;

beforeAll(async () => {
  buildCli();
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'widedoor-mcp-browser-')));
  site = await serveHtml(join(CORPUS, 'web'));
}, TIMEOUT);

afterAll(async () => {
  await site?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const meta = { [META.version]: MODERN_VERSIONS[0], [META.capabilities]: {} };

type Result = {
  isError?: boolean;
  content: { text: string }[];
  structuredContent: Record<string, unknown>;
};

/** An in-process server for a root, with the real tool context (changed by over). */
function server(name: string, allowLocal: boolean, over: Partial<ToolContext> = {}) {
  const root = join(tmp, name);
  mkdirSync(root);
  const input = new PassThrough();
  const replies = new Map<number, Result>();
  const logs: string[] = [];
  const tools = {
    ...toolContext(
      { command: 'mcp', root, allowLocal },
      { err: (l) => void logs.push(l), cwd: tmp },
    ),
    ...over,
  };
  const done = serveMcp({
    tools,
    input,
    write: (line) => {
      const message = JSON.parse(line) as { id: number; result: Result };
      replies.set(message.id, message.result);
    },
    log: (line) => void logs.push(line),
  });
  let id = 0;
  const call = async (tool: string, args: unknown): Promise<Result> => {
    const mine = ++id;
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: mine, method: 'tools/call', params: { name: tool, arguments: args, _meta: meta } })}\n`,
    );
    for (let i = 0; i < 2000; i++) {
      const found = replies.get(mine);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no reply from ${tool}`);
  };
  const close = async () => {
    input.end();
    await done;
  };
  return { root, call, close, logs };
}

describe('widedoor mcp scans', () => {
  it.skipIf(unsafeNoSandbox)(
    'with --allow-local, finds on a corpus page what widedoor scan finds',
    async () => {
      const page = `${site.origin}/alt-fail.html`;
      const cli = await runCli(['scan', page, '--out', join(tmp, 'cli'), '--format', 'json'], {
        cwd: tmp,
      });
      expect(cli.code, cli.stderr).toBe(1);
      const expected = parseJsonReport(readFileSync(join(tmp, 'cli', 'report.json'), 'utf8'))
        .findings.filter((f) => f.outcome === 'fail' || f.outcome === 'needs-review')
        .map((f) => f.id)
        .sort();
      expect(expected.length).toBeGreaterThan(0);

      const s = server('local', true);
      try {
        const scan = await s.call('widedoor_scan_url', { urls: [page] });
        expect(scan.isError, scan.content.map((c) => c.text).join()).not.toBe(true);
        expect(scan.structuredContent.assetsScanned).toBe(1);
        const read = await s.call('widedoor_read_report', { limit: 200 });
        const ids = (read.structuredContent.findings as { id: string }[]).map((f) => f.id).sort();
        expect(ids).toEqual(expected);
        expect(String(scan.structuredContent.reportPath)).toMatch(/^widedoor-report\/mcp\//);
        expect(s.logs.some((l) => l.startsWith('widedoor mcp: scan finished'))).toBe(true);
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    'by default refuses the same local URL, naming the policy',
    async () => {
      const s = server('public', false);
      try {
        const r = await s.call('widedoor_scan_url', { urls: [`${site.origin}/alt-fail.html`] });
        expect(r.isError).toBe(true);
        expect(r.content[0]!.text).toMatch(
          /^urls\[0\] is refused by the public-only network policy/,
        );
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it.skipIf(unsafeNoSandbox)(
    'keeps a public-only scan off 127.0.0.1 through the egress proxy even past the up-front check',
    async () => {
      // As a redirect would: the URL passes the first check, then the page goes local.
      const s = server('proxied', false, { checkUrl: async () => undefined });
      try {
        const r = await s.call('widedoor_scan_url', { urls: [`${site.origin}/alt-fail.html`] });
        expect(r.isError, r.content.map((c) => c.text).join()).not.toBe(true);
        expect(r.structuredContent.assetsScanned).toBe(0);
        expect(r.structuredContent.assetsUnscanned).toBe(1);
        expect(r.structuredContent.findings).toEqual([]);
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  // 3b.9 fix round 1 item 7: a real scan over real stdio puts nothing but MCP messages on stdout.
  it.skipIf(unsafeNoSandbox)(
    'keeps stdout to JSON-RPC lines while the built bin scans a corpus page',
    async () => {
      const root = join(tmp, 'stdio');
      mkdirSync(root);
      const child = spawn(process.execPath, [BIN, 'mcp', '--allow-local', '--root', root], {
        cwd: tmp,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => (out += c));
      child.stderr.on('data', (c: string) => (err += c));
      const exited = new Promise<number | null>((done) => child.once('exit', done));
      const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
      const reply = async (id: number) => {
        for (let i = 0; i < 2000; i++) {
          const line = out.split('\n').find((l) => l !== '' && JSON.parse(l).id === id);
          if (line) return JSON.parse(line) as { result: Result };
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`no reply ${id}: ${err}`);
      };
      send({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } });
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'widedoor_scan_url',
          arguments: { urls: [`${site.origin}/alt-fail.html`] },
          _meta: meta,
        },
      });
      const scan = (await reply(2)).result;
      expect(scan.isError, scan.content.map((c) => c.text).join()).not.toBe(true);
      expect(scan.structuredContent.assetsScanned).toBe(1);
      child.stdin.end();
      expect(await exited).toBe(0);
      const lines = out.split('\n').filter((l) => l !== '');
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        const message = JSON.parse(line) as Record<string, unknown>;
        expect(message.jsonrpc).toBe('2.0');
        expect(typeof message.id).toBe('number');
        expect('result' in message || 'error' in message).toBe(true);
      }
      // The log, and only the log, is on stderr.
      expect(err).toContain('widedoor mcp: scan finished');
    },
    TIMEOUT,
  );
});
