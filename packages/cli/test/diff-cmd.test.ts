import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FindingSchema,
  findingId,
  getProfile,
  type Asset,
  type Finding,
  type Location,
  type ProfileId,
} from '@widedoor/core';
import {
  ReportDiffSchema,
  buildScanReport,
  parseJsonReport,
  serializeJson,
} from '@widedoor/report';
import { UsageError, parseCommand } from '../src/args.ts';
import { main, type Io } from '../src/main.ts';

/*
 * widedoor diff, in process: exit codes 0, 1 and 2 (ruling 6), the text
 * and JSON formats, and escaping of scanned strings in both.
 */

const root = mkdtempSync(join(tmpdir(), 'widedoor-diff-cmd-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const A: Asset = { kind: 'web', uri: 'https://site.example/a', contentHash: hash('a') };
const B: Asset = { kind: 'web', uri: 'https://site.example/b', contentHash: hash('b') };
/** A PDF whose name sets the terminal title, rings the bell, reverses the line and holds U+FFFE. */
const HOSTILE: Asset = {
  kind: 'pdf',
  uri: 'docs/\u001b]0;pwned\u0007\u202eevil\ufffe.pdf',
  contentHash: hash('c'),
};
const HOSTILE_RULE = '7.1-1\u001b[2J\u2066\u0085';

function record(
  asset: Asset,
  ruleId: string,
  outcome: 'fail' | 'needs-review',
  engine: 'axe-core' | 'verapdf' = 'axe-core',
): Finding {
  const location: Location = asset.kind === 'web' ? { selector: `#${outcome}` } : { page: 1 };
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(asset.uri, location, engine, ruleId),
    asset,
    location,
    source: { engine, engineVersion: engine === 'axe-core' ? '4.14.0' : '1.30.3', ruleId },
    criteria: { wcag: ['1.1.1'] },
    outcome,
    ...(outcome === 'fail' ? { impact: 'serious' } : {}),
  });
}

function report(
  assets: Asset[],
  findings: Finding[],
  profile: ProfileId = 'wcag21aa',
  reviews: Finding[] = [],
): string {
  const web = assets.filter((a) => a.kind === 'web');
  const pdf = assets.filter((a) => a.kind === 'pdf');
  return serializeJson(
    buildScanReport({
      profile: getProfile(profile),
      startedAt: '2026-10-23T12:00:00.000Z',
      finishedAt: '2026-10-23T12:01:00.000Z',
      toolVersion: '0.0.0',
      scope: {
        web: { urls: web.map((a) => a.uri), truncated: false },
        ...(pdf.length > 0 ? { pdf: { files: pdf.map((a) => a.uri), include: [] } } : {}),
      },
      web: {
        engine: { name: 'axe-core', version: '4.14.0' },
        assets: web,
        findings: findings.filter((f) => f.asset.kind === 'web'),
        errors: [],
        skipped: [],
        warnings: [],
        truncated: false,
      },
      ...(pdf.length > 0
        ? {
            pdf: {
              engines: {
                verapdf: { version: '1.30.3', runner: 'docker', description: null },
                widedoor: { version: '0.0.0' },
              },
              assets: pdf,
              findings: findings.filter((f) => f.asset.kind === 'pdf'),
              informational: [],
              errors: [],
              warnings: [],
            },
          }
        : {}),
      reviews,
    }),
  );
}

/** A manual fail of 2.1.1 on asset, current while expiresOnChangeOf is its content hash. */
function manualFail(asset: Asset, expiresOnChangeOf: string): Finding {
  const location: Location = { selector: 'html' };
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(asset.uri, location, 'manual', 'wcag-2.1.1'),
    asset,
    location,
    source: { engine: 'manual', engineVersion: '0.2.0', ruleId: 'wcag-2.1.1' },
    criteria: { wcag: ['2.1.1'] },
    outcome: 'fail',
    review: { date: '2026-10-22', reviewer: 'Grace Hopper', expiresOnChangeOf },
  });
}

/** Distinct standard and criterion rows across the roll-ups of the given JSON reports. */
const criterionRows = (...texts: string[]) =>
  new Set(
    texts.flatMap((t) =>
      parseJsonReport(t).rollup.standards.flatMap((s) =>
        s.criteria.map((c) => `${s.standard} ${c.id}`),
      ),
    ),
  ).size;

const FAIL_A = record(A, 'image-alt', 'fail');
const REVIEW_A = record(A, 'image-alt', 'needs-review');
const FAIL_B = record(B, 'image-alt', 'fail');

