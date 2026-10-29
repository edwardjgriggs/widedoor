import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EGRESS_EVENTS,
  EgressLines,
  MAX_LINES_PER_EVENT,
  READY_TIMEOUT_MS,
  SUMMARY_REASONS,
  runReader,
} from '../src/hosted/egress-reader-bin.ts';
import { JOB_ID } from './hosted-fixtures.ts';

/*
 * The scan entry's reader of egress-bin's stdout: the ready line, the line filter and
 * tags, the per-event cap and its summary, and what it does when egress-bin never gets
 * ready (SIGTERM to the entry) or its output ends (SIGUSR1 to the entry, which then
 * stops the agent; ledger R32). The entry itself runs it in
 * hosted-lockdown.image.test.ts.
 */

const REFUSED =
  'widedoor event=egress_refused host=10.0.0.1 reason=private method=GET via=absolute';

/** The egress_summary line for these counts by reason (every other reason 0). */
const summaryLine = (counts: Record<string, number> = {}, jobId = JOB_ID) => {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const fields = SUMMARY_REASONS.map((r) => `${r.replace(/-/g, '_')}=${counts[r] ?? 0}`);
  return `widedoor event=egress_summary job=${jobId} refused=${total} ${fields.join(' ')}`;
};

describe('EgressLines', () => {
  const feed = (text: string | Buffer, jobId = JOB_ID) => {
    const log: string[] = [];
    const lines = new EgressLines(jobId, (line) => log.push(line));
    lines.push(Buffer.isBuffer(text) ? text : Buffer.from(text));
    lines.end();
    return { lines, log };
  };

  it('needs the ready line first, exactly', () => {
    expect(READY_TIMEOUT_MS).toBe(10_000);
    expect(feed('ready 18080\n').lines.state).toBe('ready');
    for (const first of ['ready 18081\n', 'ready 18080 \n', `${REFUSED}\nready 18080\n`, '\n'])
      expect(feed(first).lines.state, first).toBe('refused');
    expect(feed('').lines.state).toBe('waiting');
    // A refused reader forwards nothing after.
    expect(feed(`ready 1\n${REFUSED}\n`).log).toEqual([]);
  });

  it('forwards known events tagged with the job and source=egress, split anywhere', () => {
    const log: string[] = [];
    const lines = new EgressLines(JOB_ID, (line) => log.push(line));
    const text = `ready 18080\n${REFUSED}\r\nwidedoor event=egress_upstream_error host=a.example\n`;
    for (const byte of Buffer.from(text)) lines.push(Buffer.from([byte]));
    lines.end();
    expect(log).toEqual([
      `widedoor event=egress_refused job=${JOB_ID} source=egress host=10.0.0.1 reason=private method=GET via=absolute`,
      `widedoor event=egress_upstream_error job=${JOB_ID} source=egress host=a.example`,
    ]);
    expect(lines.summary()).toEqual([summaryLine({ private: 1 })]);
  });

  it('leaves out an id that is not a job id', () => {
    expect(feed(`ready 18080\n${REFUSED}\n`, 'not-a-job').log).toEqual([
      'widedoor event=egress_refused source=egress host=10.0.0.1 reason=private method=GET via=absolute',
    ]);
  });

  it('drops and counts every line it cannot vouch for', () => {
    const forged = [
      'widedoor event=agent_result status=done',
      'widedoor event=egress_lines_dropped name=egress_refused count=0',
      'widedoor event=egress_refused job=0 host=a',
      'widedoor event=egress_refused source=child host=a',
      'widedoor event=egress_refused host=a host=b',
      'widedoor event=egress_refused host=a b',
      'widedoor event=egress_refused host=a\u0007',
      '(node:12) Warning: something',
      `widedoor event=egress_refused host=${'a'.repeat(5000)}`,
      'ready 18080',
    ];
    const { log, lines } = feed(`ready 18080\n${forged.join('\n')}\n`);
    expect(log).toEqual([]);
    expect(lines.summary()).toEqual([
      `widedoor event=egress_lines_dropped job=${JOB_ID} name=invalid count=${forged.length}`,
      summaryLine(),
    ]);
  });

  it('forwards at most 200 lines per event name, then counts them, once per name', () => {
    expect(MAX_LINES_PER_EVENT).toBe(200);
    const idle = 'widedoor event=egress_idle_timeout host=a';
    const text = [
      'ready 18080',
      ...Array.from({ length: 250 }, () => REFUSED),
      ...Array.from({ length: 201 }, () => idle),
      'widedoor event=egress_over_capacity',
      '',
    ].join('\n');
    const { log, lines } = feed(text);
    expect(log.filter((l) => l.startsWith('widedoor event=egress_refused '))).toHaveLength(200);
    expect(log.filter((l) => l.startsWith('widedoor event=egress_idle_timeout '))).toHaveLength(
      200,
    );
    expect(log.at(-1)).toBe(`widedoor event=egress_over_capacity job=${JOB_ID} source=egress`);
    expect(lines.summary()).toEqual([
      `widedoor event=egress_lines_dropped job=${JOB_ID} name=egress_refused count=50`,
      `widedoor event=egress_lines_dropped job=${JOB_ID} name=egress_idle_timeout count=1`,
      // Every refusal is counted, the 50 past the line cap included.
      summaryLine({ private: 250 }),
    ]);
  });

  it('counts refusals by reason, metadata included, and an unknown reason as other', () => {
    const refused = (reason: string) =>
      `widedoor event=egress_refused host=a.example reason=${reason} method=GET via=connect`;
    const text = [
      'ready 18080',
      refused('metadata'),
      refused('metadata'),
      refused('link-local'),
      refused('host-limit'),
      refused('policy'),
      refused('made_up'),
      // Not a well-formed refusal line: dropped as invalid and not counted.
      'widedoor event=egress_refused reason=metadata reason=private',
      '',
    ].join('\n');
    const { lines } = feed(text);
    expect(lines.summary().at(-1)).toBe(
      summaryLine({ metadata: 2, 'link-local': 1, 'host-limit': 1, policy: 1, other: 1 }),
    );
    // A reader whose proxy never got ready says nothing of refusals.
    expect(feed('ready 1\n').lines.summary()).toEqual([]);
  });

  it('knows every event the proxy writes', () => {
    expect([...EGRESS_EVENTS].sort()).toEqual([
      'egress_idle_timeout',
      'egress_malformed',
      'egress_over_capacity',
      'egress_refused',
      'egress_upstream_error',
    ]);
  });
});

