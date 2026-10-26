/*
 * Console output carries scanned content (page titles, URLs, error text from
 * pages and PDFs). Control characters, line and paragraph separators and
 * bidirectional controls are shown as escapes, so a scanned page cannot move
 * the cursor, recolor the terminal, set its title or reorder the line.
 * Noncharacters (U+FDD0 to U+FDEF, and U+xFFFE and U+xFFFF in every plane)
 * and lone surrogates are escaped too: XML 1.0 and YAML 1.2 do not allow
 * U+FFFE, U+FFFF or surrogates, so one in a scanned string would break the
 * DOCX, OpenACR and review files built from it.
 */

/** Code point ranges printed as escapes: C0, DEL and C1, then the bidi and separator controls. */
const UNSAFE: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x61c, 0x61c],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
];

const unsafe = (code: number) =>
  UNSAFE.some(([from, to]) => code >= from && code <= to) ||
  // A lone surrogate (Array.from keeps a valid pair together as one code point).
  (code >= 0xd800 && code <= 0xdfff) ||
  // Noncharacters.
  (code >= 0xfdd0 && code <= 0xfdef) ||
  (code & 0xfffe) === 0xfffe;

const hex = (code: number, width: number) => code.toString(16).padStart(width, '0');

const escape = (code: number) =>
  code < 0x100
    ? `\\x${hex(code, 2)}`
    : code <= 0xffff
      ? `\\u${hex(code, 4)}`
      : `\\u{${hex(code, 5)}}`;

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The first line of an error's message. */
export const firstLine = (e: unknown): string =>
  String((e as Error)?.message ?? e).split('\n')[0] ?? '';

/** Text that is safe to print on a terminal, cut to max characters. */
export function safeText(value: unknown, max = 500): string {
  const chars = Array.from(String(value));
  const cut = chars.length > max ? [...chars.slice(0, max), '...'] : chars;
  return cut
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return unsafe(code) ? escape(code) : ch;
    })
    .join('');
}

/**
 * JSON that is safe to print on a terminal: the characters safeText escapes
 * are written as \u escapes (JSON.stringify already escapes C0), so the
 * output is still valid JSON with the same values.
 */
export function safeJson(value: unknown, space = 2): string {
  return Array.from(JSON.stringify(value, null, space) ?? 'null')
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      // C0 outside strings is only the layout whitespace; inside strings JSON escapes it.
      if (code < 0x7f || !unsafe(code)) return ch;
      // Above U+FFFF, JSON escapes the surrogate pair, one \u each.
      return ch.length === 1
        ? `\\u${hex(code, 4)}`
        : `\\u${hex(ch.charCodeAt(0), 4)}\\u${hex(ch.charCodeAt(1), 4)}`;
    })
    .join('');
}
