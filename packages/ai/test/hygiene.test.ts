import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Source hygiene: every file under packages/ai/src, test and schema is
 * printable ASCII plus tab, LF and CR. Unicode test inputs are written as \u
 * escapes, so an invisible or control character in a source file is always a
 * mistake (a file tool has twice turned escapes into the characters).
 */

const pkg = fileURLToPath(new URL('../', import.meta.url));
const DIRS = ['src', 'test', 'schema'];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

/** The offset of the first byte that is not printable ASCII, tab, LF or CR, or -1. */
function firstBadByte(bytes: Uint8Array): number {
  return bytes.findIndex(
    (b) => !(b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)),
  );
}

describe('packages/ai source hygiene', () => {
  it('finds a bad byte where there is one', () => {
    expect(firstBadByte(new TextEncoder().encode('ok\tline\r\n'))).toBe(-1);
    expect(firstBadByte(new TextEncoder().encode('ab\u200bc'))).toBe(2);
    expect(firstBadByte(Uint8Array.of(0x41, 0x00))).toBe(1);
    expect(firstBadByte(Uint8Array.of(0x7f))).toBe(0);
  });

  for (const dir of DIRS)
    it(`every file under packages/ai/${dir} is printable ASCII`, () => {
      const list = files(join(pkg, dir));
      expect(list.length).toBeGreaterThan(0);
      const bad = list.flatMap((file) => {
        const offset = firstBadByte(readFileSync(file));
        return offset < 0 ? [] : [`${relative(pkg, file)} at byte ${offset}`];
      });
      expect(bad).toEqual([]);
    });
});
