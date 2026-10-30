import { z } from 'zod';
import { PdfStepsSchema, SuggestionSchema, WebPatchSchema, type Suggestion } from './model.js';
import {
  decodeEntities,
  isInvisible,
  isLineSeparator,
  scanMarkup,
  type MarkupTag,
} from './redact.js';

/*
 * What comes back is untrusted too (Review Focus 1). parseAnswer accepts only
 * JSON that matches SuggestionSchema after every string is stripped of
 * controls and invisible characters, with no prototype keys. It refuses a
 * patch that the snippet tokenizer cannot fully read, that carries unsafe
 * markup, or that points a URL attribute anywhere but a relative path, an id
 * fragment or a URL the request snippet already had; and any link, web
 * address or email address in the prose fields. Nothing it returns is run,
 * applied, fetched or linked.
 */

/** Longest answer read, in UTF-8 bytes, checked before JSON.parse. */
export const ANSWER_MAX_BYTES = 64 * 1024;

export type ParsedAnswer = { ok: true; suggestion: Suggestion } | { ok: false; reason: string };

const UNSAFE = 'unsafe markup in the suggestion';
const LINK = 'the suggestion contained a link';
const NO_MATCH = 'the answer does not match the schema';

// Strings.

/** Every key either answer kind may carry; anything else fails the strict schema. */
const ANSWER_KEYS = new Set(['kind', 'summary', 'patch', 'notes', 'tool', 'steps']);
/** Keys that could reach an object prototype; refused at any depth. */
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Fields that may hold several lines; every other string is one line. */
const MULTI_LINE = new Set(['patch', 'notes']);

/**
 * Drops C0 controls, DEL, C1 controls and every invisible character (the
 * list redact.ts uses). A multi-line field keeps \n (\r\n becomes \n) and
 * turns a line or paragraph separator into \n; a one-line field turns \n and
 * the separators into a space. A tab becomes a space in both.
 */
function clean(text: string, multiLine: boolean): string {
  let out = '';
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a || isLineSeparator(ch)) out += multiLine ? '\n' : ' ';
    else if (code === 0x09) out += ' ';
    else if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || isInvisible(ch)) continue;
    else out += ch;
  }
  return multiLine ? out : out.replace(/ {2,}/g, ' ').trim();
}

/**
 * The answer with every string cleaned and null fields dropped (strict output
 * sends null for an absent optional field), built on a null prototype from
 * the answer keys only. An unknown key gives undefined: the strict schema
 * would refuse it.
 */
function cleanAnswer(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value)) {
    if (!ANSWER_KEYS.has(key)) return undefined;
    const v = value[key];
    if (v === null) continue;
    const multi = MULTI_LINE.has(key);
    if (typeof v === 'string') out[key] = clean(v, multi);
    else if (Array.isArray(v))
      out[key] = v.map((x) => (typeof x === 'string' ? clean(x, multi) : x));
    else out[key] = v;
  }
  return out;
}

/** Deepest nesting of objects and arrays an answer may have; a real answer has 2. */
export const ANSWER_MAX_DEPTH = 32;

/**
 * JSON.parse that also reports an own __proto__, constructor or prototype key
 * at any depth, and nesting past ANSWER_MAX_DEPTH. The reviver runs children
 * first, so each object's depth is one more than its deepest child's.
 */
function parseJson(raw: string): { value: unknown; refused: boolean } {
  let refused = false;
  const depths = new WeakMap<object, number>();
  const value: unknown = JSON.parse(raw, (key, v: unknown) => {
    if (PROTOTYPE_KEYS.has(key)) refused = true;
    if (typeof v === 'object' && v !== null) {
      let depth = 1;
      for (const child of Object.values(v))
        if (typeof child === 'object' && child !== null)
          depth = Math.max(depth, (depths.get(child) ?? 1) + 1);
      depths.set(v, depth);
      if (depth > ANSWER_MAX_DEPTH) refused = true;
    }
    return v;
  });
  return { value, refused };
}

// The patch.

