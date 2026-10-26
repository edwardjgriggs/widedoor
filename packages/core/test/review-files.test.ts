import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import {
  ATTACHMENT_DIR,
  ConfigError,
  FindingSchema,
  LOCK_STALE_MS,
  MAX_ATTACHMENTS,
  MAX_REVIEW_FILES,
  REVIEW_DIR,
  ReviewInputError,
  buildChecklist,
  decidingRulesFrom,
  errataFrom,
  findingId,
  getProfile,
  loadReviews,
  loadStandardsData,
  recordReview,
  reviewChecklist,
  keptFailWarning,
  outOfProfileWarning,
  rollup,
  screenItemless,
  screenReviews,
  type Asset,
  type ChecklistItem,
  type Finding,
  type Location,
  type RecordInput,
  type ReviewReport,
} from '../src/index.js';

const data = loadStandardsData();
const root = mkdtempSync(join(tmpdir(), 'widedoor-review-files-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const A: Asset = {
  kind: 'web',
  uri: 'https://example.com/a',
  contentHash: hash('a'),
  reviewHash: hash('c'),
};
const B: Asset = { kind: 'web', uri: 'https://example.com/b', contentHash: hash('b') };
const P: Asset = { kind: 'pdf', uri: 'docs/report.pdf', contentHash: hash('d') };

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
  });
}
const FAIL_A = contrastFail(A);
const FAIL_B = contrastFail(B);
const NEEDS_REVIEW_A = FindingSchema.parse({
  ...FAIL_A,
  id: findingId(A.uri, { selector: '#low' }, 'axe-core', 'color-contrast-review'),
  source: { ...FAIL_A.source, ruleId: 'color-contrast-review' },
  outcome: 'needs-review',
});

/** A report as a scan would write it: automated findings, roll-up, profile. */
function report(assets: Asset[] = [A, B, P], findings: Finding[] = [FAIL_A, FAIL_B]): ReviewReport {
  const profile = getProfile('508+wcag21aa');
  return {
    profile: { id: profile.id, pdfDocumentType: profile.pdfDocumentType },
    assets,
    findings,
    rollup: rollup({
      findings,
      reviews: [],
      profile,
      assets,
      errata: errataFrom(data),
    }),
  };
}
const REPORT = report();
const ITEMS = buildChecklist({ report: REPORT, data });

function item(uri: string | undefined, id: string): ChecklistItem {
  const found = ITEMS.find((i) => i.asset?.uri === uri && i.criterion.id === id);
  if (!found) throw new Error(`no item for ${uri ?? 'product'} ${id}`);
  return found;
}

let n = 0;
function project(): string {
  const dir = join(root, `p${n++}`);
  mkdirSync(dir);
  return dir;
}

const record = (dir: string, input: Partial<RecordInput> & { item: string }) =>
  recordReview(dir, {
    report: REPORT,
    outcome: 'pass',
    reviewer: 'Edward Griggs',
    date: '2026-10-23',
    version: '0.2.0',
    data,
    ...input,
  });

const fileFor = (asset: Asset) =>
  `${asset.kind}-${createHash('sha256').update(asset.uri).digest('hex').slice(0, 16)}.yaml`;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
