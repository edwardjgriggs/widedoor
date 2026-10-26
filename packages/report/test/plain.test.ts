import { describe, expect, it } from 'vitest';
import { loadStandardsData } from '@widedoor/core';
import { loadPlainData, parsePlainData } from '../src/plain.ts';
import { fleschKincaid, syllables } from '../../core/test/readability.ts';

const plain = loadPlainData();
const data = loadStandardsData();
const mapped = {
  'axe-core': data.axe.rules.map((r) => r.id),
  verapdf: data.verapdf.rules.map((r) => r.id),
  widedoor: data.widedoor.rules.map((r) => r.id),
} as const;

describe('plain.yaml', () => {
  it('has an entry for every mapped rule, and none for rules that are not mapped', () => {
    for (const [engine, ids] of Object.entries(mapped) as [keyof typeof mapped, string[]][]) {
      const have = [...plain[engine].keys()];
      expect(
        ids.filter((id) => !plain[engine].has(id)),
        `${engine} rules with no entry`,
      ).toEqual([]);
      expect(
        have.filter((id) => !ids.includes(id)),
        `${engine} entries for unknown rules`,
      ).toEqual([]);
    }
  });

  it('reads at Flesch-Kincaid grade 8 or lower for every entry', () => {
    const tooHard: string[] = [];
    for (const [engine, entries] of Object.entries(plain))
      for (const [id, p] of entries) {
        const { grade } = fleschKincaid(`${p.what} ${p.who} ${p.fix}`);
        if (grade > 8) tooHard.push(`${engine}:${id} (grade ${grade.toFixed(1)})`);
      }
    expect(tooHard).toEqual([]);
  });

  it('ends every what, who and fix with a full stop', () => {
    for (const entries of Object.values(plain))
      for (const [id, p] of entries)
        for (const part of [p.what, p.who, p.fix]) expect(part, id).toMatch(/\.$/);
  });

  it('rejects an entry missing a field or carrying an unknown engine', () => {
    expect(() => parsePlainData('axe-core: { label: { what: a., who: b. } }\n')).toThrow();
    expect(() => parsePlainData('axe-core: {}\nverapdf: {}\nwidedoor: {}\npa11y: {}\n')).toThrow();
  });

  it('never resolves a rule id through the object prototype', () => {
    expect(plain['axe-core'].get('constructor')).toBeUndefined();
    expect(plain['axe-core'].get('__proto__')).toBeUndefined();
  });
});

describe('readability measure', () => {
  it('counts syllables with the vowel-group rule', () => {
    expect(['the', 'table', 'reader', 'language', 'accessibility'].map(syllables)).toEqual([
      1, 2, 2, 2, 6,
    ]);
  });

  it('scores short plain sentences low and long technical ones high', () => {
    expect(fleschKincaid('The cat sat on the mat. It was warm.').grade).toBeLessThan(2);
    expect(
      fleschKincaid(
        'Programmatically determinable relationships necessitate comprehensive structural accessibility remediation.',
      ).grade,
    ).toBeGreaterThan(16);
  });
});
