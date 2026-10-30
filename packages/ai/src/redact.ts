/*
 * Redaction: everything a provider receives about a web element passes
 * through here (spec section 9: "Form values and query strings are redacted").
 * A small tokenizer, not an HTML parser: snippets are short (the web engine
 * keeps at most 300 characters and marks a cut with "...") and often end
 * mid-tag. It is a security boundary, so it fails closed: a construct it
 * cannot follow (a malformed tag, an unterminated comment, CDATA, a doctype)
 * is dropped with everything after it and counted as unparsed, never passed
 * through. A tag cut by the end of the input keeps only its completed,
 * redacted attributes.
 *
 * Attributes are an allowlist. Values are decoded before any check, so an
 * entity cannot hide a query string, and re-escaped on output, so the result
 * is well-formed and decoded text stays text. No absolute URL carries its
 * host (ruling 5); a host or brand name written as plain words is not caught.
 */

/** Longest snippet sent, measured after redaction. */
export const SENT_SNIPPET_MAX = 2000;

/** The marker the web engine appends to a snippet it cut (packages/web truncateSnippet). */
const ENGINE_CUT = '...';

/**
 * Every kind of redaction, with what it removes or masks: the one list the
 * code counts by (count and mask take only these, so TypeScript refuses a
 * kind missing here) and the table docs/ai-fixes.md shows (a test checks the
 * page against it). structure-type is counted in context.ts.
 */
export const REDACTION_KINDS = {
  attribute: 'An attribute not on the allowlist, or with a token-shaped name: dropped.',
  comment: 'An HTML comment: dropped.',
  'contact-url': 'A mailto:, tel:, sms: or callto: URL: masked whole.',
  'credential-attribute':
    'A data-* or aria-* attribute whose name says it holds a key, token, secret, password, session, CSRF value or nonce: dropped.',
  'data-json': 'A data-* attribute that holds JSON: dropped.',
  'data-url': 'A data: URL: masked whole.',
  email: 'An email address: masked.',
  'event-handler': 'An on* event handler attribute: dropped.',
  field: 'Text in a form field, such as a textarea or a hidden, password or sign-in input: masked.',
  fragment: 'The #fragment of a URL: masked (a same-page id link stays).',
  'hex-token': 'A long run of hex digits: masked.',
  host: 'The host of a URL: masked. No page address is ever sent.',
  jwt: 'A JSON Web Token: masked.',
  number: 'A long number, such as an account or card number: masked.',
  phone: 'A phone number: masked.',
  'path-segment': 'A URL path segment of 24 or more characters, in any case: masked.',
  'query-string': 'The ?query of a URL, or query parameters in text: masked.',
  'script-body': 'The body of a script element: dropped.',
  'script-url': 'A javascript: or vbscript: URL: masked whole.',
  'structure-type': 'A non-standard PDF structure type name: sent as Custom.',
  style: 'A style attribute: dropped.',
  'style-body': 'The body of a style element: dropped.',
  token: 'A token-shaped word (letters with digits, or mixed case): masked.',
  truncated: 'The snippet was cut (by the scan or at the size limit): the rest is not sent.',
  unparsed: 'Markup the redactor cannot follow: dropped with everything after it.',
  url: 'A URL in a selector attribute match: masked.',
  userinfo: 'A user name or password inside a URL: masked.',
  uuid: 'A UUID: masked.',
  value: 'A value attribute: dropped.',
} as const;

export type RedactionKind = keyof typeof REDACTION_KINDS;

/**
 * An attribute name that says it holds a credential: the config's key-shape test
 * (key, token, secret, passw, credential, auth, bearer) plus csrf, xsrf, session and nonce.
 */
const CREDENTIAL_NAME = /key|token|secret|passw|credential|auth|bearer|csrf|xsrf|session|nonce/i;

/** Redaction counts by kind; callers share one map across a snippet, its selector and its text. */
export type Counts = Map<string, number>;

export interface Redacted {
  html: string;
  redactions: { kind: string; count: number }[];
}

const count = (counts: Counts, kind: RedactionKind, n = 1) =>
  counts.set(kind, (counts.get(kind) ?? 0) + n);

