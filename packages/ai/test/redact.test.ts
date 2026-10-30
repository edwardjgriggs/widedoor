import { describe, expect, it } from 'vitest';
import { SENT_SNIPPET_MAX, redactSelector, redactSnippet, redactText } from '../src/redact.ts';

/*
 * Review Focus 2: everything a provider receives passes through these
 * functions. Each row is one rule: input, the exact output, and the kinds it
 * records. Rows that fail closed (input the tokenizer cannot follow) drop the
 * uncertain part and record it as unparsed.
 */

type Kinds = Record<string, number>;
const kinds = (redactions: { kind: string; count: number }[]): Kinds =>
  Object.fromEntries(redactions.map((r) => [r.kind, r.count]));

const SNIPPETS: [name: string, input: string, output: string, kinds: Kinds][] = [
  // Kept as is.
  [
    'keeps tag names, kept attributes and visible text',
    '<button id="go" class="btn primary" role="button" aria-label="Send" title="Send it" type="submit" lang="en">Send now</button>',
    '<button id="go" class="btn primary" role="button" aria-label="Send" title="Send it" type="submit" lang="en">Send now</button>',
    {},
  ],
  [
    'keeps alt, for, boolean attributes and void tags',
    '<label for="q">Search</label><input id="q" disabled><img alt="Logo" />',
    '<label for="q">Search</label><input id="q" disabled><img alt="Logo" />',
    {},
  ],
  // Dropped attributes.
  ['drops value', '<input type="text" value="Jane Doe">', '<input type="text">', { value: 1 }],
  [
    'drops on* handlers',
    '<a onclick="steal()" onMouseOver=\'x()\' href="/a">A</a>',
    '<a href="/a">A</a>',
    { 'event-handler': 2 },
  ],
  ['drops style', '<p style="color:red">Hi</p>', '<p>Hi</p>', { style: 1 }],
  [
    'drops attributes outside the allowlist',
    '<iframe srcdoc="<b>x</b>" title="Map"></iframe>',
    '<iframe title="Map"></iframe>',
    { attribute: 1 },
  ],
  // URLs.
  [
    'masks a query string in href',
    '<a href="https://a.example/p?x=1">A</a>',
    '<a href="https://[redacted:host]/p?[redacted]">A</a>',
    { host: 1, 'query-string': 1 },
  ],
  [
    'masks a fragment',
    '<a href="https://a.example/p#token=abc">A</a>',
    '<a href="https://[redacted:host]/p#[redacted]">A</a>',
    { fragment: 1, host: 1 },
  ],
  [
    'masks a relative URL with a query',
    '<a href="/reset?token=abc123">Reset</a>',
    '<a href="/reset?[redacted]">Reset</a>',
    { 'query-string': 1 },
  ],
  [
    'masks src, action, formaction and poster',
    '<form action="/login?next=%2Fme"><button formaction="/b?c=d"></button><video poster="/p.png?sig=1"></video><img src="/i.png?u=2" alt="i"></form>',
    '<form action="/login?[redacted]"><button formaction="/b?[redacted]"></button><video poster="/p.png?[redacted]"></video><img src="/i.png?[redacted]" alt="i"></form>',
    { 'query-string': 4 },
  ],
  [
    'masks each srcset candidate',
    '<img srcset="/a.png?s=1 1x, /b.png?s=2 2x" alt="a">',
    '<img srcset="/a.png?[redacted] 1x, /b.png?[redacted] 2x" alt="a">',
    { 'query-string': 2 },
  ],
  [
    'masks a data-* value that is a URL',
    '<div data-src="https://cdn.example/x.js?key=1" data-count="3"></div>',
    '<div data-src="https://[redacted:host]/x.js?[redacted]" data-count="3"></div>',
    { host: 1, 'query-string': 1 },
  ],
  [
    'drops a data-* value that holds JSON',
    '<div data-config=\'{"user":"jane"}\'></div>',
    '<div></div>',
    { 'data-json': 1 },
  ],
  [
    'replaces a data: URL',
    '<img src="data:image/png;base64,iVBORw0KGgo=" alt="x">',
    '<img src="[redacted:data-url]" alt="x">',
    { 'data-url': 1 },
  ],
  [
    'replaces a javascript: URL',
    '<a href=" JavaScript:alert(document.cookie)">x</a>',
    '<a href="[redacted:script-url]">x</a>',
    { 'script-url': 1 },
  ],
  [
    'masks user info in a URL',
    '<a href="https://bob:pw@a.example/">x</a>',
    '<a href="https://[redacted]@[redacted:host]/">x</a>',
    { host: 1, userinfo: 1 },
  ],
  [
    'decodes entities before the URL check',
    '<a href="/r&#x3F;token=abc">x</a><a href="/s&#63;t=1">y</a><a href="/u&quest;v=2">z</a>',
    '<a href="/r?[redacted]">x</a><a href="/s?[redacted]">y</a><a href="/u?[redacted]">z</a>',
    { 'query-string': 3 },
  ],
  // Sensitive fields.
  [
    'drops the value of a password field',
    '<input type="password" value="hunter2" id="pw">',
    '<input type="password" id="pw">',
    { value: 1 },
  ],
  [
    'drops the value of a hidden field',
    '<input type="hidden" name="csrf" value="s3cr3t">',
    '<input type="hidden" name="csrf">',
    { value: 1 },
  ],
  [
    'masks the text of a field with a card autocomplete',
    '<select autocomplete="cc-exp-month"><option>04</option><option>05</option></select>',
    '<select autocomplete="cc-exp-month"><option>[redacted:field]</option><option>[redacted:field]</option></select>',
    { field: 2 },
  ],
  [
    'masks the text of a one-time-code field',
    '<div autocomplete="section-a one-time-code"><span>123456</span></div><p>after</p>',
    '<div autocomplete="section-a one-time-code"><span>[redacted:field]</span></div><p>after</p>',
    { field: 1 },
  ],
  [
    'masks textarea content',
    '<textarea id="msg">my address is 1 Main St</textarea>',
    '<textarea id="msg">[redacted:field]</textarea>',
    { field: 1 },
  ],
  // Text and attribute masks.
  [
    'masks an email in a placeholder and in text',
    '<input placeholder="jane.doe@example.com"><p>Write to bob@example.org</p>',
    '<input placeholder="[redacted:email]"><p>Write to [redacted:email]</p>',
    { email: 2 },
  ],
  [
    'masks a phone number',
    '<p>Call +1 (555) 123-4567 or 555.123.4567</p>',
    '<p>Call [redacted:phone] or [redacted:phone]</p>',
    { phone: 2 },
  ],
  [
    'leaves dates and short numbers alone',
    '<p>On 2026-10-29, 12 items cost 1,234.</p>',
    '<p>On 2026-10-29, 12 items cost 1,234.</p>',
    {},
  ],
  [
    'masks a hex token in an id',
    '<div id="a1b2c3d4e5f60718293a4b5c6d7e8f90">x</div>',
    '<div id="[redacted:hex-token]">x</div>',
    { 'hex-token': 1 },
  ],
  [
    'masks a base64 token in a class and in text',
    '<span class="tok QmFzZTY0U2VjcmV0VmFsdWUxMjM0NTY3">key: dGhpc0lzQVNlY3JldEtleTEyMzQ1Ng==</span>',
    '<span class="tok [redacted:token]">key: [redacted:token]</span>',
    { token: 2 },
  ],
  [
    'masks a JWT',
    '<p>eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl</p>',
    '<p>[redacted:jwt]</p>',
    { jwt: 1 },
  ],
  [
    'masks a UUID',
    '<p data-user="550e8400-e29b-41d4-a716-446655440000">x</p>',
    '<p data-user="[redacted:uuid]">x</p>',
    { uuid: 1 },
  ],
  [
    'masks a long number',
    '<p>Card 4111 1111 1111 1111</p>',
    '<p>Card [redacted:number]</p>',
    { number: 1 },
  ],
  [
    'masks a query string in visible text',
    '<p>See https://a.example/r?session=abc now</p>',
    '<p>See https://[redacted:host]/r?[redacted] now</p>',
    { host: 1, 'query-string': 1 },
  ],
  [
    'keeps long lowercase class names without digits, masks those with digits',
    '<div class="navigation-menu-item-active-link col-md-6-offset-lg-3-hidden-xs"></div>',
    '<div class="navigation-menu-item-active-link [redacted:token]"></div>',
    { token: 1 },
  ],
  // Fail closed.
  ['drops comments', '<p>a<!-- user 42 -->b</p>', '<p>ab</p>', { comment: 1 }],
  ['drops an unterminated comment', '<p>a<!-- secret', '<p>a', { unparsed: 1 }],
  ['drops CDATA', '<p>a<![CDATA[secret]]>b</p>', '<p>ab</p>', { unparsed: 1 }],
  [
    'drops a script body',
    '<script>var key="abc";</script><p>x</p>',
    '<script></script><p>x</p>',
    { 'script-body': 1 },
  ],
  [
    'drops a style body',
    '<style>.a{background:url(/x?t=1)}</style>',
    '<style></style>',
    { 'style-body': 1 },
  ],
  [
    'drops the cut word and keeps the completed attributes of a cut tag',
    '<a title="ok" href="https://a.example/p?token=abc123...',
    '<a title="ok">',
    { truncated: 1 },
  ],
  [
    'drops an unquoted value cut by the end',
    '<p>ok</p><a title=x',
    '<p>ok</p><a>',
    { unparsed: 1 },
  ],
  [
    'drops the rest after a malformed attribute',
    '<p>ok</p><a "x"=1>secret</a>',
    '<p>ok</p>',
    { unparsed: 1 },
  ],
  ['drops a doctype or processing instruction', '<?xml x?><p>a</p>', '<p>a</p>', { unparsed: 1 }],
  [
    'drops a script body with no end tag',
    '<p>a</p><SCRIPT>key="abc"',
    '<p>a</p><SCRIPT>',
    { 'script-body': 1 },
  ],
  [
    'finds the script end tag in any case',
    '<script>x</SCRIPT ><p>b</p>',
    '<script></SCRIPT><p>b</p>',
    { 'script-body': 1 },
  ],
  // Evasions.
  [
    'masks an unquoted URL attribute',
    '<a href=/reset?token=abc>x</a>',
    '<a href="/reset?[redacted]">x</a>',
    { 'query-string': 1 },
  ],
  [
    'matches attribute names in any case',
    '<A HREF="/a?b=c" ONCLICK="x()" VALUE="v">x</A>',
    '<A href="/a?[redacted]">x</A>',
    { 'event-handler': 1, 'query-string': 1, value: 1 },
  ],
  [
    'decodes an entity-hidden javascript: URL',
    '<a href="&#x6A;ava&#x09;script:alert(1)">x</a>',
    '<a href="[redacted:script-url]">x</a>',
    { 'script-url': 1 },
  ],
  [
    'masks an svg xlink:href',
    '<svg><a xlink:href="/x?t=1">x</a></svg>',
    '<svg><a xlink:href="/x?[redacted]">x</a></svg>',
    { 'query-string': 1 },
  ],
  [
    'treats a type in any case as a password field',
    '<input TYPE="PASSWORD" value=x>',
    '<input type="PASSWORD">',
    { value: 1 },
  ],
  [
    'escapes text so decoded entities stay text',
    '<p>&lt;script&gt; a &amp; b < c</p>',
    '<p>&lt;script&gt; a &amp; b &lt; c</p>',
    {},
  ],
  [
    'escapes quotes in attribute values',
    '<p title=\'say "hi"\'>x</p>',
    '<p title="say &quot;hi&quot;">x</p>',
    {},
  ],
];

