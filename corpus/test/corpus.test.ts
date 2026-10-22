import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadStandardsData } from '../../packages/core/src/data.ts';
import { ACT_BASE, ACT_TO_OUTCOME } from '../scripts/lib/act.ts';
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

  it('has the four PDF cases', () => {
    const pdfs = manifest.items.filter((i) => i.kind === 'pdf').map((i) => i.path);
    expect(pdfs.sort()).toEqual(
      ['clean-pdfua', 'scanned-image-only', 'tagged-broken', 'untagged'].map((n) => `pdf/${n}.pdf`),
    );
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
    for (const page of pages) {
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

  it('confirm every corpus web page with axe-core and every PDF with veraPDF', () => {
    for (const item of manifest.items.filter((i) => i.source === 'corpus')) {
      const file = readExpected(item.expected);
      const engine = item.kind === 'web' ? 'axe-core' : 'veraPDF';
      expect(file.confirmedBy, item.path).toMatch(new RegExp(`^${engine} `));
      // Web pages are fully confirmed; PDFs only miss the Widedoor checks of Task 1.2.
      const open = file.expected.filter((e) => e.provisional);
      expect(
        open.every((e) => e.engine === 'widedoor'),
        item.path,
      ).toBe(true);
      expect(file.provisional, item.path).toBe(open.length > 0);
    }
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
});
