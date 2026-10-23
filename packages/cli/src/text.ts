/*
 * Console output carries scanned content (page titles, URLs, error text from
 * pages and PDFs). Control characters, line and paragraph separators and
 * bidirectional controls are shown as escapes, so a scanned page cannot move
 * the cursor, recolor the terminal, set its title or reorder the line.
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

const unsafe = (code: number) => UNSAFE.some(([from, to]) => code >= from && code <= to);

const escape = (code: number) =>
  code < 0x100
    ? `\\x${code.toString(16).padStart(2, '0')}`
    : `\\u${code.toString(16).padStart(4, '0')}`;

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