function image(name: string, bytes: Buffer): string {
  const dir = join(root, `img${n++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, name), bytes);
  return join(dir, name);
}

describe('recordReview and loadReviews', () => {
  it('round trips a web record with the manual identity and the review anchor', async () => {
    const dir = project();
    const it211 = item(A.uri, '2.1.1');
    const { file, record: written } = await record(dir, {
      item: it211.id,
      notes: 'Tabbed through every control.',
    });
    expect(file).toBe(join(dir, REVIEW_DIR, fileFor(A)));
    expect(written).toEqual({
      schemaVersion: 1,
      id: findingId(A.uri, { selector: 'html' }, 'manual', 'wcag-2.1.1'),
      asset: A,
      location: { selector: 'html' },
      source: { engine: 'manual', engineVersion: '0.2.0', ruleId: 'wcag-2.1.1' },
      criteria: { wcag: ['2.1.1'], baselineTest: it211.baselineTests[0] },
      outcome: 'pass',
      review: {
        reviewer: 'Edward Griggs',
        date: '2026-10-23',
        notes: 'Tabbed through every control.',
        expiresOnChangeOf: hash('c'),
      },
    });
    const text = readFileSync(file, 'utf8');
    expect(text.split('\n')[1]).toBe(`# Asset: ${A.uri}`);
    const loaded = await loadReviews(dir);
    expect(loaded.files).toEqual([file]);
    expect(loaded.reviews).toEqual([written]);
    expect(loaded.attachments.size).toBe(0);
    const state = reviewChecklist(REPORT, loaded.reviews, data);
    expect(state.items.find((i) => i.id === it211.id)).toMatchObject({
      status: 'done',
      review: written.id,
    });
    expect(state.notApplied).toEqual([]);
    expect(readdirSync(join(dir, REVIEW_DIR))).toEqual([fileFor(A)]);
  });

  it('writes PDF records with an empty location and product records to product.yaml', async () => {
    const dir = project();
    const pdf = await record(dir, { item: item(P.uri, '1.3.1').id, outcome: 'fail' });
    expect(pdf.file).toBe(join(dir, REVIEW_DIR, fileFor(P)));
    expect(pdf.record).toMatchObject({ location: {}, asset: P, outcome: 'fail' });
    expect('review' in pdf.record && pdf.record.review.expiresOnChangeOf).toBe(P.contentHash);

    // Product-scope items anchor to the first scanned asset in report order.
    const product = await record(dir, { item: item(undefined, '302.1').id });
    expect(product.file).toBe(join(dir, REVIEW_DIR, 'product.yaml'));
    expect(product.record).toMatchObject({
      asset: A,
      location: { selector: 'html' },
      source: { ruleId: '508-302.1' },
      criteria: { section508: ['302.1'] },
    });
    expect('review' in product.record && product.record.review.expiresOnChangeOf).toBe(hash('c'));
    const state = reviewChecklist(REPORT, (await loadReviews(dir)).reviews, data);
    expect(state.items.find((i) => i.id === item(undefined, '302.1').id)?.status).toBe('done');
  });

  it('replaces the record for the same item and keeps the file sorted by criterion', async () => {
    const dir = project();
    await record(dir, { item: item(A.uri, '2.4.7').id });
    await record(dir, { item: item(A.uri, '1.4.10').id });
    await record(dir, { item: item(A.uri, '1.4.4').id });
    await record(dir, { item: item(A.uri, '502.2.2').id, notes: 'No platform features.' });
    const { file } = await record(dir, { item: item(A.uri, '2.4.7').id, outcome: 'fail' });
    const records = parse(readFileSync(file, 'utf8')) as Finding[];
    expect(records.map((r) => [r.source.ruleId, r.outcome])).toEqual([
      ['wcag-1.4.4', 'pass'],
      ['wcag-1.4.10', 'pass'],
      ['wcag-2.4.7', 'fail'],
      ['508-502.2.2', 'pass'],
    ]);
  });

  it('lands both of two concurrent writers to one file', async () => {
    const dir = project();
    const ids = ['1.3.1', '2.1.1', '2.4.3', '2.4.7', '3.3.2'].map((id) => item(A.uri, id).id);
    await Promise.all(ids.map((id) => record(dir, { item: id })));
    const { reviews } = await loadReviews(dir);
    expect(reviews.map((r) => r.source.ruleId).sort()).toEqual(
      ['wcag-1.3.1', 'wcag-2.1.1', 'wcag-2.4.3', 'wcag-2.4.7', 'wcag-3.3.2'].sort(),
    );
    expect(readdirSync(join(dir, REVIEW_DIR))).toEqual([fileFor(A)]);
  });

  it('takes over a stale lock and always removes its own', async () => {
    const dir = project();
    mkdirSync(join(dir, REVIEW_DIR));
    const lock = join(dir, REVIEW_DIR, `${fileFor(A)}.lock`);
    writeFileSync(lock, '999999 deadbeef\n');
    const old = (Date.now() - LOCK_STALE_MS - 5_000) / 1000;
    utimesSync(lock, old, old);
    await record(dir, { item: item(A.uri, '2.1.1').id });
    expect(existsSync(lock)).toBe(false);
    // A write that fails under the lock still releases it.
    writeFileSync(join(dir, REVIEW_DIR, fileFor(A)), 'not: [valid');
    await expect(record(dir, { item: item(A.uri, '2.1.1').id })).rejects.toThrow(ConfigError);
    expect(readdirSync(join(dir, REVIEW_DIR))).toEqual([fileFor(A)]);
  });

  it('keeps free-text notes and names exactly as given', async () => {
    const dir = project();
    const notes =
      'line one\n--- \n# not a comment\n!!js/function "f"\n- [a]: {b}\u2028 \'q\' "q"\n';
    const reviewer = "  Ann: O'Neil #1  ";
    const { file } = await record(dir, { item: item(A.uri, '2.1.1').id, notes, reviewer });
    const [loaded] = (await loadReviews(dir)).reviews;
    expect(loaded && 'review' in loaded && loaded.review).toMatchObject({ notes, reviewer });
    // loadReviews refuses unknown tags, so the round trip shows the text stayed a string.
    expect(readFileSync(file, 'utf8')).toContain('Ann');
  });

  it('refuses input the report does not support', async () => {
    const dir = project();
    const it143 = item(A.uri, '1.4.3').id;
    const refused = async (input: Partial<RecordInput> & { item: string }, message: RegExp) => {
      const error = await record(dir, input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ReviewInputError);
      expect(String(error)).toMatch(message);
    };
    await refused({ item: 'ck_0000000000000000' }, /no checklist item ck_0000000000000000/);
    await refused({ item: 'nope' }, /--item/);
    await refused({ item: it143, reviewer: '  ' }, /reviewer/);
    await refused({ item: it143, outcome: 'not-applicable' }, /notes/);
    await refused({ item: it143, overrides: [FAIL_A.id] }, /notes/);
    await refused({ item: it143, overrides: [FAIL_A.id], notes: 'x', outcome: 'fail' }, /pass/);
    // An override must name an automated fail on the same asset and criterion.
    await refused({ item: it143, overrides: [FAIL_B.id], notes: 'x' }, new RegExp(FAIL_B.id));
    await refused({ item: item(A.uri, '2.1.1').id, overrides: [FAIL_A.id], notes: 'x' }, /2\.1\.1/);
    await refused({ item: it143, overrides: ['wd_0123456789abcdef'], notes: 'x' }, /wd_0123/);
    expect(existsSync(join(dir, REVIEW_DIR, fileFor(A)))).toBe(false);

    const ok = await record(dir, { item: it143, overrides: [FAIL_A.id], notes: 'Measured 4.6:1.' });
    expect('review' in ok.record && ok.record.review.overrides).toEqual([FAIL_A.id]);
    const state = reviewChecklist(REPORT, (await loadReviews(dir)).reviews, data);
    expect(state.items.find((i) => i.id === it143)?.status).toBe('done');
  });

  it('refuses a needs-review finding as an override', async () => {
    const withReview = report([A], [FAIL_A, NEEDS_REVIEW_A]);
    const it143 = buildChecklist({ report: withReview, data }).find(
      (i) => i.criterion.id === '1.4.3',
    )!.id;
    await expect(
      record(project(), {
        report: withReview,
        item: it143,
        overrides: [NEEDS_REVIEW_A.id],
        notes: 'x',
      }),
    ).rejects.toThrow(/not an automated fail/);
  });
});

