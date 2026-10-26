import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  FindingSchema,
  REVIEW_DIR,
  findingId,
  getProfile,
  type Asset,
  type ChecklistItem,
  type Finding,
  type Location,
} from '@widedoor/core';
import { buildScanReport, serializeJson } from '@widedoor/report';
import { UsageError, parseCommand } from '../src/args.ts';
import { main, type Io } from '../src/main.ts';

/*
 * widedoor review list and record, in process: the checklist of a JSON
 * report with widedoor-review/ applied, recording results against it, and
 * exit code 2 for every input the report does not support.
 */

const root = mkdtempSync(join(tmpdir(), 'widedoor-review-cmd-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const A: Asset = { kind: 'web', uri: 'https://site.example/a', contentHash: hash('a') };
const B: Asset = { kind: 'web', uri: 'https://site.example/b', contentHash: hash('b') };

function contrastFail(asset: Asset): Finding {
  const location = { selector: '#low' };
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(asset.uri, location, 'axe-core', 'color-contrast'),
    asset,
    location,
    source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId: 'color-contrast' },
    criteria: { wcag: ['1.4.3'] },
    outcome: 'fail',
    impact: 'serious',
  });
}
const FAIL_A = contrastFail(A);
const FAIL_B = contrastFail(B);

const REPORT_JSON = serializeJson(
  buildScanReport({
    profile: getProfile('wcag21aa'),
    startedAt: '2026-10-23T12:00:00.000Z',
    finishedAt: '2026-10-23T12:01:00.000Z',
    toolVersion: '0.0.0',
    scope: { web: { urls: [A.uri, B.uri], truncated: false } },
    web: {
      engine: { name: 'axe-core', version: '4.14.0' },
      assets: [A, B],
      findings: [FAIL_A, FAIL_B],
      errors: [],
      skipped: [],
      warnings: [],
      truncated: false,
    },
  }),
);

