import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EgressRefusedError } from '@widedoor/web/egress';
import { formatFetchRefusal, formatRobotsDecision } from '../src/hosted/agent.ts';
import {
  ChildStderr,
  MAX_CHILD_OUTPUT_BYTES,
  REAP_COMMAND,
  REAP_PASSES,
  RESULT_TIMEOUT_MS,
  SCAN_UID,
  SETPRIV,
  STOPPED,
  TIMED_OUT,
  TOO_LARGE,
  childCommand,
  childEnv,
  runAgent,
} from '../src/hosted/agent-bin.ts';
import { MAX_RETAINED_BYTES } from '../src/hosted/jobs.ts';
import {
  API_HEAP_MB,
  API_MEMORY_MB,
  DOWNLOAD_CHUNK_BYTES,
  DOWNLOADS_IN_FLIGHT,
  MAX_REPORT_BYTES,
  MEASURED_PEAK_HEAP_MB,
  OPEN_TIER,
  OVERHEAD_MB,
  UPLOADS_OFF_HEAP_MB,
  TIERS,
  VERIFIED_TIER,
  VERIFY_WALL_CLOCK_MS,
  maxPolicySkipsFor,
  timeLimitFor,
} from '../src/hosted/limits.ts';
import {
  INPUT_REFUSED,
  JOB_ERROR_MAX,
  JobInputSchema,
  JobResultSchema,
  REPORT_TOO_LARGE,
  RESULT_DEADLINE_MS,
  VerifyResultSchema,
  jobError,
  jobUrl,
  normalizeVerifyHost,
  resultBodyMax,
  type JobInput,
} from '../src/hosted/protocol.ts';
import {
  JOB_ID,
  NO_LEAKS,
  START,
  TOKEN,
  agentEnv,
  hostedLab,
  pdfJob,
  redirect,
  scanInLab,
  send,
  startControl,
  urlJob,
  type FakeControl,
  type Lab,
} from './hosted-fixtures.ts';

/*
 * The hosted scan agent without a browser or veraPDF: the tiers, the job
 * protocol, the robots.txt check of the start URL (through the SSRF lab's
 * proxy), and agent-bin against a fake control API with stand-in children.
 * The scans themselves are in hosted-agent.browser.test.ts and
 * hosted-agent.docker.test.ts.
 */

describe('tiers', () => {
  it("size the API machine so heap, budget, uploads, one result body and overhead fit (fly.toml's numbers)", () => {
    const toml = readFileSync(new URL('../../../fly.toml', import.meta.url), 'utf8');
    // fly.toml names the same heap and memory as limits.ts.
    expect(toml).toMatch(
      new RegExp(`^\\s*NODE_OPTIONS = "--max-old-space-size=${API_HEAP_MB}"$`, 'm'),
    );
    expect(toml).toMatch(new RegExp(`^\\s*memory = "${API_MEMORY_MB / 1024}gb"$`, 'm'));
    const MiB = 1024 * 1024;
    expect(MAX_RETAINED_BYTES).toBe(512 * MiB);
    // Off the heap: the budget, uploads, one raw verified result body, downloads in flight.
    const sum =
      API_HEAP_MB +
      MAX_RETAINED_BYTES / MiB +
      UPLOADS_OFF_HEAP_MB +
      resultBodyMax('verified') / MiB +
      (DOWNLOADS_IN_FLIGHT * DOWNLOAD_CHUNK_BYTES) / MiB +
      OVERHEAD_MB;
    expect(sum).toBeLessThanOrEqual(API_MEMORY_MB);
    // At least 512, and 1.5 times the peak heap of one near-cap verified result in its
    // two-byte shape (hosted-memory.measure.ts).
    expect(API_HEAP_MB).toBeGreaterThanOrEqual(512);
    expect(API_HEAP_MB).toBeGreaterThanOrEqual(Math.ceil(MEASURED_PEAK_HEAP_MB * 1.5));
    expect(VERIFIED_TIER.reportMaxBytes).toBe(32 * MiB);
  });

  it('match the spec: 6 pages open, 200 verified, 25 MiB and 100 pages per PDF', () => {
    expect(OPEN_TIER).toEqual({
      maxPages: 6,
      pdfMaxBytes: 25 * 1024 * 1024,
      pdfMaxPages: 100,
      wallClockMs: 10 * 60_000,
      reportMaxBytes: 8 * 1024 * 1024,
    });
    expect(VERIFIED_TIER).toEqual({
      maxPages: 200,
      pdfMaxBytes: 25 * 1024 * 1024,
      pdfMaxPages: 100,
      wallClockMs: 45 * 60_000,
      reportMaxBytes: 32 * 1024 * 1024,
    });
  });

  it('lets robots.txt skip 4 pages per page of the cap', () => {
    expect(maxPolicySkipsFor(TIERS.open)).toBe(24);
    expect(maxPolicySkipsFor(TIERS.verified)).toBe(800);
  });

  it('leaves each tier its cap less the 30 s margin and the time spent', () => {
    expect(timeLimitFor('open', 0)).toBe(10 * 60_000 - 30_000);
    expect(timeLimitFor('open', 5_000)).toBe(10 * 60_000 - 30_000 - 5_000);
    expect(timeLimitFor('verified', 0)).toBe(45 * 60_000 - 30_000);
    expect(timeLimitFor('verified', 60_000)).toBe(45 * 60_000 - 30_000 - 60_000);
    expect(timeLimitFor('open', 60 * 60_000)).toBe(1);
  });

  it('gives a verify job 2 minutes, whatever its tier', () => {
    expect(VERIFY_WALL_CLOCK_MS).toBe(2 * 60_000);
    expect(timeLimitFor('open', 0, true)).toBe(2 * 60_000 - 30_000);
    expect(timeLimitFor('verified', 10_000, true)).toBe(2 * 60_000 - 30_000 - 10_000);
  });
});

