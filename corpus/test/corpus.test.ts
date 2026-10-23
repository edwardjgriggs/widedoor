import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadStandardsData } from '../../packages/core/src/data.ts';
import { ACT_BASE, ACT_MIRROR, ACT_TO_OUTCOME } from '../scripts/lib/act.ts';
import { ALLOWED_FONT, pdfFonts } from '../scripts/lib/pdf-fonts.ts';
import {
  ExpectedFileSchema,
  UNLISTED,
  UNLISTED_DIRS,
  corpusPath,
  expectedPathFor,
  listCorpusFiles,
  readExpected,
  readManifest,
  sortEntries,
  type Engine,
} from '../scripts/lib/corpus.ts';

// Offline checks only: no browser and no Docker (corpus:verify runs the engines).

const manifest = readManifest();
const files = listCorpusFiles();
const data = loadStandardsData();
const known: Record<Engine, Set<string>> = {
  'axe-core': new Set(data.axe.rules.map((r) => r.id)),
  verapdf: new Set([...data.verapdf.rules, ...data.verapdf.unmapped].map((r) => r.id)),
  widedoor: new Set(data.widedoor.rules.map((r) => r.id)),
};

describe('corpus manifest', () => {
  it('lists every file under corpus/ except README, manifest, tsconfig, scripts and tests', () => {
    const listed = [
      ...manifest.items.flatMap((i) => [i.path, i.expected]),
      ...manifest.supportFiles.map((f) => f.path),
    ];
    expect(new Set(listed).size).toBe(listed.length);
    const unlisted = files.filter(
      (f) => !UNLISTED.includes(f) && !UNLISTED_DIRS.some((d) => f.startsWith(d)),
    );
    expect(unlisted.filter((f) => !listed.includes(f))).toEqual([]);
    expect(listed.filter((f) => !files.includes(f))).toEqual([]);
  });

  it('gives each item its expected file at expected/<item>.json', () => {
    for (const item of manifest.items) expect(item.expected).toBe(expectedPathFor(item.path));
  });

  it('has a failing and a clean page for each of the ten web families', () => {
    const families = ['labels', 'alt', 'contrast', 'headings', 'landmarks'];
    families.push('aria', 'links', 'tables', 'language', 'title');
    for (const family of families) {
      for (const variant of ['fail', 'pass']) {
        const item = manifest.items.find((i) => i.path === `web/${family}-${variant}.html`);
        expect(item?.family, `${family}-${variant}`).toBe(family);
      }
    }
  });

  it('has the XSS page for the HTML report test, outside the families', () => {
    const xss = manifest.items.find((i) => i.path === 'web/xss.html');
    expect(xss?.family).toBeUndefined();
    expect(
      manifest.items.filter((i) => i.kind === 'web' && i.source === 'corpus' && !i.family),
    ).toEqual([xss]);
  });

  it('has the five PDF cases', () => {
    const pdfs = manifest.items.filter((i) => i.kind === 'pdf').map((i) => i.path);
    const names = ['clean-pdfua', 'malformed', 'scanned-image-only', 'tagged-broken', 'untagged'];
    expect(pdfs.sort()).toEqual(names.map((n) => `pdf/${n}.pdf`));
  });
});

