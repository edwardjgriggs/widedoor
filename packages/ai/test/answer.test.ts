import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  ANSWER_JSON_SCHEMAS,
  ANSWER_MAX_BYTES,
  ANSWER_MAX_DEPTH,
  parseAnswer,
  toOpenAiSchema,
  toProviderSchema,
} from '../src/answer.ts';
import { PdfStepsSchema, WebPatchSchema } from '../src/model.ts';

const SNIPPET = '<a href="https://[redacted:host]/help"><img src="/logo.png"></a>';

const webAnswer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'web-patch',
    summary: 'Give the image a text alternative.',
    patch: '<a href="https://[redacted:host]/help"><img src="/logo.png" alt="Help"></a>',
    notes: null,
    ...over,
  });

const pdfAnswer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'pdf-steps',
    summary: 'Add alternate text to the figure.',
    tool: 'word',
    steps: ['Right-click the picture.', 'Choose View Alt Text and describe it.'],
    ...over,
  });

const web = (raw: string) => parseAnswer(raw, 'web', SNIPPET);
const refused = (result: ReturnType<typeof parseAnswer>) => (result.ok ? undefined : result.reason);

describe('parseAnswer: shape', () => {
  it('accepts a valid web answer and drops a null notes', () => {
    expect(web(webAnswer())).toEqual({
      ok: true,
      suggestion: {
        kind: 'web-patch',
        summary: 'Give the image a text alternative.',
        patch: '<a href="https://[redacted:host]/help"><img src="/logo.png" alt="Help"></a>',
      },
    });
    const withNotes = web(webAnswer({ notes: 'Line one.\nLine two.' }));
    expect(
      withNotes.ok && withNotes.suggestion.kind === 'web-patch' && withNotes.suggestion.notes,
    ).toBe('Line one.\nLine two.');
  });

  it('accepts a valid PDF answer', () => {
    const result = parseAnswer(pdfAnswer(), 'pdf');
    expect(result.ok && result.suggestion.kind).toBe('pdf-steps');
  });

  it('refuses non-JSON, an extra field, a missing field and a wrong kind', () => {
    expect(refused(web('Sure! Here is the fix: <img alt="x">'))).toBe('the answer is not JSON');
    expect(refused(web(webAnswer({ apply: true })))).toBe('the answer does not match the schema');
    expect(refused(web(JSON.stringify({ kind: 'web-patch', summary: 'x' })))).toBe(
      'the answer does not match the schema',
    );
    expect(refused(web(pdfAnswer()))).toBe('a pdf-steps answer for a web finding');
    expect(refused(parseAnswer(webAnswer(), 'pdf'))).toBe('a web-patch answer for a pdf finding');
    expect(refused(web('null'))).toBe('the answer does not match the schema');
    expect(refused(web('[1]'))).toBe('the answer does not match the schema');
  });

  it('refuses an answer over 64 KiB before parsing it', () => {
    expect(ANSWER_MAX_BYTES).toBe(65536);
    const big = webAnswer({ notes: 'x'.repeat(70_000) });
    expect(refused(web(big))).toBe('the answer is too long');
    // Multi-byte characters count as bytes, not characters.
    expect(refused(web(webAnswer({ notes: '\u00e9'.repeat(33_000) })))).toBe(
      'the answer is too long',
    );
  });
});

