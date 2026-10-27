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

type Open = typeof import('node:fs/promises').open;
type ReadFile = (path: string, encoding: 'utf8') => Promise<string>;
const fsHooks = vi.hoisted(() => ({
  rename: undefined as undefined | ((from: string, to: string) => Promise<void> | undefined),
  /** Gets the real open, to call when it lets the open through. */
  open: undefined as
    undefined | ((real: Open, ...args: Parameters<Open>) => ReturnType<Open> | undefined),
  /** Gets the real readFile, likewise. */
  readFile: undefined as
    undefined | ((real: ReadFile, path: string) => Promise<string> | undefined),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const readText = (path: string, encoding: 'utf8') => real.readFile(path, encoding);
  return {
    ...real,
    rename: (from: string, to: string) => fsHooks.rename?.(from, to) ?? real.rename(from, to),
    open: (...args: Parameters<Open>) => fsHooks.open?.(real.open, ...args) ?? real.open(...args),
    readFile: ((path: string, options?: unknown) =>
      (options === 'utf8' ? fsHooks.readFile?.(readText, String(path)) : undefined) ??
      real.readFile(path, options as never)) as typeof real.readFile,
  };
});
afterEach(() => {
  fsHooks.rename = undefined;
  fsHooks.open = undefined;
  fsHooks.readFile = undefined;
  vi.restoreAllMocks();
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

  it('lets one taker move a stale lock while writers in this and another process wait, and loses no record', async () => {
    const { dir, folder, lock } = project();
    writeFileSync(lock, 'dead\n');
    age(lock, -LOCK_STALE_MS - 5_000);
    // A second copy of the module has its own queue: a writer in another process.
    vi.resetModules();
    const other = await import('../src/index.js');
    // The move of the stale lock waits until the other taker, which keeps looking, has
    // been refused the claim while the move is under way.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let moves = 0;
    let paused = false;
    fsHooks.rename = (from, to) => {
      if (from !== lock) return undefined;
      if (moves++ !== 0) return undefined;
      paused = true;
      return gate.then(() => renameSync(from, to));
    };
    let refusedClaim!: () => void;
    const claimRefused = new Promise<void>((r) => (refusedClaim = r));
    fsHooks.open = (real, ...args) => {
      if (!String(args[0]).endsWith('.claim')) return undefined;
      return real(...args).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'EEXIST' && paused) refusedClaim();
        throw e;
      });
    };
    const started = Date.now();
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
    await claimRefused;
    // The taker refused the claim did not move the lock: it waits for the one moving it.
    expect(moves).toBe(1);
    release();
    await writing;
    expect(moves).toBe(1);
    expect(Date.now() - started).toBeLessThan(LOCK_STALE_MS / 2);
    const { reviews } = await loadReviews(dir);
    expect(reviews.map((r) => r.criteria.wcag?.[0]).sort()).toEqual(['2.1.1', '2.4.3', '3.3.2']);
    expect(readdirSync(folder)).toEqual([FILE]);
  });

  it('never moves a fresh lock for a taker that saw the stale one before it was replaced', async () => {
    // The interleaving that orphaned locks: writer W takes the stale lock over and writes
    // under its fresh lock, then taker T, who saw the stale lock earlier, acts on it. Had T
    // moved W's fresh lock aside, W would find no lock to remove, and the lock linked back
    // would stall every writer until LOCK_STALE_MS.
    const { dir, folder, lock } = project();
    writeFileSync(lock, 'dead\n');
    age(lock, -LOCK_STALE_MS - 5_000);
    vi.resetModules();
    const other = await import('../src/index.js');
    // T (in the other process) starts first; its first takeover step (a claim, or a move of
    // the lock) waits until W holds its fresh lock. W starts only once T has seen the stale lock.
    let steps = 0;
    let tSaw!: () => void;
    const seen = new Promise<void>((r) => (tSaw = r));
    let wHolds!: () => void;
    const holding = new Promise<void>((r) => (wHolds = r));
    let tActed!: () => void;
    const acted = new Promise<void>((r) => (tActed = r));
    let lockMoves = 0;
    fsHooks.open = (real, ...args) => {
      if (!String(args[0]).endsWith('.claim') || steps++ !== 0) return undefined;
      tSaw();
      return holding.then(() => real(...args)).finally(() => tActed());
    };
    fsHooks.rename = (from, to) => {
      if (from === lock) {
        lockMoves++;
        if (steps++ !== 0) return undefined;
        tSaw();
        // Moved while W writes; W's release runs before the lock could be linked back.
        return holding.then(async () => {
          renameSync(from, to);
          tActed();
          await new Promise((r) => setTimeout(r, 300));
        });
      }
      // W writes its review file only once T has acted on what it saw.
      if (to.endsWith('.yaml')) {
        wHolds();
        return acted.then(() => renameSync(from, to));
      }
      return undefined;
    };
    const started = Date.now();
    const t = other.recordReview(dir, {
      report: REPORT,
      item: itemId('3.3.2'),
      outcome: 'pass',
      reviewer: 'other process',
      date: '2026-10-23',
      version: '0.2.0',
      data,
    });
    await seen;
    await Promise.all([t, record(dir, { item: itemId('2.1.1') })]);
    // Only the stale lock was moved, and nobody waited for a lock to go stale.
    expect(lockMoves).toBe(1);
    expect(Date.now() - started).toBeLessThan(LOCK_STALE_MS / 2);
    const { reviews } = await loadReviews(dir);
    expect(reviews.map((r) => r.criteria.wcag?.[0]).sort()).toEqual(['2.1.1', '3.3.2']);
    expect(readdirSync(folder)).toEqual([FILE]);
  });

  it('clears a claim a taker left when it died mid-takeover, once the claim is stale', async () => {
    const { dir, folder, lock } = project();
    writeFileSync(lock, 'dead\n');
    age(lock, -LOCK_STALE_MS - 5_000);
    // The claim a dead taker made: named from the stale lock, as every taker names it.
    let claim = '';
    fsHooks.open = (real, ...args) => {
      if (String(args[0]).endsWith('.claim') && claim === '') {
        claim = String(args[0]);
        writeFileSync(claim, 'dead taker\n');
        age(claim, -60_000);
      }
      return undefined;
    };
    await record(dir, { item: itemId('2.1.1') });
    expect(claim).not.toBe('');
    expect((await loadReviews(dir)).reviews).toHaveLength(1);
    expect(readdirSync(folder)).toEqual([FILE]);
  });
});

