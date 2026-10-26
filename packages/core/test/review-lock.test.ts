import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  LOCK_STALE_MS,
  REVIEW_DIR,
  buildChecklist,
  errataFrom,
  getProfile,
  loadReviews,
  loadStandardsData,
  recordReview,
  rollup,
  type Asset,
  type RecordInput,
  type ReviewReport,
} from '../src/index.js';

/*
 * The review file lock and the order of writes, with node:fs/promises rename
 * replaceable per test, so the races and the failures that a real file
 * system produces only by chance (a lock replaced between the stale check
 * and the rename, a rename the system refuses) happen on purpose.
 */

const fsHooks = vi.hoisted(() => ({
  rename: undefined as undefined | ((from: string, to: string) => Promise<void> | undefined),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: (from: string, to: string) => fsHooks.rename?.(from, to) ?? real.rename(from, to),
  };
});
afterEach(() => {
  fsHooks.rename = undefined;
});

const data = loadStandardsData();
const root = mkdtempSync(join(tmpdir(), 'widedoor-review-lock-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const A: Asset = {
  kind: 'web',
  uri: 'https://example.com/a',
  contentHash: `sha256:${'a'.repeat(64)}`,
};
const profile = getProfile('508+wcag21aa');
const REPORT: ReviewReport = {
  profile: { id: profile.id, pdfDocumentType: profile.pdfDocumentType },
  assets: [A],
  findings: [],
  rollup: rollup({ findings: [], reviews: [], profile, assets: [A], errata: errataFrom(data) }),
};
const ITEMS = buildChecklist({ report: REPORT, data });
const itemId = (sc: string) => ITEMS.find((i) => i.criterion.id === sc)!.id;
const FILE = `web-${createHash('sha256').update(A.uri).digest('hex').slice(0, 16)}.yaml`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

let n = 0;
function project() {
  const dir = join(root, `p${n++}`);
  mkdirSync(join(dir, REVIEW_DIR), { recursive: true });
  return { dir, folder: join(dir, REVIEW_DIR), lock: join(dir, REVIEW_DIR, `${FILE}.lock`) };
}
const record = (dir: string, input: Partial<RecordInput> & { item: string }) =>
  recordReview(dir, {
    report: REPORT,
    outcome: 'pass',
    reviewer: 'r',
    date: '2026-10-23',
    version: '0.2.0',
    data,
    ...input,
  });
const age = (path: string, ms: number) => {
  const t = (Date.now() + ms) / 1000;
  utimesSync(path, t, t);
};
const refused = (code: string) =>
  Promise.reject(Object.assign(new Error(`${code}: refused by the test`), { code }));
// The code under test moves the lock aside and links it back, so a read can find no file.
const readOr = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};
const until = async (done: () => boolean) => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(done()).toBe(true);
};