describe('attachments', () => {
  it('copies PNG and JPEG files under attachments/ and loads them back', async () => {
    const dir = project();
    const it211 = item(A.uri, '2.1.1').id;
    const { record: written } = await record(dir, {
      item: it211,
      attach: [image('shot.png', PNG), image('photo.JPG', JPEG)],
    });
    const names = ('review' in written && written.review.attachments) || [];
    // Fresh names each time (<ck id>-<n>-<hex>), so a record never names an image it did not write.
    expect(names).toEqual([
      expect.stringMatching(new RegExp(`^attachments/${it211}-1-[0-9a-f]{8}\\.png$`)),
      expect.stringMatching(new RegExp(`^attachments/${it211}-2-[0-9a-f]{8}\\.jpg$`)),
    ]);
    expect(ATTACHMENT_DIR).toBe('widedoor-review/attachments');
    const loaded = await loadReviews(dir);
    expect([...loaded.attachments.keys()]).toEqual(names);
    expect(readFileSync(loaded.attachments.get(names[0]!)!)).toEqual(PNG);

    // Recording the item again removes the files only the replaced record named.
    const again = await record(dir, { item: it211, attach: [image('again.png', PNG)] });
    const kept = ('review' in again.record && again.record.review.attachments) || [];
    expect(readdirSync(join(dir, ATTACHMENT_DIR))).toEqual(kept.map((k) => k.slice(12)));

    // An image another record still names is kept.
    writeFileSync(
      join(dir, REVIEW_DIR, 'notes.yaml'),
      stringify([{ review: { attachments: kept } }]),
    );
    await record(dir, { item: it211 });
    expect(readdirSync(join(dir, ATTACHMENT_DIR))).toEqual(kept.map((k) => k.slice(12)));
  });

  it('reads the other files silently and within the caps before removing replaced images', async () => {
    const dir = project();
    const it211 = item(A.uri, '2.1.1').id;
    const first = await record(dir, { item: it211, attach: [image('a.png', PNG)] });
    const named = ('review' in first.record && first.record.review.attachments) || [];
    // An unknown tag is a parser warning, which the yaml package prints unless told not to.
    writeFileSync(
      join(dir, REVIEW_DIR, 'junk.yaml'),
      `- review:\n    attachments: !!nope ${JSON.stringify(named)}\n`,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      await record(dir, { item: it211 });
      expect(warn).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      emit.mockRestore();
    }

    // Past the loader's file cap the folder is not read at all, so nothing is removed.
    const capped = project();
    const again = await record(capped, { item: it211, attach: [image('b.png', PNG)] });
    const kept = ('review' in again.record && again.record.review.attachments) || [];
    for (let i = 0; i < MAX_REVIEW_FILES; i++)
      writeFileSync(join(capped, REVIEW_DIR, `x${i}.yml`), '');
    await record(capped, { item: it211 });
    expect(readdirSync(join(capped, ATTACHMENT_DIR))).toEqual(kept.map((k) => k.slice(12)));

    // Past the 50 MiB total (each file under the 5 MiB cap), nothing is removed either.
    const big = project();
    const third = await record(big, { item: it211, attach: [image('c.png', PNG)] });
    const bigNames = ('review' in third.record && third.record.review.attachments) || [];
    const comment = `# ${'x'.repeat(1021)}\n`.repeat(4.5 * 1024);
    for (let i = 0; i < 12; i++) writeFileSync(join(big, REVIEW_DIR, `pad${i}.yaml`), comment);
    await record(big, { item: it211 });
    expect(readdirSync(join(big, ATTACHMENT_DIR))).toEqual(bigNames.map((k) => k.slice(12)));
  });

  it('refuses a file whose bytes do not match its extension, other types and too many', async () => {
    const dir = project();
    const it211 = item(A.uri, '2.1.1').id;
    const fake = image('fake.png', Buffer.from('<svg onload="alert(1)"></svg>'));
    await expect(record(dir, { item: it211, attach: [fake] })).rejects.toThrow(/not a PNG image/);
    await expect(record(dir, { item: it211, attach: [image('x.jpg', PNG)] })).rejects.toThrow(
      /not a JPEG image/,
    );
    await expect(record(dir, { item: it211, attach: [image('x.gif', PNG)] })).rejects.toThrow(
      /PNG or JPEG/,
    );
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => image('s.png', PNG));
    await expect(record(dir, { item: it211, attach: many })).rejects.toThrow(/at most 10/);
    const big = image('big.png', Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]));
    await expect(record(dir, { item: it211, attach: [big] })).rejects.toThrow(/5 MiB/);
    expect(existsSync(join(dir, REVIEW_DIR))).toBe(false);
  });

  it('refuses attachment paths that leave attachments/ or that Windows would rewrite', async () => {
    const dir = project();
    const { record: written } = await record(dir, {
      item: item(A.uri, '2.1.1').id,
      attach: [image('ok.png', PNG)],
    });
    writeFileSync(join(dir, REVIEW_DIR, 'secret.png'), PNG);
    const file = join(dir, REVIEW_DIR, fileFor(A));
    for (const path of [
      'secret.png',
      '../secret.png',
      'attachments/../secret.png',
      'attachments/./ok.png',
      'attachments/x.png.',
      'attachments/x.png ',
      'attachments\\x.png',
      'attachments/sub/x.png',
      'attachments/CON.png',
      'Attachments/x.png',
      'attachments/missing.png',
    ]) {
      const edited = {
        ...written,
        review: { ...('review' in written ? written.review : {}), attachments: [path] },
      };
      writeFileSync(file, stringify([edited]));
      const error = await loadReviews(dir).catch((e: unknown) => e);
      expect(error, path).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).file).toBe(file);
    }
    const fake = {
      ...written,
      review: {
        ...('review' in written ? written.review : {}),
        attachments: ['attachments/text.png'],
      },
    };
    writeFileSync(join(dir, ATTACHMENT_DIR, 'text.png'), 'not an image');
    writeFileSync(file, stringify([fake]));
    await expect(loadReviews(dir)).rejects.toThrow(/not a PNG image/);
  });

  it('refuses an attachments folder that is a junction', async () => {
    const dir = project();
    const outside = mkdtempSync(join(root, 'outside-'));
    writeFileSync(join(outside, 'x.png'), PNG);
    mkdirSync(join(dir, REVIEW_DIR));
    symlinkSync(outside, join(dir, ATTACHMENT_DIR), 'junction');
    await expect(
      record(dir, { item: item(A.uri, '2.1.1').id, attach: [image('a.png', PNG)] }),
    ).rejects.toThrow(/symbolic link or junction/);
    const hand = FindingSchema.parse({
      schemaVersion: 1,
      id: findingId(A.uri, { selector: 'html' }, 'manual', 'wcag-2.1.1'),
      asset: A,
      location: { selector: 'html' },
      source: { engine: 'manual', engineVersion: '0.2.0', ruleId: 'wcag-2.1.1' },
      criteria: { wcag: ['2.1.1'] },
      outcome: 'pass',
      review: {
        reviewer: 'r',
        date: '2026-10-23',
        expiresOnChangeOf: hash('c'),
        attachments: ['attachments/x.png'],
      },
    });
    writeFileSync(join(dir, REVIEW_DIR, fileFor(A)), stringify([hand]));
    await expect(loadReviews(dir)).rejects.toThrow(/symbolic link or junction/);
  });
});