describe('redactSnippet', () => {
  for (const [name, input, output, expected] of SNIPPETS)
    it(name, () => {
      const result = redactSnippet(input);
      expect(result.html).toBe(output);
      expect(kinds(result.redactions)).toEqual(expected);
    });

  it('sends no hunter2 from a password field', () => {
    expect(redactSnippet('<input type="password" value="hunter2">').html).not.toContain('hunter2');
  });

  it('sends no token from a reset link', () => {
    expect(redactSnippet('<a href="/reset?token=abc123">Reset</a>').html).not.toContain('abc123');
  });

  it('cuts a long snippet to SENT_SNIPPET_MAX after redaction', () => {
    const input = `<p>${'word '.repeat(600)}</p>`;
    expect(input.length).toBeGreaterThan(3000);
    const result = redactSnippet(input);
    expect(SENT_SNIPPET_MAX).toBe(2000);
    expect(result.html.length).toBe(SENT_SNIPPET_MAX);
    expect(kinds(result.redactions)).toEqual({ truncated: 1 });
  });

  it('measures the cut after redaction, so masks shorten what is cut', () => {
    const input = `<p data-x="https://a.example/?${'q=1&'.repeat(700)}">x</p>`;
    expect(input.length).toBeGreaterThan(2000);
    const result = redactSnippet(input);
    expect(result.html).toBe('<p data-x="https://[redacted:host]/?[redacted]">x</p>');
  });

  it('lists redaction kinds in a fixed order', () => {
    const result = redactSnippet('<p style="x" onclick="y" value="z">a@b.co</p>');
    expect(result.redactions.map((r) => r.kind)).toEqual([
      'email',
      'event-handler',
      'style',
      'value',
    ]);
  });

  it('never passes an unknown construct through', () => {
    for (const input of ['<', '<<p>', '</', '</p', '<p/', '<!', '<!-', '<a b="'])
      expect(() => redactSnippet(input)).not.toThrow();
    expect(redactSnippet('a < b').html).toBe('a &lt; b');
  });
});

