import { describe, expect, it } from 'vitest';
import { REFUSAL_KINDS, REFUSAL_LOG_MS, Refusals } from '../src/refusals.ts';

/*
 * The refused request counts, with an injected clock: one line at once, then
 * at most one per REFUSAL_LOG_MS with the count of each kind since the last.
 */

function counter() {
  let t = 0;
  const lines: string[] = [];
  const refusals = new Refusals(
    (line) => void lines.push(line),
    () => t,
  );
  return { refusals, lines, at: (ms: number) => void (t = ms) };
}

describe('Refusals', () => {
  it('logs the first refusal at once, then counts the rest until 10 s have passed', () => {
    const { refusals, lines, at } = counter();
    refusals.count('token');
    expect(lines).toEqual(['refused 1 request (1 token)']);
    at(1_000);
    refusals.count('origin');
    at(REFUSAL_LOG_MS - 1);
    refusals.count('token');
    expect(lines).toHaveLength(1);
    at(REFUSAL_LOG_MS);
    refusals.count('host');
    expect(lines).toEqual([
      'refused 1 request (1 token)',
      'refused 3 requests since the last line (1 Host, 1 token, 1 Origin)',
    ]);
    // Quiet for a while: the next refusal logs at once again.
    at(60_000);
    refusals.count('rate');
    expect(lines.at(-1)).toBe('refused 1 request since the last line (1 rate (429))');
  });

  it('names every kind, in the order the server checks them', () => {
    const { refusals, lines, at } = counter();
    refusals.count('schema');
    at(1);
    for (const kind of [...REFUSAL_KINDS].reverse()) refusals.count(kind);
    refusals.flush();
    expect(lines.at(-1)).toBe(
      'refused 7 requests since the last line (1 Host, 1 token, 1 Origin, 1 content type, 1 size, 1 schema, 1 rate (429))',
    );
  });

  it('flushes what is counted, and logs nothing when nothing is', () => {
    const { refusals, lines } = counter();
    refusals.flush();
    expect(lines).toEqual([]);
    refusals.count('size');
    refusals.count('size');
    refusals.flush();
    expect(lines).toEqual([
      'refused 1 request (1 size)',
      'refused 1 request since the last line (1 size)',
    ]);
    refusals.flush();
    expect(lines).toHaveLength(2);
  });
});