describe('links under widedoor-review', () => {
  it('refuses to write through a junction at widedoor-review', async () => {
    const dir = project();
    const outside = mkdtempSync(join(root, 'outside-'));
    symlinkSync(outside, join(dir, REVIEW_DIR), 'junction');
    await expect(record(dir, { item: item(A.uri, '2.1.1').id })).rejects.toThrow(
      /symbolic link or junction/,
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses to replace a review file that is a symbolic link', async () => {
    const dir = project();
    mkdirSync(join(dir, REVIEW_DIR));
    const outside = mkdtempSync(join(root, 'outside-'));
    writeFileSync(join(outside, 'target.yaml'), '[]\n');
    try {
      symlinkSync(join(outside, 'target.yaml'), join(dir, REVIEW_DIR, fileFor(A)), 'file');
    } catch {
      return; // File links need privileges this Windows account may not have.
    }
    await expect(record(dir, { item: item(A.uri, '2.1.1').id })).rejects.toThrow(/symbolic link/);
    expect(readFileSync(join(outside, 'target.yaml'), 'utf8')).toBe('[]\n');
  });
});

/** A manual record with the identity recordReview writes, for hand-written review files. */
function manualOn(asset: Asset, id: string, extra: Record<string, unknown> = {}): Finding {
  const type = /^\d\.\d+\.\d+$/.test(id) ? 'wcag' : 'section508';
  const ruleId = type === 'wcag' ? `wcag-${id}` : `508-${id}`;
  const location: Location = asset.kind === 'web' ? { selector: 'html' } : {};
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(asset.uri, location, 'manual', ruleId),
    asset,
    location,
    source: { engine: 'manual', engineVersion: '0.2.0', ruleId },
    criteria: type === 'wcag' ? { wcag: [id] } : { section508: [id] },
    outcome: 'pass',
    ...extra,
    review: {
      reviewer: 'r',
      date: '2026-10-23',
      notes: 'n',
      expiresOnChangeOf: asset.reviewHash ?? asset.contentHash,
      ...(extra.review as object),
    },
  });
}