describe('parseAnswer: stripping', () => {
  it('strips bidi overrides and isolates, zero-width characters, C0, DEL and C1', () => {
    const summary = 'Add\u202e alt\u2066 text\u200b\u200c\u200d\ufeff\u0007\u007f\u0085 now';
    const result = web(webAnswer({ summary }));
    expect(result.ok && result.suggestion.summary).toBe('Add alt text now');
  });

  it('keeps newlines only in patch and notes; single-line fields turn them into spaces', () => {
    const result = web(
      webAnswer({
        summary: 'One\ntwo\r\nthree',
        patch: '<p>\n  <img alt="a">\r\n</p>',
        notes: 'a\nb',
      }),
    );
    expect(result.ok && result.suggestion).toEqual({
      kind: 'web-patch',
      summary: 'One two three',
      patch: '<p>\n  <img alt="a">\n</p>',
      notes: 'a\nb',
    });
    const steps = parseAnswer(pdfAnswer({ steps: ['a\nb', 'c\td'] }), 'pdf');
    expect(steps.ok && steps.suggestion.kind === 'pdf-steps' && steps.suggestion.steps).toEqual([
      'a b',
      'c d',
    ]);
  });

  it('re-checks the maxima after stripping, and refuses a string stripped to nothing', () => {
    const padded = `${'x'.repeat(400)}${'\u200b'.repeat(50)}`;
    expect(web(webAnswer({ summary: padded })).ok).toBe(true);
    expect(refused(web(webAnswer({ summary: 'x'.repeat(401) })))).toBe(
      'the answer does not match the schema',
    );
    expect(refused(web(webAnswer({ summary: '\u202e\u200b' })))).toBe(
      'the answer does not match the schema',
    );
  });
});

describe('parseAnswer: unsafe markup in the patch', () => {
  const UNSAFE = [
    '<script>alert(1)</script>',
    '<SCRIPT src=x></SCRIPT>',
    '< script>',
    '<iframe src="/x"></iframe>',
    '<object data="x"></object>',
    '<embed src="x">',
    '<link rel="stylesheet" href="/x.css">',
    '<meta http-equiv="refresh" content="0">',
    '<base href="/">',
    '<form action="/steal"><button>Go</button></form>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="java\tscript:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href="jav&#x09;ascript:alert(1)">x</a>',
    '<a href="VBScript:x">x</a>',
    '<a href="data:text/html,<b>x</b>">x</a>',
    '<a href="data: text / html;base64,PGI+">x</a>',
    '<iframe srcdoc="<b>x</b>">',
    '<p srcdoc = "x">',
    '<img src="x" onerror="alert(1)">',
    '<button ONCLICK = "x()">Go</button>',
    '<img src="x" on&#101;rror="alert(1)">',
    '<p style="width: expression(alert(1))">x</p>',
    '<p style="background:url(/x)">x</p>',
  ];
  for (const patch of UNSAFE)
    it(`refuses ${JSON.stringify(patch)}`, () => {
      expect(refused(web(webAnswer({ patch })))).toBe('unsafe markup in the suggestion');
    });

  it('accepts ordinary accessible markup', () => {
    for (const patch of [
      '<button type="button" aria-label="Close">x</button>',
      '<form><label for="q">Search</label><input id="q"></form>',
      '<p>Turn on the setting</p>',
      '<a href="#main-content">Skip to content</a>',
      '<a href="../help/index.html">Help</a>',
    ])
      expect(web(webAnswer({ patch })).ok, patch).toBe(true);
  });
});

describe('parseAnswer: links', () => {
  it('refuses any http or https URL in summary, notes or steps', () => {
    const link = 'See https://evil.example/fix for details.';
    expect(refused(web(webAnswer({ summary: link })))).toBe('the suggestion contained a link');
    expect(refused(web(webAnswer({ notes: '[docs](http://evil.example)' })))).toBe(
      'the suggestion contained a link',
    );
    expect(refused(web(webAnswer({ notes: 'h t t p s : / / evil.example' })))).toBe(
      'the suggestion contained a link',
    );
    expect(refused(parseAnswer(pdfAnswer({ steps: ['Open HTTPS://evil.example'] }), 'pdf'))).toBe(
      'the suggestion contained a link',
    );
  });

  it('allows an absolute URL in the patch only when the request snippet had it verbatim', () => {
    expect(web(webAnswer()).ok).toBe(true);
    for (const patch of [
      '<a href="https://[redacted:host]/help?ref=x"><img alt="Help"></a>',
      '<a href="https://evil.example/help"><img alt="Help"></a>',
      '<a href="https://[redacted:host]/login"><img alt="Help"></a>',
      '<img src="http://evil.example/x.png" alt="x">',
    ])
      expect(refused(web(webAnswer({ patch }))), patch).toBe('the suggestion contained a link');
    expect(refused(parseAnswer(webAnswer(), 'web'))).toBe('the suggestion contained a link');
  });
});

