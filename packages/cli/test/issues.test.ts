import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FindingSchema } from '@widedoor/core';
import { formatIssues, formatPath } from '../src/issues.ts';

const hash = `sha256:${'a'.repeat(64)}`;
const manual = {
  schemaVersion: 1,
  id: 'wd_0123456789abcdef',
  asset: { kind: 'web', uri: 'https://example.com/', contentHash: hash },
  location: { selector: 'main' },
  source: { engine: 'manual', engineVersion: '1', ruleId: 'keyboard' },
  criteria: { wcag: ['2.1.1'] },
  outcome: 'pass',
  review: { reviewer: 'Edward Griggs', date: '2026-10-21', expiresOnChangeOf: hash },
};

describe('formatPath', () => {
  it('writes keys with dots and indexes in brackets', () => {
    expect(formatPath([])).toBe('(top level)');
    expect(formatPath(['web', 'urls', 0])).toBe('web.urls[0]');
    expect(formatPath([2, 'review', 'date'])).toBe('[2].review.date');
  });
});

describe('formatIssues', () => {
  it('reads a four-way Finding union as the closest branch only', () => {
    const bad = { ...manual, review: { ...manual.review, date: '21 October' }, outcome: 'passed' };
    const result = FindingSchema.safeParse(bad);
    expect(result.success).toBe(false);
    const lines = formatIssues(result.error!.issues);
    expect(lines).toEqual([
      expect.stringMatching(/^outcome: /),
      expect.stringMatching(/^review\.date: /),
    ]);
    // The raw issue is a single invalid_union holding every branch.
    expect(result.error!.issues.map((i) => i.code)).toEqual(['invalid_union']);
  });

  it('keeps the outer path for nested unions and names unknown keys', () => {
    const schema = z.strictObject({ items: z.array(FindingSchema) });
    const result = schema.safeParse({ items: [manual, { ...manual, colour: 'red' }] });
    expect(formatIssues(result.error!.issues)).toEqual(['items[1]: unknown key "colour"']);
  });

  it('adds a base path and drops duplicate lines', () => {
    const result = z.strictObject({ a: z.string() }).safeParse({ a: 1 });
    const twice = [...result.error!.issues, ...result.error!.issues];
    expect(formatIssues(twice, [3])).toEqual([expect.stringMatching(/^\[3\]\.a: /)]);
  });
});