function files(contents: Record<string, string>): string {
  const dir = project();
  mkdirSync(join(dir, REVIEW_DIR));
  for (const [name, text] of Object.entries(contents))
    writeFileSync(join(dir, REVIEW_DIR, name), text);
  return dir;
}

const problemsOf = async (dir: string) => {
  const error = await loadReviews(dir).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConfigError);
  return error as ConfigError;
};

describe('loadReviews', () => {
  const plain = (r: Finding) => JSON.parse(JSON.stringify(r)) as Record<string, unknown>;

  it('reads one record or a list per file, in name order, and ignores other files', async () => {
    const dir = files({
      [fileFor(B)]: stringify([manualOn(B, '2.1.1'), manualOn(B, '2.4.7', { outcome: 'fail' })]),
      [fileFor(A)]: stringify(manualOn(A, '2.1.1')),
      'empty.yaml': '',
      'empty.yml': '',
      'notes.txt': 'not a review',
    });
    const { files: names, reviews } = await loadReviews(dir);
    expect(names.map((f) => f.slice(dir.length + 1).replace(/\\/g, '/'))).toEqual(
      [fileFor(A), fileFor(B), 'empty.yaml', 'empty.yml'].sort().map((f) => `widedoor-review/${f}`),
    );
    expect(reviews.map((r) => [r.asset.uri, r.outcome]).sort()).toEqual([
      [A.uri, 'pass'],
      [B.uri, 'fail'],
      [B.uri, 'pass'],
    ]);
  });

  it('refuses a linked review folder or file instead of following it', async () => {
    const outside = mkdtempSync(join(root, 'outside-'));
    writeFileSync(join(outside, 'secret.yaml'), 'private_key: hunter2\n');
    const dir = project();
    symlinkSync(outside, join(dir, REVIEW_DIR), 'junction');
    await expect(loadReviews(dir)).rejects.toThrow(/symbolic link or junction/);

    const linked = files({});
    try {
      symlinkSync(join(outside, 'secret.yaml'), join(linked, REVIEW_DIR, 'x.yaml'), 'file');
    } catch {
      return; // File links need privileges this Windows account may not have.
    }
    const error = await loadReviews(linked).catch((e: unknown) => e);
    expect(String(error)).toMatch(/symbolic link/);
    expect(String(error)).not.toContain('private_key');
  });

  it('refuses a folder that is not a regular file and too many files', async () => {
    const dir = files({});
    mkdirSync(join(dir, REVIEW_DIR, 'sub.yaml'));
    await expect(loadReviews(dir)).rejects.toThrow(/not a regular file/);
    const many = files(
      Object.fromEntries(Array.from({ length: MAX_REVIEW_FILES + 1 }, (_, i) => [`${i}.yaml`, ''])),
    );
    await expect(loadReviews(many)).rejects.toThrow(/more than 1000 review files/);
  });

  it('finds nothing when the folder is missing', async () => {
    expect(await loadReviews(join(root, 'none'))).toEqual({
      files: [],
      reviews: [],
      attachments: new Map(),
    });
  });

  it('names the file and each bad record, with readable union errors', async () => {
    const good = plain(manualOn(A, '2.1.1'));
    const dir = files({
      [fileFor(A)]: stringify([
        good,
        { ...plain(manualOn(A, '2.4.7')), review: { ...(good.review as object), date: 'soon' } },
      ]),
    });
    const error = await problemsOf(dir);
    expect(error.file).toBe(join(dir, REVIEW_DIR, fileFor(A)));
    expect(error.problems).toEqual([expect.stringMatching(/^\[1\]\.review\.date: /)]);
  });

  it('refuses automated records in a review file', async () => {
    const dir = files({ [fileFor(A)]: stringify(FAIL_A) });
    await expect(loadReviews(dir)).rejects.toThrow(/review files hold manual records only/);
  });

  it('refuses a manual record whose rule id does not match its one criterion', async () => {
    const good = plain(manualOn(A, '2.1.1'));
    const source = good.source as object;
    const dir = files({
      [fileFor(A)]: stringify([
        good,
        { ...good, source: { ...source, ruleId: 'keyboard' } },
        { ...good, criteria: { wcag: ['2.1.1'], section508: ['302.1'] } },
        { ...good, source: { ...source, ruleId: '508-2.1.1' } },
      ]),
    });
    const error = await problemsOf(dir);
    expect(error.file).toBe(join(dir, REVIEW_DIR, fileFor(A)));
    const id = good.id as string;
    expect(error.problems).toEqual([
      expect.stringMatching(
        new RegExp(`^\\[1\\]\\.source\\.ruleId: record ${id} .*"wcag-2\\.1\\.1"`),
      ),
      expect.stringMatching(new RegExp(`^\\[2\\]\\.criteria: record ${id} cites 2 criteria`)),
      expect.stringMatching(/^\[3\]\.source\.ruleId: .*"wcag-2\.1\.1"/),
    ]);
  });

  it('refuses a record for a criterion the errata satisfy (4.1.1)', async () => {
    const dir = files({ [fileFor(A)]: stringify([manualOn(A, '4.1.1')]) });
    const error = await problemsOf(dir);
    expect(error.problems).toEqual([
      expect.stringMatching(
        /^\[0\]\.criteria: .*WCAG 4\.1\.1, which is satisfied by the errata; no review needed/,
      ),
    ]);
  });

  it('refuses a 4.1.1 fail record, citing the errata basis, so it can never move 4.1.1 off Supports', async () => {
    const dir = files({ [fileFor(A)]: stringify([manualOn(A, '4.1.1', { outcome: 'fail' })]) });
    const error = await problemsOf(dir);
    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toMatch(/no outcome \(fail\) is accepted\. Basis: WCAG 2\.0 errata /);
    expect(error.problems[0]).toContain('https://www.w3.org/WAI/WCAG20/errata/');
    // Under a 508 profile a 4.1.1 unit is never a checklist item, so `review record` cannot write one.
    expect(REPORT.profile.id).toBe('508+wcag21aa');
    expect(ITEMS.some((i) => i.criterion.type === 'wcag' && i.criterion.id === '4.1.1')).toBe(
      false,
    );
  });

  it('binds each record to the file named for its asset, or product.yaml', async () => {
    const product = manualOn(A, '302.1');
    const misplaced = files({
      'zz.yaml': stringify([manualOn(A, '2.1.1')]),
      [fileFor(B)]: stringify([manualOn(A, '2.4.7')]),
    });
    const error = await problemsOf(misplaced);
    expect(error.file).toBe(join(misplaced, REVIEW_DIR, fileFor(B)));
    expect(error.problems).toEqual([
      expect.stringMatching(new RegExp(`^\\[0\\]\\.asset\\.uri: .* belongs in ${fileFor(A)}`)),
    ]);
    const zz = files({ 'zz.yaml': stringify([manualOn(A, '2.1.1')]) });
    expect((await problemsOf(zz)).file).toBe(join(zz, REVIEW_DIR, 'zz.yaml'));
    // A product-scope item lives in product.yaml whatever asset anchors it.
    const productInAsset = files({ [fileFor(A)]: stringify([product]) });
    expect((await problemsOf(productInAsset)).problems).toEqual([
      expect.stringMatching(/belongs in product\.yaml/),
    ]);
    const ok = files({ 'product.yaml': stringify([product]) });
    expect((await loadReviews(ok)).reviews).toEqual([product]);
  });

  it('refuses a review dated after tomorrow and a record id that is not its own', async () => {
    const future = manualOn(A, '2.1.1', { review: { date: '2099-01-01' } });
    const forged = { ...plain(manualOn(A, '2.4.7')), id: 'wd_0123456789abcdef' };
    const dir = files({ [fileFor(A)]: stringify([future, forged]) });
    expect((await problemsOf(dir)).problems).toEqual([
      expect.stringMatching(/^\[0\]\.review\.date: .*dated 2099-01-01, after tomorrow/),
      expect.stringMatching(
        /^\[1\]\.id: record wd_0123456789abcdef does not match its asset, location and rule/,
      ),
    ]);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const near = files({
      [fileFor(A)]: stringify([manualOn(A, '2.1.1', { review: { date: tomorrow } })]),
    });
    expect((await loadReviews(near)).reviews).toHaveLength(1);
  });

  it('refuses two records for one item in the folder', async () => {
    const pass = manualOn(A, '2.1.1');
    const other = {
      ...plain(pass),
      id: findingId(A.uri, { selector: 'main' }, 'manual', 'wcag-2.1.1'),
      location: { selector: 'main' },
    };
    const dir = files({ [fileFor(A)]: stringify([pass, other]) });
    expect((await problemsOf(dir)).problems).toEqual([
      expect.stringMatching(
        /^\[1\]\.asset\.uri: record .* repeats the result for WCAG 2\.1\.1 on .* already in/,
      ),
    ]);
    const products = files({
      'product.yaml': stringify([manualOn(A, '302.1'), manualOn(B, '302.1')]),
    });
    expect((await problemsOf(products)).problems).toEqual([
      expect.stringMatching(/repeats the result for 508 302\.1 already in product\.yaml/),
    ]);
  });
});

