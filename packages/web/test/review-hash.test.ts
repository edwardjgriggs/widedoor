import { describe, expect, it } from 'vitest';
import { reviewHashOf } from '../src/review-hash.js';

const page = (body: string, head = '') =>
  `<!doctype html><html lang="en"><head><title>T</title>${head}</head><body>${body}</body></html>`;

const BASE = page(
  `<h1>Welcome</h1><p>Read <a href="/a">the guide</a>.</p><img src="x.png" alt="logo">
   <form><label for="q">Search</label><input id="q" name="q"><input type="hidden" name="csrf_token" value="aaa"></form>
   <script nonce="n1">var a = 1;</script><noscript>Enable JS</noscript><template><p>x</p></template>`,
  '<meta name="csrf-token" content="tok1"><style>p { color: red }</style>',
);

describe('reviewHashOf', () => {
  it('returns sha256:<hex>', () => {
    expect(reviewHashOf(BASE)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([
    ['a script body', BASE.replace('var a = 1;', 'var b = 2; track();')],
    ['a style body', BASE.replace('color: red', 'color: blue')],
    ['a hidden input value', BASE.replace('value="aaa"', 'value="zzz"')],
    ['a csrf meta content', BASE.replace('content="tok1"', 'content="tok2"')],
    ['a nonce attribute', BASE.replace('nonce="n1"', 'nonce="n2"')],
    ['a comment', BASE.replace('<h1>', '<!-- built 12:01 --><h1>')],
    ['a noscript body', BASE.replace('Enable JS', 'Please enable JS')],
    ['a template body', BASE.replace('<p>x</p>', '<p>y</p>')],
    ['a data-csrf attribute', BASE.replace('<form>', '<form data-csrf="1">')],
    ['an integrity attribute', BASE.replace('<script', '<script integrity="sha384-abc"')],
    ['the length of whitespace runs', BASE.replace(/\s+/g, '\n\n\t')],
  ])('ignores %s', (_n, changed) => {
    expect(reviewHashOf(changed)).toBe(reviewHashOf(BASE));
  });

  it.each([
    ['visible text', BASE.replace('Welcome', 'Welcome back')],
    ['an alt', BASE.replace('alt="logo"', 'alt="company logo"')],
    ['a label', BASE.replace('>Search<', '>Find<')],
    ['a heading level', BASE.replace('<h1>Welcome</h1>', '<h2>Welcome</h2>')],
    ['a link href', BASE.replace('href="/a"', 'href="/b"')],
    ['a visible input value', BASE.replace('<input id="q"', '<input value="x" id="q"')],
  ])('changes with %s', (_n, changed) => {
    expect(reviewHashOf(changed)).not.toBe(reviewHashOf(BASE));
  });

  it.each([
    ['a space before inline markup', '<p>hello <b>world</b></p>', '<p>hello<b>world</b></p>'],
    ['a space between inline elements', '<b>a</b> <i>b</i>', '<b>a</b><i>b</i>'],
  ])('tells apart %s', (_n, a, b) => {
    expect(reviewHashOf(page(a))).not.toBe(reviewHashOf(page(b)));
  });

  // Accepted fail-open: the token-like test is a substring match, so a field whose
  // id merely contains "token" (a tokenizer setting) loses its value and content too.
  it('drops value and content of an element whose id or name looks like a token', () => {
    const a = page('<input id="tokenizer" value="one"><meta name="xsrf" content="a">');
    const b = page('<input id="tokenizer" value="two"><meta name="xsrf" content="b">');
    expect(reviewHashOf(a)).toBe(reviewHashOf(b));
    // An ordinary field keeps its value.
    expect(reviewHashOf(page('<input id="city" value="one">'))).not.toBe(
      reviewHashOf(page('<input id="city" value="two">')),
    );
  });

  it('is deterministic across attribute order', () => {
    expect(reviewHashOf(page('<a href="/a" title="t">x</a>'))).toBe(
      reviewHashOf(page('<a title="t" href="/a">x</a>')),
    );
  });

  it('does not let a changed value collide through markup characters', () => {
    expect(reviewHashOf(page('<p title="a&quot;>b">x</p>'))).not.toBe(
      reviewHashOf(page('<p title="a">b">x</p>')),
    );
  });

  it('finishes hostile input well under the 60 s page deadline', () => {
    const started = Date.now();
    reviewHashOf(page('<div>'.repeat(2_000) + 'x'));
    reviewHashOf(page(`<p>${'word '.repeat(1_000_000)}</p>`));
    reviewHashOf(page('<b>'.repeat(4_000) + '<p>'.repeat(20_000)));
    // Nesting past the cap is refused before parse5 sees it.
    expect(() => reviewHashOf(page('<div>'.repeat(4_000_000)))).toThrow(/too deep/);
    // Generous bound so a busy host does not flake; the real budget is the 60 s deadline.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