describe('redactSelector', () => {
  const SELECTORS: [input: string, output: string, kinds: Kinds][] = [
    ['main > p.intro', 'main > p.intro', {}],
    ['a[href="/reset?token=abc"]', 'a[href="/reset?[redacted]"]', { 'query-string': 1 }],
    ["a[href^='https://a.example/p?x=1']", 'a[href^="[redacted:url]"]', { url: 1 }],
    ['input[value="hunter2"]', 'input[value="[redacted:value]"]', { value: 1 }],
    ['div[onclick="x()"]', 'div[onclick="[redacted:event-handler]"]', { 'event-handler': 1 }],
    ['input[type=hidden]', 'input[type="hidden"]', {}],
    [
      '#a1b2c3d4e5f60718293a4b5c6d7e8f90 > span',
      '#[redacted:hex-token] > span',
      { 'hex-token': 1 },
    ],
    ['iframe >> a[title="bob@example.org"]', 'iframe >> a[title="[redacted:email]"]', { email: 1 }],
    ['a[href="/r\\3F token=1"]', 'a[href="[redacted:unparsed]"]', { unparsed: 1 }],
    ['a[href="/r?token=1', '[redacted:unparsed]', { unparsed: 1 }],
    ["p[title='a\"b']", 'p[title="a\\"b"]', {}],
  ];
  for (const [input, output, expected] of SELECTORS)
    it(`redacts ${input}`, () => {
      const counts = new Map<string, number>();
      expect(redactSelector(input, counts)).toBe(output);
      expect(Object.fromEntries(counts)).toEqual(expected);
    });
});