describe('screenReviews', () => {
  it('keeps records for scanned and unscanned assets and says why it drops the rest', () => {
    const good = manualOn(A, '2.1.1');
    const failed = manualOn(B, '2.1.1');
    const orphan = manualOn({ ...A, uri: 'https://elsewhere.example/' }, '2.1.1');
    const wrongKind = manualOn({ kind: 'web', uri: P.uri, contentHash: P.contentHash }, '1.3.1');
    const foreign = manualOn(A, '1.4.3', { review: { overrides: [FAIL_B.id] } });
    const older = manualOn(A, '302.1', { review: { date: '2026-10-01' } });
    const newer = manualOn(P, '302.1', { review: { date: '2026-10-22' } });
    const screened = screenReviews(
      [good, failed, orphan, wrongKind, foreign, older, newer],
      { assets: [A, P], unscanned: [{ uri: B.uri, kind: 'web' }], automated: [FAIL_A, FAIL_B] },
      data,
    );
    expect(screened.applied).toEqual([good, failed, newer]);
    expect(screened.notApplied.map((x) => [x.record, x.reason])).toEqual([
      [orphan, 'orphaned'],
      [wrongKind, 'kind-mismatch'],
      [foreign, 'bad-override'],
      [older, 'superseded'],
    ]);
  });
});