/** Tags an accessibility fix never needs and that can run code, load content or restyle the page. */
const UNSAFE_TAG_NAMES = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'portal',
  'link',
  'meta',
  'base',
  'animate',
  'set',
  'animatemotion',
  'animatetransform',
]);
/** Attributes that hold one or more URLs. */
const URL_ATTRIBUTES = new Set([
  'href',
  'src',
  'srcset',
  'action',
  'formaction',
  'xlink:href',
  'poster',
  'data',
  'ping',
  'background',
  'cite',
  'codebase',
  'manifest',
  'longdesc',
  'usemap',
  'lowsrc',
  'dynsrc',
  'icon',
  'archive',
  'classid',
]);

/** Decoded, lower case, with every whitespace character removed: a scheme cannot hide behind spacing or entities. */
const squash = (text: string) => decodeEntities(text).toLowerCase().replace(/\s+/g, '');

// Belt and braces over the tokenizer: the same names anywhere in the decoded text.
const UNSAFE_TAGS =
  /<\s*(?:script|style|iframe|frame|frameset|object|embed|applet|portal|link|meta|base|animate|set|animatemotion|animatetransform)\b/;
const HANDLER = /\bon[a-z]+\s*=/;
const SRCDOC = /\bsrcdoc\s*=/;
/**
 * An attribute-shaped URL with a scheme or a host, over the decoded and
 * squashed patch, wherever the tokenizer saw it or not. Group 1 is the value
 * from the start of the URL to the next quote, space or >.
 */
const ATTRIBUTE_URL =
  /\b(?:href|src|srcset|action|formaction|xlink:href|poster|data|ping|background|cite)=["']?((?:[a-z][a-z0-9+.-]*:|\/\/|\\\\|\/\\|\\\/)[^"'\s>]*)/g;

/** The URLs one attribute value holds: srcset candidates, ping and archive lists, else the value. */
function urlsOf(name: string, value: string): string[] {
  if (name === 'srcset') return value.split(',').map((c) => c.trim().split(/\s+/)[0] ?? '');
  if (name === 'ping' || name === 'archive') return value.split(/[\s,]+/);
  return [value];
}

const urlValues = (tags: MarkupTag[]) =>
  new Set(
    tags.flatMap((t) =>
      t.attrs
        .filter(([n, v]) => URL_ATTRIBUTES.has(n) && v !== undefined)
        .flatMap(([n, v]) => urlsOf(n, v ?? '').map((u) => u.trim())),
    ),
  );

const styleValues = (tags: MarkupTag[]) =>
  new Set(tags.flatMap((t) => t.attrs.filter(([n]) => n === 'style').map(([, v]) => v ?? '')));

/** Whitespace, controls and invisible characters removed, as a browser reads a URL's scheme. */
const bareUrl = (url: string) =>
  Array.from(url)
    .filter((ch) => !/\s/.test(ch) && !isInvisible(ch) && (ch.codePointAt(0) ?? 0) > 0x1f)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x7f || code > 0x9f;
    })
    .join('');

