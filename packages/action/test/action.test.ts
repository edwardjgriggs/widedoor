import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { PROFILE_IDS } from '../../core/src/profile-ids.ts';
import {
  CONFIG_FILE as CLI_CONFIG_FILE,
  DEFAULT_FAIL_ON as CLI_DEFAULT_FAIL_ON,
  DEFAULT_OUT as CLI_DEFAULT_OUT,
  FAIL_ON as CLI_FAIL_ON,
  parseCommand,
  type ScanArgs,
} from '../../cli/src/args.ts';
import { MARKER as CLI_MARKER } from '../../server/src/output.ts';
import { VERAPDF_IMAGE_REF } from '../../pdf/src/verapdf.ts';
import {
  CONFIG_FILE,
  CONTEXT_ENV,
  DEFAULT_FAIL_ON,
  DEFAULT_OUT,
  DEFAULT_REVIEW_OVERRIDES,
  EXIT_ERROR,
  FAIL_ON,
  INPUT_ENV,
  InputError,
  MARKER,
  PROFILES,
  clearReports,
  REPORT_FILES,
  exitCode,
  fromFork,
  main,
  outputRecord,
  plan,
  run,
  sarifReady,
  writeOutputs,
} from '../src/action.ts';

const ACTION_DIR = fileURLToPath(new URL('../', import.meta.url));
const ROOT = resolve(ACTION_DIR, '../..');
let tmp: string;
let empty: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-action-'));
  empty = mkdtempSync(join(tmp, 'empty-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const env = (inputs: Partial<Record<keyof typeof INPUT_ENV, string>>): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(inputs).map(([k, v]) => [INPUT_ENV[k as keyof typeof INPUT_ENV], v]),
  );

/** The CLI's own parse of the argv the action builds. */
const cliParse = (argv: string[]) => parseCommand(argv) as ScanArgs;

/** Reads a GITHUB_OUTPUT file the way the runner does: name=value or name<<delimiter blocks. */
function readOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rows = text.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as string;
    if (row === '') continue;
    const heredoc = /^([^=<]+)<<(.+)$/.exec(row);
    if (heredoc) {
      const [, name, delimiter] = heredoc as unknown as [string, string, string];
      const value: string[] = [];
      for (i++; i < rows.length && rows[i] !== delimiter; i++) value.push(rows[i] as string);
      if (i >= rows.length) throw new Error(`unterminated output ${name}`);
      out[name] = value.join('\n');
    } else {
      const eq = row.indexOf('=');
      if (eq < 0) throw new Error(`bad output row ${row}`);
      out[row.slice(0, eq)] = row.slice(eq + 1);
    }
  }
  return out;
}

describe('enums and defaults', () => {
  it('match the CLI and core', () => {
    expect(PROFILES).toEqual(PROFILE_IDS);
    expect(FAIL_ON).toEqual(CLI_FAIL_ON);
    expect(DEFAULT_FAIL_ON).toBe(CLI_DEFAULT_FAIL_ON);
    expect(DEFAULT_OUT).toBe(CLI_DEFAULT_OUT);
    expect(CONFIG_FILE).toBe(CLI_CONFIG_FILE);
    expect(MARKER).toBe(CLI_MARKER);
  });
});

