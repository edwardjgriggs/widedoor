import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MODEL_ID_RULE } from '@widedoor/core';
import {
  ConfigError,
  buildPlan,
  classifyTarget,
  loadConfig,
  type PlanArgs,
} from '../src/config.ts';
import { UsageError } from '../src/settings.ts';

const dir = mkdtempSync(join(tmpdir(), 'widedoor-config-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
/** YAML from lines, one per argument. */
const yaml = (...lines: string[]) =>
  `${lines.join(String.fromCharCode(10))}${String.fromCharCode(10)}`;

function configFile(text: string): string {
  const sub = join(dir, `c${n++}`);
  mkdirSync(sub);
  const file = join(sub, 'widedoor.config.yaml');
  writeFileSync(file, text);
  return file;
}

const problems = (text: string): readonly string[] => {
  try {
    loadConfig(configFile(text));
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  throw new Error('expected a ConfigError');
};

/** What widedoor scan or a scan request asks for: targets, and the flags or fields set. */
const scan = (
  targets: string[] = [],
  flags: Omit<Partial<PlanArgs>, 'targets'> = {},
): PlanArgs => ({
  targets,
  unsafeNoSandbox: false,
  ...flags,
});

const SPEC_EXAMPLE = `profile: 508+wcag21aa
web:
  urls: [https://example.com/]
  sitemap: https://example.com/sitemap.xml
  crawl: { sameOrigin: true, maxPages: 50 }
  auth: { storageState: .widedoor/auth.json }   # CLI and local only
  actions: []            # later: scripted states
pdf:
  include: ["public/**/*.pdf"]
report:
  formats: [html, json, sarif]
  failOn: serious        # CI exit code threshold
ai:
  enabled: false
  provider: anthropic    # or openai
`;

describe('loadConfig', () => {
  it('accepts the spec example', () => {
    const loaded = loadConfig(configFile(SPEC_EXAMPLE));
    expect(loaded.config.web?.crawl).toEqual({ sameOrigin: true, maxPages: 50 });
    expect(loaded.config.pdf?.include).toEqual(['public/**/*.pdf']);
  });

  it('treats an empty file as an empty config', () => {
    expect(loadConfig(configFile('')).config).toEqual({});
  });

  it('rejects unknown keys at every level, naming the path', () => {
    expect(problems('profle: 508\nweb:\n  crawl: { maxPage: 3 }\n').toSorted()).toEqual([
      '(top level): unknown key "profle"',
      'web.crawl: unknown key "maxPage"',
    ]);
  });

  it('rejects bad values with readable paths', () => {
    expect(
      problems(
        'profile: wcag22\nweb:\n  urls: [https://ok.example/, "file:///etc/passwd"]\n  crawl: { maxPages: 0 }\nreport:\n  formats: []\n  failOn: high\n',
      ),
    ).toEqual([
      expect.stringMatching(/^profile: /),
      'web.urls[1]: expected an http or https URL',
      expect.stringMatching(/^web\.crawl\.maxPages: /),
      expect.stringMatching(/^report\.formats: /),
      expect.stringMatching(/^report\.failOn: /),
    ]);
  });

  it('rejects features that are not supported yet', () => {
    expect(problems(yaml('web:', '  actions: [{ click: "#menu" }]'))).toEqual([
      'web.actions: scripted actions are not supported yet; leave web.actions empty',
    ]);
  });

  describe('the ai block', () => {
    it('accepts every field', () => {
      const loaded = loadConfig(
        configFile(
          yaml(
            'ai:',
            '  enabled: true',
            '  provider: openai',
            '  model: gpt-5.5',
            '  maxGroups: 10',
            '  maxRequestsPerMinute: 5',
            '  concurrency: 2',
            '  maxOutputTokens: 4096',
            '  maxInputTokensTotal: 100000',
          ),
        ),
      );
      expect(loaded.config.ai).toEqual({
        enabled: true,
        provider: 'openai',
        model: 'gpt-5.5',
        maxGroups: 10,
        maxRequestsPerMinute: 5,
        concurrency: 2,
        maxOutputTokens: 4096,
        maxInputTokensTotal: 100000,
      });
      expect(loadConfig(configFile(yaml('ai:', '  enabled: true'))).config.ai).toEqual({
        enabled: true,
      });
    });

    it('refuses a key-shaped field at any depth, with the environment message', () => {
      const KEY_MESSAGE =
        'API keys come from ANTHROPIC_API_KEY or OPENAI_API_KEY, never the config file';
      for (const lines of [
        ['ai:', '  apiKey: sk-ant-x'],
        ['ai:', '  key: sk-x'],
        ['ai:', '  token: t'],
        ['ai:', '  OPENAI_API_KEY: sk-x'],
        ['ai:', '  enabled: true', '  openai:', '    apiKey: sk-x'],
        ['ai:', '  provider: anthropic', '  extra:', '    - secret: s'],
      ])
        expect(problems(yaml(...lines)).join(' | '), lines.join(' / ')).toContain(KEY_MESSAGE);
      expect(problems(yaml('ai:', '  apiKey: sk-ant-SECRET')).join(' ')).not.toContain('SECRET');
    });

    // 3b.7 fix round 1 item 2: a key pasted into ai.model (CWE-532).
    it('refuses a key-shaped model with the environment message, never echoing it', () => {
      const KEY_MESSAGE =
        'API keys come from ANTHROPIC_API_KEY or OPENAI_API_KEY, never the config file';
      for (const model of [
        'sk-proj-SECRETabc123def456',
        'sk-ant-api03-SECRET-x1y2z3',
        'sk-SECRET123',
        'sk_live_SECRET',
        'SECRETa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
        'my-token-SECRET',
      ]) {
        const found = problems(yaml('ai:', `  model: ${model}`)).join(' | ');
        expect(found, model).toContain(KEY_MESSAGE);
        expect(found, model).not.toContain('SECRET');
      }
      for (const model of ['claude-opus-5-5', 'gpt-5.5', 'claude-3-5-sonnet-20241022', 'o4-mini'])
        expect(loadConfig(configFile(yaml('ai:', `  model: ${model}`))).config.ai?.model).toBe(
          model,
        );
    });

    it('holds the model to its characters and the limits to their ranges', () => {
      for (const line of [
        '  model: "bad model"',
        `  model: ${'m'.repeat(101)}`,
        '  maxGroups: 0',
        '  maxGroups: 201',
        '  maxRequestsPerMinute: 61',
        '  concurrency: 5',
        '  maxOutputTokens: 100',
        '  maxInputTokensTotal: 999',
        '  provider: gemini',
        '  temperature: 0.2',
      ])
        expect(problems(yaml('ai:', line)).length, line).toBeGreaterThan(0);
    });

    // Final fix round 1 item 15: ai.model, --ai-model, the runner and the providers share one rule.
    it('takes the model ids the providers take, with "@" and "/", and names the rule', () => {
      for (const model of ['anthropic/claude-opus-5-5', 'claude-opus-5-5@2026-10-01'])
        expect(loadConfig(configFile(yaml('ai:', `  model: ${model}`))).config.ai?.model).toBe(
          model,
        );
      expect(problems(yaml('ai:', '  model: "bad model"')).join(' ')).toContain(
        `must be ${MODEL_ID_RULE}`,
      );
    });
  });

  it('rejects PDF globs that leave the config folder', () => {
    for (const pattern of [
      '../x/*.pdf',
      '/abs/*.pdf',
      'C:/x/*.pdf',
      'C:x/*.pdf',
      'a/../../b.pdf',
      '{../outside,sub}/*.pdf',
      '[.][.]/outside/*.pdf',
      '.[.]/outside/*.pdf',
    ])
      expect(problems(`pdf:\n  include: ["${pattern}"]\n`)).toEqual([
        expect.stringMatching(/^pdf\.include\[0\]: must be a relative pattern/),
      ]);
  });

  it('bounds pdf.maxBytes and takes only http(s) pdf.urls', () => {
    for (const value of ['0', String(100 * 1024 * 1024 + 1), '1.5'])
      expect(problems(`pdf:\n  maxBytes: ${value}\n`)).toEqual([
        expect.stringMatching(/^pdf\.maxBytes: /),
      ]);
    expect(problems('pdf:\n  urls: [file:///etc/a.pdf]\n')).toEqual([
      'pdf.urls[0]: expected an http or https URL',
    ]);
    expect(
      loadConfig(configFile('pdf:\n  urls: [https://a.example/x]\n  maxBytes: 104857600\n')).config
        .pdf,
    ).toEqual({ urls: ['https://a.example/x'], maxBytes: 104857600 });
  });

  it('reports YAML syntax errors, duplicate keys and a missing file', () => {
    expect(problems('web: [unclosed\n')[0]).toMatch(/^not valid YAML: /);
    expect(problems('profile: 508\nprofile: wcag21aa\n')[0]).toMatch(
      /^not valid YAML: Map keys must be unique/,
    );
    expect(() => loadConfig(join(dir, 'nope.yaml'))).toThrow(/no such file/);
  });

  it('treats unknown YAML tags as errors instead of strings, and prints nothing itself', () => {
    const warn = process.emitWarning;
    const emitted: unknown[] = [];
    process.emitWarning = ((w: unknown) => void emitted.push(w)) as typeof process.emitWarning;
    try {
      const esc = String.fromCharCode(0x1b);
      const lines = problems(`profile: !weird wcag21aa\nweb: !!js/function "${esc}[2J"\n`);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => l.startsWith('not valid YAML: '))).toBe(true);
      expect(lines.join('')).not.toContain(esc);
    } finally {
      process.emitWarning = warn;
    }
    expect(emitted).toEqual([]);
  });

  it('holds against the YAML probes: alias bombs, prototype keys, merge keys, binary', () => {
    const levels = ['a: &a [x, x, x, x, x, x, x, x, x]'];
    for (const c of 'bcdefghi')
      levels.push(
        `${c}: &${c} [${Array(9)
          .fill(`*${String.fromCharCode(c.charCodeAt(0) - 1)}`)
          .join(', ')}]`,
      );
    expect(problems(`${levels.join('\n')}\n`)[0]).toMatch(/^not valid YAML: .*alias/i);
    expect(problems('__proto__: { polluted: 1 }\n')).toEqual([
      '(top level): unknown key "__proto__"',
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(problems('b: &b { profile: 508 }\n<<: *b\n')).toEqual([
      expect.stringMatching(/^\(top level\): unknown keys? /),
    ]);
    expect(problems('profile: !!binary aGVsbG8=\n')[0]).toMatch(/^profile: /);
  });

  it('deduplicates report.formats', () => {
    const loaded = loadConfig(configFile('report:\n  formats: [html, json, html]\n'));
    expect(loaded.config.report?.formats).toEqual(['html', 'json']);
  });

  it('refuses a config file that is a symbolic link', () => {
    const real = configFile('profile: 508\n');
    const link = join(dir, `link-${n++}.yaml`);
    try {
      symlinkSync(real, link, 'file');
    } catch {
      return; // File links need privileges this Windows account may not have.
    }
    expect(() => loadConfig(link)).toThrow(/symbolic link/);
  });
});

describe('classifyTarget', () => {
  it('splits http(s) URLs from local PDF files, Windows drive paths included', () => {
    expect(classifyTarget('https://example.com/a')).toEqual({
      kind: 'url',
      url: 'https://example.com/a',
    });
    expect(classifyTarget('https://example.com/r/Report.PDF?v=2')).toEqual({
      kind: 'pdf-url',
      url: 'https://example.com/r/Report.PDF?v=2',
    });
    expect(classifyTarget('https://example.com/view?file=a.pdf')).toEqual({
      kind: 'url',
      url: 'https://example.com/view?file=a.pdf',
    });
    expect(classifyTarget('docs/A.PDF')).toEqual({ kind: 'file', path: 'docs/A.PDF' });
    expect(classifyTarget('C:\\docs\\a.pdf')).toEqual({ kind: 'file', path: 'C:\\docs\\a.pdf' });
  });

  it('refuses other schemes and non-PDF files', () => {
    expect(() => classifyTarget('file:///tmp/a.pdf')).toThrow(UsageError);
    expect(() => classifyTarget('javascript:alert(1)')).toThrow(
      /http and https URLs and local PDF files/,
    );
    expect(() => classifyTarget('page.html')).toThrow(/local files must be PDFs/);
  });
});

describe('buildPlan', () => {
  const cwd = resolve(dir, 'cwd');

  it('zero-config: targets only, with the defaults', () => {
    const plan = buildPlan(scan(['https://example.com/', 'a.pdf']), undefined, cwd);
    expect(plan).toEqual({
      profile: '508+wcag21aa',
      pdfDocumentType: 'non-web',
      pdfMaxBytes: 50 * 1024 * 1024,
      formats: ['html', 'json', 'sarif'],
      failOn: 'serious',
      out: resolve(cwd, 'widedoor-report'),
      web: { urls: ['https://example.com/'], maxPages: 50, maxPagesSetting: 'default' },
      pdf: { baseDir: cwd, files: ['a.pdf'], include: [], urls: [] },
      reviewDir: cwd,
      outRoots: [cwd],
      unsafeNoSandbox: false,
      concurrency: 1,
      memoryMb: 768,
    });
  });

  it('takes the scope from the config, relative to the config folder', () => {
    const file = configFile(
      'profile: wcag21aa\nweb:\n  urls: [https://example.com/]\n  sitemap: https://example.com/sitemap.xml\n  crawl: { maxPages: 5 }\npdf:\n  include: ["docs/*.pdf"]\nreport:\n  formats: [json]\n  failOn: minor\n',
    );
    const loaded = loadConfig(file);
    const plan = buildPlan(scan(), loaded, cwd);
    expect(plan.profile).toBe('wcag21aa');
    expect(plan.formats).toEqual(['json']);
    expect(plan.failOn).toBe('minor');
    expect(plan.web).toEqual({
      urls: ['https://example.com/'],
      sitemap: 'https://example.com/sitemap.xml',
      crawl: { sameOrigin: true, maxPages: 5 },
      maxPages: 5,
      maxPagesSetting: 'web.crawl.maxPages',
    });
    expect(plan.pdf).toEqual({
      baseDir: loaded.dir,
      files: [],
      include: ['docs/*.pdf'],
      urls: [],
    });
    expect(plan.reviewDir).toBe(loaded.dir);
    expect(plan.outRoots).toEqual([cwd, loaded.dir]);
    expect(plan.configFile).toBe(file);
  });

  it('lets targets replace the config scope and flags override the config', () => {
    const loaded = loadConfig(
      configFile(
        'web:\n  urls: [https://config.example/]\n  sitemap: https://config.example/s.xml\n  crawl: { sameOrigin: false, maxPages: 9 }\npdf:\n  include: ["*.pdf"]\nreport:\n  failOn: minor\n',
      ),
    );
    const plan = buildPlan(
      scan(['https://cli.example/'], { failOn: 'none', profile: '508' }),
      loaded,
      cwd,
    );
    expect(plan.web).toEqual({
      urls: ['https://cli.example/'],
      crawl: { sameOrigin: false, maxPages: 9 },
      maxPages: 9,
      maxPagesSetting: 'web.crawl.maxPages',
    });
    expect(plan.pdf).toBeUndefined();
    expect(plan.failOn).toBe('none');
    expect(plan.profile).toBe('508');
  });

  it('takes a lower maxPages for one run (a scan request), never one above the page cap', () => {
    const crawl = loadConfig(
      configFile('web:\n  urls: [https://config.example/]\n  crawl: { maxPages: 9 }\n'),
    );
    expect(buildPlan(scan([], { maxPages: 4 }), crawl, cwd).web).toMatchObject({
      maxPages: 4,
      crawl: { sameOrigin: true, maxPages: 4 },
    });
    expect(buildPlan(scan([], { maxPages: 9 }), crawl, cwd).web?.maxPages).toBe(9);
    expect(() => buildPlan(scan([], { maxPages: 10 }), crawl, cwd)).toThrow(
      new UsageError('maxPages must be at most 9 (web.crawl.maxPages in the config)'),
    );
    expect(() =>
      buildPlan(scan(['https://example.com/'], { maxPages: 51 }), undefined, cwd),
    ).toThrow('maxPages must be at most 50 (the default page cap)');
    expect(
      buildPlan(scan(['https://example.com/'], { maxPages: 50 }), undefined, cwd).web,
    ).toMatchObject({ maxPages: 50, maxPagesSetting: 'default' });
  });

  it('fetches command-line URLs ending in .pdf as PDFs, replacing pdf.urls', () => {
    const loaded = loadConfig(
      configFile('pdf:\n  urls: [https://config.example/x.pdf]\n  maxBytes: 1048576\n'),
    );
    const plan = buildPlan(
      scan(['https://cli.example/', 'https://cli.example/a.pdf', 'b.pdf']),
      loaded,
      cwd,
    );
    expect(plan.web?.urls).toEqual(['https://cli.example/']);
    expect(plan.pdf).toEqual({
      baseDir: cwd,
      files: ['b.pdf'],
      include: [],
      urls: ['https://cli.example/a.pdf'],
    });
    expect(plan.pdfMaxBytes).toBe(1048576);
  });

  it('takes pdf.urls from the config, with no web scope needed', () => {
    const loaded = loadConfig(configFile('pdf:\n  urls: [https://config.example/report]\n'));
    const plan = buildPlan(scan(), loaded, cwd);
    expect(plan.web).toBeUndefined();
    expect(plan.pdf).toEqual({
      baseDir: loaded.dir,
      files: [],
      include: [],
      urls: ['https://config.example/report'],
    });
    expect(plan.pdfMaxBytes).toBe(50 * 1024 * 1024);
    // Unset, the run decides from the veraPDF runner.
    expect(plan.pdfFetch).toBeUndefined();
  });

  it('takes pdf.fetch from the config, and only a boolean', () => {
    for (const value of [true, false])
      expect(
        buildPlan(
          scan(),
          loadConfig(configFile(`pdf:\n  urls: [https://a.example/x]\n  fetch: ${value}\n`)),
          cwd,
        ).pdfFetch,
      ).toBe(value);
    expect(problems('pdf:\n  fetch: "yes"\n')).toEqual([expect.stringMatching(/^pdf\.fetch: /)]);
  });

  describe('page cap precedence', () => {
    const cap = (yaml: string) => {
      const web = buildPlan(scan(), loadConfig(configFile(yaml)), cwd).web;
      return { maxPages: web?.maxPages, from: web?.maxPagesSetting, crawl: web?.crawl?.maxPages };
    };
    const urls = 'web:\n  urls: [https://a.example/]\n';

    it('defaults to 50 with or without a crawl', () => {
      expect(cap(urls)).toEqual({ maxPages: 50, from: 'default', crawl: undefined });
      expect(cap(`${urls}  crawl: {}\n`)).toEqual({ maxPages: 50, from: 'default', crawl: 50 });
    });

    it('takes web.maxPages for a run without a crawl, and for a crawl that sets none', () => {
      expect(cap(`${urls}  maxPages: 200\n`)).toEqual({
        maxPages: 200,
        from: 'web.maxPages',
        crawl: undefined,
      });
      expect(cap(`${urls}  maxPages: 200\n  crawl: {}\n`)).toEqual({
        maxPages: 200,
        from: 'web.maxPages',
        crawl: 200,
      });
    });

    it('lets web.crawl.maxPages win over web.maxPages', () => {
      expect(cap(`${urls}  maxPages: 200\n  crawl: { maxPages: 7 }\n`)).toEqual({
        maxPages: 7,
        from: 'web.crawl.maxPages',
        crawl: 7,
      });
    });

    it('refuses a cap that is not a positive integer', () => {
      expect(() => loadConfig(configFile(`${urls}  maxPages: 0\n`))).toThrow(ConfigError);
    });
  });

  describe('pdf.documentType (spec D20)', () => {
    const include = 'pdf:\n  include: ["*.pdf"]\n';

    it('defaults to non-web', () => {
      expect(buildPlan(scan(), loadConfig(configFile(include)), cwd).pdfDocumentType).toBe(
        'non-web',
      );
    });

    for (const value of ['non-web', 'web'] as const)
      it(`carries ${value} into the plan, also when targets replace the scope`, () => {
        const loaded = loadConfig(configFile(`${include}  documentType: ${value}\n`));
        expect(buildPlan(scan(), loaded, cwd).pdfDocumentType).toBe(value);
        expect(buildPlan(scan(['a.pdf']), loaded, cwd).pdfDocumentType).toBe(value);
      });

    it('refuses any other value', () => {
      expect(() => loadConfig(configFile(`${include}  documentType: html\n`))).toThrow(ConfigError);
    });
  });

  describe('acr block (Task 2.7)', () => {
    const urls = 'web:\n  urls: [https://example.com/]\n';
    const ACR = [
      'acr:',
      '  vendor: { name: Example Agency, contact: accessibility@example.gov }',
      '  product: { name: Permit portal, version: "2.10", description: Online permit applications. }',
      '  notes: |',
      '    Tested on staging.',
      '    Second line.',
      '  reportDate: 2026-10-23',
      '',
    ].join('\n');
    const openacr = (flags: Omit<Partial<PlanArgs>, 'targets'> = {}) =>
      scan([], { formats: ['openacr'], ...flags });

    it('reads the metadata into the plan for an ACR format', () => {
      const plan = buildPlan(openacr(), loadConfig(configFile(`${urls}${ACR}`)), cwd);
      expect(plan.formats).toEqual(['openacr']);
      expect(plan.acr).toEqual({
        vendor: { name: 'Example Agency', contact: 'accessibility@example.gov' },
        product: {
          name: 'Permit portal',
          version: '2.10',
          description: 'Online permit applications.',
        },
        notes: 'Tested on staging.\nSecond line.',
        reportDate: '2026-10-23',
      });
    });

    it('leaves it out of the plan when no ACR format is written', () => {
      expect(buildPlan(scan(), loadConfig(configFile(`${urls}${ACR}`)), cwd).acr).toBeUndefined();
    });

    it('takes an ACR format from report.formats too', () => {
      const loaded = loadConfig(configFile(`${urls}${ACR}report:\n  formats: [json, openacr]\n`));
      expect(buildPlan(scan(), loaded, cwd).acr?.product?.name).toBe('Permit portal');
    });

    it('needs acr.product.name for an ACR format, a usage error naming the key', () => {
      const loaded = loadConfig(configFile(`${urls}acr:\n  vendor: { contact: a@example.gov }\n`));
      expect(() => buildPlan(openacr(), loaded, cwd)).toThrow(UsageError);
      expect(() => buildPlan(openacr(), loaded, cwd)).toThrow(
        /the openacr format needs acr\.product\.name in .*widedoor\.config\.yaml$/,
      );
      expect(() =>
        buildPlan(scan(['https://example.com/'], { formats: ['openacr'] }), undefined, cwd),
      ).toThrow(/needs acr\.product\.name in a config file \(none was given or found\)$/);
      // The other keys only leave the ACR a draft.
      const named = loadConfig(
        configFile(
          `${urls}acr:\n  vendor: { contact: a@example.gov }\n  product: { name: Portal }\n`,
        ),
      );
      expect(buildPlan(openacr(), named, cwd).acr).toEqual({
        vendor: { contact: 'a@example.gov' },
        product: { name: 'Portal' },
      });
    });

    it('needs acr.product.name and the 508 view for vpat-html and vpat-docx too', () => {
      const unnamed = loadConfig(configFile(`${urls}acr:\n  vendor: { name: Example Agency }\n`));
      for (const format of ['vpat-html', 'vpat-docx'] as const) {
        expect(() => buildPlan(scan([], { formats: [format] }), unnamed, cwd)).toThrow(
          new RegExp(`^the ${format} format needs acr\\.product\\.name in `),
        );
        expect(() =>
          buildPlan(scan([], { formats: ['json', format], profile: 'wcag21aa' }), unnamed, cwd),
        ).toThrow(`the ${format} format needs the Section 508 view`);
      }
      const loaded = loadConfig(configFile(`${urls}${ACR}`));
      const plan = buildPlan(scan([], { formats: ['vpat-html', 'vpat-docx'] }), loaded, cwd);
      expect(plan.formats).toEqual(['vpat-html', 'vpat-docx']);
      expect(plan.acr?.product?.name).toBe('Permit portal');
    });

    it('needs the Section 508 view, naming the profiles that have it', () => {
      const loaded = loadConfig(configFile(`${urls}${ACR}`));
      expect(() => buildPlan(openacr({ profile: 'wcag21aa' }), loaded, cwd)).toThrow(
        'the openacr format needs the Section 508 view, which profile wcag21aa does not have; use --profile 508 or 508+wcag21aa',
      );
      const wcagOnly = loadConfig(configFile(`profile: wcag21aa\n${urls}${ACR}`));
      expect(() => buildPlan(openacr(), wcagOnly, cwd)).toThrow(UsageError);
      for (const profile of ['508', '508+wcag21aa'] as const)
        expect(buildPlan(openacr({ profile }), loaded, cwd).profile).toBe(profile);
    });

    it('is strict, and checks the report date and the value types', () => {
      expect(problems('acr:\n  vendr: {}\n  product: { name: x, owner: y }\n').toSorted()).toEqual([
        'acr.product: unknown key "owner"',
        'acr: unknown key "vendr"',
      ]);
      for (const date of ['2026-02-30', '"23 October 2026"', '2026-10-23T00:00:00Z'])
        expect(problems(`acr:\n  reportDate: ${date}\n`), date).toEqual([
          'acr.reportDate: must be a date written YYYY-MM-DD, for example "2026-10-23"',
        ]);
      expect(problems('acr:\n  product: { name: x, version: 2.10 }\n')).toEqual([
        'acr.product.version: must be text; quote a value YAML would read as a number, such as "2.10"',
      ]);
      expect(problems('acr:\n  product: { name: "  " }\n')).toEqual([
        expect.stringMatching(/^acr\.product\.name: /),
      ]);
    });
  });

  it('resolves web.auth.storageState against the config folder and requires the file', () => {
    const file = configFile(
      'web:\n  urls: [https://example.com/]\n  auth: { storageState: auth/state.json }\n',
    );
    const loaded = loadConfig(file);
    expect(() => buildPlan(scan(), loaded, cwd, {})).toThrow(ConfigError);
    // The message names the setting, never a resolved path (no existence oracle).
    expect(() => buildPlan(scan(), loaded, cwd, {})).toThrow(
      /web\.auth\.storageState: no such file$/,
    );
    mkdirSync(join(loaded.dir, 'auth'));
    writeFileSync(
      join(loaded.dir, 'auth', 'state.json'),
      '{"cookies":[{"value":"secret-cookie"}]}',
    );
    const plan = buildPlan(scan(), loaded, cwd, {});
    expect(plan.web?.storageState).toBe(join(loaded.dir, 'auth', 'state.json'));
    expect(JSON.stringify(plan)).not.toContain('secret-cookie');
  });

  it('keeps a config storageState inside the config folder', () => {
    for (const path of ['../outside.json', resolve(dir, 'abs.json')]) {
      writeFileSync(resolve(dir, 'abs.json'), '{}');
      const loaded = loadConfig(
        configFile(
          `web:\n  urls: [https://example.com/]\n  auth: { storageState: ${JSON.stringify(path)} }\n`,
        ),
      );
      expect(() => buildPlan(scan(), loaded, cwd, {}), path).toThrow(
        /storageState: must be inside the config folder/,
      );
    }
  });

  it('takes the storage state from --storage-state, then WIDEDOOR_STORAGE_STATE, before the config', () => {
    const elsewhere = join(dir, 'runner-state.json');
    writeFileSync(elsewhere, '{}');
    const loaded = loadConfig(
      configFile('web:\n  urls: [https://example.com/]\n  auth: { storageState: ../never.json }\n'),
    );
    expect(
      buildPlan(scan([], { storageState: elsewhere }), loaded, cwd, {}).web?.storageState,
    ).toBe(elsewhere);
    expect(
      buildPlan(scan(), loaded, cwd, { WIDEDOOR_STORAGE_STATE: elsewhere }).web?.storageState,
    ).toBe(elsewhere);
    expect(() => buildPlan(scan([], { storageState: 'missing.json' }), loaded, cwd, {})).toThrow(
      /^--storage-state: no such file$/,
    );
  });

  it('reads a bare 508 profile as the 508 profile', () => {
    const loaded = loadConfig(configFile('profile: 508\nweb:\n  urls: [https://example.com/]\n'));
    expect(buildPlan(scan(), loaded, cwd).profile).toBe('508');
  });

  it('refuses a config that names nothing to scan', () => {
    const loaded = loadConfig(configFile('profile: 508\n'));
    expect(() => buildPlan(scan(), loaded, cwd)).toThrow(/names nothing to scan/);
  });
});