/** A relative path, an id-shaped fragment, or a URL the request snippet already had. */
function allowedUrl(url: string, known: ReadonlySet<string>): boolean {
  if (known.has(url.trim())) return true;
  const bare = bareUrl(url);
  if (/^#[A-Za-z][\w-]*$/.test(bare)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(bare)) return false;
  if (/^(?:\/\/|\\\\|\/\\|\\\/)/.test(bare)) return false;
  // A relative URL carrying an absolute one ("/redirect?to=https://...") is a link too.
  return !bare.includes('://') && !bare.includes(':\\');
}

/** Why a patch is refused, if it is: unsafe markup first, then a link. */
function patchProblem(patch: string, snippet: string | undefined): string | undefined {
  const scan = scanMarkup(patch, { check: true });
  if (!scan.complete) return UNSAFE;
  const decoded = decodeEntities(patch).toLowerCase();
  const squashed = squash(patch);
  if (
    UNSAFE_TAGS.test(decoded) ||
    HANDLER.test(decoded) ||
    SRCDOC.test(decoded) ||
    squashed.includes('javascript:') ||
    squashed.includes('vbscript:') ||
    squashed.includes('data:text/html')
  )
    return UNSAFE;
  const original = scanMarkup(snippet ?? '').tags;
  const styles = styleValues(original);
  for (const tag of scan.tags) {
    if (UNSAFE_TAG_NAMES.has(tag.name)) return UNSAFE;
    for (const [name, value] of tag.attrs) {
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') return UNSAFE;
      // xml:base changes how every other URL in the element resolves, so no value of it is safe.
      if (name === 'xml:base') return UNSAFE;
      if (tag.name === 'form' && name === 'action') return UNSAFE;
      // The redacted snippet never carries style, so in practice no style attribute is kept.
      if (name === 'style' && !styles.has(value ?? '')) return UNSAFE;
      // CSS that loads a resource (cursor, filter, fill, mask) in any attribute.
      if (value !== undefined && squash(value).includes('url(')) return UNSAFE;
    }
  }
  const known = urlValues(original);
  for (const tag of scan.tags)
    for (const [name, value] of tag.attrs)
      if (URL_ATTRIBUTES.has(name) && value !== undefined)
        if (urlsOf(name, value).some((u) => !allowedUrl(u, known))) return LINK;
  const knownSquashed = new Set([...known].map(squash));
  for (const m of squashed.matchAll(ATTRIBUTE_URL)) if (!knownSquashed.has(m[1] ?? '')) return LINK;
  return undefined;
}

// The prose fields.

/** File extensions a step or note may name ("index.html", "report.docx") without it reading as a host. */
const FILE_EXTENSIONS = new Set([
  'html',
  'htm',
  'css',
  'js',
  'ts',
  'tsx',
  'jsx',
  'json',
  'pdf',
  'docx',
  'doc',
  'indd',
  'idml',
  'xml',
  'svg',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'txt',
]);

const EMAIL_SHAPE = /[^\s@<>"'()]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/u;
const AUTOLINK = /<[a-z][a-z0-9+.-]*:[^>\s]*>/;
const SCHEME = /[a-z][a-z0-9+.-]*:[\\/]+/;
const IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.]*\d)/;
/** Dotted labels of letters and digits ending in a 2 to 24 letter label or an xn-- label, in any script. */
const DOTTED_HOST =
  /(?<![\p{L}\p{N}-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(\p{L}{2,24}|xn--[a-z0-9-]+)(?![\p{L}\p{N}])/gu;
/** A single-backtick code span on one line. */
const CODE_SPAN = /`[^`\n]*`/g;

/**
 * A link, web address or email address in prose. Text is NFKC-normalized and
 * the ideographic and fullwidth full stops read as dots before any check. A
 * file name with a known extension is not a host, and neither is a dotted
 * name inside a backtick code span (`document.title`, `ASP.NET`) unless a
 * "/" follows it; every other rule applies inside code spans too.
 */
function proseLink(text: string): boolean {
  const t = decodeEntities(text)
    .normalize('NFKC')
    .replace(/[\u3002\uff0e\uff61]/g, '.')
    .toLowerCase();
  if (
    t.includes('www.') ||
    t.includes('//') ||
    t.includes('](') ||
    AUTOLINK.test(t) ||
    SCHEME.test(t) ||
    /https?:\/\//.test(t.replace(/\s+/g, '')) ||
    EMAIL_SHAPE.test(t) ||
    IPV4.test(t)
  )
    return true;
  // A dotted name followed by "/" is a host with a path, inside a code span or not.
  for (const m of t.matchAll(DOTTED_HOST)) if (t[m.index + m[0].length] === '/') return true;
  const prose = t.replace(CODE_SPAN, ' ');
  for (const m of prose.matchAll(DOTTED_HOST)) if (!FILE_EXTENSIONS.has(m[1] ?? '')) return true;
  return false;
}

/**
 * Parses one provider answer for one request. The snippet is the request's
 * redacted snippet, the only source of URLs and style values a patch may keep.
 */
export function parseAnswer(raw: string, assetKind: 'web' | 'pdf', snippet?: string): ParsedAnswer {
  if (Buffer.byteLength(raw, 'utf8') > ANSWER_MAX_BYTES)
    return { ok: false, reason: 'the answer is too long' };
  let parsedJson: { value: unknown; refused: boolean };
  try {
    parsedJson = parseJson(raw);
  } catch (e) {
    // Nesting deep enough to exhaust the stack is a shape problem, not a syntax one.
    if (e instanceof RangeError) return { ok: false, reason: NO_MATCH };
    return { ok: false, reason: 'the answer is not JSON' };
  }
  const { value, refused } = parsedJson;
  if (refused || typeof value !== 'object' || value === null || Array.isArray(value))
    return { ok: false, reason: NO_MATCH };
  const cleaned = cleanAnswer(value as Record<string, unknown>);
  const parsed = cleaned && SuggestionSchema.safeParse(cleaned);
  if (!parsed?.success) return { ok: false, reason: NO_MATCH };
  const suggestion = parsed.data;
  const expected = assetKind === 'web' ? 'web-patch' : 'pdf-steps';
  if (suggestion.kind !== expected)
    return { ok: false, reason: `a ${suggestion.kind} answer for a ${assetKind} finding` };
  const prose =
    suggestion.kind === 'web-patch'
      ? [suggestion.summary, suggestion.notes ?? '']
      : [suggestion.summary, ...suggestion.steps];
  if (suggestion.kind === 'web-patch') {
    const problem = patchProblem(suggestion.patch, snippet);
    if (problem) return { ok: false, reason: problem };
  }
  if (prose.some(proseLink)) return { ok: false, reason: LINK };
  return { ok: true, suggestion };
}

// The answer schema for provider structured output.

type JsonSchema = Record<string, unknown>;

/** Keywords both strict modes accept; everything else (lengths, maxItems, $schema) is enforced by parseAnswer instead. */
const KEPT = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
]);

/**
 * The strict structured-output form of a generated JSON Schema: only the
 * keywords in KEPT, minItems only when 0 or 1, every object closed, and every
 * property required, an optional one as "anyOf: [its schema, null]".
 */
export function toProviderSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'minItems' && (value === 0 || value === 1)) out[key] = value;
    if (!KEPT.has(key)) continue;
    if (key === 'properties') {
      const required = new Set((schema.required as string[] | undefined) ?? []);
      const props: JsonSchema = {};
      for (const [name, prop] of Object.entries(value as Record<string, JsonSchema>)) {
        const strict = toProviderSchema(prop);
        props[name] = required.has(name) ? strict : { anyOf: [strict, { type: 'null' }] };
      }
      out.properties = props;
      out.required = Object.keys(props);
    } else if (key === 'required') continue;
    else if (key === 'items') out.items = toProviderSchema(value as JsonSchema);
    else if (key === 'anyOf') out.anyOf = (value as JsonSchema[]).map(toProviderSchema);
    else out[key] = value;
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

/**
 * One answer schema per asset kind, each generated from its SuggestionSchema
 * member. Both providers need an object at the root, and SuggestionSchema is a
 * union, so one schema for both kinds cannot be strict; the kind check in
 * parseAnswer would refuse the other member anyway.
 */
export const ANSWER_JSON_SCHEMAS = {
  web: toProviderSchema(z.toJSONSchema(WebPatchSchema)),
  pdf: toProviderSchema(z.toJSONSchema(PdfStepsSchema)),
} as const;

/**
 * The OpenAI strict form of an answer schema: every const as a one-value
 * enum, and no count or length keyword (minItems is the only one left after
 * toProviderSchema). The installed SDK documents only that strict mode takes
 * "a subset of JSON Schema"; enum is in every published form of that subset,
 * and parseAnswer enforces every count and length the schema drops.
 */
export function toOpenAiSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'const') out.enum = [value];
    else if (key === 'minItems') continue;
    else if (key === 'properties')
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, JsonSchema>).map(([k, v]) => [k, toOpenAiSchema(v)]),
      );
    else if (key === 'items') out.items = toOpenAiSchema(value as JsonSchema);
    else if (key === 'anyOf') out.anyOf = (value as JsonSchema[]).map(toOpenAiSchema);
    else out[key] = value;
  }
  return out;
}