describe('plan', () => {
  it('builds the scan argv from newline-separated urls and files', () => {
    const p = plan(
      env({
        urls: 'https://example.com/\r\n\n  http://127.0.0.1:8080/a.html  \n',
        files: 'docs/a.pdf\ndocs/b c.pdf\n',
        profile: '508',
        failOn: 'critical',
        out: 'reports/wd',
        uploadSarif: 'false',
      }),
      empty,
    );
    expect(p.argv).toEqual([
      'scan',
      '--format=html,json,sarif',
      '--out=reports/wd',
      '--fail-on=critical',
      '--profile=508',
      '--',
      'https://example.com/',
      'http://127.0.0.1:8080/a.html',
      'docs/a.pdf',
      'docs/b c.pdf',
    ]);
    expect(p.reportDir).toBe(resolve(empty, 'reports/wd'));
    expect(p.uploadSarif).toBe(false);
    const args = cliParse(p.argv);
    expect(args.targets).toEqual(p.argv.slice(6));
    expect(args).toMatchObject({ profile: '508', failOn: 'critical', out: 'reports/wd' });
    expect(args.formats).toEqual(['html', 'json', 'sarif']);
  });

  it('uses the defaults for empty inputs', () => {
    const p = plan(
      env({ urls: 'https://example.com/', failOn: '', out: '', uploadSarif: '' }),
      empty,
    );
    expect(p.argv).toEqual([
      'scan',
      '--format=html,json,sarif',
      '--out=widedoor-report',
      '--fail-on=serious',
      '--',
      'https://example.com/',
    ]);
    expect(p.uploadSarif).toBe(true);
    expect(p.reportDir).toBe(join(empty, 'widedoor-report'));
  });

  it('passes a config and allows an empty target list with one', () => {
    const p = plan(env({ config: 'ci/widedoor.config.yaml' }), empty);
    expect(p.argv).toContain('--config=ci/widedoor.config.yaml');
    expect(p.argv.at(-1)).toBe('--');
    expect(cliParse(p.argv)).toMatchObject({ config: 'ci/widedoor.config.yaml', targets: [] });
  });

  it('allows no inputs when widedoor.config.yaml sits in the working folder', () => {
    const dir = mkdtempSync(join(tmp, 'config-'));
    writeFileSync(join(dir, 'widedoor.config.yaml'), 'web:\n  urls: [https://example.com/]\n');
    expect(plan({}, dir).argv.at(-1)).toBe('--');
  });

  it('refuses a run with nothing to scan', () => {
    expect(() => plan({}, empty)).toThrow(/nothing to scan: set urls or files, or config/);
    expect(() => plan(env({ urls: '\n \n', files: '  ' }), empty)).toThrow(InputError);
  });

  it.each([
    ['profile', { profile: 'wcag22aa' }, /profile must be one of 508, wcag21aa, 508\+wcag21aa/],
    ['fail-on', { failOn: 'high' }, /fail-on must be one of critical, serious/],
    ['fail-on case', { failOn: 'Serious' }, /fail-on must be one of/],
    ['upload-sarif', { uploadSarif: 'yes' }, /upload-sarif must be one of true, false/],
  ])('rejects a bad %s', (_name, inputs, message) => {
    expect(() => plan(env({ urls: 'https://example.com/', ...inputs }), empty)).toThrow(message);
  });

  it.each([
    ['a relative path', 'example.com'],
    ['a file URL', 'file:///etc/passwd'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a flag', '--unsafe-no-sandbox'],
    ['a short flag', '-h'],
  ])('rejects %s in urls', (_name, value) => {
    expect(() => plan(env({ urls: value }), empty)).toThrow(
      /urls: .* (is not a URL|http or https)/,
    );
  });

  it('keeps hostile values as literal arguments: no shell, no flags', () => {
    const hostile = [
      'https://example.com/$(touch pwned)',
      'https://example.com/`id`',
      'https://example.com/a\'b"c',
      'https://example.com/?q=;rm -rf ~&x=|y',
    ];
    const files = ['--unsafe-no-sandbox', '-h', '$(touch pwned).pdf', '`id`.pdf', '"q".pdf'];
    const p = plan(
      env({
        urls: hostile.join('\n'),
        files: files.join('\n'),
        out: '--unsafe-no-sandbox',
        config: '--help',
      }),
      empty,
    );
    expect(p.argv.slice(p.argv.indexOf('--') + 1)).toEqual([...hostile, ...files]);
    const args = cliParse(p.argv);
    expect(args.command).toBe('scan');
    expect(args.unsafeNoSandbox).toBe(false);
    expect(args.targets).toEqual([...hostile, ...files]);
    expect(args.out).toBe('--unsafe-no-sandbox');
    expect(args.config).toBe('--help');
  });

  it.each([
    ['config', { urls: 'https://example.com/', config: 'a.yaml\nb' }],
    ['out', { urls: 'https://example.com/', out: 'a\rb' }],
    ['profile', { urls: 'https://example.com/', profile: '508\n--unsafe-no-sandbox' }],
    ['fail-on', { urls: 'https://example.com/', failOn: 'none\u2028x' }],
    ['urls', { urls: 'https://example.com/\u0000x' }],
    ['files', { files: 'a.pdf\u001b[31m' }],
  ])('rejects control characters in %s', (_name, inputs) => {
    expect(() => plan(env(inputs), empty)).toThrow(/control characters/);
  });
});

describe('review overrides', () => {
  /** A GitHub event payload file for a pull request from head to base. */
  function event(head: string | null, base = 'owner/site', name = 'pull_request') {
    const file = join(mkdtempSync(join(tmp, 'event-')), 'event.json');
    writeFileSync(
      file,
      JSON.stringify({
        pull_request: {
          head: { repo: head === null ? null : { full_name: head } },
          base: { repo: { full_name: base } },
        },
      }),
    );
    return { GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: file };
  }
  const urls = { urls: 'https://example.com/' };

  it.each([
    // Built inside the test: tmp exists only after beforeAll.
    ['a push', () => ({ GITHUB_EVENT_NAME: 'push' }), false],
    ['a pull request inside the repository', () => event('owner/site'), false],
    ['the same repository in other letter case', () => event('Owner/Site'), false],
    ['a pull request from a fork', () => event('someone/site'), true],
    [
      'pull_request_target from a fork',
      () => event('someone/site', 'owner/site', 'pull_request_target'),
      true,
    ],
    ['a pull request from a deleted fork', () => event(null), true],
    [
      'a pull request whose payload cannot be read',
      () => ({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: join(tmp, 'missing.json') }),
      true,
    ],
    [
      'another event whose payload cannot be read',
      () => ({ GITHUB_EVENT_NAME: 'schedule', GITHUB_EVENT_PATH: join(tmp, 'missing.json') }),
      false,
    ],
  ])('auto: %s counts as a fork: %s', (_n, make: () => NodeJS.ProcessEnv, fork) => {
    const github = make();
    expect(fromFork(github)).toBe(fork);
    const p = plan({ ...env(urls), ...github }, empty);
    expect(p.argv.includes('--ignore-overrides')).toBe(fork);
    expect(cliParse(p.argv).ignoreOverrides).toBe(fork);
    expect(p.argv.at(-1)).toBe('https://example.com/');
  });

  it.each([
    ['a push', { WIDEDOOR_EVENT_NAME: 'push' }, false],
    [
      'a pull request inside the repository',
      {
        WIDEDOOR_EVENT_NAME: 'pull_request',
        WIDEDOOR_HEAD_REPO: 'owner/site',
        WIDEDOOR_BASE_REPO: 'Owner/Site',
      },
      false,
    ],
    [
      'a pull request from a fork',
      {
        WIDEDOOR_EVENT_NAME: 'pull_request',
        WIDEDOOR_HEAD_REPO: 'someone/site',
        WIDEDOOR_BASE_REPO: 'owner/site',
      },
      true,
    ],
    [
      'a pull request from a deleted fork',
      {
        WIDEDOOR_EVENT_NAME: 'pull_request',
        WIDEDOOR_HEAD_REPO: '',
        WIDEDOOR_BASE_REPO: 'owner/site',
      },
      true,
    ],
    [
      'a workflow_run inside the repository',
      {
        WIDEDOOR_EVENT_NAME: 'workflow_run',
        WIDEDOOR_RUN_HEAD_REPO: 'owner/site',
        WIDEDOOR_REPO: 'owner/site',
      },
      false,
    ],
    [
      'a workflow_run for a fork',
      {
        WIDEDOOR_EVENT_NAME: 'workflow_run',
        WIDEDOOR_RUN_HEAD_REPO: 'someone/site',
        WIDEDOOR_REPO: 'owner/site',
      },
      true,
    ],
  ])('context: %s counts as a fork: %s', (_n, context, fork) => {
    expect(fromFork(context)).toBe(fork);
  });

  it('trusts the runner context over a payload file an earlier step rewrote', () => {
    // The payload claims the same repository; the context says fork.
    const forged = event('owner/site');
    expect(
      fromFork({
        ...forged,
        WIDEDOOR_EVENT_NAME: 'pull_request',
        WIDEDOOR_HEAD_REPO: 'someone/site',
        WIDEDOOR_BASE_REPO: 'owner/site',
      }),
    ).toBe(true);
  });

  it('reads a workflow_run payload when the context is missing', () => {
    const file = join(mkdtempSync(join(tmp, 'event-')), 'event.json');
    writeFileSync(
      file,
      JSON.stringify({
        workflow_run: { head_repository: { full_name: 'someone/site' } },
        repository: { full_name: 'owner/site' },
      }),
    );
    expect(fromFork({ GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: file })).toBe(true);
    expect(
      fromFork({ GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: join(tmp, 'missing.json') }),
    ).toBe(true);
  });

  it('on counts overrides even from a fork; off ignores them everywhere', () => {
    const fork = event('someone/site');
    expect(plan({ ...env({ ...urls, reviewOverrides: 'on' }), ...fork }, empty).argv).not.toContain(
      '--ignore-overrides',
    );
    const off = plan(env({ ...urls, reviewOverrides: 'off' }), empty);
    expect(off.argv).toContain('--ignore-overrides');
    expect(off.ignoreOverrides).toBe('review-overrides is off');
    expect(() => plan(env({ ...urls, reviewOverrides: 'maybe' }), empty)).toThrow(
      /review-overrides must be one of auto, on, off/,
    );
    expect(DEFAULT_REVIEW_OVERRIDES).toBe('auto');
  });
});

describe('outputs', () => {
  it('a value with newlines and fake delimiters cannot add outputs', () => {
    const file = join(tmp, 'output-inject');
    const evil = 'x\nexit-code=0\nadmin<<EOF\ntrue\nEOF\nwidedoor_guess\n';
    writeOutputs(file, { 'report-dir': evil, 'exit-code': '1' });
    const outputs = readOutputs(readFileSync(file, 'utf8'));
    expect(Object.keys(outputs).sort()).toEqual(['exit-code', 'report-dir']);
    expect(outputs['report-dir']).toBe(evil);
    expect(outputs['exit-code']).toBe('1');
  });

  it('uses a fresh random delimiter per output', () => {
    const a = outputRecord('exit-code', '0');
    const b = outputRecord('exit-code', '0');
    expect(a).toMatch(/^exit-code<<widedoor_[0-9a-f-]{36}\n0\nwidedoor_[0-9a-f-]{36}\n$/);
    expect(a).not.toBe(b);
  });

  it('refuses a value that contains the delimiter, and a bad name', () => {
    expect(() => outputRecord('x', 'a\nD\nb', 'D')).toThrow(/delimiter/);
    expect(() => outputRecord('x=y', 'a')).toThrow(/bad output name/);
  });

  it('skips writing without GITHUB_OUTPUT', () => {
    expect(() => writeOutputs(undefined, { a: 'b' })).not.toThrow();
  });
});

describe('run', () => {
  // A stand-in for the CLI bin: records its argv, writes report.sarif and exits with FAKE_CODE.
  let bin: string;
  beforeAll(() => {
    bin = join(tmp, 'fake-cli.mjs');
    writeFileSync(
      bin,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "const out = process.argv.find((a) => a.startsWith('--out=')).slice(6);",
        "writeFileSync(process.env.FAKE_ARGV, JSON.stringify({ argv: process.argv.slice(2), inputs: Object.keys(process.env).filter((k) => k.startsWith('INPUT_')) }));",
        "if (process.env.FAKE_SARIF === '1') { mkdirSync(out, { recursive: true }); writeFileSync(out + '/.widedoor-report', ''); writeFileSync(out + '/report.sarif', '{}'); }",
        'process.exit(Number(process.env.FAKE_CODE));',
        '',
      ].join('\n'),
    );
  });

  async function runFake(
    code: number,
    inputs: Parameters<typeof env>[0],
    extra = {},
    prepare?: (dir: string) => void,
  ) {
    const dir = mkdtempSync(join(tmp, 'run-'));
    prepare?.(dir);
    const output = join(dir, 'github-output');
    const record = join(dir, 'argv.json');
    let stdout = '';
    let stderr = '';
    const result = await run({
      env: {
        ...process.env,
        ...env(inputs),
        // A run on GitHub Actions must not read the real job's event.
        GITHUB_EVENT_NAME: '',
        GITHUB_EVENT_PATH: '',
        ...Object.fromEntries(Object.values(CONTEXT_ENV).map((k) => [k, ''])),
        GITHUB_OUTPUT: output,
        FAKE_ARGV: record,
        FAKE_CODE: String(code),
        ...extra,
      },
      cwd: dir,
      bin,
      out: (t) => (stdout += t),
      err: (t) => (stderr += t),
    });
    let outputs: Record<string, string> = {};
    try {
      outputs = readOutputs(readFileSync(output, 'utf8'));
    } catch {
      // no outputs written
    }
    let child: { argv: string[]; inputs: string[] } | undefined;
    try {
      child = JSON.parse(readFileSync(record, 'utf8'));
    } catch {
      // the CLI never ran
    }
    return { result, outputs, child, stdout, stderr, dir };
  }

  it.each([0, 1, 2])('passes CLI exit code %i through to the step and its output', async (code) => {
    const r = await runFake(code, { urls: 'https://example.com/$(id)' });
    expect(r.result).toBe(code);
    expect(r.outputs['exit-code']).toBe(String(code));
    expect(r.outputs['report-dir']).toBe(join(r.dir, 'widedoor-report'));
    expect(r.child?.argv.at(-1)).toBe('https://example.com/$(id)');
    expect(r.child?.inputs).toEqual([]);
  });

  it('maps any other CLI exit code to 2', async () => {
    const r = await runFake(9, { urls: 'https://example.com/' });
    expect(r.result).toBe(EXIT_ERROR);
    expect(r.outputs['exit-code']).toBe('2');
  });

  it('maps a signal and unknown codes to 2', () => {
    expect(exitCode(null)).toBe(2);
    expect(exitCode(3)).toBe(2);
    expect(exitCode(-1)).toBe(2);
    expect(exitCode(1)).toBe(1);
  });

  it('names report.sarif for upload only when it exists and upload-sarif is true', async () => {
    const yes = await runFake(1, { urls: 'https://example.com/' }, { FAKE_SARIF: '1' });
    expect(yes.outputs['sarif-file']).toBe(join(yes.dir, 'widedoor-report', 'report.sarif'));
    const none = await runFake(1, { urls: 'https://example.com/' });
    expect(none.outputs['sarif-file']).toBe('');
    const off = await runFake(
      1,
      { urls: 'https://example.com/', uploadSarif: 'false' },
      { FAKE_SARIF: '1' },
    );
    expect(off.outputs['sarif-file']).toBe('');
  });

  it('removes a stale report.sarif from a marked report folder before the CLI runs', async () => {
    const r = await runFake(2, { urls: 'https://example.com/' }, {}, (dir) => {
      mkdirSync(join(dir, 'widedoor-report'));
      writeFileSync(join(dir, 'widedoor-report', MARKER), '');
      writeFileSync(join(dir, 'widedoor-report', 'report.sarif'), '{"stale":true}');
    });
    expect(existsSync(join(r.dir, 'widedoor-report', 'report.sarif'))).toBe(false);
    expect(r.outputs['sarif-file']).toBe('');
    expect(r.stderr).toContain('skipping the SARIF upload');
  });

  it('never deletes or uploads a report.sarif in a folder without the marker', async () => {
    const r = await runFake(2, { urls: 'https://example.com/' }, {}, (dir) => {
      mkdirSync(join(dir, 'widedoor-report'));
      writeFileSync(join(dir, 'widedoor-report', 'report.sarif'), '{"committed":true}');
    });
    expect(readFileSync(join(r.dir, 'widedoor-report', 'report.sarif'), 'utf8')).toBe(
      '{"committed":true}',
    );
    expect(r.outputs['sarif-file']).toBe('');
    expect(r.stderr).toContain('skipping the SARIF upload');
  });

  it('accepts only a regular report.sarif, not a link', () => {
    const dir = mkdtempSync(join(tmp, 'link-'));
    writeFileSync(join(dir, MARKER), '');
    const target = join(tmp, 'outside.sarif');
    writeFileSync(target, '{}');
    try {
      symlinkSync(target, join(dir, 'report.sarif'), 'file');
    } catch {
      // Windows without symlink rights: the regular-file case below still runs.
      writeFileSync(join(dir, 'report.sarif'), '{}');
      expect(sarifReady(dir)).toBe(join(dir, 'report.sarif'));
      return;
    }
    expect(sarifReady(dir)).toBeUndefined();
    clearReports(dir);
    expect(existsSync(join(dir, 'report.sarif'))).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('{}');
  });

  it('clears report.sarif, report.json and report.html only in a marker-owned folder', () => {
    const owned = mkdtempSync(join(tmp, 'owned-'));
    const foreign = mkdtempSync(join(tmp, 'foreign-'));
    writeFileSync(join(owned, MARKER), '');
    for (const dir of [owned, foreign])
      for (const name of [...REPORT_FILES, 'keep.txt']) writeFileSync(join(dir, name), 'old');
    clearReports(owned);
    clearReports(foreign);
    expect(REPORT_FILES.map((n) => existsSync(join(owned, n)))).toEqual([false, false, false]);
    expect(existsSync(join(owned, 'keep.txt'))).toBe(true);
    expect(REPORT_FILES.map((n) => existsSync(join(foreign, n)))).toEqual([true, true, true]);
  });

  it('ignores a report folder that is a link or junction', () => {
    const real = mkdtempSync(join(tmp, 'real-'));
    writeFileSync(join(real, MARKER), '');
    writeFileSync(join(real, 'report.sarif'), '{}');
    const link = join(tmp, `linked-${Date.now()}`);
    // A junction needs no extra rights on Windows; elsewhere this is a directory symlink.
    symlinkSync(real, link, 'junction');
    expect(sarifReady(link)).toBeUndefined();
    clearReports(link);
    expect(existsSync(join(real, 'report.sarif'))).toBe(true);
  });

  it('exits 2, not 1, on an unexpected error', async () => {
    const dir = mkdtempSync(join(tmp, 'boom-'));
    let stderr = '';
    const code = await main({
      // GITHUB_OUTPUT is a folder, so writing the outputs throws.
      env: {
        ...env({ urls: 'https://example.com/' }),
        GITHUB_OUTPUT: dir,
        FAKE_ARGV: join(dir, 'argv.json'),
        FAKE_CODE: '1',
      },
      cwd: dir,
      bin: join(tmp, 'fake-cli.mjs'),
      out: () => undefined,
      err: (t) => (stderr += t),
    });
    expect(code).toBe(2);
    expect(stderr).toMatch(/widedoor action: unexpected error: /);
  });

  it('says in the log when overrides do not count', async () => {
    const r = await runFake(0, { urls: 'https://example.com/', reviewOverrides: 'off' });
    expect(r.child?.argv).toContain('--ignore-overrides');
    expect(r.stderr).toContain(
      'widedoor action: review overrides do not count toward the exit code: review-overrides is off',
    );
    expect(r.stdout).toContain(
      '::notice title=widedoor::Review overrides did not count toward the exit code: review-overrides is off',
    );
  });

  it('exits 2 on a bad input without running the CLI', async () => {
    const r = await runFake(0, { urls: 'https://example.com/', failOn: 'loud' });
    expect(r.result).toBe(2);
    expect(r.child).toBeUndefined();
    expect(r.outputs).toEqual({ 'exit-code': '2' });
    expect(r.stderr).toMatch(/^widedoor action: fail-on must be one of/);
  });

  it('stops workflow commands around the run on GitHub Actions', async () => {
    const r = await runFake(0, { urls: 'https://example.com/' }, { GITHUB_ACTIONS: 'true' });
    const [, token] = /^::stop-commands::(widedoor-[0-9a-f-]{36})\n/.exec(r.stdout) ?? [];
    expect(token).toBeDefined();
    expect(r.stdout.endsWith(`::${token}::\n`)).toBe(true);
    const local = await runFake(0, { urls: 'https://example.com/' }, { GITHUB_ACTIONS: '' });
    expect(local.stdout).toBe('');
  });

  it('resumes workflow commands after an input error too', async () => {
    const r = await runFake(0, {}, { GITHUB_ACTIONS: 'true' });
    expect(r.result).toBe(2);
    expect(r.stdout).toMatch(/^::stop-commands::(widedoor-[0-9a-f-]{36})\n::\1::\n$/);
  });
});

