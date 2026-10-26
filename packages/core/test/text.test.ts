import { describe, expect, it } from 'vitest';
import { safeJson, safeText } from '../src/index.js';

describe('safeJson', () => {
  it('escapes what safeText escapes and stays JSON with the same values', () => {
    const value = { uri: `a${String.fromCharCode(0x1b, 0x9b, 0x202e, 0x2028)}b`, n: [1, 2] };
    const text = safeJson(value);
    expect(JSON.parse(text)).toEqual(value);
    expect(text).toContain(String.raw`a\u001b\u009b\u202e\u2028b`);
    expect(Array.from(text).every((ch) => safeText(ch) === ch || ch === '\n')).toBe(true);
    expect(safeJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('escapes noncharacters as JSON escapes, a supplementary one as its surrogate pair', () => {
    const value = { s: `a\ufffe\uffff\ufdd0${String.fromCodePoint(0x1fffe)}b` };
    const text = safeJson(value);
    expect(JSON.parse(text)).toEqual(value);
    expect(text).toContain(String.raw`a\ufffe\uffff\ufdd0\ud83f\udffeb`);
  });
});

describe('safeText', () => {
  it('escapes noncharacters and lone surrogates, which XML 1.0 and YAML 1.2 do not allow', () => {
    expect(safeText('a\ufffe\uffff\ufdd0\ufdefb')).toBe(String.raw`a\ufffe\uffff\ufdd0\ufdefb`);
    expect(safeText(`x${String.fromCodePoint(0x1fffe, 0x10ffff)}y`)).toBe(
      String.raw`x\u{1fffe}\u{10ffff}y`,
    );
    expect(safeText('lone \ud800 and \udfff')).toBe(String.raw`lone \ud800 and \udfff`);
    // A valid pair, U+FFFD and ordinary text stay as they are.
    const ok = `ok ${String.fromCodePoint(0x1f600, 0xfffd, 0xfdcf, 0xfdf0)}`;
    expect(safeText(ok)).toBe(ok);
  });
});