describe('redactText', () => {
  it('masks emails, tokens and phone numbers in plain text', () => {
    const counts = new Map<string, number>();
    expect(redactText('Mail jane@example.com, call 555-123-4567', counts)).toBe(
      'Mail [redacted:email], call [redacted:phone]',
    );
    expect(Object.fromEntries(counts)).toEqual({ email: 1, phone: 1 });
  });
});

type Row = [name: string, input: string, output: string, kinds: Kinds];

const snippetRows = (rows: Row[]) => {
  for (const [name, input, output, expected] of rows)
    it(name, () => {
      const result = redactSnippet(input);
      expect(result.html).toBe(output);
      expect(kinds(result.redactions)).toEqual(expected);
    });
};

const selectorRows = (rows: Row[]) => {
  for (const [name, input, output, expected] of rows)
    it(name, () => {
      const counts = new Map<string, number>();
      expect(redactSelector(input, counts)).toBe(output);
      expect(Object.fromEntries(counts)).toEqual(expected);
    });
};

// Fix round 1: one table per reviewer finding, each with the reviewer's example.
describe('fix round 1', () => {
  describe('2: a tag cut by the end of the input', () => {
    snippetRows([
      [
        'never emits the partial attribute value',
        '<a class="nav" href="/account/settings?session=9f8e7d6c5b4a',
        '<a class="nav">',
        { unparsed: 1 },
      ],
      [
        'drops a token cut by the engine marker',
        '<p>key: dGhpc0lzQVNlY3J...',
        '<p>key: ',
        { truncated: 1 },
      ],
      [
        'drops a value cut by the engine marker inside a tag',
        '<input id="q" placeholder="hunter...',
        '<input id="q">',
        { truncated: 1 },
      ],
    ]);
  });

  describe('3: counts of a dropped tag are not kept', () => {
    snippetRows([
      [
        'a malformed tag records unparsed only',
        '<a href="/x?t=1" "bad">x</a>',
        '',
        { unparsed: 1 },
      ],
    ]);
  });

  describe('4: token rule', () => {
    snippetRows([
      [
        'masks a dotted token with a digit',
        '<p>sess.a1b2c3d4.e5f6g7h8.i9j0</p>',
        '<p>[redacted:token]</p>',
        { token: 1 },
      ],
      [
        'masks mixed case with no digit',
        '<p>AbCdEfGhIjKlMnOpQrStUvWxYz</p>',
        '<p>[redacted:token]</p>',
        { token: 1 },
      ],
    ]);
  });

  describe('5: query strings anywhere', () => {
    snippetRows([
      [
        'in a title (root-relative path)',
        '<a title="/reset?token=abc" href="#main">x</a>',
        '<a title="/reset?[redacted]" href="#main">x</a>',
        { 'query-string': 1 },
      ],
      [
        'in visible text (./ and ../ paths, //host)',
        '<p>./a?x=1 ../b?y=2 //cdn.example/c?z=3</p>',
        '<p>./a?[redacted] ../b?[redacted] //[redacted:host]/c?[redacted]</p>',
        { host: 1, 'query-string': 3 },
      ],
      [
        'a bare parameter run',
        '<p data-q="page=2&amp;token=abc">x</p>',
        '<p data-q="page=2&amp;[redacted]">x</p>',
        { 'query-string': 1 },
      ],
    ]);
    selectorRows([
      [
        'a URL attribute matched by substring',
        'a[href*="token=abc"]',
        'a[href*="[redacted:url]"]',
        { url: 1 },
      ],
      [
        'a URL attribute matched by suffix',
        'img[src$=".png?sig=1"]',
        'img[src$="[redacted:url]"]',
        { url: 1 },
      ],
      [
        'any other value through the text masks',
        'a[title="/reset?token=abc"]',
        'a[title="/reset?[redacted]"]',
        { 'query-string': 1 },
      ],
    ]);
  });

  describe('6: numeric entities', () => {
    snippetRows([
      [
        'any number of leading zeros',
        '<a href="/r&#x00000000003F;token=abc&#0000000063;x">x</a>',
        '<a href="/r?[redacted]">x</a>',
        { 'query-string': 1 },
      ],
      [
        'out of range or surrogate becomes U+FFFD',
        '<p title="a&#x110000;b&#xD800;c">x</p>',
        '<p title="a\ufffdb\ufffdc">x</p>',
        {},
      ],
      [
        'controls are stripped from values after decoding',
        '<a href="java&#x01;script:alert(1)">x</a>',
        '<a href="[redacted:script-url]">x</a>',
        { 'script-url': 1 },
      ],
    ]);
  });

  describe('7: hosts', () => {
    const asset = 'https://intranet.acme-corp.example/hr/employees/jdoe';
    it('a link to the asset URI sends no part of its host', () => {
      const result = redactSnippet(`<a href="${asset}">Profile</a> <p>${asset}</p>`);
      expect(result.html).not.toMatch(/intranet|acme|corp\.example/);
      expect(result.html).toBe(
        '<a href="https://[redacted:host]/hr/employees/jdoe">Profile</a> <p>https://[redacted:host]/hr/employees/jdoe</p>',
      );
      expect(kinds(result.redactions)).toEqual({ host: 2 });
    });
    snippetRows([
      [
        'a protocol-relative src',
        '<img src="//cdn.acme.example/i.png" alt="i">',
        '<img src="//[redacted:host]/i.png" alt="i">',
        { host: 1 },
      ],
      [
        'the path still goes through the number mask',
        '<a href="https://shop.example/orders/123456789012">x</a>',
        '<a href="https://[redacted:host]/orders/[redacted:number]">x</a>',
        { host: 1, number: 1 },
      ],
    ]);
    selectorRows([
      [
        'a host in a selector value',
        'a[href="https://intranet.acme.example/x"]',
        'a[href="https://[redacted:host]/x"]',
        { host: 1 },
      ],
    ]);
  });

  describe('8: numbers', () => {
    snippetRows([
      [
        'tel: masked whole',
        '<a href="tel:+15551234567">Call</a>',
        '<a href="[redacted:contact-url]">Call</a>',
        { 'contact-url': 1 },
      ],
      [
        'sms: masked whole',
        '<a href="sms:5551234567">Text</a>',
        '<a href="[redacted:contact-url]">Text</a>',
        { 'contact-url': 1 },
      ],
      [
        'mailto: masked whole',
        '<a href="mailto:jane@example.com">Mail</a>',
        '<a href="[redacted:contact-url]">Mail</a>',
        { 'contact-url': 1 },
      ],
      [
        'an unbroken 9-digit run',
        '<p>Member 123456789</p>',
        '<p>Member [redacted:number]</p>',
        { number: 1 },
      ],
      ['a 19-digit run', '<p>1234567890123456789</p>', '<p>[redacted:number]</p>', { number: 1 }],
      ['8 digits stay', '<p>Order 12345678</p>', '<p>Order 12345678</p>', {}],
    ]);
    selectorRows([
      ['a digit run in a selector', '#order-123456789', '#order-[redacted:number]', { number: 1 }],
    ]);
  });

  describe('9: emails', () => {
    snippetRows([
      [
        'percent-encoded in a URL value',
        '<a href="/u/jane%40example.com">x</a>',
        '<a href="[redacted:email]">x</a>',
        { email: 1 },
      ],
      [
        'a wide local part',
        '<p>Mail first#last!x~y@example.com</p>',
        '<p>Mail [redacted:email]</p>',
        { email: 1 },
      ],
      [
        'a bad percent escape does not throw',
        '<a href="/u/%E0%A4%A">x</a>',
        '<a href="/u/%E0%A4%A">x</a>',
        {},
      ],
    ]);
  });

  describe('10: user info', () => {
    snippetRows([
      [
        'backslash slashes',
        '<a href="https:\\\\bob:pw@a.example/">x</a>',
        '<a href="https:\\\\[redacted]@[redacted:host]/">x</a>',
        { host: 1, userinfo: 1 },
      ],
      [
        'no slashes, in text',
        '<p>ftp:bob:pw@files.example</p>',
        // Fix round 2 item 1: ftp is a special scheme, so its host goes too.
        '<p>ftp:[redacted]@[redacted:host]</p>',
        { host: 1, userinfo: 1 },
      ],
    ]);
  });

  describe('11: names', () => {
    snippetRows([
      [
        'a token-shaped data-* name is dropped',
        '<div data-a1b2c3d4e5f6a7b8c9d0e1f2a3="1">x</div>',
        '<div>x</div>',
        { attribute: 1 },
      ],
      [
        'a token-shaped aria-* name is dropped',
        '<div aria-Session9f8e7d6c5b4a3f2e1d0c="x">x</div>',
        '<div>x</div>',
        { attribute: 1 },
      ],
      [
        'a token-shaped tag name is unparsed',
        '<p>a</p><x-a1b2c3d4e5f6a7b8c9d0e1f2a3>b',
        '<p>a</p>',
        { unparsed: 1 },
      ],
    ]);
    selectorRows([
      [
        'a token-shaped selector attribute name is dropped',
        'div[data-a1b2c3d4e5f6a7b8c9d0e1f2a3="1"]',
        'div',
        { attribute: 1 },
      ],
    ]);
  });

  describe('12: duplicate attributes', () => {
    snippetRows([
      [
        'the first occurrence wins',
        '<a href="/safe" href="/x?token=abc">x</a>',
        '<a href="/safe">x</a>',
        {},
      ],
      [
        'a duplicate type cannot hide a password field',
        '<div type="password" type="text" autocomplete="off"><span>hunter2</span></div>',
        '<div type="password" autocomplete="off"><span>[redacted:field]</span></div>',
        { field: 1 },
      ],
    ]);
  });

  describe('13: named entities', () => {
    snippetRows([
      [
        'an unknown entity passes through',
        '<p>&copy; 2026 &hellip;</p>',
        '<p>&copy; 2026 &hellip;</p>',
        {},
      ],
      ['a literal ampersand is escaped', '<p>Tom & Jerry</p>', '<p>Tom &amp; Jerry</p>', {}],
      [
        'Tab and NewLine decode in a value',
        '<a href="java&Tab;script&NewLine;:alert(1)">x</a>',
        '<a href="[redacted:script-url]">x</a>',
        { 'script-url': 1 },
      ],
    ]);
  });

  describe('14: same-page fragments', () => {
    snippetRows([
      [
        'an id-shaped skip link is kept',
        '<a href="#main-content">Skip</a>',
        '<a href="#main-content">Skip</a>',
        {},
      ],
      [
        'a non-id fragment is masked',
        '<a href="#/route?x=1">x</a>',
        '<a href="#[redacted]">x</a>',
        { fragment: 1 },
      ],
      [
        'a token-shaped id fragment is masked',
        '<a href="#a1b2c3d4e5f6a7b8c9d0e1f2a3">x</a>',
        '<a href="#[redacted]">x</a>',
        { fragment: 1 },
      ],
    ]);
  });

  it('15: SENT_SNIPPET_MAX is 2000', () => {
    expect(SENT_SNIPPET_MAX).toBe(2000);
  });
});