describe('ANSWER_JSON_SCHEMAS', () => {
  it('is the provider form of the generated JSON Schema of each SuggestionSchema member', () => {
    expect(ANSWER_JSON_SCHEMAS.web).toEqual(toProviderSchema(z.toJSONSchema(WebPatchSchema)));
    expect(ANSWER_JSON_SCHEMAS.pdf).toEqual(toProviderSchema(z.toJSONSchema(PdfStepsSchema)));
  });

  it('pins the web form', () => {
    expect(ANSWER_JSON_SCHEMAS.web).toEqual({
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'web-patch' },
        summary: { type: 'string' },
        patch: { type: 'string' },
        notes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['kind', 'summary', 'patch', 'notes'],
      additionalProperties: false,
    });
  });

  it('pins the PDF form', () => {
    expect(ANSWER_JSON_SCHEMAS.pdf).toEqual({
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'pdf-steps' },
        summary: { type: 'string' },
        tool: { type: 'string', enum: ['word', 'indesign', 'acrobat', 'other'] },
        steps: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
      required: ['kind', 'summary', 'tool', 'steps'],
      additionalProperties: false,
    });
  });

  it('meets strict structured output on both providers', () => {
    const ALLOWED = new Set([
      'type',
      'properties',
      'required',
      'additionalProperties',
      'items',
      'enum',
      'const',
      'anyOf',
      'minItems',
    ]);
    const check = (node: Record<string, unknown>, path: string): void => {
      for (const key of Object.keys(node)) expect(ALLOWED.has(key), `${path}.${key}`).toBe(true);
      if (node.minItems !== undefined) expect([0, 1], path).toContain(node.minItems);
      if (node.type === 'object') {
        expect(node.additionalProperties, path).toBe(false);
        const props = node.properties as Record<string, Record<string, unknown>>;
        expect(node.required, path).toEqual(Object.keys(props));
        for (const [k, v] of Object.entries(props)) check(v, `${path}.${k}`);
      }
      if (node.items) check(node.items as Record<string, unknown>, `${path}[]`);
      for (const option of (node.anyOf as Record<string, unknown>[] | undefined) ?? [])
        check(option, `${path}|`);
    };
    for (const [kind, schema] of Object.entries(ANSWER_JSON_SCHEMAS)) {
      expect(schema.type, kind).toBe('object');
      check(schema as Record<string, unknown>, kind);
    }
  });
});

