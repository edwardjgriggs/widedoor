import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EGRESS_PORT, SAME_USER_ENV, main } from '../src/hosted/egress-bin.ts';

/*
 * egress-bin through main() (the uid gate, startup failure, stop; on any free port), and
 * the built process itself on its fixed port: its first line, a refusal with its event
 * line, and SIGTERM.
 */

const built = fileURLToPath(new URL('../dist/hosted/egress-bin.js', import.meta.url));
const source = fileURLToPath(new URL('../src/hosted/egress-bin.ts', import.meta.url));

const REFUSED_LINE =
  /^widedoor event=egress_refused host=10\.0\.0\.1 reason=private method=GET via=absolute$/;

/** Sends one raw request and resolves with everything the proxy answers. */
function exchange(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    socket.write(text);
  });
}

const PRIVATE_GET = 'GET http://10.0.0.1/ HTTP/1.1\r\nHost: 10.0.0.1\r\n\r\n';

/** Runs main until its ready line, then hands back its lines, its port and a stop. */
async function run(getuid: () => number | undefined, env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  const stop = new AbortController();
  let ready: (port: number) => void = () => undefined;
  const port = new Promise<number>((resolve) => (ready = resolve));
  const exit = main({
    env,
    getuid,
    port: 0,
    signal: stop.signal,
    write: (line) => {
      lines.push(line);
      const match = /^ready (\d+)$/.exec(line);
      if (match) ready(Number(match[1]));
    },
  });
  return { lines, port: await Promise.race([port, exit.then(() => 0)]), stop, exit };
}

describe('egress-bin main', () => {
  it('refuses to run as root', async () => {
    const lines: string[] = [];
    const code = await main({
      env: {},
      getuid: () => 0,
      port: 0,
      signal: new AbortController().signal,
      write: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines).toEqual(['widedoor event=egress_config_error name=uid']);
  });

  it('runs as root only with the test switch', async () => {
    const { lines, port, stop, exit } = await run(() => 0, { [SAME_USER_ENV]: '1' });
    expect(port).toBeGreaterThan(0);
    stop.abort();
    expect(await exit).toBe(0);
    expect(lines).toEqual([`ready ${port}`]);
  });

  it('writes ready first, then one line per event, and exits 0 when stopped', async () => {
    const { lines, port, stop, exit } = await run(() => 10002);
    expect(lines[0]).toBe(`ready ${port}`);
    const answer = await exchange(port, PRIVATE_GET);
    expect(answer.startsWith('HTTP/1.1 403 ')).toBe(true);
    expect(lines.slice(1)).toHaveLength(1);
    expect(lines[1]).toMatch(REFUSED_LINE);
    stop.abort();
    expect(await exit).toBe(0);
  });

  it('treats an unknown uid as root except on Windows', async () => {
    const lines: string[] = [];
    const stop = new AbortController();
    const exit = main({
      env: {},
      getuid: () => undefined,
      port: 0,
      signal: stop.signal,
      write: (line) => lines.push(line),
    });
    stop.abort();
    if (process.platform === 'win32') {
      expect(await exit).toBe(0);
      expect(lines[0]).toMatch(/^ready \d+$/);
    } else {
      expect(await exit).toBe(1);
      expect(lines).toEqual(['widedoor event=egress_config_error name=uid']);
    }
  });

  it('reports a start the loopback check refuses and exits 1', async () => {
    const lines: string[] = [];
    const code = await main({
      env: {},
      getuid: () => 10002,
      host: '0.0.0.0',
      port: 0,
      signal: new AbortController().signal,
      write: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines).toEqual(['widedoor event=egress_start_failed']);
  });
});

describe('egress-bin process', () => {
  it('starts on port 18080, refuses a private address, logs it and stops on SIGTERM', async () => {
    if (!existsSync(built)) throw new Error(`${built} is missing: run npm run build first`);
    if (statSync(built).mtimeMs < statSync(source).mtimeMs)
      throw new Error(`${built} is older than its source: run npm run build first`);
    // CI may run as root; the switch is for that case only.
    const env = { ...process.env };
    if (process.getuid?.() === 0) env[SAME_USER_ENV] = '1';
    else delete env[SAME_USER_ENV];
    const child = spawn(process.execPath, [built], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    let gone = false;
    try {
      const lines: string[] = [];
      const waiters: (() => void)[] = [];
      const wakeAll = (): void => {
        for (const wake of waiters.splice(0)) wake();
      };
      createInterface({ input: child.stdout }).on('line', (line) => {
        lines.push(line);
        wakeAll();
      });
      child.once('exit', () => {
        gone = true;
        wakeAll();
      });
      // Fails at once, with the child's stderr, if the child exits before the line comes.
      const lineAt = async (index: number): Promise<string> => {
        while (lines[index] === undefined) {
          if (gone)
            throw new Error(
              `egress-bin exited early; stdout ${JSON.stringify(lines)}, stderr ${stderr}`,
            );
          await new Promise<void>((wake) => waiters.push(wake));
        }
        return lines[index];
      };

      // The fixed port: this fails, with egress_start_failed code=EADDRINUSE, if the host
      // already has a listener on it.
      expect(EGRESS_PORT).toBe(18080);
      const first = await lineAt(0);
      expect(first).toBe(`ready ${EGRESS_PORT}`);
      const port = EGRESS_PORT;

      const answer = await exchange(port, PRIVATE_GET);
      expect(answer.startsWith('HTTP/1.1 403 ')).toBe(true);
      expect(await lineAt(1)).toMatch(REFUSED_LINE);

      child.kill('SIGTERM');
      const { code, signal } = await exited;
      // Windows has no SIGTERM handler: kill() ends the process outright, so there this
      // only shows that the process stops. Elsewhere the handler closes the proxy and exits 0.
      if (process.platform === 'win32') expect(signal ?? code).not.toBeNull();
      else expect(code).toBe(0);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('exits 1 once its output can no longer be written (the reader died)', async () => {
    if (!existsSync(built)) throw new Error(`${built} is missing: run npm run build first`);
    const env = { ...process.env };
    if (process.getuid?.() === 0) env[SAME_USER_ENV] = '1';
    else delete env[SAME_USER_ENV];
    const child = spawn(process.execPath, [built], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = new Promise<number | null>((resolve) =>
      child.once('exit', (code) => resolve(code)),
    );
    try {
      const first = await new Promise<string>((resolve) =>
        createInterface({ input: child.stdout }).once('line', resolve),
      );
      expect(first).toBe(`ready ${EGRESS_PORT}`);
      // The reader's end of the pipe closes; the next event line cannot be written.
      child.stdout.destroy();
      await exchange(EGRESS_PORT, PRIVATE_GET).catch(() => '');
      expect(await exited).toBe(1);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