describe('the review file lock', () => {
  it('refuses a folder at the lock name with a ConfigError naming it', async () => {
    const { dir, lock } = project();
    mkdirSync(lock);
    const error = await record(dir, { item: itemId('2.1.1') }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).file).toBe(lock);
    expect(String(error)).toMatch(/not a regular file/);
  });

  it('treats a lock dated in the future as stale', async () => {
    const { dir, lock } = project();
    writeFileSync(lock, 'planted\n');
    age(lock, 10 * 60_000);
    await record(dir, { item: itemId('2.1.1') });
    expect(existsSync(lock)).toBe(false);
  });

  it('gives up with a ConfigError, without spinning, when a stale lock cannot be moved', async () => {
    const { dir, lock } = project();
    writeFileSync(lock, 'dead\n');
    age(lock, -LOCK_STALE_MS - 5_000);
    let tries = 0;
    fsHooks.rename = (from) => (from === lock ? (tries++, refused('EACCES')) : undefined);
    const started = Date.now();
    const error = await record(dir, { item: itemId('2.1.1') }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).file).toBe(lock);
    expect(String(error)).toMatch(/stale lock that cannot be moved aside/);
    expect(tries).toBe(5);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('puts back a fresh lock that another writer made between the stale check and the move', async () => {
    const { dir, folder, lock } = project();
    writeFileSync(lock, 'dead\n');
    age(lock, -LOCK_STALE_MS - 5_000);
    let replaced = false;
    fsHooks.rename = (from) => {
      // Another writer takes the stale lock over just before this one moves it.
      if (from === lock && !replaced) {
        replaced = true;
        writeFileSync(lock, 'fresh\n');
      }
      return undefined;
    };
    const writing = record(dir, { item: itemId('2.1.1') });
    // The fresh lock is linked back, the moved copy removed, and this writer waits.
    await until(
      () =>
        replaced &&
        readOr(lock) === 'fresh\n' &&
        !readdirSync(folder).some((f) => f.endsWith('.stale')),
    );
    expect(existsSync(join(folder, FILE))).toBe(false);
    rmSync(lock); // the other writer finishes
    await writing;
    expect((await loadReviews(dir)).reviews).toHaveLength(1);
    expect(readdirSync(folder)).toEqual([FILE]);
  });

  it('lands every one of several writers that find a stale lock at once', async () => {
    const { dir, folder, lock } = project();
    writeFileSync(lock, 'dead\n');
    age(lock, -LOCK_STALE_MS - 5_000);
    const ids = ['1.3.1', '2.1.1', '2.4.3', '2.4.7', '3.3.2', '1.4.10'].map(itemId);
    await Promise.all(ids.map((item) => record(dir, { item })));
    expect((await loadReviews(dir)).reviews).toHaveLength(ids.length);
    expect(readdirSync(folder)).toEqual([FILE]);
  });

  it('queues writers in one process, so a stale lock and a writer in another process lose no record', async () => {
    const { dir, folder, lock } = project();
    writeFileSync(lock, 'dead\n');
    age(lock, -LOCK_STALE_MS - 5_000);
    // A second copy of the module has its own queue: a writer in another process.
    vi.resetModules();
    const other = await import('../src/index.js');
    // The first move of the lock waits until the other writers had their chance to move it too.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let moves = 0;
    let movesWhilePaused = 0;
    fsHooks.rename = (from, to) => {
      if (from !== lock) return undefined;
      if (moves++ === 0) return gate.then(() => renameSync(from, to));
      movesWhilePaused++;
      return undefined;
    };
    const writing = Promise.all([
      record(dir, { item: itemId('2.1.1') }),
      record(dir, { item: itemId('2.4.3') }),
      other.recordReview(dir, {
        report: REPORT,
        item: itemId('3.3.2'),
        outcome: 'pass',
        reviewer: 'other process',
        date: '2026-10-23',
        version: '0.2.0',
        data,
      }),
    ]);
    // Only one of the other two writers moves the lock: the one queued here never tries.
    await until(() => movesWhilePaused >= 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(movesWhilePaused).toBe(1);
    release();
    await writing;
    const { reviews } = await loadReviews(dir);
    expect(reviews.map((r) => r.criteria.wcag?.[0]).sort()).toEqual(['2.1.1', '2.4.3', '3.3.2']);
    expect(readdirSync(folder)).toEqual([FILE]);
  });
});

describe('the order of writes', () => {
  it('removes new images and keeps the old record when the review file does not land', async () => {
    const { dir, folder } = project();
    const shot = join(root, `shot${n++}.png`);
    writeFileSync(shot, PNG);
    const first = await record(dir, { item: itemId('2.1.1'), attach: [shot] });
    const before = readFileSync(join(folder, FILE), 'utf8');
    const images = readdirSync(join(folder, 'attachments'));
    fsHooks.rename = (_from, to) => (to.endsWith('.yaml') ? refused('EIO') : undefined);
    await expect(
      record(dir, { item: itemId('2.1.1'), outcome: 'fail', attach: [shot, shot] }),
    ).rejects.toThrow(/EIO/);
    expect(readFileSync(join(folder, FILE), 'utf8')).toBe(before);
    expect(readdirSync(join(folder, 'attachments'))).toEqual(images);
    expect(readdirSync(folder).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'))).toEqual(
      [],
    );
    expect((await loadReviews(dir)).reviews).toEqual([first.record]);
  });
});