describe('action.yml', () => {
  const text = readFileSync(join(ACTION_DIR, 'action.yml'), 'utf8');
  const action = parse(text);
  const steps: Record<string, unknown>[] = action.runs.steps;
  const workflows = ['ci.yml'].map((f) => ({
    name: f,
    doc: parse(readFileSync(join(ROOT, '.github', 'workflows', f), 'utf8')),
  }));
  const workflowSteps = workflows.flatMap(({ doc }) =>
    Object.values(doc.jobs as Record<string, { steps: Record<string, unknown>[] }>).flatMap(
      (j) => j.steps,
    ),
  );

  it('is a composite action', () => {
    expect(action.runs.using).toBe('composite');
  });

  it('never interpolates an expression inside a run block', () => {
    for (const step of steps)
      if (typeof step.run === 'string') expect(step.run, String(step.name)).not.toContain('${{');
    for (const step of workflowSteps)
      if (typeof step.run === 'string') {
        expect(step.run, String(step.name)).not.toMatch(/\$\{\{\s*inputs/);
        expect(step.run, String(step.name)).not.toMatch(/\$\{\{\s*github\.event/);
      }
  });

  it('pins every action by full commit SHA with the tag in a comment', () => {
    const uses = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(.+)$/gm)].map((m) => m[1] as string);
    const workflowUses = workflows.flatMap(({ name }) =>
      [
        ...readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8').matchAll(
          /^\s*(?:-\s*)?uses:\s*(.+)$/gm,
        ),
      ].map((m) => m[1] as string),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const u of [...uses, ...workflowUses])
      expect(u).toMatch(/^(\.\/[\w/-]+|[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+)$/);
  });

  it('passes every input to the scan step through env only', () => {
    const scan = steps.find((s) => s.id === 'scan') as { env: Record<string, string>; run: string };
    const expected = {
      INPUT_URLS: '${{ inputs.urls }}',
      INPUT_FILES: '${{ inputs.files }}',
      INPUT_CONFIG: '${{ inputs.config }}',
      INPUT_PROFILE: '${{ inputs.profile }}',
      INPUT_FAIL_ON: '${{ inputs.fail-on }}',
      INPUT_OUT: '${{ inputs.out }}',
      INPUT_UPLOAD_SARIF: '${{ inputs.upload-sarif }}',
      INPUT_REVIEW_OVERRIDES: '${{ inputs.review-overrides }}',
    };
    const context = {
      WIDEDOOR_EVENT_NAME: '${{ github.event_name }}',
      WIDEDOOR_HEAD_REPO: '${{ github.event.pull_request.head.repo.full_name }}',
      WIDEDOOR_BASE_REPO: '${{ github.event.pull_request.base.repo.full_name }}',
      WIDEDOOR_RUN_HEAD_REPO: '${{ github.event.workflow_run.head_repository.full_name }}',
      WIDEDOOR_REPO: '${{ github.repository }}',
    };
    expect(scan.env).toEqual({ ...expected, ...context });
    expect(Object.keys(expected).sort()).toEqual(Object.values(INPUT_ENV).sort());
    expect(Object.keys(context).sort()).toEqual(Object.values(CONTEXT_ENV).sort());
    expect(scan.run).toBe('node "$GITHUB_ACTION_PATH/dist/entry.js"');
  });

  it('declares the inputs and defaults the entry script assumes', () => {
    expect(Object.keys(action.inputs).sort()).toEqual(
      [
        'config',
        'fail-on',
        'files',
        'out',
        'profile',
        'review-overrides',
        'sarif-category',
        'upload-sarif',
        'urls',
      ].sort(),
    );
    expect(action.inputs['fail-on'].default).toBe(DEFAULT_FAIL_ON);
    expect(action.inputs.out.default).toBe(DEFAULT_OUT);
    expect(action.inputs['upload-sarif'].default).toBe('true');
    expect(action.inputs['sarif-category'].default).toBe('widedoor');
    expect(action.inputs['review-overrides'].default).toBe(DEFAULT_REVIEW_OVERRIDES);
    expect(Object.keys(action.outputs).sort()).toEqual(['exit-code', 'report-dir']);
  });

  it('installs with scripts off and uploads SARIF after a failing scan but not after a cancel', () => {
    const install = steps.find((s) => s.name === 'Install Widedoor') as { run: string };
    expect(install.run).toContain('npm ci --ignore-scripts --include=dev');
    // Not incremental: an earlier job's dist or tsbuildinfo is removed before the build.
    expect(install.run.indexOf('rm -rf packages/*/dist')).toBeGreaterThan(-1);
    expect(install.run.indexOf('rm -rf packages/*/dist')).toBeLessThan(
      install.run.indexOf('npm run build'),
    );
    const node = steps.find((s) => s.name === 'Set up Node') as { with: Record<string, unknown> };
    expect(node.with['package-manager-cache']).toBe(false);
    const upload = steps.find((s) => s.name === 'Upload SARIF') as { if: string; uses: string };
    expect(upload.uses).toMatch(/^github\/codeql-action\/upload-sarif@[0-9a-f]{40}$/);
    expect(upload.if).toContain('!cancelled()');
    expect(upload.if).toContain("inputs.upload-sarif == 'true'");
    expect(upload.if).toContain("steps.scan.outputs.sarif-file != ''");
  });

  it('gates the AppArmor change to GitHub-hosted runners, in the action and in CI', () => {
    const own = steps.find((s) => s.name === 'Allow the Chromium sandbox') as { if: string };
    expect(own.if).toContain("runner.environment == 'github-hosted'");
    for (const step of workflowSteps)
      if (typeof step.run === 'string' && step.run.includes('apparmor_restrict'))
        expect(String(step.if)).toContain("runner.environment == 'github-hosted'");
  });

  it('pulls the same veraPDF digest as CI and the PDF adapter', () => {
    const digest = VERAPDF_IMAGE_REF.split('@')[1];
    const pull = steps.find((s) => s.name === 'Pull veraPDF image') as {
      env: { VERAPDF_DIGEST: string };
      if: string;
      run: string;
    };
    expect(pull.env.VERAPDF_DIGEST).toBe(digest);
    // Every Linux run pulls (a URL-only scan can reach PDFs), unless Docker is missing.
    expect(pull.if).toBe("runner.os == 'Linux'");
    expect(pull.run.indexOf('command -v docker')).toBeGreaterThanOrEqual(0);
    expect(pull.run.indexOf('command -v docker')).toBeLessThan(pull.run.indexOf('docker pull'));
    const ciPulls = workflowSteps.filter((s) => s.name === 'Pull veraPDF image');
    expect(ciPulls.length).toBeGreaterThan(0);
    for (const s of ciPulls)
      expect((s.env as { VERAPDF_DIGEST: string }).VERAPDF_DIGEST).toBe(digest);
  });
});