describe('a stale lock that cannot be read, a lost claim, a refused claim name', () => {
  const withOther = async () => {
    vi.resetModules();
    return import('../src/index.js');
  };
  const otherRecord = (other: Awaited<ReturnType<typeof withOther>>, dir: string, sc: string) =>
    other.recordReview(dir, {
      report: REPORT,
      item: itemId(sc),
      outcome: 'pass',
      reviewer: 'other process',
      date: '2026-10-23',
      version: '0.2.0',
      data,
    });

  it('waits for the deadline, without spinning, on a stale lock it cannot read', async () => {
    const { dir, lock } = project();
    writeFileSync(lock, 'dead\n');
    age(lock, -LOCK_STALE_MS - 5_000);
    let reads = 0;
    fsHooks.readFile = (_real, path) =>
      path === lock ? (reads++, refused('EACCES') as Promise<string>) : undefined;
    // The clock runs a second ahead per reading, so the 60 s wait ends in about a second.
    const real = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + (skew += 1_000));
    const started = performance.now();
    const error = await record(dir, { item: itemId('2.1.1') }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).file).toBe(lock);
    // Says why, naming the lock root-relative; not "another writer has held it".
    expect((error as ConfigError).problems).toEqual([
      `widedoor-review/${FILE}.lock is stale but cannot be read (its permissions, or another program holding it open); fix that, or remove it if no Widedoor is running`,
    ]);
    // Each look sleeps: a few dozen reads, not a hot loop of thousands.
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(200);
    expect(performance.now() - started).toBeLessThan(15_000);
  });

  it('says the review folder cannot be written when the claim name is refused until the deadline', async () => {
    const { dir, lock } = project();
    writeFileSync(lock, 'dead\n');
    age(lock, -LOCK_STALE_MS - 5_000);
    let refusals = 0;
    fsHooks.open = (_real, ...args) =>
      String(args[0]).endsWith('.claim')
        ? (refusals++, refused('EPERM') as ReturnType<Open>)
        : undefined;
    const real = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + (skew += 1_000));
    const error = await record(dir, { item: itemId('2.1.1') }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).file).toBe(lock);
    expect((error as ConfigError).problems).toEqual([
      `widedoor-review/ cannot be written: the system refuses new files next to the stale lock widedoor-review/${FILE}.lock; check the folder's permissions`,
    ]);
    expect(refusals).toBeGreaterThan(0);
    expect(refusals).toBeLessThan(200);
  });

  it('lets a taker paused past CLAIM_STALE_MS neither move the lock nor remove the claim it lost', async () => {
    const { dir, folder, lock } = project();
    writeFileSync(lock, 'dead\n');
    age(lock, -LOCK_STALE_MS - 5_000);
    const other = await withOther();
    // Taker A (the other process) pauses right after it creates its claim.
    let aPaused!: () => void;
    const aWaits = new Promise<void>((r) => (aPaused = r));
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    let claimReads = 0;
    let claim = '';
    fsHooks.readFile = (real, path) => {
      if (!path.endsWith('.claim') || claimReads++ !== 0) return undefined;
      claim = path;
      aPaused();
      return gateA.then(() => real(path, 'utf8'));
    };
    // Taker B (this process) holds its move of the lock until A has had its say.
    let bMoving!: () => void;
    const bMoves = new Promise<void>((r) => (bMoving = r));
    let releaseB!: () => void;
    const gateB = new Promise<void>((r) => (releaseB = r));
    let lockMoves = 0;
    fsHooks.rename = (from, to) => {
      if (from !== lock) return undefined;
      if (lockMoves++ !== 0) return undefined;
      bMoving();
      return gateB.then(() => renameSync(from, to));
    };
    let aRetried!: () => void;
    const retried = new Promise<void>((r) => (aRetried = r));
    let moving = false;
    void bMoves.then(() => (moving = true));
    fsHooks.open = (real, ...args) => {
      if (!String(args[0]).endsWith('.claim') || !moving) return undefined;
      return real(...args).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'EEXIST') aRetried();
        throw e;
      });
    };
    const a = otherRecord(other, dir, '3.3.2');
    await aWaits;
    // A's claim looks dead: B clears it, claims the lock itself and starts to move it.
    age(claim, -60_000);
    const b = record(dir, { item: itemId('2.1.1') });
    await bMoves;
    const bClaim = readFileSync(claim, 'utf8');
    releaseA();
    // A finds the claim is no longer its own, leaves it and the lock alone, and looks again.
    await retried;
    expect(lockMoves).toBe(1);
    expect(readFileSync(claim, 'utf8')).toBe(bClaim);
    releaseB();
    await Promise.all([a, b]);
    expect(lockMoves).toBe(1);
    const { reviews } = await loadReviews(dir);
    expect(reviews.map((r) => r.criteria.wcag?.[0]).sort()).toEqual(['2.1.1', '3.3.2']);
    expect(readdirSync(folder)).toEqual([FILE]);
  });

  it('waits, rather than giving up, while Windows refuses a just-deleted claim name', async () => {
    const { dir, folder, lock } = project();
    writeFileSync(lock, 'dead\n');
    age(lock, -LOCK_STALE_MS - 5_000);
    let refusals = 0;
    fsHooks.open = (_real, ...args) => {
      if (!String(args[0]).endsWith('.claim') || refusals >= 8) return undefined;
      refusals++;
      return refused(refusals % 2 === 0 ? 'EPERM' : 'EACCES') as ReturnType<Open>;
    };
    await record(dir, { item: itemId('2.1.1') });
    // More refusals than LOCK_TAKEOVER_TRIES, and the write still landed.
    expect(refusals).toBe(8);
    expect((await loadReviews(dir)).reviews).toHaveLength(1);
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