const merge = (into: Counts, from: Counts) => {
  for (const [kind, n] of from) into.set(kind, (into.get(kind) ?? 0) + n);
};

/** Redaction kinds in a fixed (alphabetical) order. */
export const toRedactions = (counts: Counts): Redacted['redactions'] =>
  [...counts]
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, n]) => ({ kind, count: n }));

const mask = (kind: RedactionKind) => `[redacted:${kind}]`;
const MASKED = '[redacted]';

// Entities.

/** Every HTML named entity that decodes to ASCII, plus nbsp; any other name passes through as written. */
const NAMED: Record<string, string> = {
  Tab: '\t',
  NewLine: '\n',
  excl: '!',
  quot: '"',
  QUOT: '"',
  num: '#',
  dollar: '$',
  percnt: '%',
  amp: '&',
  AMP: '&',
  apos: "'",
  lpar: '(',
  rpar: ')',
  ast: '*',
  midast: '*',
  plus: '+',
  comma: ',',
  period: '.',
  sol: '/',
  colon: ':',
  semi: ';',
  lt: '<',
  LT: '<',
  equals: '=',
  gt: '>',
  GT: '>',
  quest: '?',
  commat: '@',
  lsqb: '[',
  lbrack: '[',
  bsol: '\\',
  rsqb: ']',
  rbrack: ']',
  Hat: '^',
  lowbar: '_',
  UnderBar: '_',
  grave: '`',
  DiacriticalGrave: '`',
  lcub: '{',
  lbrace: '{',
  verbar: '|',
  vert: '|',
  VerticalLine: '|',
  rcub: '}',
  rbrace: '}',
  nbsp: '\u00a0',
  // Invisible: decoded so the splitter strip below removes them.
  shy: '\u00ad',
  ZeroWidthSpace: '\u200b',
  NegativeVeryThinSpace: '\u200b',
  NegativeThinSpace: '\u200b',
  NegativeMediumSpace: '\u200b',
  NegativeThickSpace: '\u200b',
  zwnj: '\u200c',
  zwj: '\u200d',
  NoBreak: '\u2060',
};

/** A code point from entity digits, any number of leading zeros; out of range or a surrogate is U+FFFD. */
function codePoint(digits: string, radix: 16 | 10): string {
  const trimmed = digits.replace(/^0+/, '') || '0';
  if (trimmed.length > (radix === 16 ? 6 : 7)) return '\ufffd';
  const n = parseInt(trimmed, radix);
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
    ? String.fromCodePoint(n)
    : '\ufffd';
}

/** Decodes numeric entities (with or without the semicolon) and the named ones above; others stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]*);)/g,
    (whole, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
      if (hex !== undefined) return codePoint(hex, 16);
      if (dec !== undefined) return codePoint(dec, 10);
      return NAMED[name ?? ''] ?? whole;
    },
  );
}

/** C0 and C1 controls, stripped from attribute values after decoding. */
const stripControls = (text: string) =>
  Array.from(text)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && (code < 0x7f || code > 0x9f);
    })
    .join('');

const FORMAT = /^\p{Cf}$/u;
const LINE_BREAK = /^[\p{Zl}\p{Zp}]$/u;

/**
 * Invisible characters, one list for what is sent (here) and what comes back
 * (answer.ts): every format character (soft hyphen, zero-width characters,
 * bidi controls, the BOM and the rest of \p{Cf}), tag characters U+E0000 to
 * U+E007F, variation selectors, and the Hangul fillers. They could split a
 * token or hide text.
 */
export function isInvisible(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    FORMAT.test(ch) ||
    (code >= 0xe0000 && code <= 0xe007f) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef) ||
    code === 0x3164 ||
    code === 0x115f ||
    code === 0x1160 ||
    code === 0xad ||
    // Combining grapheme joiner and the halfwidth Hangul filler.
    code === 0x34f ||
    code === 0xffa0
  );
}

/** Line and paragraph separators (U+2028, U+2029). */
export const isLineSeparator = (ch: string) => LINE_BREAK.test(ch);

/**
 * Drops invisible characters and controls from text; tab, newline and
 * carriage return are whitespace and stay, and a line or paragraph separator
 * becomes a space.
 */