let n = 0;
function project(): string {
  const dir = join(root, `p${n++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'report.json'), REPORT_JSON);
  return dir;
}

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { out: (l) => void out.push(l), err: (l) => void err.push(l), cwd };
  return { io: value, out, err };
}

async function run(dir: string, ...argv: string[]) {
  const r = io(dir);
  const code = await main(argv, r.io);
  return { code, out: r.out.join('\n'), err: r.err.join('\n') };
}

interface Listed {
  summary: { total: number; byStatus: Record<string, number> };
  items: ChecklistItem[];
  notApplied: { id: string; uri: string; ruleId: string; reason: string; detail: string }[];
  warnings: string[];
}
async function listJson(dir: string, ...extra: string[]): Promise<Listed> {
  const r = await run(
    dir,
    'review',
    'list',
    '--report',
    'report.json',
    '--format',
    'json',
    ...(extra.includes('--status') ? [] : ['--status', 'all']),
    ...extra,
  );
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out) as Listed;
}

const itemFor = (items: ChecklistItem[], uri: string, id: string) => {
  const found = items.find((i) => i.asset?.uri === uri && i.criterion.id === id);
  if (!found) throw new Error(`no item ${uri} ${id}`);
  return found;
};

const fileFor = (asset: Asset) =>
  `${asset.kind}-${createHash('sha256').update(asset.uri).digest('hex').slice(0, 16)}.yaml`;

describe('parseCommand review', () => {
  it('parses list and record with their defaults', () => {
    expect(parseCommand(['review', 'list', '--report', 'r.json'])).toEqual({
      command: 'review',
      action: 'list',
      report: 'r.json',
      status: 'open',
      format: 'text',
    });
    expect(
      parseCommand([
        'review',
        'list',
        '--report',
        'r.json',
        '--config',
        'sub/widedoor.config.yaml',
      ]),
    ).toMatchObject({ config: 'sub/widedoor.config.yaml' });
    expect(
      parseCommand([
        'review',
        'record',
        '--report',
        'r.json',
        '--item',
        'ck_0123456789abcdef',
        '--outcome',
        'pass',
        '--reviewer',
        'Ann',
        '--attach',
        'a.png',
        '--attach',
        'b.jpg',
        '--override',
        'wd_0123456789abcdef',
      ]),
    ).toEqual({
      command: 'review',
      action: 'record',
      report: 'r.json',
      item: 'ck_0123456789abcdef',
      outcome: 'pass',
      reviewer: 'Ann',
      attach: ['a.png', 'b.jpg'],
      overrides: ['wd_0123456789abcdef'],
    });
  });

  it.each([
    [['review'], /widedoor review needs list or record/],
    [['review', 'show'], /widedoor review needs list or record/],
    [['review', 'list'], /--report/],
    [['review', 'list', '--report', 'r.json', '--config', ''], /--config needs a file/],
    [['review', 'list', '--report', 'r.json', 'extra'], /takes no other arguments/],
    [['review', 'list', '--report', 'r.json', '--status', 'closed'], /--status must be one of/],
    [
      ['review', 'list', '--report', 'r.json', '--format', 'html'],
      /--format must be one of text, json/,
    ],
    [
      ['review', 'list', '--report', 'r.json', '--item', 'ck_0123456789abcdef'],
      /--item is an option of widedoor review record/,
    ],
    [['review', 'record', '--report', 'r.json'], /--item/],
    [
      [
        'review',
        'record',
        '--report',
        'r.json',
        '--item',
        'x',
        '--outcome',
        'ok',
        '--reviewer',
        'a',
      ],
      /--outcome must be one of pass, fail, not-applicable/,
    ],
    [['review', 'record', '--report', 'r.json', '--item', 'x', '--outcome', 'pass'], /--reviewer/],
    [
      [
        'review',
        'record',
        '--report',
        'r.json',
        '--item',
        'x',
        '--outcome',
        'pass',
        '--reviewer',
        'a',
        '--status',
        'open',
      ],
      /--status is an option of widedoor review list/,
    ],
    [
      ['review', 'list', '--report', 'r.json', '--out', 'x'],
      /--out is not an option of widedoor review/,
    ],
    [['scan', '--item', 'x'], /--item is an option of widedoor review/],
    [['ui', '--reviewer', 'x'], /--reviewer is not an option of widedoor ui/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
    expect(() => parseCommand(argv)).toThrow(message);
  });
});

describe('widedoor review', () => {
  it('lists the checklist as text and JSON, filtered by status', async () => {
    const dir = project();
    const text = await run(dir, 'review', 'list', '--report', 'report.json', '--status', 'all');
    expect(text.code).toBe(0);
    const all = await listJson(dir);
    const contrast = itemFor(all.items, A.uri, '1.4.3');
    expect(contrast).toMatchObject({ status: 'failed-automated', related: [FAIL_A.id] });
    expect(text.out).toContain(`${contrast.id}  failed-automated  WCAG 1.4.3 Contrast (Minimum)`);
    expect(text.out).toContain(A.uri);
    expect(text.out).toMatch(
      /^Checklist: \d+ items \(\d+ open, 0 done, 0 expired, 2 failed-automated\)/,
    );

    const failed = await listJson(dir, '--status', 'failed-automated');
    expect(failed.items.map((i) => i.asset?.uri)).toEqual([A.uri, B.uri]);
    expect(failed.summary.total).toBe(all.items.length);
    expect(existsSync(join(dir, REVIEW_DIR))).toBe(false);

    // Without --status, only the open items.
    const open = await run(dir, 'review', 'list', '--report', 'report.json', '--format', 'json');
    const listed = JSON.parse(open.out) as Listed;
    expect(listed.items.length).toBeGreaterThan(0);
    expect(listed.items.every((i) => i.status === 'open')).toBe(true);
    expect(listed.items.length).toBe(all.summary.byStatus.open);
  });

  it('records a result, prints the file, and lists the item as done', async () => {
    const dir = project();
    const item = itemFor((await listJson(dir)).items, A.uri, '2.1.1');
    const r = await run(
      dir,
      'review',
      'record',
      '--report',
      'report.json',
      '--item',
      item.id,
      '--outcome',
      'pass',
      '--reviewer',
      'Ann Reviewer',
      '--notes',
      'Tabbed through the page.',
    );
    expect(r.code, r.err).toBe(0);
    expect(r.out.split('\n')).toEqual([
      `widedoor: recorded ${item.id} in ${join(REVIEW_DIR, fileFor(A))}`,
      expect.stringMatching(new RegExp(`^  record wd_[0-9a-f]{16} for ${A.uri} \\(web\\)$`)),
    ]);
    const text = readFileSync(join(dir, REVIEW_DIR, fileFor(A)), 'utf8');
    expect(text).toContain('reviewer: Ann Reviewer');
    expect(text).toContain('ruleId: wcag-2.1.1');
    expect(itemFor((await listJson(dir)).items, A.uri, '2.1.1').status).toBe('done');
    expect((await listJson(dir, '--status', 'done')).items.map((i) => i.id)).toEqual([item.id]);
  });

  it('records an override of an automated fail on the same asset', async () => {
    const dir = project();
    const item = itemFor((await listJson(dir)).items, A.uri, '1.4.3');
    const r = await run(
      dir,
      'review',
      'record',
      '--report',
      'report.json',
      '--item',
      item.id,
      '--outcome',
      'pass',
      '--reviewer',
      'Ann',
      '--override',
      FAIL_A.id,
      '--notes',
      'Measured 4.6:1 by hand.',
    );
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`  overrides: ${FAIL_A.id}`);
    expect(itemFor((await listJson(dir)).items, A.uri, '1.4.3').status).toBe('done');
  });

  it('exits 2 when --override names a finding on another asset, and writes nothing', async () => {
    const dir = project();
    const item = itemFor((await listJson(dir)).items, A.uri, '1.4.3');
    const r = await run(
      dir,
      'review',
      'record',
      '--report',
      'report.json',
      '--item',
      item.id,
      '--outcome',
      'pass',
      '--reviewer',
      'Ann',
      '--override',
      FAIL_B.id,
      '--notes',
      'False positive.',
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain(`--override ${FAIL_B.id} is not an automated fail on ${A.uri}`);
    expect(existsSync(join(dir, REVIEW_DIR, fileFor(A)))).toBe(false);
  });

  it('exits 2 on an unknown item, missing notes and an attachment that is not an image', async () => {
    const dir = project();
    const item = itemFor((await listJson(dir)).items, A.uri, '2.1.1');
    const base = ['review', 'record', '--report', 'report.json', '--reviewer', 'Ann'];
    const unknown = await run(dir, ...base, '--item', 'ck_0000000000000000', '--outcome', 'pass');
    expect(unknown).toMatchObject({ code: 2 });
    expect(unknown.err).toContain('there is no checklist item ck_0000000000000000');
    const na = await run(dir, ...base, '--item', item.id, '--outcome', 'not-applicable');
    expect(na.code).toBe(2);
    expect(na.err).toContain('needs --notes');
    writeFileSync(join(dir, 'shot.png'), 'GIF89a not a png');
    const fake = await run(
      dir,
      ...base,
      '--item',
      item.id,
      '--outcome',
      'pass',
      '--attach',
      'shot.png',
    );
    expect(fake.code).toBe(2);
    expect(fake.err).toContain('is not a PNG image');
    expect(existsSync(join(dir, REVIEW_DIR))).toBe(false);
  });

  it('copies an attachment, resolved against the current folder', async () => {
    const dir = project();
    const item = itemFor((await listJson(dir)).items, A.uri, '2.1.1');
    writeFileSync(
      join(dir, 'shot.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
    );
    const r = await run(
      dir,
      'review',
      'record',
      '--report',
      'report.json',
      '--item',
      item.id,
      '--outcome',
      'fail',
      '--reviewer',
      'Ann',
      '--attach',
      'shot.png',
    );
    expect(r.code, r.err).toBe(0);
    expect(readdirSync(join(dir, REVIEW_DIR, 'attachments'))).toEqual([
      expect.stringMatching(new RegExp(`^${item.id}-1-[0-9a-f]{8}\\.png$`)),
    ]);
  });

  it('reports a hand-edited record for an unknown uri as orphaned and never applies it', async () => {
    const dir = project();
    const item = itemFor((await listJson(dir)).items, A.uri, '2.1.1');
    const elsewhere = 'https://elsewhere.example/\u001b[31mred';
    const orphan = FindingSchema.parse({
      schemaVersion: 1,
      id: findingId(elsewhere, { selector: 'html' }, 'manual', 'wcag-2.1.1'),
      asset: { ...A, uri: elsewhere },
      location: { selector: 'html' },
      source: { engine: 'manual', engineVersion: '0.0.0', ruleId: 'wcag-2.1.1' },
      criteria: { wcag: ['2.1.1'] },
      outcome: 'pass',
      review: { reviewer: 'Ann', date: '2026-10-23', expiresOnChangeOf: A.contentHash },
    });
    mkdirSync(join(dir, REVIEW_DIR));
    writeFileSync(join(dir, REVIEW_DIR, fileFor({ ...A, uri: elsewhere })), stringify([orphan]));

    const listed = await listJson(dir);
    expect(listed.notApplied).toEqual([
      {
        id: orphan.id,
        uri: elsewhere,
        ruleId: 'wcag-2.1.1',
        reason: 'orphaned',
        detail: expect.stringContaining('this scan did not cover'),
      },
    ]);
    expect(itemFor(listed.items, A.uri, '2.1.1').status).toBe('open');
    const text = await run(dir, 'review', 'list', '--report', 'report.json', '--status', 'done');
    expect(text.code).toBe(0);
    expect(text.out).toContain('Records not applied (1):');
    expect(text.out).toContain('orphaned');
    expect(text.out).toContain('\\x1b[31mred');
    expect(text.out).not.toContain('\u001b');
    expect(text.out).not.toContain(item.id);
  });

  const manualRecord = (asset: Asset, sc: string, outcome: 'pass' | 'fail') => {
    const location: Location = asset.kind === 'web' ? { selector: 'html' } : {};
    return FindingSchema.parse({
      schemaVersion: 1,
      id: findingId(asset.uri, location, 'manual', `wcag-${sc}`),
      asset,
      location,
      source: { engine: 'manual', engineVersion: '0.0.0', ruleId: `wcag-${sc}` },
      criteria: { wcag: [sc] },
      outcome,
      review: { reviewer: 'Ann', date: '2026-10-23', expiresOnChangeOf: asset.contentHash },
    });
  };

  it('leaves out records for criteria the profile does not have, with the warning a scan prints', async () => {
    const dir = project();
    // 2.1.3 and 2.4.9 are Level AAA: the wcag21aa profile has no row for them.
    const fail = manualRecord(A, '2.1.3', 'fail');
    const pass = manualRecord(A, '2.4.9', 'pass');
    mkdirSync(join(dir, REVIEW_DIR));
    writeFileSync(join(dir, REVIEW_DIR, fileFor(A)), stringify([fail, pass]));
    const line = (f: Finding, sc: string) =>
      `manual review record ${f.id} on ${A.uri}: WCAG ${sc} is not in profile wcag21aa; the record is not used`;

    const listed = await listJson(dir);
    expect(listed.notApplied.map((x) => [x.id, x.reason])).toEqual([
      [fail.id, 'out-of-profile'],
      [pass.id, 'out-of-profile'],
    ]);
    expect(listed.warnings).toEqual([line(fail, '2.1.3'), line(pass, '2.4.9')]);
    const text = await run(dir, 'review', 'list', '--report', 'report.json');
    expect(text.out).toContain(`Warning: ${line(fail, '2.1.3')}.`);
    expect(text.out.match(/^Warning: /gm)).toHaveLength(2);
  });

  it('leaves out a manual fail on a profile row with no item, and warns that a scan keeps it', async () => {
    // Under 508 the E205.4 exception settles 2.4.1 for a non-web PDF: a row, but no item.
    const P: Asset = { kind: 'pdf', uri: 'docs/form.pdf', contentHash: hash('d') };
    const dir = join(root, `p${n++}`);
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'report.json'),
      serializeJson(
        buildScanReport({
          profile: getProfile('508'),
          startedAt: '2026-10-23T12:00:00.000Z',
          finishedAt: '2026-10-23T12:01:00.000Z',
          toolVersion: '0.0.0',
          scope: { pdf: { files: [P.uri], include: [] } },
          pdf: {
            engines: {
              verapdf: { version: '1.30.3', runner: null, description: null },
              widedoor: { version: '0.0.0' },
            },
            assets: [P],
            findings: [],
            informational: [],
            errors: [],
            warnings: [],
          },
        }),
      ),
    );
    const fail = manualRecord(P, '2.4.1', 'fail');
    const pass = manualRecord(P, '2.4.5', 'pass');
    mkdirSync(join(dir, REVIEW_DIR));
    writeFileSync(join(dir, REVIEW_DIR, fileFor(P)), stringify([fail, pass]));
    const warning = `manual review record ${fail.id} on ${P.uri} for WCAG 2.4.1: manual fail recorded on a unit automation decided; the manual fail is kept; a scan applies it`;

    const listed = await listJson(dir);
    expect(listed.notApplied.map((x) => [x.id, x.reason])).toEqual([
      [fail.id, 'no-item'],
      [pass.id, 'no-item'],
    ]);
    expect(listed.warnings).toEqual([warning]);
    const text = await run(dir, 'review', 'list', '--report', 'report.json');
    expect(text.out).toContain(`Warning: ${warning}.`);
    expect(text.out.match(/^Warning: /gm)).toHaveLength(1);
  });

  it('exits 2 on a report that cannot be read and on a linked review folder', async () => {
    const dir = project();
    writeFileSync(join(dir, 'bad.json'), '{"schemaVersion": 1}');
    const bad = await run(dir, 'review', 'list', '--report', 'bad.json');
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/bad\.json cannot be used/);
    const missing = await run(dir, 'review', 'list', '--report', 'none.json');
    expect(missing.code).toBe(2);

    const outside = mkdtempSync(join(root, 'outside-'));
    symlinkSync(outside, join(dir, REVIEW_DIR), 'junction');
    const linked = await run(dir, 'review', 'list', '--report', 'report.json');
    expect(linked.code).toBe(2);
    expect(linked.err).toMatch(/symbolic link or junction/);
  });

  it('reads and writes widedoor-review/ in the folder of --config, like a scan', async () => {
    const dir = project();
    mkdirSync(join(dir, 'site'));
    writeFileSync(join(dir, 'site', 'widedoor.config.yaml'), `web:\n  urls: [${A.uri}]\n`);
    const item = itemFor((await listJson(dir)).items, A.uri, '2.1.1');
    const config = ['--config', join('site', 'widedoor.config.yaml')];
    const r = await run(
      dir,
      'review',
      'record',
      '--report',
      'report.json',
      ...config,
      '--item',
      item.id,
      '--outcome',
      'pass',
      '--reviewer',
      'Ann',
    );
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(dir, 'site', REVIEW_DIR, fileFor(A)))).toBe(true);
    expect(existsSync(join(dir, REVIEW_DIR))).toBe(false);
    expect(itemFor((await listJson(dir, ...config)).items, A.uri, '2.1.1').status).toBe('done');
    expect(itemFor((await listJson(dir)).items, A.uri, '2.1.1').status).toBe('open');
    const missing = await run(
      dir,
      'review',
      'list',
      '--report',
      'report.json',
      '--config',
      'no.yaml',
    );
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('no such file');
  });
});