let n = 0;
/** A folder with before.json and after.json. */
function project(before: string, after: string): string {
  const dir = join(root, `p${n++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'before.json'), before);
  writeFileSync(join(dir, 'after.json'), after);
  return dir;
}

async function run(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l) => void out.push(l), err: (l) => void err.push(l), cwd: dir };
  const code = await main(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const diff = (dir: string, ...extra: string[]) =>
  run(dir, 'diff', 'before.json', 'after.json', ...extra);

/** Raw characters safeText escapes: C0 but newline (the line joiner), DEL and C1, bidi controls, U+FFFE and U+FFFF. */
const RAW =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufffe\uffff]/u;

describe('parseCommand diff', () => {
  it('reads the two reports, the format and --fail-on-new', () => {
    expect(parseCommand(['diff', 'a.json', 'b.json'])).toEqual({
      command: 'diff',
      before: 'a.json',
      after: 'b.json',
      format: 'text',
      failOnNew: false,
    });
    expect(
      parseCommand(['diff', 'a.json', 'b.json', '--format', 'json', '--fail-on-new']),
    ).toMatchObject({ format: 'json', failOnNew: true });
  });

  it.each([
    [['diff'], /needs two JSON reports, before and after; got 0/],
    [['diff', 'a.json'], /got 1/],
    [['diff', 'a.json', 'b.json', 'c.json'], /got 3/],
    [['diff', 'a.json', ''], /needs two JSON reports/],
    [['diff', 'a.json', 'b.json', '--format', 'html'], /--format must be one of text, json/],
    [
      ['diff', 'a.json', 'b.json', '--report', 'r.json'],
      /--report is not an option of widedoor diff/,
    ],
    [['diff', 'a.json', 'b.json', '--fail-on', 'serious'], /--fail-on is not an option/],
    [
      ['scan', 'https://x.example/', '--fail-on-new'],
      /--fail-on-new is an option of widedoor diff/,
    ],
  ])('refuses %j', (argv, message) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
    expect(() => parseCommand(argv)).toThrow(message);
  });
});

describe('widedoor diff', () => {
  it('exits 0 for identical reports and says nothing changed', async () => {
    const same = report([A, B], [FAIL_A, FAIL_B]);
    const r = await diff(project(same, same));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Results: 0 new, 0 fixed, 2 unchanged, 0 not compared');
    expect(r.out).toContain('Criteria: 0 changed, 0 not compared');
    expect(r.out).not.toContain('Not compared:');
    expect(r.err).toBe('');
  });

  it('lists new and fixed results and changed criteria in text', async () => {
    const r = await diff(project(report([A, B], [FAIL_A]), report([A, B], [FAIL_B])));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Results: 1 new, 1 fixed, 0 unchanged, 0 not compared');
    expect(r.out).toContain(`New (1):\n  ${B.uri}  image-alt  fail`);
    expect(r.out).toContain(`Fixed (1):\n  ${A.uri}  image-alt  fail`);
    expect(r.out).not.toMatch(/[\u2013\u2014]/);
  });

  it('exits 1 with --fail-on-new when a new fail exists, and 0 without the flag', async () => {
    const dir = project(report([A, B], []), report([A, B], [FAIL_B]));
    const gated = await diff(dir, '--fail-on-new');
    expect(gated.code).toBe(1);
    expect(gated.err).toBe('widedoor: 1 new failed check (--fail-on-new)');
    expect((await diff(dir)).code).toBe(0);
  });

  it('exits 0 with --fail-on-new when only a needs-review is new', async () => {
    const r = await diff(project(report([A], []), report([A], [REVIEW_A])), '--fail-on-new');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('1 new');
  });

  it('exits 0 with --fail-on-new when the fail is on a page new in after (not compared)', async () => {
    const r = await diff(project(report([A], []), report([A, B], [FAIL_B])), '--fail-on-new');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('0 new, 0 fixed, 0 unchanged, 1 not compared');
    expect(r.out).toContain(`  1 result: 1 not in before\n    on ${B.uri}`);
  });

  it('summarizes criteria not compared when the profiles differ', async () => {
    const before = report([A], [], '508+wcag21aa');
    const after = report([A], [], 'wcag21aa');
    const rows = criterionRows(before, after);
    expect(rows).toBeGreaterThan(50);
    const r = await diff(project(before, after));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`Criteria: 0 changed, ${rows} not compared`);
    expect(r.out).toContain(`  ${rows} criteria: ${rows} the profiles differ`);
  });

  it('exits 0 with --fail-on-new when a manual fail went from expired to current', async () => {
    const before = report([A], [], 'wcag21aa', [manualFail(A, hash('9'))]);
    const after = report([A], [], 'wcag21aa', [manualFail(A, A.contentHash)]);
    const r = await diff(project(before, after), '--fail-on-new');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('0 new, 0 fixed, 0 unchanged, 1 not compared');
    expect(r.out).toContain('  1 result: 1 a manual review expired in one report');
  });

  it('escapes a hostile criterion id in the changed criteria', async () => {
    const hostileId = [
      '1.1.1',
      String.fromCharCode(0x1b),
      '[31m',
      String.fromCharCode(0x202e, 0xfffe),
    ].join('');
    const withId = (text: string, level: string) => {
      const r = JSON.parse(text) as {
        rollup: { standards: { criteria: { id: string; level: string }[] }[] };
      };
      const row = r.rollup.standards[0]?.criteria[0];
      if (!row) throw new Error('no criterion row');
      row.id = hostileId;
      row.level = level;
      return JSON.stringify(r);
    };
    const same = report([A], []);
    const r = await diff(project(withId(same, 'Supports'), withId(same, 'Does Not Support')));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Changed criteria (1):');
    expect(r.out).toContain(
      '  wcag21aa 1.1.1\\x1b[31m\\u202e\\ufffe: Supports -> Does Not Support',
    );
    expect(r.out).not.toMatch(RAW);
    const json = await diff(
      project(withId(same, 'Supports'), withId(same, 'Does Not Support')),
      '--format',
      'json',
    );
    expect(json.out).not.toMatch(RAW);
    expect(ReportDiffSchema.parse(JSON.parse(json.out)).criteria.changed[0]?.id).toBe(hostileId);
  });

  it('documents diff in --help', async () => {
    const r = await run(root, '--help');
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      'widedoor diff <before.json> <after.json> [--format text|json] [--fail-on-new]',
    );
    expect(r.out).toContain('widedoor diff compares two JSON reports');
    expect(r.out).toContain('diff options:');
    expect(r.out).toContain('  --format <format>     text or json (default: text)');
    expect(r.out).toContain(
      '  --fail-on-new         exit 1 when the after report has a new failed check',
    );
    expect(r.out).toContain('and 2 on bad input');
  });

  it('prints the ReportDiff as JSON', async () => {
    const r = await diff(
      project(report([A, B], [FAIL_A]), report([A, B], [FAIL_B])),
      '--format',
      'json',
    );
    expect(r.code, r.err).toBe(0);
    const parsed = ReportDiffSchema.parse(JSON.parse(r.out));
    expect(parsed.findings.new.map((e) => e.id)).toEqual([FAIL_B.id]);
    expect(parsed.findings.fixed.map((e) => e.id)).toEqual([FAIL_A.id]);
    expect(parsed.before.profile.id).toBe('wcag21aa');
  });

  it('escapes a hostile uri and rule id in text and JSON', async () => {
    const fail = record(HOSTILE, HOSTILE_RULE, 'fail', 'verapdf');
    const dir = project(report([A, HOSTILE], []), report([A, HOSTILE], [fail]));
    const text = await diff(dir);
    expect(text.code, text.err).toBe(0);
    expect(text.out).toContain('1 new');
    expect(text.out).not.toMatch(RAW);
    expect(text.out).toContain('docs/\\x1b]0;pwned\\x07\\u202eevil\\ufffe.pdf');
    expect(text.out).toContain('7.1-1\\x1b[2J\\u2066\\x85');
    const json = await diff(dir, '--format', 'json');
    expect(json.out).not.toMatch(RAW);
    const parsed = ReportDiffSchema.parse(JSON.parse(json.out));
    expect(parsed.findings.new).toEqual([
      { id: fail.id, uri: HOSTILE.uri, ruleId: HOSTILE_RULE, outcome: 'fail' },
    ]);
  });

  it('escapes a hostile uri in the not-compared summary', async () => {
    const fail = record(HOSTILE, HOSTILE_RULE, 'fail', 'verapdf');
    const r = await diff(project(report([A, HOSTILE], [fail]), report([A], [])));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('1 result: 1 not in after');
    expect(r.out).not.toMatch(RAW);
  });

  describe('exits 2 on bad input', () => {
    const good = report([A], [FAIL_A]);
    /** The good report with its records moved to a page it does not list. */
    const unknownAsset = () => {
      const r = JSON.parse(good) as { findings: { asset: { uri: string } }[] };
      for (const f of r.findings) f.asset.uri = 'https://site.example/other';
      return JSON.stringify(r);
    };
    it.each([
      ['a missing file', (dir: string) => run(dir, 'diff', 'before.json', 'nope.json')],
      ['a folder', (dir: string) => run(dir, 'diff', 'before.json', '.')],
      ['wrong arg count', (dir: string) => run(dir, 'diff', 'before.json')],
      ['an unknown flag', (dir: string) => diff(dir, '--bogus')],
      ['an unknown format', (dir: string) => diff(dir, '--format', 'sarif')],
    ])('%s', async (_, go) => {
      const r = await go(project(good, good));
      expect(r.code).toBe(2);
      expect(r.out).toBe('');
      expect(r.err).toMatch(/^widedoor: /);
    });

    it.each([
      ['invalid JSON', '{"schemaVersion": 1,', /after\.json cannot be used: it is not valid JSON/],
      [
        'a report that fails the schema',
        '{"schemaVersion": 1}',
        /after\.json cannot be used: it is not a Widedoor JSON report/,
      ],
      [
        'a record for an unknown asset',
        unknownAsset(),
        /it is not a Widedoor JSON report at findings\.0\.asset\.uri/,
      ],
    ])('%s', async (_, after, message) => {
      const r = await diff(project(good, after));
      expect(r.code).toBe(2);
      expect(r.out).toBe('');
      expect(r.err).toMatch(message);
    });

    it('names the before file when it is the bad one', async () => {
      const r = await diff(project('not json', good));
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/before\.json cannot be used/);
    });
  });
});
