import { createHash } from 'node:crypto';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

/**
 * Elements whose contents change without changing what a reviewer saw. Style text
 * stays in: a changed inline stylesheet can change contrast, visibility or reflow.
 */
const DROP_CONTENTS = new Set(['script', 'noscript', 'template']);
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
  'param',
  'source',
  'track',
  'wbr',
]);
// parse5 is quadratic in element depth (50k nested divs take about 8 s) and runs
// synchronously, so the page deadline could not interrupt it. Real pages nest a
// few dozen deep; past this the caller falls back to the byte hash.
const MAX_DEPTH = 5000;
// Elements whose end tag is commonly omitted: not counted as nesting.
const OPTIONAL_END = new Set([
  'p',
  'li',
  'dt',
  'dd',
  'tr',
  'td',
  'th',
  'option',
  'thead',
  'tbody',
  'tfoot',
]);

/** Linear over-estimate of element depth, ignoring void and omitted-end-tag elements. */
function roughDepth(html: string): number {
  let depth = 0;
  let max = 0;
  for (const m of html.matchAll(/<(\/?)([a-z][a-z0-9-]*)/gi)) {
    const tag = m[2]!.toLowerCase();
    if (VOID.has(tag) || OPTIONAL_END.has(tag)) continue;
    depth = m[1] ? Math.max(0, depth - 1) : depth + 1;
    if (depth > max) max = depth;
  }
  return max;
}

const TOKEN_LIKE = /csrf|xsrf|token|nonce/i;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const attrsOf = (el: Element): string => {
  const attrs = new Map(el.attrs.map((a) => [a.name, a.value]));
  const tokenHolder =
    TOKEN_LIKE.test(attrs.get('name') ?? '') || TOKEN_LIKE.test(attrs.get('id') ?? '');
  const hidden = el.tagName === 'input' && attrs.get('type')?.trim().toLowerCase() === 'hidden';
  return (
    [...attrs]
      .filter(([name]) => name !== 'nonce' && name !== 'integrity')
      .filter(([name]) => !(name.startsWith('data-') && TOKEN_LIKE.test(name)))
      // A csrf meta tag or field carries its secret in content or value.
      .filter(
        ([name]) =>
          !((tokenHolder || hidden) && (name === 'value' || (tokenHolder && name === 'content'))),
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => ` ${name}="${esc(value)}"`)
      .join('')
  );
};

/**
 * Hash of the served HTML after dropping what changes between loads without
 * changing the page: script, noscript and template contents, comments,
 * nonce and integrity attributes, token-like attributes and hidden input values,
 * and the length of whitespace runs. Pure and offline; a manual review is anchored to this
 * rather than to the byte hash. Throws on input it will not parse (nesting over
 * MAX_DEPTH, or anything parse5 rejects); the caller falls back to the byte hash.
 */
export function reviewHashOf(html: string): string {
  if (roughDepth(html) > MAX_DEPTH) throw new Error('document nesting is too deep to normalize');
  const out: string[] = [];
  // Iterative walk: hostile nesting must not overflow the call stack.
  const stack: (Node | string)[] = [parse(html)];
  while (stack.length) {
    const node = stack.pop() as Node | string;
    if (typeof node === 'string') {
      out.push(node);
      continue;
    }
    if (node.nodeName === '#text') {
      // Whitespace runs collapse to one space; they are neither trimmed nor dropped,
      // because "a <b>b</b>" and "a<b>b</b>" render differently.
      const text = (node as { value: string }).value.replace(/\s+/g, ' ');
      if (text) out.push(esc(text));
    } else if ('tagName' in node) {
      out.push(`<${node.tagName}${attrsOf(node)}>`);
      if (VOID.has(node.tagName)) continue;
      stack.push(`</${node.tagName}>`);
      if (!DROP_CONTENTS.has(node.tagName))
        for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
    } else if ('childNodes' in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
    }
    // Comments and doctypes fall through and contribute nothing.
  }
  return `sha256:${createHash('sha256').update(out.join('')).digest('hex')}`;
}
