/*
 * A tiny XML 1.0 reader for the JUnit and DOCX tests (no dependency): the
 * declaration (standalone allowed), comments, elements (prefixed names kept as
 * written, for example w:p) with double-quoted attributes, self-closing tags,
 * text and the five predefined entities plus numeric references. It throws on
 * anything that is not well formed in that subset: a character anywhere in the
 * document that is outside the XML 1.0 Char production (U+FFFE, U+FFFF, a lone
 * surrogate, a C0 control but tab and line breaks), a stray "<" or "&", an
 * unknown entity, a reference to a character XML 1.0 does not allow, a
 * mismatched end tag, a repeated attribute, or text outside the root.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const NAME = /^[A-Za-z_][\w.:-]*/;
const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const xmlChar = (c: number) =>
  c === 0x9 ||
  c === 0xa ||
  c === 0xd ||
  (c >= 0x20 && c <= 0xd7ff) ||
  (c >= 0xe000 && c <= 0xfffd) ||
  (c >= 0x10000 && c <= 0x10ffff);

function decode(raw: string): string {
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    if (!xmlChar(c)) throw new Error(`character U+${c.toString(16)} is not allowed in XML 1.0`);
  }
  if (raw.includes('<')) throw new Error('a "<" in text or an attribute');
  return raw.replace(/&([^;]*);|&/g, (whole, ref: string | undefined) => {
    if (ref === undefined) throw new Error('a bare "&"');
    if (ref.startsWith('#')) {
      const c = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isInteger(c) || !xmlChar(c)) throw new Error(`bad character reference ${whole}`);
      return String.fromCodePoint(c);
    }
    const v = ENTITY[ref];
    if (v === undefined) throw new Error(`unknown entity ${whole}`);
    return v;
  });
}

export function parseXml(text: string): XmlElement {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (!xmlChar(c)) throw new Error(`character U+${c.toString(16)} is not allowed in XML 1.0`);
  }
  let at = 0;
  const skip = (re: RegExp) => {
    const m = re.exec(text.slice(at));
    if (m?.index === 0) at += m[0].length;
    return m?.index === 0;
  };
  const misc = () => {
    for (;;) {
      skip(/^\s+/);
      if (text.startsWith('<!--', at)) {
        const end = text.indexOf('-->', at + 4);
        if (end < 0 || text.slice(at + 4, end).includes('--')) throw new Error('bad comment');
        at = end + 3;
      } else return;
    }
  };
  const element = (): XmlElement => {
    if (text[at] !== '<') throw new Error(`expected an element at ${at}`);
    at++;
    const name = NAME.exec(text.slice(at))?.[0];
    if (!name) throw new Error(`bad element name at ${at}`);
    at += name.length;
    const el: XmlElement = { name, attrs: {}, children: [], text: '' };
    for (;;) {
      const spaced = skip(/^\s+/);
      if (text.startsWith('/>', at)) {
        at += 2;
        return el;
      }
      if (text[at] === '>') {
        at++;
        break;
      }
      const attr = /^([A-Za-z_][\w.:-]*)="([^"]*)"/.exec(text.slice(at));
      if (!attr || !spaced) throw new Error(`bad attribute at ${at}`);
      const [whole, key = '', value = ''] = attr;
      if (key in el.attrs) throw new Error(`repeated attribute ${key}`);
      el.attrs[key] = decode(value);
      at += whole.length;
    }
    for (;;) {
      const next = text.indexOf('<', at);
      if (next < 0) throw new Error(`unclosed <${name}>`);
      el.text += decode(text.slice(at, next));
      at = next;
      if (text.startsWith('</', at)) {
        const close = `</${name}>`;
        if (!text.startsWith(close, at)) throw new Error(`mismatched end tag for <${name}>`);
        at += close.length;
        return el;
      }
      if (text.startsWith('<!--', at)) misc();
      else el.children.push(element());
    }
  };
  if (!skip(/^<\?xml version="1\.0" encoding="UTF-8"(?: standalone="yes")?\?>/))
    throw new Error('no XML declaration');
  misc();
  const root = element();
  misc();
  if (at !== text.length) throw new Error('content after the root element');
  return root;
}

/** Every element below el (el excluded) with this name, in document order. */
export function descendants(el: XmlElement, name: string): XmlElement[] {
  return el.children.flatMap((c) => [...(c.name === name ? [c] : []), ...descendants(c, name)]);
}
