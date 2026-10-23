import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { UsageError, parseCommand, type ScanArgs } from '../src/args.ts';
import { ConfigError, buildPlan, classifyTarget, loadConfig } from '../src/config.ts';

const dir = mkdtempSync(join(tmpdir(), 'widedoor-config-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
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

const scan = (...argv: string[]) => parseCommand(['scan', ...argv]) as ScanArgs;

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
    expect(problems('web:\n  actions: [{ click: "#menu" }]\nai:\n  enabled: true\n')).toEqual([
      'web.actions: scripted actions are not supported yet; leave web.actions empty',
      'ai.enabled: AI fix suggestions are not supported yet; set ai.enabled to false',
    ]);
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
    const plan = buildPlan(scan('https://example.com/', 'a.pdf'), undefined, cwd);
    expect(plan).toEqual({
      profile: '508+wcag21aa',
      pdfDocumentType: 'non-web',
      formats: ['html', 'json', 'sarif'],
      failOn: 'serious',
      out: resolve(cwd, 'widedoor-report'),
      web: { urls: ['https://example.com/'], maxPages: 50, maxPagesSetting: 'default' },
      pdf: { baseDir: cwd, files: ['a.pdf'], include: [] },
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
    expect(plan.pdf).toEqual({ baseDir: loaded.dir, files: [], include: ['docs/*.pdf'] });
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
      scan('https://cli.example/', '--fail-on', 'none', '--profile', '508'),
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
        expect(buildPlan(scan('a.pdf'), loaded, cwd).pdfDocumentType).toBe(value);
      });

    it('refuses any other value', () => {
      expect(() => loadConfig(configFile(`${include}  documentType: html\n`))).toThrow(ConfigError);
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
    expect(buildPlan(scan('--storage-state', elsewhere), loaded, cwd, {}).web?.storageState).toBe(
      elsewhere,
    );
    expect(
      buildPlan(scan(), loaded, cwd, { WIDEDOOR_STORAGE_STATE: elsewhere }).web?.storageState,
    ).toBe(elsewhere);
    expect(() => buildPlan(scan('--storage-state', 'missing.json'), loaded, cwd, {})).toThrow(
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
