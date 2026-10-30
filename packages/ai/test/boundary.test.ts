import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * D16: the hosted tier never loads @widedoor/ai. ESLint bans the import in
 * these trees (eslint.config.js); this test is a second line behind it, not a
 * proof. It matches literal specifiers only, so it catches import() and
 * require of a string literal, but not a specifier built at run time.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const TREES = ['packages/server/src/hosted', 'packages/ui/src', 'packages/web'];
const SKIP = new Set(['node_modules', 'dist']);

/** A string literal naming @widedoor/ai or a subpath of it, in any quote style. */
const SPECIFIER = /(['"`])@widedoor\/ai(?:\/[^'"`]*)?\1/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('the @widedoor/ai boundary (D16)', () => {
  it('recognizes every form of the specifier and nothing else', () => {
    for (const line of [
      "import { suggestFixes } from '@widedoor/ai';",
      'import type { AiSuggestions } from "@widedoor/ai";',
      "const ai = await import('@widedoor/ai');",
      'const ai = await import(`@widedoor/ai`);',
      "const ai = require('@widedoor/ai/model');",
      "export * from '@widedoor/ai';",
    ])
      expect(SPECIFIER.test(line), line).toBe(true);
    for (const line of [
      "import { x } from '@widedoor/aim';",
      "import { x } from '@widedoor/report';",
      "const note = 'see @widedoor/ai docs';",
    ])
      expect(SPECIFIER.test(line), line).toBe(false);
  });

  for (const tree of TREES)
    it(`nothing under ${tree} names @widedoor/ai`, () => {
      const files = sources(join(root, tree));
      // An empty or broken walk must not pass.
      expect(files.length).toBeGreaterThanOrEqual(10);
      const offenders = files.filter((file) => SPECIFIER.test(readFileSync(file, 'utf8')));
      expect(offenders).toEqual([]);
    });
});