describe('reviewChecklist', () => {
  it('applies current records and lists the ones it cannot apply, with why', () => {
    const good = manualOn(A, '2.1.1');
    const orphan = manualOn({ ...A, uri: 'https://elsewhere.example/' }, '2.1.1');
    const wrongKind = manualOn({ kind: 'web', uri: P.uri, contentHash: P.contentHash }, '1.3.1');
    const foreign = manualOn(A, '1.4.3', { review: { overrides: [FAIL_B.id] } });
    const older = manualOn(B, '2.4.7', { review: { date: '2026-10-01' } });
    const newer = manualOn(B, '2.4.7', { outcome: 'fail', review: { date: '2026-10-22' } });
    const state = reviewChecklist(REPORT, [good, orphan, wrongKind, foreign, older, newer], data);
    expect(state.applied).toEqual([good, newer]);
    expect(state.notApplied.map((x) => [x.record, x.reason])).toEqual([
      [orphan, 'orphaned'],
      [wrongKind, 'kind-mismatch'],
      [foreign, 'bad-override'],
      [older, 'superseded'],
    ]);
    expect(state.items.find((i) => i.id === item(A.uri, '2.1.1').id)?.status).toBe('done');
    // The refused override is never applied: the automated fail still stands.
    expect(state.items.find((i) => i.id === item(A.uri, '1.4.3').id)?.status).toBe(
      'failed-automated',
    );
    expect(state.summary.total).toBe(state.items.length);
  });

  it('keeps, and never calls orphaned, a record for a page in scope that failed to scan', () => {
    const profile = getProfile('508+wcag21aa');
    const unscanned = [{ uri: B.uri, kind: 'web' as const }];
    const failedB: ReviewReport = {
      profile: { id: profile.id, pdfDocumentType: profile.pdfDocumentType },
      assets: [A, P],
      findings: [FAIL_A],
      rollup: rollup({
        findings: [FAIL_A],
        reviews: [],
        profile,
        assets: [A, P],
        errata: errataFrom(data),
        unscanned,
      }),
    };
    const kept = manualOn(B, '2.1.1');
    const orphan = manualOn({ ...A, uri: 'https://elsewhere.example/' }, '2.1.1');
    const state = reviewChecklist(failedB, [kept, orphan], data);
    expect(state.applied).toEqual([kept]);
    expect(state.notApplied.map((x) => [x.record, x.reason])).toEqual([[orphan, 'orphaned']]);
    expect(state.items.some((i) => i.asset?.uri === B.uri)).toBe(false);
  });

  it('lists a record for a criterion that has no checklist item as no-item', () => {
    // 4.1.1 is settled by the errata basis, so it never needs a reviewer.
    const settled = manualOn(A, '4.1.1');
    const state = reviewChecklist(REPORT, [settled], data);
    expect(state.notApplied.map((x) => x.reason)).toEqual(['no-item']);
    expect(state.applied).toEqual([]);
  });

  it('never applies a record without the manual identity, such as one from an old report', () => {
    const good = manualOn(A, '2.1.1');
    const renamed = FindingSchema.parse({
      ...good,
      source: { ...good.source, ruleId: 'keyboard' },
    });
    const state = reviewChecklist(REPORT, [renamed, FAIL_A], data);
    expect(state.notApplied.map((x) => [x.record, x.reason])).toEqual([
      [renamed, 'bad-identity'],
      [FAIL_A, 'bad-identity'],
    ]);
    expect(state.items.find((i) => i.id === item(A.uri, '2.1.1').id)?.status).toBe('open');
  });
});

