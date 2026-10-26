import { describe, expect, it } from 'vitest';
import { reviewHashOf } from '../src/review-hash.ts';
import { reviewHashFor } from '../src/review-hash-run.ts';

const CONTENT = `sha256:${'c'.repeat(64)}`;
const bytes = (s: string) => new TextEncoder().encode(s);
const PAGE =
  '<!doctype html><html lang="en"><head><title>T</title></head><body><h1>Hi</h1><script>1</script></body></html>';

describe('reviewHashFor', () => {
  it('returns the same hash as reviewHashOf for a normal page', async () => {
    const r = await reviewHashFor(bytes(PAGE), CONTENT);
    expect(r).toEqual({ hash: reviewHashOf(PAGE) });
  });

  it('falls back to the content hash past the time budget and leaves no worker behind', async () => {
    const started = Date.now();
    // Stray end tags keep any lexical depth estimate low while parse5 goes quadratic.
    const r = await reviewHashFor(bytes('<div></span>'.repeat(300_000)), CONTENT);
    expect(r.hash).toBe(CONTENT);
    expect(r.fallback).toMatch(/took over 2000 ms/);
    expect(Date.now() - started).toBeLessThan(8_000);
    // The worker was terminated: the next call runs on a fresh one and succeeds.
    expect((await reviewHashFor(bytes(PAGE), CONTENT)).hash).toBe(reviewHashOf(PAGE));
  }, 20_000);

  it('honours a smaller budget', async () => {
    const r = await reviewHashFor(bytes('<div></span>'.repeat(100_000)), CONTENT, {
      timeoutMs: 100,
    });
    expect(r.fallback).toMatch(/took over 100 ms/);
  }, 20_000);

  it('falls back when the normalizer refuses the document', async () => {
    const r = await reviewHashFor(bytes('<div>'.repeat(6_000)), CONTENT);
    expect(r).toEqual({ hash: CONTENT, fallback: 'the document could not be normalized' });
  });

  it('falls back when the bytes are not valid UTF-8', async () => {
    const r = await reviewHashFor(
      Uint8Array.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]),
      CONTENT,
    );
    expect(r).toEqual({ hash: CONTENT, fallback: 'the document is not valid UTF-8' });
  });

  it('falls back when the worker runs out of heap', async () => {
    const r = await reviewHashFor(bytes(`<p>${'word '.repeat(2_000_000)}</p>`), CONTENT, {
      maxHeapMb: 4,
    });
    expect(r.hash).toBe(CONTENT);
    expect(r.fallback).toBeDefined();
  }, 20_000);
});