describe('runReader', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const ENTRY = 4242;

  /** The reader on a PassThrough, with a parent pid the test can change. */
  const start = (options: { readyTimeoutMs?: number; args?: string[] } = {}) => {
    dir = mkdtempSync(join(tmpdir(), 'widedoor-reader-'));
    const ready = join(dir, 'ready');
    const input = new PassThrough();
    const log: string[] = [];
    const kills: [number, string][] = [];
    const parent = { pid: ENTRY };
    const stop = new AbortController();
    const exit = runReader({
      env: { WIDEDOOR_JOB_ID: JOB_ID, WIDEDOOR_JOB_TOKEN: 'never-read' },
      args: options.args ?? [String(ENTRY), ready],
      input,
      log: (line) => log.push(line),
      getppid: () => parent.pid,
      kill: (pid, signal) => void kills.push([pid, signal]),
      signal: stop.signal,
      readyTimeoutMs: options.readyTimeoutMs ?? 2_000,
      watchMs: 20,
    });
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
    };
    return { ready, input, log, kills, parent, stop, exit, until };
  };

  it('creates the ready file on the ready line, and ends with a summary if the wrapper is gone', async () => {
    const r = start();
    r.input.write('ready 18080\n');
    await r.until(() => existsSync(r.ready));
    expect(existsSync(r.ready)).toBe(true);
    for (let i = 0; i < MAX_LINES_PER_EVENT + 3; i++) r.input.write(`${REFUSED}\n`);
    await r.until(() => r.log.length === MAX_LINES_PER_EVENT);
    // The wrapper was killed: this reader is handed to another parent.
    r.parent.pid = 1;
    expect(await r.exit).toBe(0);
    expect(r.log.slice(-2)).toEqual([
      `widedoor event=egress_lines_dropped job=${JOB_ID} name=egress_refused count=3`,
      summaryLine({ private: MAX_LINES_PER_EVENT + 3 }),
    ]);
    expect(r.kills).toEqual([]);
  });

  it('ends with the summary when the entry says the scan is over', async () => {
    const r = start();
    r.input.write('ready 18080\nnot an event\n');
    await r.until(() => existsSync(r.ready));
    r.stop.abort();
    expect(await r.exit).toBe(0);
    expect(r.log).toEqual([
      `widedoor event=egress_lines_dropped job=${JOB_ID} name=invalid count=1`,
      summaryLine(),
    ]);
  });

  it('tells the entry to stop the agent when the proxy output ends', async () => {
    const r = start();
    r.input.write(`ready 18080\n${REFUSED}\n`);
    await r.until(() => existsSync(r.ready));
    r.input.end();
    expect(await r.exit).toBe(1);
    expect(r.kills).toEqual([[ENTRY, 'SIGUSR1']]);
    expect(r.log).toEqual([
      `widedoor event=egress_refused job=${JOB_ID} source=egress host=10.0.0.1 reason=private method=GET via=absolute`,
      `widedoor event=egress_exited job=${JOB_ID}`,
      summaryLine({ private: 1 }),
    ]);
  });

  it('stops the entry, with no ready file, when the proxy never gets ready', async () => {
    for (const [write, reason] of [
      [
        (r: ReturnType<typeof start>) =>
          r.input.write('widedoor event=egress_start_failed code=EADDRINUSE\n'),
        'line',
      ],
      [(r: ReturnType<typeof start>) => r.input.end(), 'exited'],
      [() => undefined, 'timeout'],
    ] as const) {
      const r = start({ readyTimeoutMs: 100 });
      write(r);
      expect(await r.exit, reason).toBe(1);
      expect(existsSync(r.ready)).toBe(false);
      expect(r.kills).toEqual([[ENTRY, 'SIGTERM']]);
      expect(r.log).toEqual([`widedoor event=egress_not_ready job=${JOB_ID} reason=${reason}`]);
      rmSync(dir as string, { recursive: true, force: true });
    }
  });

  it('refuses a ready file that is already there', async () => {
    const r = start();
    writeFileSync(r.ready, '');
    r.input.write('ready 18080\n');
    expect(await r.exit).toBe(1);
    expect(r.log).toEqual([`widedoor event=egress_not_ready job=${JOB_ID} reason=file`]);
  });

  it('refuses arguments that are not a pid and an absolute ready file', async () => {
    for (const args of [[], ['0', '/tmp/ready'], ['4242', 'ready'], ['+4242', '/tmp/ready']]) {
      const r = start({ args });
      expect(await r.exit, JSON.stringify(args)).toBe(1);
      expect(r.log).toEqual([`widedoor event=egress_reader_config_error job=${JOB_ID}`]);
      expect(r.kills).toEqual([]);
      rmSync(dir as string, { recursive: true, force: true });
    }
  });
});
