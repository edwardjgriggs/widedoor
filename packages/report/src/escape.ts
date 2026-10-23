/*
 * The one escape path for the HTML report. escapeHtml makes any value safe in
 * element text and in a double- or single-quoted attribute, and turns control,
 * format and other invisible characters into visible [U+XXXX] markers so a
 * scanned string cannot reorder, hide or smuggle text. The html tag
 * escapes every interpolated value unless it is SafeHtml, which only the html
 * tag itself can create.
 */

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// Every code point a reader cannot see or that changes how the text around it
// reads: controls (except tab, line feed and carriage return), format characters
// (bidi marks, embeddings, overrides and isolates, zero-width characters, tag
// characters, BOM), other default-ignorable code points (soft hyphen, Hangul
// fillers, variation selectors), noncharacters, line and paragraph separators,
// and unpaired surrogates, which cannot be encoded as UTF-8.
const INVISIBLE =
  /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}\u2028\u2029]/gu;

const marker = (c: string) =>
  `[U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}]`;

/** The value as text with every invisible character shown as a [U+XXXX] marker. For the UI, which renders text only. */
export function visibleText(value: unknown): string {
  return String(value).replace(INVISIBLE, marker);
}

export function escapeHtml(value: unknown): string {
  return visibleText(value).replace(/[&<>"']/g, (c) => ENTITIES[c] as string);
}

const MINT = Symbol('SafeHtml');

/** Markup built by the html tag. Its constructor refuses calls from outside this module. */
export class SafeHtml {
  readonly #value: string;
  constructor(token: symbol, value: string) {
    if (token !== MINT) throw new Error('SafeHtml is created only by the html tag');
    this.#value = value;
  }
  toString(): string {
    return this.#value;
  }
}

type Part = SafeHtml | string | number | boolean | null | undefined | readonly Part[];

function render(value: Part): string {
  if (value instanceof SafeHtml) return value.toString();
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(value);
}

/** Tagged template for report markup: the literal parts are trusted, every value is escaped. */
export function html(strings: TemplateStringsArray, ...values: Part[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? '');
  });
  return new SafeHtml(MINT, out);
}