const stripInvisible = (text: string) =>
  Array.from(text)
    .map((ch) => {
      if (isInvisible(ch)) return '';
      if (isLineSeparator(ch)) return ' ';
      const code = ch.codePointAt(0) ?? 0;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return ch;
      return code > 0x1f && (code < 0x7f || code > 0x9f) ? ch : '';
    })
    .join('');

// An "&name;" this module does not decode passes through as written; every other & is escaped.
const escapeText = (text: string) =>
  text
    .replace(/&(?:([A-Za-z][A-Za-z0-9]*);)?/g, (whole, name: string | undefined) =>
      name !== undefined && !(name in NAMED) ? whole : `&amp;${whole.slice(1)}`,
    )
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const escapeAttr = (text: string) => escapeText(text).replace(/"/g, '&quot;');

// Text masks: visible text, every kept attribute value, selectors and plain-language text.

/** Scheme-prefixed user info ("https://user:pw@", "ftp:\\user@"); mailto: is left to the email mask. */
const USERINFO = /\b(?!mailto:)([a-z][a-z0-9+.-]*:[\\/]*)[^\s/\\?#"'<>@[\]]+@/gi;
/**
 * The authority of a URL. Browsers read any number of / or \ after a special
 * scheme ("https:example.com", "https:/\example.com"), so those take zero or
 * more; other schemes need two. A protocol-relative "//host" counts after any
 * character that cannot continue a path or a scheme.
 */
const SPECIAL_HOST = /\b((?:https?|wss?|ftp|file):[\\/]*)((?:\[redacted\]@)?)([^\s/\\?#"'<>]+)/gi;
const SCHEME_HOST = /\b([a-z][a-z0-9+.-]*:[\\/]{2})((?:\[redacted\]@)?)([^\s/\\?#"'<>]+)/gi;
const RELATIVE_HOST = /(^|[^\w:/\\])([\\/]{2})((?:\[redacted\]@)?)([^\s/\\?#"'<>]+)/g;
/** A query or fragment on any token with a "/" or "." before it. */
const PATH_QUERY = /([^\s?#"'<>]*[/.][^\s?#"'<>]*)([?#])([^\s"'<>]*)/g;
/** A parameter run: "?a=1" or "&a=1" and what follows. */
const PARAMS = /([?&])[\w.%-]+=[^\s"'<>]*/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const EMAIL = /[^\s@<>"'()[\]]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const TOKEN_RUN = /[A-Za-z0-9_\-+/=.]{24,}/g;
const NUMBER_RUN = /\+?\(?\d[\d ().-]{5,}\d|\d{9,}/g;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A run of 24 or more token characters with a digit and a letter, or mixed case. */
function tokenKind(run: string): RedactionKind | undefined {
  if (/^[0-9a-fA-F]+$/.test(run)) return 'hex-token';
  const hit = (/[A-Za-z]/.test(run) && /\d/.test(run)) || (/[a-z]/.test(run) && /[A-Z]/.test(run));
  return hit ? 'token' : undefined;
}

/** Whether a name (tag, attribute) is token-shaped. */
const tokenShaped = (name: string) =>
  [...name.matchAll(TOKEN_RUN)].some((m) => tokenKind(m[0]) !== undefined);

/**
 * A phone number (7 to 15 digits with a separator or a leading +), or a
 * number: an unbroken run of 9 or more digits, or 16 or more with separators.
 */
function numberKind(run: string): RedactionKind | undefined {
  if (DATE.test(run)) return undefined;
  const digits = run.replace(/\D/g, '').length;
  const separated = /[ ().+-]/.test(run);
  if (!separated) return digits >= 9 ? 'number' : undefined;
  if (digits >= 16) return 'number';
  if (digits >= 7) return digits >= 12 && !run.startsWith('+') ? 'number' : 'phone';
  return undefined;
}

/** The masks that need no URL shape: JWTs, emails, UUIDs, tokens and numbers. */
function maskShapes(text: string, counts: Counts, email = true): string {
  const hit = (kind: RedactionKind) => (count(counts, kind), mask(kind));
  return (email ? text.replace(EMAIL, () => hit('email')) : text)
    .replace(JWT, () => hit('jwt'))
    .replace(UUID, () => hit('uuid'))
    .replace(TOKEN_RUN, (run) => {
      const kind = tokenKind(run);
      return kind ? hit(kind) : run;
    })
    .replace(NUMBER_RUN, (run) => {
      const kind = numberKind(run);
      return kind ? hit(kind) : run;
    });
}

/** Masks user info, hosts, queries and fragments, JWTs, emails, UUIDs, tokens and numbers. */
export function redactText(text: string, counts: Counts): string {
  const host = (h: string) => (h === mask('host') ? h : (count(counts, 'host'), mask('host')));
  const urls = stripInvisible(text)
    .replace(USERINFO, (_, prefix: string) => (count(counts, 'userinfo'), `${prefix}${MASKED}@`))
    .replace(
      SPECIAL_HOST,
      (_, prefix: string, user: string, h: string) => `${prefix}${user}${host(h)}`,
    )
    .replace(
      SCHEME_HOST,
      (_, prefix: string, user: string, h: string) => `${prefix}${user}${host(h)}`,
    )
    .replace(
      RELATIVE_HOST,
      (_, lead: string, slashes: string, user: string, h: string) =>
        `${lead}${slashes}${user}${host(h)}`,
    )
    .replace(PATH_QUERY, (whole: string, base: string, mark: string, rest: string) => {
      if (rest === MASKED) return whole;
      count(counts, mark === '?' ? 'query-string' : 'fragment');
      return `${base}${mark}${MASKED}`;
    })
    .replace(PARAMS, (_, mark: string) => (count(counts, 'query-string'), `${mark}${MASKED}`));
  return maskShapes(urls, counts);
}

/** Selector delimiters outside attribute brackets. */
const SELECTOR_DELIMITERS = /([.#>+~:(),\s]+)/;

/**
 * Selector text outside attribute brackets: emails over the whole text, then
 * tokens and numbers per part between delimiters, so a class list is judged
 * one class at a time. No path, query or host rule: a selector is not a URL.
 */
function redactSelectorText(text: string, counts: Counts): string {
  const withEmails = stripInvisible(text).replace(
    EMAIL,
    () => (count(counts, 'email'), mask('email')),
  );
  return withEmails
    .split(SELECTOR_DELIMITERS)
    .map((part, i) =>
      i % 2 === 1 || part.startsWith('[redacted') ? part : maskShapes(part, counts, false),
    )
    .join('');
}

// URLs.

/** A same-page link to an id: kept so a skip link's target stays visible. */
const ID_FRAGMENT = /^#[A-Za-z][\w-]*$/;

function percentDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * A URL attribute value: data:, javascript: and contact URLs are replaced
 * whole; otherwise the value is percent-decoded, everything from the first ?
 * or # is masked (an id-shaped same-page fragment excepted), and the rest goes
 * through the text masks, which replace the host and mask user info.
 */
export function maskUrl(raw: string, counts: Counts): string {
  const url = stripControls(raw).trim();
  if (/^data:/i.test(url)) return (count(counts, 'data-url'), mask('data-url'));
  if (/^(?:java|vb)script:/i.test(url)) return (count(counts, 'script-url'), mask('script-url'));
  if (/^(?:tel|sms|mailto|callto):/i.test(url))
    return (count(counts, 'contact-url'), mask('contact-url'));
  let out = stripControls(percentDecode(url));
  if (ID_FRAGMENT.test(out) && !tokenShaped(out)) return out;
  const mark = out.search(/[?#]/);
  if (mark >= 0) {
    count(counts, out[mark] === '?' ? 'query-string' : 'fragment');
    out = `${out.slice(0, mark + 1)}${MASKED}`;
  }
  return maskLongSegments(redactText(out, counts), counts);
}

/** A path segment this long is masked even in one case: an id or a key in a path, not a word. */
export const LONG_SEGMENT = 24;

/**
 * The URL with every path segment of LONG_SEGMENT or more path characters masked. It runs
 * after the text masks, so a host or query is already masked; a segment holding a mask, a
 * colon or an @ (a scheme, a host, user info) is never a plain path segment and stays.
 */
function maskLongSegments(url: string, counts: Counts): string {
  return url
    .split(/([\\/])/)
    .map((part) =>
      part.length >= LONG_SEGMENT && /^[A-Za-z0-9._~%+=-]+$/.test(part)
        ? (count(counts, 'path-segment'), mask('path-segment'))
        : part,
    )
    .join('');
}

function maskSrcset(raw: string, counts: Counts): string {
  if (/data:/i.test(raw)) return (count(counts, 'data-url'), mask('data-url'));
  return raw
    .split(',')
    .map((candidate) => {
      const [url = '', ...descriptors] = candidate.trim().split(/\s+/);
      return [maskUrl(url, counts), ...descriptors.map((d) => redactText(d, counts))].join(' ');
    })
    .join(', ');
}

// Attributes.

const KEEP = new Set([
  'id',
  'class',
  'role',
  'alt',
  'title',
  'for',
  'type',
  'lang',
  'xml:lang',
  'dir',
  'name',
  'placeholder',
  'autocomplete',
  'tabindex',
  'scope',
  'headers',
  'colspan',
  'rowspan',
  'label',
  'width',
  'height',
  'hidden',
  'disabled',
  'required',
  'readonly',
  'checked',
  'selected',
  'multiple',
  'accesskey',
  'summary',
  'abbr',
  'rel',
  'target',
  'inert',
  'open',
  'focusable',
  'media',
  'sizes',
]);
const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'cite',
  'longdesc',
  'data',
  'background',
  'xlink:href',
  // meta refresh carries a URL; meta viewport has no ? or # and passes unchanged.
  'content',
]);
const LOOKS_LIKE_URL = /^\s*(?:[a-z][a-z0-9+.-]*:|\/|\.{1,2}\/|[^\s]*[?#])/i;

/** Whether an attribute holds a URL: the URL attributes, srcset, and data-* values shaped like one. */
const isUrlAttribute = (name: string, value: string) =>
  URL_ATTRS.has(name) ||
  name === 'srcset' ||
  (name.startsWith('data-') && LOOKS_LIKE_URL.test(value));

/** The attribute as sent, or the kind it was dropped as. The value is already entity-decoded. */
export function redactAttribute(
  name: string,
  value: string,
  counts: Counts,
): { value: string } | { drop: RedactionKind } {
  const n = name.toLowerCase();
  if (tokenShaped(n)) return { drop: 'attribute' };
  if (n === 'value') return { drop: 'value' };
  if (n.startsWith('on')) return { drop: 'event-handler' };
  if (n === 'style') return { drop: 'style' };
  // A data-* or aria-* name that says it holds a credential (aria-keyshortcuts is a real one).
  if (
    (n.startsWith('data-') || n.startsWith('aria-')) &&
    n !== 'aria-keyshortcuts' &&
    CREDENTIAL_NAME.test(n)
  )
    return { drop: 'credential-attribute' };
  const clean = stripControls(value);
  if (n === 'srcset') return { value: maskSrcset(clean, counts) };
  if (URL_ATTRS.has(n)) return { value: maskUrl(clean, counts) };
  if (n.startsWith('data-')) {
    if (/[{[]/.test(clean)) return { drop: 'data-json' };
    return {
      value: LOOKS_LIKE_URL.test(clean) ? maskUrl(clean, counts) : redactText(clean, counts),
    };
  }
  if (KEEP.has(n) || n.startsWith('aria-')) return { value: redactText(clean, counts) };
  return { drop: 'attribute' };
}

// Fields whose text is a secret or personal data.

const SENSITIVE_AUTOCOMPLETE =
  /^(?:username|current-password|new-password|one-time-code|webauthn|cc-[a-z-]+)$/;
const sensitiveField = (attrs: ReadonlyMap<string, string>) =>
  /^(?:hidden|password)$/i.test(attrs.get('type') ?? '') ||
  (attrs.get('autocomplete') ?? '')
    .toLowerCase()
    .split(/\s+/)
    .some((t) => SENSITIVE_AUTOCOMPLETE.test(t));

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
/** Raw text bodies: dropped with the kind given. textarea holds a field value. */
const RAW: Record<string, RedactionKind> = {
  script: 'script-body',
  style: 'style-body',
  textarea: 'field',
  xmp: 'unparsed',
  iframe: 'unparsed',
  noembed: 'unparsed',
  noframes: 'unparsed',
};

const TAG_NAME = /^[A-Za-z][A-Za-z0-9:-]*/;
const ATTR_NAME = /^[^\s"'>/=<`]+/;

/** Cuts to at most max UTF-16 code units without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

interface StartTag {
  /** Where parsing stopped: after the tag, or at the end of the input. */
  end: number;
  /** closed: ended with > or />; cut: ran into the end of the input; malformed: anything else. */
  state: 'closed' | 'cut' | 'malformed';
  selfClosing: boolean;
  /** Completed attributes, redacted and ready to emit. */
  attrs: string[];
  /** Decoded values of completed attributes, first occurrence of each name. */
  seen: Map<string, string>;
  /** Every completed attribute in order, duplicates included, with its decoded value (undefined when it has none). */
  all: [name: string, value: string | undefined][];
  counts: Counts;
}

/** Parses the attributes of a start tag from position j (just after its name). */
function parseStartTag(html: string, j: number): StartTag {
  const tag: StartTag = {
    end: j,
    state: 'malformed',
    selfClosing: false,
    attrs: [],
    seen: new Map(),
    all: [],
    counts: new Map(),
  };
  const space = () => {
    while (j < html.length && /\s/.test(html[j] ?? '')) j++;
  };
  const finish = (state: StartTag['state']) => ((tag.state = state), (tag.end = j), tag);
  for (;;) {
    space();
    if (j >= html.length) return finish('cut');
    const c = html[j];
    if (c === '>') return (j++, finish('closed'));
    if (c === '/') {
      if (html[j + 1] === '>') return ((tag.selfClosing = true), (j += 2), finish('closed'));
      j++;
      continue;
    }
    const attr = ATTR_NAME.exec(html.slice(j));
    if (!attr) return finish('malformed');
    const key = attr[0].toLowerCase();
    let k = j + attr[0].length;
    while (k < html.length && /\s/.test(html[k] ?? '')) k++;
    let value: string | undefined;
    if (html[k] === '=') {
      k++;
      while (k < html.length && /\s/.test(html[k] ?? '')) k++;
      if (k >= html.length) return finish('cut');
      const q = html[k];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, k + 1);
        // The value runs into the end of the input: a cut, never emitted.
        if (close < 0) return finish('cut');
        value = html.slice(k + 1, close);
        k = close + 1;
      } else {
        const m = /^[^\s>]+/.exec(html.slice(k)) ?? [''];
        value = m[0];
        k += value.length;
        if (k >= html.length) return finish('cut');
      }
    } else if (k >= html.length) return finish('cut');
    else k = j + attr[0].length;
    j = k;
    tag.all.push([key, value === undefined ? undefined : decodeEntities(value)]);
    // Browsers keep the first of two attributes with one name.
    if (tag.seen.has(key)) continue;
    const decoded = decodeEntities(value ?? '');
    tag.seen.set(key, decoded);
    const kept = redactAttribute(key, decoded, tag.counts);
    if ('drop' in kept) count(tag.counts, kept.drop);
    else tag.attrs.push(value === undefined ? key : `${key}="${escapeAttr(kept.value)}"`);
  }
}

/** Drops the last word before the engine's cut marker: it may be part of a cut token or value. */
function dropCutWord(html: string, counts: Counts): string {
  if (!html.endsWith(ENGINE_CUT)) return html;
  count(counts, 'truncated');
  // A lone "<" left at the end would only turn into a stray "&lt;".
  return html
    .slice(0, -ENGINE_CUT.length)
    .replace(/[^\s<>]*$/, '')
    .replace(/<$/, '');
}

/** Redacts one element snippet; see the module comment. Never throws. */
export function redactSnippet(snippet: string): Redacted {
  const counts: Counts = new Map();
  const html = dropCutWord(snippet, counts);
  let out = '';
  let i = 0;
  // An open sensitive field: its tag name and how deep the same name nests inside it.
  let field: { name: string; depth: number } | undefined;

  /** Drops everything from here on as unparsed. */
  const giveUp = () => {
    count(counts, 'unparsed');
    i = html.length;
  };

  const text = (raw: string) => {
    if (!raw) return;
    if (field) {
      if (raw.trim()) {
        count(counts, 'field');
        out += mask('field');
      } else out += raw;
      return;
    }
    out += escapeText(redactText(decodeEntities(raw), counts));
  };

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    text(html.slice(i, lt));
    i = lt;
    const rest = html.slice(i);

    if (rest.startsWith('<!--')) {
      const end = html.indexOf('-->', i + 4);
      if (end < 0) giveUp();
      else {
        count(counts, 'comment');
        i = end + 3;
      }
      continue;
    }
    if (rest.startsWith('<![CDATA[')) {
      const end = html.indexOf(']]>', i);
      count(counts, 'unparsed');
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (rest.startsWith('<!') || rest.startsWith('<?')) {
      const end = html.indexOf('>', i);
      count(counts, 'unparsed');
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (rest.startsWith('</')) {
      const m = /^<\/([A-Za-z][A-Za-z0-9:-]*)\s*>/.exec(rest);
      if (!m || tokenShaped(m[1] ?? '')) {
        giveUp();
        continue;
      }
      const name = m[1] ?? '';
      if (field && field.name === name.toLowerCase() && --field.depth === 0) field = undefined;
      out += `</${name}>`;
      i += m[0].length;
      continue;
    }
    const nameMatch = TAG_NAME.exec(rest.slice(1));
    if (!nameMatch) {
      // A lone "<" is text.
      text('<');
      i += 1;
      continue;
    }

    // A start tag. Its redaction counts are kept only if it is emitted.
    const name = nameMatch[0];
    if (tokenShaped(name)) {
      giveUp();
      continue;
    }
    const lower = name.toLowerCase();
    const tag = parseStartTag(html, i + 1 + name.length);
    if (tag.state === 'malformed') {
      giveUp();
      continue;
    }
    merge(counts, tag.counts);
    const attrs = tag.attrs.map((a) => ` ${a}`).join('');
    if (tag.state === 'cut') {
      // Cut by the end of the input: the completed attributes only.
      if (/\S/.test(html.slice(tag.end))) count(counts, 'unparsed');
      out += `<${name}${attrs}>`;
      break;
    }
    out += `<${name}${attrs}${tag.selfClosing ? ' />' : '>'}`;
    i = tag.end;
    if (tag.selfClosing || VOID.has(lower)) continue;

    const raw = RAW[lower];
    if (raw) {
      const close = new RegExp(`</${lower}[\\s/>]`, 'i').exec(html.slice(i));
      const body = close ? html.slice(i, i + close.index) : html.slice(i);
      if (body.trim()) {
        count(counts, raw);
        if (raw === 'field') out += mask('field');
      }
      if (!close) break;
      i += close.index;
      continue;
    }
    if (field) {
      if (field.name === lower) field.depth++;
    } else if (sensitiveField(tag.seen)) field = { name: lower, depth: 1 };
  }

  if (out.length > SENT_SNIPPET_MAX) {
    out = cut(out, SENT_SNIPPET_MAX);
    count(counts, 'truncated');
  }
  return { html: out, redactions: toRedactions(counts) };
}

/** Raw text and escapable raw text elements, plus noscript and plaintext: their bodies are rescanned in check mode. */
const CHECK_RAW = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'noembed',
  'noframes',
  'iframe',
  'noscript',
  'plaintext',
]);

/** One start tag as markup holds it: its name and every attribute, decoded, duplicates included. */
export interface MarkupTag {
  name: string;
  attrs: [name: string, value: string | undefined][];
}

/**
 * Reads markup with the same tokenizer as redactSnippet, without changing
 * it: every start tag with its attributes. complete is false when any part
 * could not be followed (a malformed or cut tag, an unterminated comment,
 * CDATA, a doctype or processing instruction, a raw text body with no end
 * tag); a caller checking untrusted markup refuses it then.
 *
 * check: true is for markup that must never hide anything from the check
 * (a provider's patch). A browser's parser and this tokenizer disagree on
 * comments ("<!-->") and on raw text bodies inside foreign content
 * ("<svg><textarea>"), so in that mode any comment makes the markup
 * incomplete, and a raw text body is scanned as markup like the rest, its
 * end tag still required. Refusing too much is the safe side.
 */
export function scanMarkup(
  html: string,
  options: { check?: boolean } = {},
): { complete: boolean; tags: MarkupTag[] } {
  const tags: MarkupTag[] = [];
  let i = 0;
  const incomplete = () => ({ complete: false, tags });
  const check = options.check === true;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    const rest = html.slice(i);
    if (rest.startsWith('<!--')) {
      const end = html.indexOf('-->', i + 4);
      if (end < 0 || check) return incomplete();
      i = end + 3;
      continue;
    }
    if (rest.startsWith('<!') || rest.startsWith('<?')) return incomplete();
    if (rest.startsWith('</')) {
      const m = /^<\/([A-Za-z][A-Za-z0-9:-]*)\s*>/.exec(rest);
      if (!m) return incomplete();
      i += m[0].length;
      continue;
    }
    const nameMatch = TAG_NAME.exec(rest.slice(1));
    if (!nameMatch) {
      i += 1;
      continue;
    }
    const name = nameMatch[0];
    const tag = parseStartTag(html, i + 1 + name.length);
    if (tag.state !== 'closed') return incomplete();
    const lower = name.toLowerCase();
    tags.push({ name: lower, attrs: tag.all });
    i = tag.end;
    if (tag.selfClosing || VOID.has(lower)) continue;
    const raw = check ? CHECK_RAW.has(lower) : RAW[lower] !== undefined;
    if (!raw) continue;
    const close = new RegExp(`</${lower}[\\s/>]`, 'i').exec(html.slice(i));
    if (!close) return incomplete();
    // Check mode reads the body as markup too; the default skips it, as redactSnippet does.
    if (!check) i += close.index;
  }
  return { complete: true, tags };
}

// Selectors.

const ATTR_SELECTOR =
  /\[\s*([^\s~|^$*!=\]"'\\]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]"'\\]+))\s*([iIsS])?\s*)?\]/g;
/** Outside attribute selectors: a bracket, quote or escape means the selector was not understood. */
const UNBALANCED = /[[\]"'\\]/;

/**
 * Redacts a selector: attribute values go through the same policy as in a
 * snippet (a dropped attribute keeps its name, its value is masked; a URL
 * attribute matched by prefix, suffix or substring is masked whole), the rest
 * through the text masks. A token-shaped attribute name drops the attribute
 * selector. A backslash escape or an unbalanced bracket or quote masks the
 * value, or the whole selector, as unparsed.
 */
export function redactSelector(selector: string, counts: Counts): string {
  // Counted locally, so a selector given up as unparsed records only that.
  const local: Counts = new Map();
  const unparsed = () => (count(counts, 'unparsed'), mask('unparsed'));
  let out = '';
  let last = 0;
  for (const m of selector.matchAll(ATTR_SELECTOR)) {
    const between = selector.slice(last, m.index);
    if (UNBALANCED.test(between)) return unparsed();
    out += redactSelectorText(between, local);
    last = m.index + m[0].length;
    const [, name = '', op, dq, sq, bare, flag] = m;
    if (tokenShaped(name)) {
      count(local, 'attribute');
      continue;
    }
    if (op === undefined) {
      out += `[${name}]`;
      continue;
    }
    const raw = dq ?? sq ?? bare ?? '';
    const lower = name.toLowerCase();
    let value: string;
    if (raw.includes('\\')) value = (count(local, 'unparsed'), mask('unparsed'));
    else if (op !== '=' && isUrlAttribute(lower, raw)) value = (count(local, 'url'), mask('url'));
    else {
      const kept = redactAttribute(lower, decodeEntities(raw), local);
      value = 'drop' in kept ? (count(local, kept.drop), mask(kept.drop)) : kept.value;
    }
    out += `[${name}${op}"${value.replace(/"/g, '\\"')}"${flag ? ` ${flag}` : ''}]`;
  }
  const tail = selector.slice(last);
  if (UNBALANCED.test(tail)) return unparsed();
  out += redactSelectorText(tail, local);
  merge(counts, local);
  return out;
}
