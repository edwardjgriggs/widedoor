import { createHash } from 'node:crypto';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { expect } from 'vitest';
import { loadStandardsData } from '@widedoor/core';

/*
 * Parses an HTML report the way a browser would (parse5 follows the HTML
 * parsing spec) and checks it against an allowlist: only the elements and
 * attributes the reporter emits, and links only to the two help sites and the
 * errata the data cites. Anything
 * else (a script, an event handler, an svg animate, a srcset, a style
 * attribute, a link to another host) is reported, whether or not the CSP would
 * stop it in a browser.
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

/** Every element the reporter emits, with the attributes each may carry. */
const ALLOWED: Record<string, readonly string[]> = {
  html: ['lang'],
  head: [],
  meta: ['http-equiv', 'content', 'charset', 'name'],
  title: [],
  style: [],
  body: [],
  header: [],
  main: [],
  footer: [],
  section: ['aria-labelledby'],
  h1: [],
  h2: ['id'],
  h3: ['id', 'class'],
  h4: [],
  p: ['class'],
  span: ['class'],
  ol: ['class'],
  ul: ['class'],
  li: ['class'],
  a: ['href'],
  img: ['class', 'src', 'alt'],
  pre: [],
  code: [],
  details: [],
  summary: [],
  table: [],
  caption: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ['scope'],
  td: [],
  dl: [],
  dt: [],
  dd: [],
  br: [],
};

const LINK_PREFIXES = [
  'https://www.w3.org/WAI/WCAG21/Understanding/',
  'https://dequeuniversity.com/rules/axe/',
];

/** The errata citations a criterion that passes on the errata basis links to, exactly. */
const ERRATA_LINKS = loadStandardsData().errata.criteria.flatMap((c) =>
  c.citations.map((x) => x.url),
);

export interface Inspection {
  /** Elements or attributes outside the allowlist, as "tag" or "tag attr". */
  disallowed: string[];
  /** href values that do not start with an allowed help-site prefix. */
  badLinks: string[];
  /** Every attribute value that is a javascript: or vbscript: URL after stripping what browsers strip. */
  javascriptUrls: string[];
  /** img src values. */
  images: string[];
  /** Name, http-equiv and content of the first element in head. */
  firstInHead:
    { name: string; httpEquiv: string | undefined; content: string | undefined } | undefined;
  /** Text of every style element. */
  styles: string[];
  /** Tag and attribute names in document order, for structural comparisons. */
  shape: string[];
}

const isElement = (n: Node): n is Element => 'tagName' in n;

// What a browser strips before deciding a URL's scheme: ASCII whitespace and controls anywhere.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const scheme = (v: string) => v.replace(/[\u0000- \u007F]/g, '').toLowerCase();

export function inspect(text: string): Inspection {
  const out: Inspection = {
    disallowed: [],
    badLinks: [],
    javascriptUrls: [],
    images: [],
    firstInHead: undefined,
    styles: [],
    shape: [],
  };
  const visit = (node: Node) => {
    if (isElement(node)) {
      const tag = node.tagName;
      const allowed = ALLOWED[tag];
      out.shape.push(`${tag}[${node.attrs.map((a) => a.name).join(',')}]`);
      if (allowed === undefined || node.namespaceURI !== 'http://www.w3.org/1999/xhtml')
        out.disallowed.push(tag);
      for (const a of node.attrs) {
        if (!allowed?.includes(a.name) || a.namespace) out.disallowed.push(`${tag} ${a.name}`);
        if (/(?:java|vb)script:/.test(scheme(a.value))) out.javascriptUrls.push(`${tag} ${a.name}`);
        if (
          a.name === 'href' &&
          !LINK_PREFIXES.some((p) => a.value.startsWith(p)) &&
          !ERRATA_LINKS.includes(a.value)
        )
          out.badLinks.push(a.value);
      }
      if (tag === 'meta') {
        const equiv = node.attrs.find((a) => a.name === 'http-equiv')?.value;
        const name = node.attrs.find((a) => a.name === 'name')?.value;
        if (equiv !== undefined && equiv !== 'Content-Security-Policy')
          out.disallowed.push(`meta http-equiv=${equiv}`);
        if (name !== undefined && !['viewport', 'referrer'].includes(name))
          out.disallowed.push(`meta name=${name}`);
      }
      if (tag === 'img') out.images.push(node.attrs.find((a) => a.name === 'src')?.value ?? '');
      if (tag === 'style')
        out.styles.push(
          node.childNodes
            .map((c) => ('value' in c && c.nodeName === '#text' ? c.value : ''))
            .join(''),
        );
      if (tag === 'head') {
        const first = node.childNodes.find(isElement);
        if (first) {
          const attr = (n: string) => first.attrs.find((a) => a.name === n)?.value;
          out.firstInHead = {
            name: first.tagName,
            httpEquiv: attr('http-equiv'),
            content: attr('content'),
          };
        }
      }
      if (tag === 'template' && 'content' in node) node.content.childNodes.forEach(visit);
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
  };
  visit(parse(text));
  return out;
}

export const sha256Base64 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('base64');

/** Asserts the report is inert and its CSP fits what it holds. Returns the inspection. */
export function expectInert(page: string) {
  const r = inspect(page);
  expect(r.disallowed, 'elements and attributes outside the allowlist').toEqual([]);
  expect(r.badLinks, 'links to other hosts').toEqual([]);
  expect(r.javascriptUrls, 'javascript: URLs').toEqual([]);
  expect(r.firstInHead?.name).toBe('meta');
  expect(r.firstInHead?.httpEquiv).toBe('Content-Security-Policy');
  const csp = r.firstInHead?.content ?? '';
  expect(csp).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'/);
  expect(csp).not.toMatch(/script-src|unsafe/);
  expect(r.styles).toHaveLength(1);
  expect(csp).toContain(`'sha256-${sha256Base64(r.styles[0] ?? '')}'`);
  for (const src of r.images)
    expect(src).toMatch(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/);
  expect(csp.includes('img-src data:')).toBe(r.images.length > 0);
  return r;
}