describe('screenItemless (ruling 9)', () => {
  // Data in which a color-contrast pass decides 1.4.3, so a page that passes it has no item.
  const deciding = {
    ...data,
    axe: {
      ...data.axe,
      rules: data.axe.rules.map((r) => (r.id === 'color-contrast' ? { ...r, decides: true } : r)),
    },
  };
  const location = { selector: 'html' };
  const PASS_B = FindingSchema.parse({
    ...FAIL_B,
    id: findingId(B.uri, location, 'axe-core', 'color-contrast'),
    location,
    outcome: 'pass',
  });
  const profile = getProfile('wcag21aa');
  const settled: ReviewReport = {
    profile: { id: profile.id, pdfDocumentType: profile.pdfDocumentType },
    assets: [B],
    findings: [PASS_B],
    rollup: rollup({
      findings: [PASS_B],
      reviews: [],
      profile,
      assets: [B],
      decidingRules: decidingRulesFrom(deciding),
      errata: errataFrom(deciding),
    }),
  };
  const level = (reviews: Finding[]) =>
    rollup({
      findings: [PASS_B],
      reviews,
      profile,
      assets: [B],
      decidingRules: decidingRulesFrom(deciding),
      errata: errataFrom(deciding),
    }).standards[0]?.criteria.find((c) => c.id === '1.4.3')?.level;

  it('keeps a manual fail on a unit an automated pass decided, with a warning, and it fails', () => {
    expect(level([])).toBe('Supports');
    const fail = manualOn(B, '1.4.3', { outcome: 'fail' });
    const out = screenItemless(settled, [fail], deciding);
    expect(out).toEqual({ applied: [fail], kept: [fail], dropped: [] });
    expect(keptFailWarning(fail)).toBe(
      `manual review record ${fail.id} on ${B.uri} for WCAG 1.4.3: manual fail recorded on a unit automation decided; the manual fail is kept`,
    );
    expect(level(out.applied)).toBe('Does Not Support');
  });

  it('drops a pass, a not-applicable and an override on such a unit, so it stays as decided', () => {
    const pass = manualOn(B, '1.4.3');
    const na = manualOn(B, '1.4.3', { outcome: 'not-applicable' });
    for (const record of [pass, na]) {
      const out = screenItemless(settled, [record], deciding);
      expect(out.applied).toEqual([]);
      expect(out.kept).toEqual([]);
      expect(out.dropped.map((n) => [n.record, n.reason])).toEqual([[record, 'no-item']]);
    }
    // A record that has an item is untouched.
    const keyboard = manualOn(B, '2.1.1');
    expect(screenItemless(settled, [keyboard], deciding)).toEqual({
      applied: [keyboard],
      kept: [],
      dropped: [],
    });
  });

  it('drops a record for a criterion the profile does not have, whatever its outcome', () => {
    // Level AAA 2.1.3 has no row in any profile; 508 302.1 has none under wcag21aa.
    const aaa = manualOn(B, '2.1.3', { outcome: 'fail' });
    const provision = manualOn(B, '302.1', { outcome: 'fail' });
    const out = screenItemless(settled, [aaa, provision], deciding);
    expect(out.applied).toEqual([]);
    expect(out.kept).toEqual([]);
    expect(out.dropped.map((n) => [n.record, n.reason, n.detail])).toEqual([
      [aaa, 'out-of-profile', 'WCAG 2.1.3 is not in profile wcag21aa; the record is not used'],
      [provision, 'out-of-profile', '508 302.1 is not in profile wcag21aa; the record is not used'],
    ]);
    expect(outOfProfileWarning(aaa, 'wcag21aa')).toBe(
      `manual review record ${aaa.id} on ${B.uri}: WCAG 2.1.3 is not in profile wcag21aa; the record is not used`,
    );
  });

  it('review list still leaves the fail out, as a no-item record', () => {
    const fail = manualOn(B, '1.4.3', { outcome: 'fail' });
    const state = reviewChecklist(settled, [fail], deciding);
    expect(state.applied).toEqual([]);
    expect(state.notApplied.map((n) => n.reason)).toEqual(['no-item']);
  });
});

describe('buildChecklist and the errata basis', () => {
  it('makes no item for 4.1.1, even with a manual record or an automated fail on it', () => {
    const profile = getProfile('508+wcag21aa');
    const manual = manualOn(A, '4.1.1', { outcome: 'fail' });
    const automated = FindingSchema.parse({
      ...FAIL_A,
      id: findingId(A.uri, { selector: '#dup' }, 'axe-core', 'duplicate-id'),
      location: { selector: '#dup' },
      source: { ...FAIL_A.source, ruleId: 'duplicate-id' },
      criteria: { wcag: ['4.1.1'] },
    });
    const findings = [automated, manual];
    const rolled = rollup({
      findings: [automated],
      reviews: [manual],
      profile,
      assets: [A],
      errata: errataFrom(data),
    });
    const items = buildChecklist({
      report: { assets: [A], findings, rollup: rolled, profile: { id: profile.id } },
      data,
    });
    expect(items.some((i) => i.criterion.id === '4.1.1')).toBe(false);
    expect(items.length).toBeGreaterThan(0);
  });
});

describe('the review file header', () => {
  it('escapes line breaks in the uri so it cannot end the comment', async () => {
    const evil: Asset = {
      kind: 'web',
      uri: 'https://example.com/x\n- injected: 1\r\n\u2028\u0085done',
      contentHash: hash('e'),
    };
    const evilReport = report([evil], []);
    const it211 = buildChecklist({ report: evilReport, data }).find(
      (i) => i.criterion.id === '2.1.1',
    )!.id;
    const dir = project();
    const { file } = await record(dir, { report: evilReport, item: it211 });
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    expect(lines[1]).toBe(
      '# Asset: https://example.com/x\\x0a- injected: 1\\x0d\\x0a\\u2028\\x85done',
    );
    expect(lines.slice(0, 3).every((l) => l.startsWith('#'))).toBe(true);
    // The body holds the uri only as a quoted string: the file is still one list of one record.
    expect((parse(text) as unknown[]).length).toBe(1);
    expect(lines.slice(0, 3).join('\n')).not.toMatch(/[\r\u2028\u0085]/);
    const loaded = await loadReviews(dir);
    expect(loaded.reviews.map((r) => r.asset.uri)).toEqual([evil.uri]);
  });
});
