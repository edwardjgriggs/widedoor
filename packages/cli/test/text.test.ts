import { describe, expect, it } from 'vitest';
import { safeText } from '../src/text.ts';

describe('safeText', () => {
  it('shows terminal escapes, line breaks and bidi controls as escapes', () => {
    const esc = String.fromCharCode(0x1b);
    const csi = String.fromCharCode(0x9b);
    const rlo = String.fromCharCode(0x202e);
    const ls = String.fromCharCode(0x2028);
    const hostile = `${esc}]0;owned${String.fromCharCode(7)}${esc}[31mred${csi}2J\r\nnext${rlo}gpj.exe${ls}x`;
    const shown = safeText(hostile);
    expect(shown).toBe('\\x1b]0;owned\\x07\\x1b[31mred\\x9b2J\\x0d\\x0anext\\u202egpj.exe\\u2028x');
    expect([...shown].every((ch) => (ch.codePointAt(0) ?? 0) >= 0x20)).toBe(true);
  });

  it('keeps ordinary text, non-Latin scripts included', () => {
    expect(safeText('Página de contacto: 東京 (1/2)')).toBe('Página de contacto: 東京 (1/2)');
  });

  it('cuts long text by characters, not UTF-16 units', () => {
    expect(safeText('abcdef', 3)).toBe('abc...');
    expect(safeText(String.fromCodePoint(0x1f600).repeat(4), 2)).toBe(
      `${String.fromCodePoint(0x1f600).repeat(2)}...`,
    );
  });
});