// Fix round 1: one row per reviewer input.
describe('fix round 1', () => {
  const reason = (patch: string) => refused(web(webAnswer({ patch })));

  describe('1: patch URLs through the tokenizer', () => {
    const LINKS = [
      '<a href="//evil.example/login">x</a>',
      '<a href="https:\\\\evil.example/login">x</a>',
      '<a href="https:/evil.example/login">x</a>',
      '<a href="ftp://evil.example/x">x</a>',
      '<a href="HTTPS://evil.example">x</a>',
      '<img srcset="//evil.example/t.png 1x" alt="t">',
      '<svg><use href="//evil.example/s.svg#a"/></svg>',
      '<a href="/\\evil.example/x">x</a>',
      '<a href=" \t//evil.example/x">x</a>',
      '<a ping="/ok //evil.example/p" href="/ok">x</a>',
      '<img src="/ok.png" src="//evil.example/t.png" alt="t">',
    ];
    for (const patch of LINKS)
      it(`refuses ${JSON.stringify(patch)}`, () => {
        expect(reason(patch)).toBe('the suggestion contained a link');
      });

    it('refuses a form with any action, whatever the attribute order', () => {
      expect(reason('<form title=">" action="//evil.example/c"><input name=p></form>')).toBe(
        'unsafe markup in the suggestion',
      );
      expect(reason('<form action="/search"><input name=q></form>')).toBe(
        'unsafe markup in the suggestion',
      );
    });

    it('refuses a patch the tokenizer cannot fully read', () => {
      for (const patch of [
        '<a href="/x',
        '<p>x</p><a "b"=1>',
        '<!DOCTYPE html><p>x</p>',
        '<p>a<!-- b',
      ])
        expect(reason(patch), patch).toBe('unsafe markup in the suggestion');
    });

    it('allows relative paths, id fragments and URLs the snippet had verbatim', () => {
      for (const patch of [
        '<a href="/help">x</a>',
        '<a href="help/faq.html">x</a>',
        '<a href="#main">x</a>',
        '<img srcset="/a.png 1x, /b.png 2x" alt="a">',
        '<a href="https://[redacted:host]/help">Help</a>',
      ])
        expect(web(webAnswer({ patch })).ok, patch).toBe(true);
    });
  });

  describe('2: CSS', () => {
    for (const patch of [
      '<style>@import "//evil.example/x.css";</style>',
      '<p style="background:u\\72l(//evil.example/t.png)">x</p>',
      '<p style="background-image:image-set(\'//evil.example/t.png\' 1x)">x</p>',
      '<p style="color: #1a1a1a">Readable</p>',
    ])
      it(`refuses ${JSON.stringify(patch)}`, () => {
        expect(reason(patch)).toBe('unsafe markup in the suggestion');
      });

    it('keeps a style attribute the snippet already had with the same value', () => {
      const snippet = '<p style="color: red">x</p>';
      const answer = webAnswer({ patch: '<p style="color: red" role="note">x</p>' });
      expect(parseAnswer(answer, 'web', snippet).ok).toBe(true);
      const changed = webAnswer({ patch: '<p style="color: blue">x</p>' });
      expect(refused(parseAnswer(changed, 'web', snippet))).toBe('unsafe markup in the suggestion');
    });
  });

  describe('3: prototype keys', () => {
    it("refuses the reviewer's __proto__ answer", () => {
      const raw =
        '{"kind":"web-patch","summary":"s","patch":"<a href=\\"/hr\\">x</a>","__proto__":{"notes":"hi \u202e\\u0007\u200b evil"}}';
      expect(refused(web(raw))).toBe('the answer does not match the schema');
    });

    it('refuses constructor and prototype keys at any depth', () => {
      expect(refused(web(webAnswer({ constructor: { x: 1 } })))).toBe(
        'the answer does not match the schema',
      );
      const nested =
        '{"kind":"pdf-steps","summary":"s","tool":"word","steps":["a"],"x":{"prototype":1}}';
      expect(refused(parseAnswer(nested, 'pdf'))).toBe('the answer does not match the schema');
    });

    it('returns a suggestion with only schema keys', () => {
      const result = web(webAnswer());
      expect(result.ok && Object.keys(result.suggestion).sort()).toEqual([
        'kind',
        'patch',
        'summary',
      ]);
    });
  });

  describe('4: links in prose', () => {
    const LINKY = [
      'Read www.evil.example first.',
      'See //evil.example for more.',
      'Follow [the guide](x) to fix it.',
      'Open <https:evil.example> now.',
      'Open <mailto:a@b.co> now.',
      'Go to ftp:\\\\evil.example.',
      'Ask jane@evil.example for help.',
      'See evil.example/fix for the fix.',
      'See evil.example for the fix.',
      'Visit evil.xn--p1ai today.',
      'Edit index.html/../x to fix it.',
      'h t t p s : / / evil.example',
    ];
    for (const summary of LINKY)
      it(`refuses ${JSON.stringify(summary)}`, () => {
        expect(refused(web(webAnswer({ summary })))).toBe('the suggestion contained a link');
        expect(refused(parseAnswer(pdfAnswer({ steps: [summary] }), 'pdf'))).toBe(
          'the suggestion contained a link',
        );
      });

    it('allows file names with a known extension', () => {
      for (const summary of [
        'Edit index.html and styles.css.',
        'Open report.docx in Word, then export annual-report.pdf.',
        'Replace logo.svg; e.g. keep the same size, i.e. 32 by 32.',
        'WCAG 2.1 success criterion 1.1.1 applies.',
      ])
        expect(web(webAnswer({ summary })).ok, summary).toBe(true);
    });
  });

  describe('5: one invisible-character list', () => {
    it('strips format characters, tag characters, variation selectors and Hangul fillers', () => {
      const summary =
        'Add\u0600 alt\u{e0041} text\ufe0f\u{e0100} now\u3164\u115f\u1160\u00ad\u061c';
      const result = web(webAnswer({ summary }));
      expect(result.ok && result.suggestion.summary).toBe('Add alt text now');
    });

    it('turns line and paragraph separators into a space, or a newline in patch and notes', () => {
      const result = web(webAnswer({ summary: 'a\u2028b\u2029c', notes: 'a\u2028b' }));
      expect(result.ok && result.suggestion).toMatchObject({ summary: 'a b c', notes: 'a\nb' });
    });
  });
});