describe('corpus/web pages', () => {
  const pages = manifest.items.filter((i) => i.source === 'corpus' && i.kind === 'web');

  it('give every page a lang and a title except the language and title failures', () => {
    for (const page of pages) {
      const html = readFileSync(corpusPath(page.path), 'utf8');
      const hasLang = /<html\s+lang="[a-z-]+"/i.test(html);
      const hasTitle = /<title>[^<]+<\/title>/.test(html);
      expect(hasLang, page.path).toBe(page.path !== 'web/language-fail.html');
      expect(hasTitle, page.path).toBe(page.path !== 'web/title-fail.html');
    }
  });

  it('load nothing from the network', () => {
    for (const page of pages) {
      const html = readFileSync(corpusPath(page.path), 'utf8');
      expect(html, page.path).not.toMatch(/(?:src|href|data|srcset)=["'](?:https?:)?\/\//i);
      expect(html, page.path).not.toMatch(/url\(\s*["']?(?:https?:)?\/\//i);
    }
  });

  // Mirrors the family table in corpus/README.md.
  const TARGET: Record<string, string> = {
    labels: 'label',
    alt: 'image-alt',
    contrast: 'color-contrast',
    headings: 'aria-required-attr',
    landmarks: 'bypass',
    aria: 'aria-valid-attr-value',
    links: 'link-name',
    tables: 'td-headers-attr',
    language: 'html-has-lang',
    title: 'document-title',
  };

  it('pair a finding on the target rule with a clean twin that passes it', () => {
    for (const page of pages.filter((p) => p.family !== undefined)) {
      const target = TARGET[page.family!];
      expect(target, page.path).toBeDefined();
      const entries = readExpected(page.expected).expected;
      const findings = entries.filter((e) => e.outcome === 'fail' || e.outcome === 'needs-review');
      if (page.path.endsWith('-fail.html')) {
        expect(
          findings.map((e) => e.ruleId),
          page.path,
        ).toContain(target);
      } else {
        expect(findings, page.path).toEqual([]);
        expect(entries, page.path).toContainEqual({
          engine: 'axe-core',
          ruleId: target,
          outcome: 'pass',
        });
      }
    }
  });
});

describe('corpus PDF fonts', () => {
  it('vendor Liberation Sans exactly as recorded in fonts/source.json', () => {
    const source = JSON.parse(readFileSync(corpusPath('fonts/source.json'), 'utf8'));
    expect(Object.keys(source.files).sort()).toEqual(
      files
        .filter((f) => f.startsWith('fonts/') && f !== 'fonts/source.json')
        .map((f) => f.slice(6)),
    );
    for (const [file, sha256] of Object.entries(source.files)) {
      const bytes = readFileSync(corpusPath(`fonts/${file}`));
      expect(createHash('sha256').update(bytes).digest('hex'), file).toBe(sha256);
    }
  });

  it('embed no font other than Liberation Sans', async () => {
    const readable = manifest.items.filter(
      (i) => i.kind === 'pdf' && readExpected(i.expected).error === undefined,
    );
    for (const item of readable) {
      const fonts = await pdfFonts(readFileSync(corpusPath(item.path)));
      expect(
        fonts.filter((f) => !ALLOWED_FONT.test(f)),
        item.path,
      ).toEqual([]);
      const scanned = item.path === 'pdf/scanned-image-only.pdf';
      expect(fonts.length === 0, item.path).toBe(scanned);
    }
  });
});

describe('expected files', () => {
  const expectedFiles = files.filter((f) => f.startsWith('expected/'));

  it('validate, match their manifest item and are sorted', () => {
    expect(expectedFiles.length).toBe(manifest.items.length);
    for (const item of manifest.items) {
      const file = readExpected(item.expected);
      expect(file.item).toBe(item.path);
      expect(file.kind).toBe(item.kind);
      expect(file.source).toBe(item.source);
      expect(file.expected).toEqual(sortEntries(file.expected));
      if (file.provisional) expect(item.note, `${item.path} needs a reason`).toBeDefined();
    }
  });

  it('only reference rule ids in the engine map files', () => {
    for (const item of manifest.items) {
      for (const e of readExpected(item.expected).expected) {
        expect(known[e.engine].has(e.ruleId), `${item.expected}: ${e.engine} ${e.ruleId}`).toBe(
          true,
        );
      }
    }
  });

  it('confirm every corpus web page with axe-core and every PDF with veraPDF and Widedoor', () => {
    for (const item of manifest.items.filter((i) => i.source === 'corpus')) {
      const file = readExpected(item.expected);
      const engines =
        item.kind === 'web' ? 'axe-core [0-9.]+' : 'veraPDF [0-9.]+, Widedoor [0-9.]+';
      expect(file.confirmedBy, item.path).toMatch(new RegExp(`^${engines}$`));
      expect(file.provisional, item.path).toBe(false);
      expect(
        file.expected.filter((e) => e.provisional),
        item.path,
      ).toEqual([]);
      if (item.kind === 'web') expect(file.error, item.path).toBeUndefined();
    }
  });

  it('expect a scan error only with no findings, and only for the malformed PDF', () => {
    const withError = manifest.items.filter((i) => readExpected(i.expected).error !== undefined);
    expect(withError.map((i) => i.path)).toEqual(['pdf/malformed.pdf']);
    expect(readExpected('expected/pdf/malformed.json').error).toEqual({ code: 'malformed-pdf' });
  });

  it('reject malformed files', () => {
    const good = readExpected(manifest.items[0]!.expected);
    const bad = [
      { ...good, kind: 'video' },
      { ...good, expected: [{ engine: 'lighthouse', ruleId: 'x', outcome: 'fail' }] },
      { ...good, expected: [{ engine: 'axe-core', ruleId: 'label', outcome: 'failed' }] },
      { ...good, provisional: false, confirmedBy: null },
      {
        ...good,
        provisional: false,
        expected: [
          { engine: 'widedoor', ruleId: 'pdf-language', outcome: 'fail', provisional: true },
        ],
      },
      { ...good, extra: true },
      { ...good, error: { code: 'malformed-pdf' } },
      { ...good, expected: [], error: { code: '' } },
    ];
    for (const b of bad)
      expect(ExpectedFileSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });
});

// corpus/act is empty until vendoring is approved (see README); these checks
// hold for an empty folder and become binding once vendor-act.ts has run.
describe('vendored ACT test cases', () => {
  const actItems = manifest.items.filter((i) => i.source === 'act');
  const vendoredAny = actItems.length > 0 || files.some((f) => f.startsWith('act/'));

  it('record their source, license and retrieval date', () => {
    if (!vendoredAny) {
      expect(existsSync(corpusPath('act/source.json'))).toBe(false);
      return;
    }
    const source = JSON.parse(readFileSync(corpusPath('act/source.json'), 'utf8'));
    expect(source.source).toBe(`${ACT_BASE}testcases.json`);
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(source.license).toMatch(/^https:\/\//);
    expect(source.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(source.testcases).toBe(actItems.length);
    expect(readFileSync(corpusPath('act/LICENSE.md'), 'utf8')).toMatch(
      /W3C Software and Document Notice and License/,
    );
    expect(readFileSync(corpusPath('../NOTICE'), 'utf8')).toMatch(/corpus\/act/);
  });

  it('give every vendored file an attribution source', () => {
    const vendored = files.filter((f) => /^act\/(?:testcases|test-assets)\//.test(f));
    const attributed = new Set([
      ...actItems.map((i) => i.path),
      ...manifest.supportFiles
        .filter((f) => f.path.startsWith('act/test-assets/'))
        .map((f) => f.path),
    ]);
    expect(vendored.filter((f) => !attributed.has(f))).toEqual([]);
    for (const item of actItems) {
      expect(item.act?.url).toBe(`${ACT_BASE}${item.path.slice('act/'.length)}`);
      expect(existsSync(corpusPath(item.path))).toBe(true);
    }
  });

  it('expect the ACT outcome from every axe rule mapped to the ACT rule', () => {
    const rulesFor = (act: string) =>
      data.axe.rules
        .filter((r) => r.actRules.includes(act))
        .map((r) => r.id)
        .sort();
    for (const item of actItems) {
      const file = readExpected(item.expected);
      const act = item.act!;
      expect(file.expected.map((e) => e.ruleId).sort()).toEqual(rulesFor(act.ruleId));
      for (const e of file.expected) expect(e.outcome).toBe(ACT_TO_OUTCOME[act.outcome]);
    }
  });

  it('are byte-identical to the copies recorded in act/source.json', () => {
    if (!vendoredAny) return;
    const source = JSON.parse(readFileSync(corpusPath('act/source.json'), 'utf8'));
    const recorded = source.sha256 as Record<string, string>;
    const vendored = files
      .filter((f) => f.startsWith('act/testcases/') || f.startsWith('act/test-assets/'))
      .map((f) => f.slice('act/'.length));
    expect(Object.keys(recorded).sort()).toEqual([...vendored].sort());
    const drift = vendored.filter((f) => {
      const bytes = readFileSync(corpusPath(`act/${f}`));
      return createHash('sha256').update(bytes).digest('hex') !== recorded[f];
    });
    expect(drift).toEqual([]);
  });

  it('stay under 5 MB, with no vendored asset over 1 MB', () => {
    const vendored = files.filter(
      (f) => f.startsWith('act/testcases/') || f.startsWith('act/test-assets/'),
    );
    const size = (f: string) => statSync(corpusPath(f)).size;
    expect(vendored.reduce((n, f) => n + size(f), 0)).toBeLessThan(5 * 1024 * 1024);
    for (const f of vendored.filter((f) => f.startsWith('act/test-assets/'))) {
      expect(size(f), f).toBeLessThanOrEqual(1024 * 1024);
    }
  });

  it('list every test case left out with its pinned upstream copy and a reason', () => {
    if (!vendoredAny) return expect(manifest.notVendored).toEqual([]);
    const source = JSON.parse(readFileSync(corpusPath('act/source.json'), 'utf8'));
    expect(source.testcasesNotVendored).toBe(manifest.notVendored.length);
    const vendoredIds = new Set(actItems.map((i) => i.act!.testcaseId + i.act!.ruleId));
    for (const n of manifest.notVendored) {
      const rel = n.act.url.slice(ACT_BASE.length);
      expect(n.act.url.startsWith(ACT_BASE), n.act.url).toBe(true);
      expect(n.upstream).toBe(`${ACT_MIRROR}${rel}`);
      expect(n.reason).toMatch(/over 1048576 bytes/);
      expect(existsSync(corpusPath(`act/${rel}`)), rel).toBe(false);
      expect(vendoredIds.has(n.act.testcaseId + n.act.ruleId), rel).toBe(false);
    }
  });

  it('confirm agreeing test cases and track the rest as known disagreements', () => {
    for (const item of actItems) {
      const file = readExpected(item.expected);
      if (file.provisional) {
        expect(file.confirmedBy, item.path).toBeNull();
        expect(item.knownDisagreement?.engine, item.path).toMatch(/^axe-core [0-9]/);
        expect(item.note, item.path).toMatch(/^Known disagreement/);
      } else {
        expect(file.confirmedBy, item.path).toMatch(/^axe-core [0-9]/);
        expect(item.knownDisagreement, item.path).toBeUndefined();
      }
    }
  });
});