// Fix round 2: the remaining minors.
describe('fix round 2', () => {
  describe('1: unusual absolute-URL spellings keep no host', () => {
    snippetRows([
      [
        'one slash with user info',
        '<a href="https:/admin:p!ss@example.com/">x</a>',
        '<a href="https:/[redacted]@[redacted:host]/">x</a>',
        { host: 1, userinfo: 1 },
      ],
      [
        'no slashes',
        '<a href="https:example.com/p">x</a>',
        '<a href="https:[redacted:host]/p">x</a>',
        { host: 1 },
      ],
      [
        'backslashes',
        '<a href="https:\\\\example.com/">x</a>',
        '<a href="https:\\\\[redacted:host]/">x</a>',
        { host: 1 },
      ],
      [
        'three slashes, upper case scheme',
        '<a href="HTTP:///example.com/x">x</a>',
        '<a href="HTTP:///[redacted:host]/x">x</a>',
        { host: 1 },
      ],
      [
        'wss with no slashes in text',
        '<p>wss:ws.example/s</p>',
        '<p>wss:[redacted:host]/s</p>',
        { host: 1 },
      ],
      [
        'protocol-relative with backslashes',
        '<a href="\\\\example.com/x">x</a>',
        '<a href="\\\\[redacted:host]/x">x</a>',
        { host: 1 },
      ],
      [
        'protocol-relative after any non-word lead',
        '<p>|//cdn.example/a ;//cdn.example/b</p>',
        '<p>|//[redacted:host]/a ;//[redacted:host]/b</p>',
        { host: 2 },
      ],
      [
        'a path with a double slash is not a host',
        '<a href="/a//b">x</a>',
        '<a href="/a//b">x</a>',
        {},
      ],
    ]);
  });

  describe('2: entities and invisible splitters', () => {
    snippetRows([
      [
        'ASCII named entities decode',
        '<p title="a&excl;b&dollar;c&lpar;d&rpar;&ast;&comma;&semi;&lsqb;&rsqb;&lcub;&rcub;&verbar;&Hat;&grave;&UnderBar;&bsol;">x</p>',
        '<p title="a!b$c(d)*,;[]{}|^`_\\">x</p>',
        {},
      ],
      [
        'upper-case AMP, LT, GT and QUOT decode',
        '<p title="&AMP;&LT;&GT;&QUOT;">x</p>',
        '<p title="&amp;&lt;&gt;&quot;">x</p>',
        {},
      ],
      [
        'an entity-built URL loses its host',
        '<a href="https&colon;&sol;&sol;evil&period;example&sol;x&quest;t&equals;1">x</a>',
        '<a href="https://[redacted:host]/x?[redacted]">x</a>',
        { host: 1, 'query-string': 1 },
      ],
      [
        'a numeric soft hyphen cannot split a token in text',
        '<p>a1b2c3d4e5f6&#173;a7b8c9d0e1f2a3b4</p>',
        '<p>[redacted:hex-token]</p>',
        { 'hex-token': 1 },
      ],
      [
        'a named soft hyphen or zero-width space cannot split a token',
        '<p>a1b2c3d4e5f6&shy;a7b8c9d0&ZeroWidthSpace;e1f2a3b4</p>',
        '<p>[redacted:hex-token]</p>',
        { 'hex-token': 1 },
      ],
      [
        'a raw zero-width space cannot split a token',
        '<p>a1b2c3d4e5f6\u200ba7b8c9d0e1f2a3b4</p>',
        '<p>[redacted:hex-token]</p>',
        { 'hex-token': 1 },
      ],
      [
        'joiners, word joiner and BOM in a value',
        '<div title="a1b2c3\u200cd4e5f6\u200da7b8\u2060c9d0\ufeffe1f2a3b4">x</div>',
        '<div title="[redacted:hex-token]">x</div>',
        { 'hex-token': 1 },
      ],
      [
        'C0 and C1 controls in text cannot split a token',
        '<p>a1b2c3d4e5f6\u0001a7b8c9d0e1f2\u0085a3b4</p>',
        '<p>[redacted:hex-token]</p>',
        { 'hex-token': 1 },
      ],
      [
        'tab and newline in text stay whitespace',
        '<p>one\ttwo\nthree</p>',
        '<p>one\ttwo\nthree</p>',
        {},
      ],
    ]);
  });

  describe('4: selectors judge one part at a time', () => {
    selectorRows([
      [
        'a utility class list survives',
        'div.flex.items-center.justify-between.px-4 > button',
        'div.flex.items-center.justify-between.px-4 > button',
        {},
      ],
      [
        'a 24-character token in one class is masked',
        'div.card.a1b2c3d4e5f6a7b8c9d0e1f2 > p',
        'div.card.[redacted:hex-token] > p',
        { 'hex-token': 1 },
      ],
      [
        'a token-shaped id is masked',
        '#Sess9f8e7d6c5b4a3f2e1d0c9b8a:nth-child(2)',
        '#[redacted:token]:nth-child(2)',
        { token: 1 },
      ],
      ['an id after a class is not a fragment', 'div.nav#main', 'div.nav#main', {}],
      [
        // The wide local part (round 1 item 9) takes the class prefix with it: over-masking.
        'an email outside brackets is still masked',
        'li > a.bob@example.org',
        'li > [redacted:email]',
        { email: 1 },
      ],
      [
        'values inside brackets keep every mask',
        'a.nav[title="https://intranet.example/p?x=1"]',
        'a.nav[title="https://[redacted:host]/p?[redacted]"]',
        { host: 1, 'query-string': 1 },
      ],
    ]);
  });

  describe('5: a stray < before the cut marker', () => {
    snippetRows([
      ['is dropped', '<p>x</p><...', '<p>x</p>', { truncated: 1 }],
      ['is dropped after a space', '<p>x</p> <...', '<p>x</p> ', { truncated: 1 }],
    ]);
  });

  // The security reviewer's own inputs for m1 and m2: none may send any part of the host.
  describe("reviewer's m1 and m2 inputs", () => {
    const HOST = /intranet|corp\.example|example\.com/;
    const reviewerRows: Row[] = [
      [
        'm1: https with one slash',
        '<a href="https:/intranet.corp.example/hr">x</a>',
        '<a href="https:/[redacted:host]/hr">x</a>',
        { host: 1 },
      ],
      [
        'm1: https with three slashes',
        '<a href="https:///intranet.corp.example/hr">x</a>',
        '<a href="https:///[redacted:host]/hr">x</a>',
        { host: 1 },
      ],
      [
        'm1: http with no slashes',
        '<a href="http:intranet.corp.example/hr">x</a>',
        '<a href="http:[redacted:host]/hr">x</a>',
        { host: 1 },
      ],
      [
        'm1: one slash in text',
        '<p>See https:/intranet.corp.example/hr</p>',
        '<p>See https:/[redacted:host]/hr</p>',
        { host: 1 },
      ],
      [
        'm1: protocol-relative after [',
        '<p>[//intranet.corp.example/x]</p>',
        '<p>[//[redacted:host]/x]</p>',
        { host: 1 },
      ],
      [
        'm1: protocol-relative between backticks',
        '<p>`//intranet.corp.example/x`</p>',
        '<p>`//[redacted:host]/x`</p>',
        { host: 1 },
      ],
      [
        'm1: protocol-relative right after a tag',
        '<p><b>x</b>//intranet.corp.example/x</p>',
        '<p><b>x</b>//[redacted:host]/x</p>',
        { host: 1 },
      ],
      [
        'm1: user info and host',
        '<a href="https:/admin:p!ss@example.com/">x</a>',
        '<a href="https:/[redacted]@[redacted:host]/">x</a>',
        { host: 1, userinfo: 1 },
      ],
      [
        'm2: entity backslashes',
        '<a href="https:&bsol;&bsol;intranet.corp.example/hr">x</a>',
        '<a href="https:\\\\[redacted:host]/hr">x</a>',
        { host: 1 },
      ],
      [
        'm2: a named soft hyphen inside a mixed-case token',
        '<p>AbCdEfGh12345678&shy;IjKlMnOp12345678</p>',
        '<p>[redacted:token]</p>',
        { token: 1 },
      ],
      [
        'm2: a numeric zero-width space inside a mixed-case token',
        '<p>AbCdEfGh12345678&#x200B;IjKlMnOp12345678</p>',
        '<p>[redacted:token]</p>',
        { token: 1 },
      ],
      ['m2: &#x1; leaves no raw U+0001', '<p>a&#x1;b</p>', '<p>ab</p>', {}],
    ];
    snippetRows(reviewerRows);

    it('no reviewer input sends any part of the host or a raw U+0001', () => {
      for (const [, input] of reviewerRows) {
        const { html } = redactSnippet(input);
        expect(html, input).not.toMatch(HOST);
        expect(html, input).not.toContain('\u0001');
      }
    });

    selectorRows([
      [
        'm1: one slash in a selector value',
        'a[title="https:/intranet.corp.example"]',
        'a[title="https:/[redacted:host]"]',
        { host: 1 },
      ],
    ]);
  });
});

