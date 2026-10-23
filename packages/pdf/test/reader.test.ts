import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PdfScanner, inspectPdf, readerEnv, type InspectLimits } from '../src/index.ts';
import { fakeRunner, fakeSpawn, result, verapdfReport } from './fixtures.ts';

// The pdf.js reader process: its environment, its reply contract, and how it ends on its own.

const childPath = fileURLToPath(new URL('../src/inspect-child.ts', import.meta.url));
const limits: InspectLimits = { maxPages: 10, timeoutMs: 30_000, maxHeapMb: 256, maxRssMb: 1024 };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

async function waitForExit(pid: number, withinMs: number): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return !alive(pid);
}

describe('reader environment', () => {
  it('passes only allow-listed variables, whatever their case', () => {
    const env = readerEnv({
      PATH: '/usr/bin',
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      TEMP: '/tmp',
      HOME: '/home/u',
      GITHUB_TOKEN: 'ghp_secret',
      AWS_SECRET_ACCESS_KEY: 'x',
      NODE_OPTIONS: '--require ./evil.js',
      node_options: '--require ./evil.js',
    });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'Path', 'SystemRoot', 'TEMP']);
  });

  it('starts the reader with that environment', async () => {
    const { spawn, calls } = fakeSpawn((c) => c.child.exit(1));
    await inspectPdf(new Uint8Array(1), limits, spawn);
    const env = calls[0]!.options.env ?? {};
    expect(Object.keys(env).every((k) => !/TOKEN|SECRET|NODE_OPTIONS/i.test(k))).toBe(true);
    // Its own deadline goes along as the last argument.
    expect(calls[0]!.args.at(-1)).toBe(String(limits.timeoutMs));
  });
});

describe('reader reply', () => {
  const reply = async (stdout: string) => {
    const { spawn } = fakeSpawn((c) => c.child.exit(0, stdout));
    return inspectPdf(new Uint8Array(1), limits, spawn);
  };

  it('accepts a reply of the agreed shape', async () => {
    const ok = {
      ok: true,
      inspection: {
        pages: 1,
        title: 'T',
        displayDocTitle: true,
        lang: 'en',
        outlineItems: 0,
        tagged: false,
        structureTypes: [],
        structureTruncated: false,
        imageOnlyPages: [],
      },
    };
    expect(await reply(JSON.stringify(ok))).toEqual(ok);
  });

  it('turns any other reply into scan-failed', async () => {
    const bad = [
      '{"ok":true,"inspection":{"pages":"1"}}',
      '{"ok":true}',
      JSON.stringify({ ok: false, code: 'all-good', message: 'x' }),
      JSON.stringify({ ok: false, code: 'scan-failed', message: 'x'.repeat(5000) }),
      '[]',
      'not json',
    ];
    for (const stdout of bad)
      expect(await reply(stdout), stdout.slice(0, 40)).toMatchObject({
        ok: false,
        code: 'scan-failed',
      });
  });
});

describe('error messages', () => {
  it('get the snippet treatment: no control or bidi characters reach run metadata', async () => {
    const esc = String.fromCharCode(0x1b);
    const rlo = String.fromCharCode(0x202e);
    // A rule id built from a hostile clause ends up in the normalization error message.
    const runner = fakeRunner(
      result(verapdfReport([{ clause: `9${esc}[2J${rlo}`, testNumber: 1, status: 'passed' }])),
    );
    const scanner = await PdfScanner.create({
      verapdf: runner,
      baseDir: fileURLToPath(new URL('../../../corpus/', import.meta.url)),
    });
    const scan = await scanner.scanFile('pdf/untagged.pdf');
    expect(scan.error?.code).toBe('scan-failed');
    const message = scan.error?.message ?? '';
    expect(message).toMatch(/not in verapdf-map/);
    expect(message.includes(esc) || message.includes(rlo)).toBe(false);
  });
});

describe('reader lifetime', () => {
  it('ends itself after its own deadline even if nobody kills it', async () => {
    // stdin is never closed, so the reader waits for its PDF until the watchdog's deadline (1 ms + 5 s).
    const child = nodeSpawn(process.execPath, [childPath, '10', '1024', '1'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: readerEnv(),
    });
    const started = Date.now();
    const exited = await new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(false), 20_000);
      child.once('exit', () => {
        clearTimeout(timer);
        done(true);
      });
    });
    expect(exited).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
    child.stdin.destroy();
  }, 30_000);

  it('ends itself when its parent process dies', async () => {
    // An intermediate parent starts the reader on our stdin pipe (held open), prints its pid and exits.
    const launcher = [
      "const { spawn } = require('node:child_process');",
      `const c = spawn(process.execPath, [${JSON.stringify(childPath)}, '10', '1024', '600000'],`,
      "  { stdio: [0, 'ignore', 'ignore'], detached: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });",
      'c.unref(); process.stdout.write(String(c.pid)); process.exit(0);',
    ].join('\n');
    const parent = nodeSpawn(process.execPath, ['-e', launcher], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    parent.stdout.on('data', (b: Buffer) => (out += b.toString()));
    await new Promise((done) => parent.once('exit', done));
    const pid = Number(out);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    try {
      // The watchdog checks its parent about every 0.5 s.
      expect(await waitForExit(pid, 10_000)).toBe(true);
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
      parent.stdin.destroy();
    }
  }, 30_000);
});