// Fix round 2: one row per reviewer input.
describe('fix round 2', () => {
  const reason = (patch: string) => refused(web(webAnswer({ patch })));
  const UNSAFE = 'unsafe markup in the suggestion';
  const LINK = 'the suggestion contained a link';

  describe('1: the patch check never sees less markup than a browser', () => {
    const ROWS: [patch: string, why: string][] = [
      ['<!--><a href="//evil.example/login">Sign in</a>-->', UNSAFE],
      ['<!---><a href="//evil.example/login">Sign in</a>-->', UNSAFE],
      ['<!-- x --!><form action="//evil.example/c"><input name=p></form> -->', UNSAFE],
      ['<!--><div style="background:url(//evil.example/t.png)">x</div>-->', UNSAFE],
      [
        '<!--><svg><a><animate attributeName="href" to="//evil.example/x"/><text>Go</text></a></svg>-->',
        UNSAFE,
      ],
      ['<svg><textarea><a href="//evil.example/x"><text>Go</text></a></textarea></svg>', LINK],
      ['<svg><xmp><img src="//evil.example/t.png"></xmp></svg>', LINK],
      ['<math><noembed><a href="//evil.example/x">Go</a></noembed></math>', LINK],
      ['<p>a harmless comment <!-- note --></p>', UNSAFE],
      ['<textarea>no end tag', UNSAFE],
      ['<svg><animate attributeName="href" to="/x"/></svg>', UNSAFE],
      ['<p>href="//evil.example/x"</p>', LINK],
      ['<p>src = "https://evil.example/t.png"</p>', LINK],
    ];
    for (const [patch, why] of ROWS)
      it(`refuses ${JSON.stringify(patch)}`, () => {
        expect(reason(patch)).toBe(why);
      });

    it('keeps text that only mentions an attribute, and a URL the snippet had', () => {
      for (const patch of [
        '<p>Set the href attribute to the page address.</p>',
        '<a href="https://[redacted:host]/help">Help</a>',
        '<textarea id="m" aria-label="Message"></textarea>',
      ])
        expect(web(webAnswer({ patch })).ok, patch).toBe(true);
    });
  });

  describe('2: url( in any attribute', () => {
    for (const patch of [
      '<svg><rect cursor="url(//evil.example/c.png), auto"/></svg>',
      '<svg><rect filter="url(//evil.example/f.svg#f)"/></svg>',
      '<svg><rect fill="u&#x72;l(#g)"/></svg>',
    ])
      it(`refuses ${JSON.stringify(patch)}`, () => {
        expect(reason(patch)).toBe(UNSAFE);
      });
  });

  describe('3: embedded absolute URLs', () => {
    for (const patch of [
      '<a href="/redirect?to=https://evil.example">x</a>',
      '<a href="go?u=ftp:\\\\evil.example">x</a>',
    ])
      it(`refuses ${JSON.stringify(patch)}`, () => {
        expect(reason(patch)).toBe(LINK);
      });
  });

  describe('4 and 5: prose', () => {
    const REFUSED = [
      'Read phish.md first.',
      'Connect to 192.168.1.10 to test.',
      'See \u043f\u0440\u0438\u043c\u0435\u0440.\u0440\u0444 for help.',
      'See evil\u3002example for help.',
      'See evil\uff0eexample for help.',
      'See evil\uff61example for help.',
      'See \uff45\uff56\uff49\uff4c.example for help.',
      '`www.evil.example`',
      '`//evil.example`',
      'Remove the `// comment`',
      '`https://evil.example/x`',
      '`jane@evil.example`',
    ];
    for (const summary of REFUSED)
      it(`refuses ${JSON.stringify(summary)}`, () => {
        expect(refused(web(webAnswer({ summary })))).toBe(LINK);
      });

    it('passes code names in backticks and ordinary numbers', () => {
      for (const summary of [
        'Set `document.title` in your router.',
        'In `ASP.NET`, set the alt in the view.',
        'WCAG 2.1 success criterion 1.1.1 applies.',
        'Use version 1.30.3 of the tool.',
      ])
        expect(web(webAnswer({ summary })).ok, summary).toBe(true);
    });
  });

  describe('6: residual invisibles and depth', () => {
    it('strips U+034F and U+FFA0', () => {
      const result = web(webAnswer({ summary: 'Add\u034f alt\uffa0 text' }));
      expect(result.ok && result.suggestion.summary).toBe('Add alt text');
    });

    it(`refuses nesting past ${ANSWER_MAX_DEPTH}`, () => {
      expect(ANSWER_MAX_DEPTH).toBe(32);
      const nest = (n: number) => `${'['.repeat(n)}"a"${']'.repeat(n)}`;
      const raw = (n: number) =>
        `{"kind":"pdf-steps","summary":"s","tool":"word","steps":${nest(n)}}`;
      expect(refused(parseAnswer(raw(40), 'pdf'))).toBe('the answer does not match the schema');
      expect(refused(parseAnswer(raw(30_000), 'pdf'))).toBe('the answer does not match the schema');
    });
  });
});