// Task 3b.3 fix round 1, item 5: the invisible-character list answer.ts uses applies here too.
describe('shared invisible characters', () => {
  snippetRows([
    [
      'an Arabic number sign (Cf) cannot split a token',
      '<p>a1b2c3d4e5f6\u0600a7b8c9d0e1f2a3b4</p>',
      '<p>[redacted:hex-token]</p>',
      { 'hex-token': 1 },
    ],
    [
      'a tag character cannot split a token',
      '<p>a1b2c3d4e5f6\u{e0041}a7b8c9d0e1f2a3b4</p>',
      '<p>[redacted:hex-token]</p>',
      { 'hex-token': 1 },
    ],
    [
      'variation selectors and Hangul fillers cannot split a token',
      '<p>a1b2c3d4\ufe0fe5f6\u{e0100}a7b8\u3164c9d0\u115fe1f2\u1160a3b4</p>',
      '<p>[redacted:hex-token]</p>',
      { 'hex-token': 1 },
    ],
    ['a line separator becomes a space', '<p>one\u2028two</p>', '<p>one two</p>', {}],
  ]);

  it('answer.ts and redact.ts share isInvisible', async () => {
    const redact = await import('../src/redact.ts');
    for (const ch of [
      '\u00ad',
      '\u200b',
      '\u202e',
      '\u2066',
      '\ufeff',
      '\u{e0041}',
      '\ufe0f',
      '\u3164',
    ])
      expect(redact.isInvisible(ch), ch.codePointAt(0)?.toString(16)).toBe(true);
    expect(redact.isInvisible('a')).toBe(false);
    expect(redact.isInvisible(' ')).toBe(false);
  });
});

