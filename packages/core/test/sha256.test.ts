import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/sha256.js';

const node = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches node:crypto across block boundaries and for non-ASCII text', () => {
    const inputs = [
      ...[55, 56, 63, 64, 65, 119, 120, 1000].map((n) => 'x'.repeat(n)),
      '["https://example.com/café?q=\u{1F600}","wcag","1.1.1"]',
    ];
    for (const text of inputs) expect(sha256Hex(text), `length ${text.length}`).toBe(node(text));
  });
});
