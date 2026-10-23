import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers.ts';

/*
 * The README is user guidance, and Prettier accepts a code fence that runs on
 * and swallows later sections. These checks parse the fences (CommonMark
 * rules: a fence of 3 or more backticks or tildes closes only on the same
 * character, at least as long, with nothing after it) and make sure every one
 * closes and the required headings sit outside them.
 */

interface Fence {
  open: number;
  close?: number;
}

function fences(text: string): { fences: Fence[]; outside: string[] } {
  const found: Fence[] = [];
  const outside: string[] = [];
  let current: { fence: Fence; char: string; size: number } | undefined;
  text.split(/\r?\n/).forEach((line, i) => {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (current) {
      const marker = m?.[1];
      if (marker && marker[0] === current.char && marker.length >= current.size && !m[2]?.trim()) {
        current.fence.close = i + 1;
        current = undefined;
      }
      return;
    }
    if (m?.[1] && !(m[1][0] === '`' && m[2]?.includes('`'))) {
      const fence: Fence = { open: i + 1 };
      found.push(fence);
      current = { fence, char: m[1][0] as string, size: m[1].length };
      return;
    }
    outside.push(line);
  });
  return { fences: found, outside };
}

describe('Markdown code fences', () => {
  for (const file of ['README.md', 'CHANGELOG.md', 'docker/README.md']) {
    it(`closes every fence in ${file}`, () => {
      const unclosed = fences(readFileSync(join(ROOT, file), 'utf8'))
        .fences.filter((f) => f.close === undefined)
        .map((f) => `line ${f.open}`);
      expect(unclosed).toEqual([]);
    });
  }

  it('keeps the README sections outside code blocks', () => {
    const { outside } = fences(readFileSync(join(ROOT, 'README.md'), 'utf8'));
    for (const heading of [
      '## Status',
      '## Install',
      '## Quick start',
      '## What is and is not automated',
      '## Usage',
      '## Docker',
      '### Licenses in the image',
      '## GitHub Action',
      '## Reports',
      '## Disclaimer',
      '## License',
    ])
      expect(outside, heading).toContain(heading);
  });

  it('opens every README fence with exactly three backticks', () => {
    const lines = readFileSync(join(ROOT, 'README.md'), 'utf8').split(/\r?\n/);
    const opens = fences(lines.join('\n')).fences.map((f) => lines[f.open - 1]?.trim() ?? '');
    for (const open of opens) expect(open).toMatch(/^```(?!`)/);
  });
});