// Task 3b.3 carry-over (security re-review fix2, two optional Minors ruled in).
describe('3b.3 carry-over', () => {
  it('refuses xml:base in a patch', () => {
    expect(refused(web(webAnswer({ patch: '<svg><a xml:base="//evil.example/" href="x">' })))).toBe(
      'unsafe markup in the suggestion',
    );
    expect(
      refused(web(webAnswer({ patch: '<svg><a xml:base="docs/" href="x">Go</a></svg>' }))),
    ).toBe('unsafe markup in the suggestion');
  });

  it('refuses a dotted host followed by / inside a code span', () => {
    expect(
      refused(web(webAnswer({ summary: 'Host the font on `fonts.evil.example/inter.css`' }))),
    ).toBe('the suggestion contained a link');
  });

  it('still passes code names and a bare dotted name in a code span', () => {
    for (const summary of [
      'Set `document.title` here.',
      'In `ASP.NET`, set the alt.',
      'Point it at `evil.example`',
    ])
      expect(web(webAnswer({ summary })).ok, summary).toBe(true);
  });
});

// Task 3b.5: the OpenAI form of the answer schemas.
describe('toOpenAiSchema', () => {
  it('turns every const into a one-value enum and changes nothing else', () => {
    expect(toOpenAiSchema(ANSWER_JSON_SCHEMAS.web)).toEqual({
      ...ANSWER_JSON_SCHEMAS.web,
      properties: {
        ...(ANSWER_JSON_SCHEMAS.web.properties as Record<string, unknown>),
        kind: { type: 'string', enum: ['web-patch'] },
      },
    });
    const pdf = toOpenAiSchema(ANSWER_JSON_SCHEMAS.pdf);
    expect(JSON.stringify(pdf)).not.toContain('"const"');
    expect((pdf.properties as Record<string, unknown>).kind).toEqual({
      type: 'string',
      enum: ['pdf-steps'],
    });
  });

  it('carries no count or length keyword at all', () => {
    const COUNTS = ['minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum'];
    for (const kind of ['web', 'pdf'] as const) {
      const text = JSON.stringify(toOpenAiSchema(ANSWER_JSON_SCHEMAS[kind]));
      for (const keyword of COUNTS)
        expect(text, `${kind} ${keyword}`).not.toContain(`"${keyword}"`);
    }
    const steps = (toOpenAiSchema(ANSWER_JSON_SCHEMAS.pdf).properties as Record<string, unknown>)
      .steps;
    expect(steps).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('does not change the input', () => {
    const before = JSON.stringify(ANSWER_JSON_SCHEMAS.web);
    toOpenAiSchema(ANSWER_JSON_SCHEMAS.web);
    expect(JSON.stringify(ANSWER_JSON_SCHEMAS.web)).toBe(before);
  });
});
