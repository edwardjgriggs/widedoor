import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { ConfigError } from '../src/config.ts';
import { MAX_REVIEW_FILES, loadReviews } from '../src/reviews.ts';

const root = mkdtempSync(join(tmpdir(), 'widedoor-reviews-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hash = `sha256:${'a'.repeat(64)}`;
const REVIEW = {
  schemaVersion: 1,
  id: 'wd_0123456789abcdef',
  asset: { kind: 'web', uri: 'https://example.com/', contentHash: hash },
  location: { selector: 'main' },
  source: { engine: 'manual', engineVersion: '1', ruleId: 'keyboard' },
  criteria: { wcag: ['2.1.1'] },
  outcome: 'pass',
  review: { reviewer: 'Edward Griggs', date: '2026-10-21', expiresOnChangeOf: hash },
};

let n = 0;
function project(files: Record<string, string>): string {
  const dir = join(root, `p${n++}`);
  mkdirSync(join(dir, 'widedoor-review'), { recursive: true });
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, 'widedoor-review', name), text);
  return dir;
}

describe('loadReviews', () => {
  it('reads one record or a list per file, in name order, and ignores other files', async () => {
    const dir = project({
      'b.yaml': stringify([REVIEW, { ...REVIEW, outcome: 'fail' }]),
      'a.yaml': stringify(REVIEW),
      'empty.yaml': '',
      'notes.txt': 'not a review',
    });
    const { files, reviews } = await loadReviews(dir);
    expect(files.map((f) => f.slice(dir.length + 1).replace(/\\/g, '/'))).toEqual([
      'widedoor-review/a.yaml',
      'widedoor-review/b.yaml',
      'widedoor-review/empty.yaml',
    ]);
    expect(reviews.map((r) => r.outcome)).toEqual(['pass', 'pass', 'fail']);
  });

  it('reads .yml files too', async () => {
    const dir = project({ 'c.yml': stringify(REVIEW) });
    expect((await loadReviews(dir)).reviews).toHaveLength(1);
  });

  it('refuses a linked review folder or file instead of following it', async () => {
    const outside = mkdtempSync(join(root, 'outside-'));
    writeFileSync(join(outside, 'secret.yaml'), 'private_key: hunter2\n');
    const dir = join(root, `p${n++}`);
    mkdirSync(dir);
    symlinkSync(outside, join(dir, 'widedoor-review'), 'junction');
    await expect(loadReviews(dir)).rejects.toThrow(/symbolic link or junction/);

    const files = project({});
    try {
      symlinkSync(join(outside, 'secret.yaml'), join(files, 'widedoor-review', 'x.yaml'), 'file');
    } catch {
      return; // File links need privileges this Windows account may not have.
    }
    const error = await loadReviews(files).catch((e: unknown) => e);
    expect(String(error)).toMatch(/symbolic link/);
    expect(String(error)).not.toContain('private_key');
  });

  it('refuses a folder that is not a regular file and too many files', async () => {
    const dir = project({});
    mkdirSync(join(dir, 'widedoor-review', 'sub.yaml'));
    await expect(loadReviews(dir)).rejects.toThrow(/not a regular file/);
    const many = project(
      Object.fromEntries(Array.from({ length: MAX_REVIEW_FILES + 1 }, (_, i) => [`${i}.yaml`, ''])),
    );
    await expect(loadReviews(many)).rejects.toThrow(/more than 1000 review files/);
  });

  it('finds nothing when the folder is missing', async () => {
    expect(await loadReviews(join(root, 'none'))).toEqual({ files: [], reviews: [] });
  });

  it('names the file and each bad record, with readable union errors', async () => {
    const dir = project({
      'bad.yaml': stringify([REVIEW, { ...REVIEW, review: { ...REVIEW.review, date: 'soon' } }]),
    });
    const error = await loadReviews(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).file).toBe(join(dir, 'widedoor-review', 'bad.yaml'));
    expect((error as ConfigError).problems).toEqual([
      expect.stringMatching(/^\[1\]\.review\.date: /),
    ]);
  });

  it('refuses automated records in a review file', async () => {
    const automated = {
      ...Object.fromEntries(Object.entries(REVIEW).filter(([key]) => key !== 'review')),
      source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId: 'label' },
    };
    const dir = project({ 'x.yaml': stringify(automated) });
    await expect(loadReviews(dir)).rejects.toThrow(/review files hold manual records only/);
  });
});