const VERIFY_TOKEN_VALUE = '0123456789abcdef0123456789abcdef'; // gitleaks:allow (a test fixture, not a secret)
const verifyJob = (host = 'site.example.org', token = VERIFY_TOKEN_VALUE): JobInput => ({
  jobId: JOB_ID,
  tier: 'open',
  target: { kind: 'verify', host, token },
  profile: '508+wcag21aa',
});

describe('verify jobs in the protocol', () => {
  it('takes a verify job with a normalized host and a 32 hex token', () => {
    expect(JobInputSchema.safeParse(verifyJob()).success).toBe(true);
    expect(JobInputSchema.safeParse(verifyJob('xn--bcher-kva.example.org')).success).toBe(true);
  });

  it.each([
    ['an upper-case host', verifyJob('Site.example.org')],
    ['a trailing dot', verifyJob('site.example.org.')],
    ['a port', verifyJob('site.example.org:443')],
    ['a path', verifyJob('site.example.org/x')],
    ['an IP literal', verifyJob('93.184.215.14')],
    ['a short token', verifyJob('site.example.org', 'abc')],
    ['an upper-case token', verifyJob('site.example.org', VERIFY_TOKEN_VALUE.toUpperCase())],
    ['an extra key', { ...verifyJob(), target: { ...verifyJob().target, url: 'https://x.org/' } }],
  ])('refuses a verify job with %s', (_, input) => {
    expect(JobInputSchema.safeParse(input).success).toBe(false);
  });

  it('normalizes a host as the API does', () => {
    expect(normalizeVerifyHost('Site.Example.ORG.')).toBe('site.example.org');
    expect(normalizeVerifyHost('b\u00fccher.example.org')).toBe('xn--bcher-kva.example.org');
    for (const bad of ['', '.', 'a..org', 'a.org..', '0x7f.1', '2130706433', '[::1]', 'a b.org'])
      expect(normalizeVerifyHost(bad)).toBeUndefined();
  });

  it('takes a verify result and keeps it apart from a scan result', () => {
    const verified = { status: 'verified', tried: [{ method: 'well_known', ok: true }] };
    const not = {
      status: 'not_verified',
      tried: [
        { method: 'well_known', ok: false, reason: 'the site answered 404' },
        { method: 'meta_tag', ok: false, reason: 'the page has no matching meta tag' },
      ],
    };
    expect(JobResultSchema.safeParse(verified).success).toBe(true);
    expect(JobResultSchema.safeParse(not).success).toBe(true);
    for (const bad of [
      { ...verified, reportJson: '{}' },
      { status: 'done', reportJson: '{}', tried: verified.tried },
      { status: 'verified', tried: [{ method: 'dns_txt', ok: true }] },
      { status: 'verified', tried: [{ method: 'well_known', ok: false, reason: 'x' }] },
      { status: 'not_verified', tried: [{ method: 'meta_tag', ok: true }] },
      { status: 'not_verified', tried: [] },
      { status: 'not_verified', tried: [not.tried[0], not.tried[0]] },
      { status: 'not_verified', tried: [{ method: 'well_known', ok: false, reason: 'a\u001bb' }] },
    ]) {
      expect(JobResultSchema.safeParse(bad).success).toBe(false);
      expect(VerifyResultSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('JobInputSchema', () => {
  it('takes a URL job and a PDF job', () => {
    expect(JobInputSchema.safeParse(urlJob()).success).toBe(true);
    expect(JobInputSchema.safeParse(pdfJob('Annual Report (2026).pdf')).success).toBe(true);
  });

  it.each([
    ['an uppercase job id', { ...urlJob(), jobId: JOB_ID.toUpperCase() }],
    ['a short job id', { ...urlJob(), jobId: 'abc' }],
    ['an unknown tier', { ...urlJob(), tier: 'gold' }],
    ['an unknown profile', { ...urlJob(), profile: 'wcag22aa' }],
    ['an extra key', { ...urlJob(), maxPages: 500 }],
    ['a file: URL', urlJob('file:///etc/passwd')],
    ['a URL with credentials', urlJob('https://user:secret@example.org/')],
    ['an over-long URL', urlJob(`https://example.org/${'a'.repeat(2_100)}`)],
    ['a name with a slash', pdfJob('../secret.pdf')],
    ['a name with a backslash', pdfJob('..\\secret.pdf')],
    ['a name that is not a PDF', pdfJob('notes.txt')],
    ['a bare extension', pdfJob('.pdf')],
    ['a name with a bidi control', pdfJob('cod\u202Efdp.pdf')],
    ['a name with a line break', pdfJob('a\nb.pdf')],
  ])('refuses %s', (_, input) => {
    expect(JobInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('JobResultSchema', () => {
  it('takes a done result with its JSON report and a failed one with its error', () => {
    expect(JobResultSchema.safeParse({ status: 'done', reportJson: '{}' }).success).toBe(true);
    expect(JobResultSchema.safeParse({ status: 'failed', error: 'it broke' }).success).toBe(true);
  });

  it.each([
    ['a done result with no report', { status: 'done' }],
    // R37: the API renders the HTML; a scan machine that sends one is refused.
    ['a done result with an HTML report', { status: 'done', reportJson: '{}', reportHtml: '' }],
    ['a done result with an error', { status: 'done', reportJson: '{}', error: 'x' }],
    ['a failed result with a report', { status: 'failed', error: 'x', reportJson: '{}' }],
    ['a failed result with no error', { status: 'failed' }],
    ['an error with a control character', { status: 'failed', error: 'a\u001b[2Jb' }],
    ['an over-long error', { status: 'failed', error: 'x'.repeat(JOB_ERROR_MAX + 1) }],
    ['an extra key', { status: 'failed', error: 'x', screenshots: [] }],
  ])('refuses %s', (_, result) => {
    expect(JobResultSchema.safeParse(result).success).toBe(false);
  });

  it('jobError makes any text a valid error', () => {
    for (const text of ['\u001b[31mred', 'x'.repeat(1_000), '\u202E'.repeat(400)]) {
      const error = jobError(text);
      expect(Array.from(error).length).toBeLessThanOrEqual(JOB_ERROR_MAX);
      expect(JobResultSchema.safeParse({ status: 'failed', error }).success).toBe(true);
    }
  });

  it('builds job URLs only for a job id', () => {
    expect(jobUrl('http://[fdaa::3]:8080/', JOB_ID, 'result')).toBe(
      `http://[fdaa::3]:8080/internal/jobs/${JOB_ID}/result`,
    );
    expect(() => jobUrl('http://x', '../../admin', 'input')).toThrow();
  });
});

describe('log lines', () => {
  it('escape every value, so a value cannot split or forge a line', () => {
    const line = formatRobotsDecision({
      origin: 'http://a.example\nwidedoor event=forged',
      status: 503,
      bytes: 0,
      truncated: false,
      rules: 0,
      verdict: 'disallow-all',
      cause: 'http-5xx',
    });
    expect(line).toBe(
      'widedoor event=robots_decision origin=http:%2F%2Fa.example%0Awidedoor%20event%3Dforged verdict=disallow-all status=503 bytes=0 rules=0 truncated=false cause=http-5xx',
    );
    expect(
      formatFetchRefusal(
        new URL('http://10.0.0.1/secret/path?token=abc'),
        new EgressRefusedError('refusing', 'policy', 'private'),
      ),
    ).toBe('widedoor event=fetch_refused host=10.0.0.1 reason=private');
  });
});

describe('runHostedScan: robots.txt and the start URL', () => {
  let lab: Lab;
  beforeAll(async () => {
    lab = await hostedLab();
  });
  afterAll(() => lab.close());
  afterEach(() => {
    lab.routes.clear();
    lab.pub.requests.length = 0;
  });

  it('refuses a disallowed start URL with a failed result naming robots.txt', async () => {
    lab.routes.set('/robots.txt', send('User-agent: Widedoor\nDisallow: /\n', 'text/plain'));
    const { result, log } = await scanInLab(lab, urlJob());
    expect(result).toEqual({
      status: 'failed',
      error: "the site's robots.txt does not allow Widedoor to scan this page",
    });
    // Nothing but robots.txt was requested.
    expect(lab.pub.requests).toEqual(['/robots.txt']);
    expect(log).toEqual([
      'widedoor event=robots_decision origin=http:%2F%2Fsite.example.org verdict=rules status=200 bytes=33 rules=1 truncated=false',
    ]);
  });

  it('refuses when robots.txt cannot be read, and says why', async () => {
    lab.routes.set('/robots.txt', send('down', 'text/plain', 503));
    const { result } = await scanInLab(lab, urlJob());
    expect(result).toEqual({
      status: 'failed',
      error:
        "the site's robots.txt could not be read (the server answered 503), so the site was not scanned",
    });
    expect(lab.pub.requests).toEqual(['/robots.txt']);
  });

  it('logs a refused hop when robots.txt redirects to a private address', async () => {
    lab.routes.set('/robots.txt', redirect('http://10.0.0.1/robots.txt?token=abc'));
    const { result, log } = await scanInLab(lab, urlJob());
    expect(result).toEqual({
      status: 'failed',
      error:
        "the site's robots.txt could not be read (its address is not allowed), so the site was not scanned",
    });
    expect(log).toContain('widedoor event=fetch_refused host=10.0.0.1 reason=private');
    expect(log.join('\n')).not.toMatch(/token|robots\.txt\?/);
    expect(lab.leaks()).toEqual(NO_LEAKS);
  });

  it.each(['http', 'https'])(
    'over %s, a name only the proxy could resolve is refused there, never scanned anyway',
    async (scheme) => {
      // The scan child does no DNS (the scan machine's firewall gives it none): the name
      // goes to the proxy, which looks it up, refuses it, and robots.txt stays fail-closed.
      // Over http the refusal is a 403 that must not read as "no robots.txt".
      const host = 'nowhere.example.org';
      const { result, log } = await scanInLab(lab, urlJob(`${scheme}://${host}/`));
      expect(result).toEqual({
        status: 'failed',
        error:
          "the site's robots.txt could not be read (the name did not resolve or its address is not allowed), so the site was not scanned",
      });
      // The lab's resolver is the proxy's alone (it pins answers, so once per name).
      expect(lab.lookups).toContain(host);
      expect(log).toEqual([
        `widedoor event=fetch_refused host=${host} reason=proxy`,
        `widedoor event=robots_decision origin=${scheme}:%2F%2F${host} verdict=disallow-all bytes=0 rules=0 truncated=false cause=refused`,
      ]);
      expect(lab.leaks()).toEqual(NO_LEAKS);
    },
  );

  it('refuses an input that does not validate before anything is requested', async () => {
    const { result } = await scanInLab(lab, { ...urlJob(), jobId: 'nope' });
    expect(result).toEqual({ status: 'failed', error: INPUT_REFUSED });
    expect(lab.pub.requests).toEqual([]);
  });

  it('returns failed, not a throw, when the stage cannot be made, naming no path', async () => {
    const { result } = await scanInLab(lab, urlJob(), {
      makeStage: () =>
        Promise.reject(
          new Error(`ENOSPC: no space left, mkdtemp '${join(tmpdir(), 'widedoor-job-x')}'`),
        ),
    });
    expect(result).toEqual({
      status: 'failed',
      error: "the scan failed: ENOSPC: no space left, mkdtemp 'widedoor-job-x'",
    });
    expect(lab.pub.requests).toEqual([]);
  });

  it('checks a PDF URL against robots.txt too', async () => {
    lab.routes.set('/robots.txt', send('User-agent: *\nDisallow: /docs/\n', 'text/plain'));
    const { result } = await scanInLab(lab, urlJob(`${START}docs/a.pdf`));
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/robots\.txt/);
    expect(lab.pub.requests).toEqual(['/robots.txt']);
  });
});

describe('agent-bin', () => {
  let control: FakeControl | undefined;
  let work: string;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'widedoor-agent-test-'));
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  afterEach(async () => {
    await control?.close();
    control = undefined;
  });

  /** A stand-in child: runs `body` (JavaScript) with the job parsed from stdin as `job`. */
  const stub = (body: string): string[] => [
    process.execPath,
    '-e',
    `let s='';process.stdin.on('data',(c)=>s+=c).on('end',()=>{const job=JSON.parse(s);${body}});`,
  ];
  const quiet = () => {
    const lines: string[] = [];
    return { lines, log: (line: string) => void lines.push(line) };
  };

  it('starts the scan as uid 10001 through setpriv only when root', () => {
    expect(SETPRIV).toBe('/usr/bin/setpriv');
    expect(childCommand(true, '/app/agent-child.js')).toEqual([
      '/usr/bin/setpriv',
      `--reuid=${SCAN_UID}`,
      `--regid=${SCAN_UID}`,
      '--clear-groups',
      '--inh-caps=-all',
      '--bounding-set=-all',
      '--no-new-privs',
      process.execPath,
      '/app/agent-child.js',
    ]);
    expect(childCommand(false, '/app/agent-child.js')).toEqual([
      process.execPath,
      '/app/agent-child.js',
    ]);
  });

  it('gives the child no token, no control address and no job id', () => {
    const env = {
      Path: '/usr/bin',
      HOME: '/root',
      SECRET: 'x',
      WIDEDOOR_JOB_TOKEN: TOKEN,
      WIDEDOOR_CONTROL_URL: 'http://[fdaa::3]:8080',
      WIDEDOOR_JOB_ID: JOB_ID,
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    };
    const asRoot = childEnv(env, true, 'http://127.0.0.1:3128', undefined);
    expect(asRoot).toEqual({
      PATH: '/usr/bin',
      HOME: tmpdir(),
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
      WIDEDOOR_PROXY_URL: 'http://127.0.0.1:3128',
    });
    const asUser = childEnv(env, false, 'http://127.0.0.1:3128', 'https://example.org/about');
    expect(Object.keys(asUser).sort()).toEqual([
      'HOME',
      'PATH',
      'PLAYWRIGHT_BROWSERS_PATH',
      'WIDEDOOR_CONTACT_URL',
      'WIDEDOOR_PROXY_URL',
    ]);
  });

  it('runs the job in the child and sends its result, with the token on every request', async () => {
    control = await startControl({ input: urlJob() });
    const { log } = quiet();
    const code = await runAgent({
      env: agentEnv(control),
      // A stray line first: only the last line is the result.
      child: stub(
        `console.log('noise');console.log(JSON.stringify({status:'done',reportJson:JSON.stringify({env:Object.keys(process.env),target:job.input.target})}));`,
      ),
      log,
    });
    expect(code).toBe(0);
    expect(control.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /internal/jobs/${JOB_ID}/input`,
      `PUT /internal/jobs/${JOB_ID}/result`,
    ]);
    expect(control.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    const sent = control.results[0] as { status: string; reportJson: string };
    expect(sent.status).toBe('done');
    const seen = JSON.parse(sent.reportJson) as { env: string[]; target: unknown };
    expect(seen.target).toEqual({ kind: 'url', url: START });
    expect(seen.env.map((k) => k.toUpperCase())).not.toEqual(
      expect.arrayContaining(['WIDEDOOR_JOB_TOKEN']),
    );
    expect(seen.env).toContain('WIDEDOOR_PROXY_URL');
    expect(seen.env.some((k) => /TOKEN|CONTROL|JOB_ID/i.test(k))).toBe(false);
  });

  it('hands an uploaded PDF to the child', async () => {
    const pdf = Buffer.from('%PDF-1.7\nnot really\n');
    control = await startControl({ input: pdfJob(), pdf });
    const code = await runAgent({
      env: agentEnv(control),
      child: stub(
        `console.log(JSON.stringify({status:'done',reportJson:JSON.stringify({name:job.input.target.fileName,bytes:Buffer.from(job.pdf,'base64').toString()})}));`,
      ),
      log: quiet().log,
    });
    expect(code).toBe(0);
    expect(control.requests.map((r) => r.path.split('/').pop())).toEqual([
      'input',
      'pdf',
      'result',
    ]);
    const sent = control.results[0] as { reportJson: string };
    expect(JSON.parse(sent.reportJson)).toEqual({ name: 'report.pdf', bytes: pdf.toString() });
  });

  it('posts failed with a safe message when the control server sends a bad input', async () => {
    const marker = join(work, 'spawned');
    for (const input of [
      '{not json',
      { ...urlJob(), target: { kind: 'url', url: 'file:///etc/passwd' } },
      // Another job's input.
      { ...urlJob(), jobId: 'f'.repeat(32) },
    ]) {
      control = await startControl({ input });
      const code = await runAgent({
        env: agentEnv(control),
        child: [
          process.execPath,
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
        ],
        log: quiet().log,
      });
      expect(code).toBe(0);
      expect(control.results).toEqual([{ status: 'failed', error: INPUT_REFUSED }]);
      await control.close();
      control = undefined;
    }
    // The scan never ran.
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses an uploaded PDF over 25 MiB without starting the scan', async () => {
    const marker = join(work, 'spawned-pdf');
    control = await startControl({
      input: pdfJob(),
      pdf: new Uint8Array(OPEN_TIER.pdfMaxBytes + 1),
    });
    const code = await runAgent({
      env: agentEnv(control),
      child: [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
      ],
      log: quiet().log,
    });
    expect(code).toBe(0);
    expect(control.results).toEqual([
      { status: 'failed', error: 'the PDF is over the 25 MiB limit' },
    ]);
    expect(existsSync(marker)).toBe(false);
  });

  it('runs a verify job in the child and sends its verification, fetching no PDF', async () => {
    control = await startControl({ input: verifyJob() });
    const code = await runAgent({
      env: agentEnv(control),
      child: stub(
        `console.log(JSON.stringify({status:job.input.target.token==='${VERIFY_TOKEN_VALUE}'?'verified':'not_verified',tried:[{method:'well_known',ok:true}]}));`,
      ),
      log: quiet().log,
    });
    expect(code).toBe(0);
    expect(control.requests.map((r) => r.path.split('/').pop())).toEqual(['input', 'result']);
    expect(control.results).toEqual([
      { status: 'verified', tried: [{ method: 'well_known', ok: true }] },
    ]);
  });

  it('the timer aborts and reports failed', async () => {
    control = await startControl({ input: urlJob() });
    const { lines, log } = quiet();
    const started = Date.now();
    const code = await runAgent({
      env: agentEnv(control),
      child: stub('setInterval(() => {}, 1000);'),
      // Stopped 500 ms in, a second before the cap.
      capMs: 1_500,
      marginMs: 1_000,
      log,
    });
    expect(code).toBe(0);
    expect(control.results).toEqual([{ status: 'failed', error: TIMED_OUT }]);
    expect(lines).toContain(`widedoor event=agent_timeout job=${JOB_ID}`);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('posts failed when the child dies or answers nonsense', async () => {
    for (const body of [
      'process.exit(3);',
      // An HTML report is no part of a result any more (R37).
      `console.log(JSON.stringify({status:'done',reportJson:'{}',reportHtml:''}));`,
      `console.log(JSON.stringify({status:'failed',error:'\\u001b[2J'}));`,
    ]) {
      control = await startControl({ input: urlJob() });
      const code = await runAgent({ env: agentEnv(control), child: stub(body), log: quiet().log });
      expect(code).toBe(0);
      expect(control.results).toEqual([
        { status: 'failed', error: 'the scan stopped unexpectedly' },
      ]);
      await control.close();
      control = undefined;
    }
  });

  it('posts failed when the child cannot start', async () => {
    control = await startControl({ input: urlJob() });
    const code = await runAgent({
      env: agentEnv(control),
      child: [join(work, 'no-such-program')],
      log: quiet().log,
    });
    expect(code).toBe(0);
    expect(control.results).toEqual([{ status: 'failed', error: 'the scan could not start' }]);
  });

  it('never follows a redirect with the token', async () => {
    const elsewhere = await startControl({ input: urlJob() });
    try {
      control = await startControl({
        input: urlJob(),
        inputStatus: 302,
        location: `${elsewhere.url}/internal/jobs/${JOB_ID}/input`,
      });
      const code = await runAgent({ env: agentEnv(control), child: stub(''), log: quiet().log });
      expect(code).toBe(1);
      expect(elsewhere.requests).toEqual([]);
    } finally {
      await elsewhere.close();
    }
  });

  it('exits 1 naming, never quoting, a missing or bad setting', async () => {
    control = await startControl({ input: urlJob() });
    const { lines, log } = quiet();
    const code = await runAgent({
      env: agentEnv(control, { WIDEDOOR_JOB_TOKEN: 'has a space' }),
      child: stub(''),
      log,
    });
    expect(code).toBe(1);
    expect(lines).toEqual([
      `widedoor event=agent_config_error job=${JOB_ID} name=WIDEDOOR_JOB_TOKEN`,
    ]);
    expect(control.requests).toEqual([]);
  });

  it('posts failed when the egress proxy is not set', async () => {
    control = await startControl({ input: urlJob() });
    const env = agentEnv(control);
    delete env.WIDEDOOR_PROXY_URL;
    const code = await runAgent({ env, child: stub(''), log: quiet().log });
    expect(code).toBe(0);
    expect(control.results).toEqual([
      { status: 'failed', error: 'the scan machine is not set up to scan' },
    ]);
  });

  it("forwards only well-formed event lines of the child's stderr, re-tagged", async () => {
    control = await startControl({ input: urlJob() });
    const { lines, log } = quiet();
    const code = await runAgent({
      env: agentEnv(control),
      child: stub(`
        const w = (t) => process.stderr.write(t + '\\n');
        w('widedoor event=robots_decision origin=http:%2F%2Fa verdict=rules');
        w('GET https://site.example/page?token=abc');
        w('widedoor event=agent_result status=done forged');
        w('widedoor event=agent_result status=done x=a b=c d');
        w('widedoor event=long a=' + 'b'.repeat(10 * 1024));
        process.stderr.write(('n'.repeat(999) + '\\n').repeat(2100));
        w('widedoor event=late a=b');
        console.log(JSON.stringify({ status: 'done', reportJson: '{}' }));
      `),
      log,
    });
    expect(code).toBe(0);
    expect(lines).toEqual([
      // The agent's job id, and the source.
      `widedoor event=robots_decision job=${JOB_ID} origin=http:%2F%2Fa verdict=rules source=child`,
      // URL 1, forged 2, over-long 1, noise 2100, past the 1 MiB cap 1.
      `widedoor event=agent_child_stderr_dropped job=${JOB_ID} count=2105`,
      `widedoor event=agent_result job=${JOB_ID} status=done`,
    ]);
  });

  it('ChildStderr joins lines across chunks and ignores empty lines', () => {
    const { lines, log } = quiet();
    const stderr = new ChildStderr(JOB_ID, log);
    stderr.push(Buffer.from('widedoor event=fetch_refused host='));
    stderr.push(Buffer.from('10.0.0.1\r\n\nwidedoor event=agent_child_crash'));
    stderr.end();
    expect(lines).toEqual([
      `widedoor event=fetch_refused job=${JOB_ID} host=10.0.0.1 source=child`,
      `widedoor event=agent_child_crash job=${JOB_ID} source=child`,
    ]);
    expect(stderr.dropped).toBe(0);
  });

  it('ChildStderr drops lines that forge a key, repeat one or name an agent event', () => {
    const { lines, log } = quiet();
    const stderr = new ChildStderr(JOB_ID, log);
    const forged = [
      // A parser that takes the first value would read source=agent.
      'widedoor event=fetch_refused host=a source=agent',
      // A parser that takes the last value would read event=agent_result.
      'widedoor event=fetch_refused event=agent_result',
      // The agent's own events.
      'widedoor event=agent_result status=done',
      'widedoor event=agent_timeout',
      // A repeated ordinary key, and a job id of the child's.
      'widedoor event=fetch_refused host=a host=b',
      `widedoor event=fetch_refused host=a job=${'f'.repeat(32)}`,
      // An event no child reports.
      'widedoor event=egress_refused host=a',
    ];
    stderr.push(
      Buffer.from(`${forged.join('\n')}\nwidedoor event=robots_decision verdict=rules\n`),
    );
    stderr.end();
    expect(lines).toEqual([
      `widedoor event=robots_decision job=${JOB_ID} verdict=rules source=child`,
    ]);
    expect(stderr.dropped).toBe(forged.length);
  });

  it('ChildStderr counts a line the 1 MiB cap cut once, with or without a line end', () => {
    const MiB = 1024 * 1024;
    // Cut, and the output ends without a line end.
    const open = new ChildStderr(JOB_ID, quiet().log);
    open.push(Buffer.from(`${'n\n'.repeat(MiB / 2 - 1)}widedoor event=cut a=b`));
    open.end();
    expect(open.dropped).toBe(MiB / 2 - 1 + 1);
    // Cut, then its line end arrives in a later chunk, then a line with no end.
    const closed = new ChildStderr(JOB_ID, quiet().log);
    closed.push(Buffer.from(`${'n\n'.repeat(MiB / 2 - 1)}widedoor event=cut`));
    closed.push(Buffer.from(' a=b\nwidedoor event=late'));
    closed.end();
    expect(closed.dropped).toBe(MiB / 2 - 1 + 2);
    // A line that only starts past the cap, with no line end.
    const late = new ChildStderr(JOB_ID, quiet().log);
    late.push(Buffer.from('n\n'.repeat(MiB / 2)));
    late.push(Buffer.from('widedoor event=late a=b'));
    late.end();
    expect(late.dropped).toBe(MiB / 2 + 1);
  });

  it('refuses to start as a user other than root unless told to, and drops the token', async () => {
    control = await startControl({ input: urlJob() });
    const { lines, log } = quiet();
    const env = agentEnv(control);
    delete env.WIDEDOOR_AGENT_SAME_USER;
    expect(await runAgent({ env, child: stub(''), uid: 1000, log })).toBe(1);
    expect(lines).toEqual([
      `widedoor event=agent_config_error job=${JOB_ID} name=uid`,
      `widedoor event=agent_result job=${JOB_ID} status=failed`,
    ]);
    // The API hears why, in fixed words; the input is never fetched.
    expect(control.requests.map((r) => `${r.method} ${r.path.split('/').pop()}`)).toEqual([
      'PUT result',
    ]);
    expect(control.results).toEqual([
      { status: 'failed', error: 'the scan machine is misconfigured' },
    ]);
    expect(env.WIDEDOOR_JOB_TOKEN).toBeUndefined();
  });

  it('runs as root, or as another user with the opt-in; reaps the scan user only as root', async () => {
    expect(REAP_COMMAND).toEqual(['/usr/bin/pkill', '-KILL', '-U', '10001']);
    const done = `console.log(JSON.stringify({ status: 'done', reportJson: '{}' }));`;
    expect(REAP_PASSES).toBe(3);
    // pkill exits 0 when it killed something and 1 when nothing was left: the reaper
    // runs again after each 0, up to REAP_PASSES times.
    for (const [uid, sameUser, codes, reaped] of [
      [0, undefined, [1], ['agent_reaped found=no passes=1']],
      [0, undefined, [0, 1], ['agent_reaped found=yes passes=2']],
      [0, undefined, [0, 0, 1], ['agent_reaped found=yes passes=3']],
      [0, undefined, [0, 0, 0], ['agent_reap_incomplete passes=3']],
      [1000, '1', [0], []],
    ] as const) {
      control = await startControl({ input: urlJob() });
      const { lines, log } = quiet();
      const runs: (readonly string[])[] = [];
      const env = agentEnv(control, { WIDEDOOR_AGENT_SAME_USER: sameUser });
      const reap = async (argv: readonly string[]) => {
        runs.push(argv);
        return codes[runs.length - 1] ?? 1;
      };
      expect(await runAgent({ env, child: stub(done), uid, reap, log })).toBe(0);
      expect(control.results).toEqual([{ status: 'done', reportJson: '{}' }]);
      expect(runs).toEqual(uid === 0 ? codes.map(() => REAP_COMMAND) : []);
      expect(lines.filter((l) => l.includes('agent_reap'))).toEqual(
        reaped.map((r) => {
          const [name, ...fields] = r.split(' ');
          return `widedoor event=${name} job=${JOB_ID} ${fields.join(' ')}`;
        }),
      );
      await control.close();
      control = undefined;
    }
  });

  it('logs a reap that failed, and still sends the result', async () => {
    control = await startControl({ input: urlJob() });
    const { lines, log } = quiet();
    const done = `console.log(JSON.stringify({ status: 'done', reportJson: '{}' }));`;
    const code = await runAgent({
      env: agentEnv(control),
      child: stub(done),
      uid: 0,
      reap: async () => 2,
      log,
    });
    expect(code).toBe(0);
    expect(lines).toContain(`widedoor event=agent_reap_failed job=${JOB_ID} code=2`);
    // A failed pass ends the reaper: running pkill again would fail the same way.
    expect(lines.filter((l) => l.includes('agent_reap'))).toHaveLength(1);
  });

  it('a stop during the input request ends it at once and posts failed', async () => {
    control = await startControl({ input: urlJob(), inputStatus: 'hang' });
    const started = Date.now();
    const code = await runAgent({
      env: agentEnv(control),
      child: stub(''),
      signal: AbortSignal.timeout(300),
      log: quiet().log,
    });
    expect(code).toBe(0);
    expect(control.results).toEqual([{ status: 'failed', error: STOPPED }]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('deletes the token from process.env once read', async () => {
    control = await startControl({ input: urlJob() });
    const names = Object.keys(agentEnv(control)).filter((k) => k.startsWith('WIDEDOOR_'));
    const before = Object.fromEntries(names.map((k) => [k, process.env[k]]));
    Object.assign(process.env, agentEnv(control));
    try {
      const code = await runAgent({
        env: process.env,
        child: stub(`console.log(JSON.stringify({ status: 'done', reportJson: '{}' }));`),
        log: quiet().log,
      });
      expect(code).toBe(0);
      expect(process.env.WIDEDOOR_JOB_TOKEN).toBeUndefined();
      expect(control.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(before))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });

  it('a stop signal stops the child and posts failed', async () => {
    control = await startControl({ input: urlJob() });
    const { lines, log } = quiet();
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    const code = await runAgent({
      env: agentEnv(control),
      child: stub('setInterval(() => {}, 1000);'),
      signal: stop.signal,
      log,
    });
    expect(code).toBe(0);
    expect(control.results).toEqual([{ status: 'failed', error: STOPPED }]);
    expect(lines).toContain(`widedoor event=agent_stopped job=${JOB_ID}`);
  });

  it('a stop before the child starts posts failed and runs nothing', async () => {
    const marker = join(work, 'spawned-stop');
    control = await startControl({ input: urlJob() });
    const code = await runAgent({
      env: agentEnv(control),
      child: [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
      ],
      signal: AbortSignal.abort(),
      log: quiet().log,
    });
    expect(code).toBe(0);
    expect(control.results).toEqual([{ status: 'failed', error: STOPPED }]);
    expect(existsSync(marker)).toBe(false);
  });

  // Windows has no process groups: there the stop reaches the child alone (the tests above).
  it.skipIf(process.platform === 'win32')(
    "a timeout stops the child's process group too",
    async () => {
      const pidFile = join(work, 'grandchild.pid');
      control = await startControl({ input: urlJob() });
      const code = await runAgent({
        env: agentEnv(control),
        child: stub(`
          const g = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
          require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
          setInterval(() => {}, 1000);
        `),
        capMs: 1_500,
        marginMs: 1_000,
        log: quiet().log,
      });
      expect(code).toBe(0);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      await new Promise((wait) => setTimeout(wait, 500));
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  it('gives a result request only the time left before the cap, at least 5 s', async () => {
    control = await startControl({ input: urlJob(), resultStatus: 'hang' });
    const started = Date.now();
    const code = await runAgent({
      env: agentEnv(control),
      child: stub('setInterval(() => {}, 1000);'),
      // Stopped at 0.5 s; the result request then has about 5.5 s, and no retry fits.
      capMs: 6_000,
      marginMs: 5_500,
      log: quiet().log,
    });
    expect(code).toBe(1);
    expect(control.results).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(7_500);
  });

  it.each([503, 429, 408])(
    'retries a result answered %i only while a retry still fits before the cap',
    async (status) => {
      control = await startControl({ input: urlJob(), resultStatus: status });
      const started = Date.now();
      const code = await runAgent({
        env: agentEnv(control),
        child: stub('setInterval(() => {}, 1000);'),
        // Stopped at 0.5 s: tries at about 0.5 s and 1.5 s; at 3.5 s less than 5 s is left.
        capMs: 8_000,
        marginMs: 7_500,
        log: quiet().log,
      });
      expect(code).toBe(1);
      expect(control.results).toHaveLength(2);
      expect(Date.now() - started).toBeLessThan(8_000);
    },
  );

  it('sends a result again after a 409 without spending a try, and waits past the API deadline', async () => {
    // The API answers 409 while another PUT of the same result is still being read.
    expect(RESULT_TIMEOUT_MS).toBeGreaterThan(RESULT_DEADLINE_MS);
    control = await startControl({ input: urlJob(), resultStatuses: [409, 409, 409] });
    const { lines, log } = quiet();
    const code = await runAgent({
      env: agentEnv(control),
      child: stub(`console.log(JSON.stringify({ status: 'done', reportJson: '{}' }));`),
      log,
    });
    expect(code).toBe(0);
    // Three 409s, then the first real try: more PUTs than RESULT_TRIES.
    expect(control.results).toHaveLength(4);
    expect(
      lines.filter((l) => l === `widedoor event=agent_result_refused job=${JOB_ID} status=409`),
    ).toHaveLength(3);
  }, 15_000);

  it('sends a too-large failure instead of a result past the body cap of its tier', async () => {
    control = await startControl({ input: urlJob() });
    const { lines, log } = quiet();
    const size = resultBodyMax('open') + 1;
    const code = await runAgent({
      env: agentEnv(control),
      child: stub(
        `console.log(JSON.stringify({ status: 'done', reportJson: 'x'.repeat(${size}) }));`,
      ),
      log,
    });
    expect(code).toBe(0);
    expect(control.results).toEqual([{ status: 'failed', error: REPORT_TOO_LARGE }]);
    expect(lines).toContain(`widedoor event=agent_result_too_large job=${JOB_ID}`);
    expect(lines).toContain(`widedoor event=agent_result job=${JOB_ID} status=failed`);
  });

  it('takes any other 4xx answer to a result as final', async () => {
    control = await startControl({ input: urlJob(), resultStatus: 400 });
    const code = await runAgent({
      env: agentEnv(control),
      child: stub(`console.log(JSON.stringify({ status: 'done', reportJson: '{}' }));`),
      log: quiet().log,
    });
    expect(code).toBe(1);
    expect(control.results).toHaveLength(1);
  });

  it('reads at most twice the report cap plus 1 MiB of child output', async () => {
    expect(MAX_CHILD_OUTPUT_BYTES).toBe(2 * MAX_REPORT_BYTES + 64 * 1024 + 1024 * 1024);
    control = await startControl({ input: urlJob() });
    const code = await runAgent({
      env: agentEnv(control),
      child: stub(`console.log(JSON.stringify({ status: 'done', reportJson: 'x'.repeat(4096) }));`),
      maxOutputBytes: 1_024,
      log: quiet().log,
    });
    expect(code).toBe(0);
    expect(control.results).toEqual([{ status: 'failed', error: TOO_LARGE }]);
  });
});