// Task 3b.3 fix round 2: check mode and two more invisibles.
describe('scanMarkup check mode and residual invisibles', () => {
  it('the default mode still skips comments and raw text bodies, as redaction does', async () => {
    const { scanMarkup } = await import('../src/redact.ts');
    const plain = scanMarkup('<p>a<!-- c --></p><textarea><a href="/x"></a></textarea>');
    expect(plain.complete).toBe(true);
    expect(plain.tags.map((t) => t.name)).toEqual(['p', 'textarea']);
  });

  it('check mode refuses any comment and rescans raw text bodies', async () => {
    const { scanMarkup } = await import('../src/redact.ts');
    expect(scanMarkup('<p>a<!-- c --></p>', { check: true }).complete).toBe(false);
    expect(scanMarkup('<!---->', { check: true }).complete).toBe(false);
    const body = scanMarkup('<textarea><a href="/x"></a></textarea>', { check: true });
    expect(body.complete).toBe(true);
    expect(body.tags.map((t) => t.name)).toEqual(['textarea', 'a']);
    expect(scanMarkup('<noscript><a href="/x">', { check: true }).complete).toBe(false);
    expect(scanMarkup('<plaintext>x', { check: true }).complete).toBe(false);
  });

  snippetRows([
    [
      'U+034F and U+FFA0 cannot split a token',
      '<p>a1b2c3d4e5f6\u034fa7b8c9d0e1f2\uffa0a3b4</p>',
      '<p>[redacted:hex-token]</p>',
      { 'hex-token': 1 },
    ],
  ]);
});
