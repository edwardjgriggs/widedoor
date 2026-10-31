import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DISCLAIMER as REPORT_DISCLAIMER } from '@widedoor/report';
import {
  BrokenLinkError,
  NAV_GROUPS,
  RUNBOOKS,
  SUMMARIES,
  TOC_MIN,
  buildSite,
  renderSite,
  slugify,
  splitAtH2,
} from '../src/site.ts';
import { DISCLAIMER } from '../src/template.ts';

/*
 * The docs site build (Task 3b.11): fixture Markdown into the expected
 * pages, raw HTML escaped, links rewritten or the build stopped, the real
 * docs with no broken internal link, identical bytes on a second build, no
 * dash introduced, the page frame on every page, and vercel.json's headers.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'widedoor-docs-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const README = `# Widedoor

The intro. See [Usage](#usage), [the hosted doc](docs/hosted.md#costs), [the changelog](CHANGELOG.md)
and [OpenACR](https://github.com/GSA/openacr).

<script>alert("xss")</script>

## Usage

Run it:

\`\`\`sh
# a shell comment, not a heading
## not a section either
widedoor scan https://example.com/
\`\`\`

### Options in detail

Back to [the intro](#widedoor) and on to [details](#options-in-detail).

## License

Apache-2.0. See [Options](#options-in-detail).
`;

const HOSTED = `# The hosted scanner

Read the [runbook](hosted-runbook.md) and the [README](../README.md#license).

## Costs

| Item | Cost |
| :--- | ---: |
| A | 1 |
`;

let n = 0;
function fixture(extra: Record<string, string> = {}) {
  const root = join(tmp, `repo${n++}`);
  mkdirSync(join(root, 'docs'), { recursive: true });
  const files: Record<string, string> = {
    'README.md': README,
    'CHANGELOG.md': '# Changes\n',
    'docs/hosted.md': HOSTED,
    'docs/hosted-runbook.md': '# Runbook\n\nOperator steps.\n',
    'docs/docs-site-deploy.md': '# Deploy\n\nOperator steps.\n',
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return root;
}

const pagesOf = (out: string) =>
  readdirSync(out, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) =>
      join(e.parentPath, e.name)
        .slice(out.length + 1)
        .split('\\')
        .join('/'),
    )
    .sort();

describe('the build', () => {
  it('writes a page per README section and doc, without the runbooks', () => {
    const out = join(tmp, `out${n++}`);
    const written = buildSite(fixture(), out);
    // License is an About section, so it is on the About page.
    expect(written).toEqual([
      '404.html',
      'about/index.html',
      'hosted/index.html',
      'index.html',
      'site.css',
      'usage/index.html',
    ]);
    expect(pagesOf(out)).toEqual(written);
    expect(RUNBOOKS).toEqual(['hosted-runbook.md', 'docs-site-deploy.md']);
  });

  it('splits only at ## outside code blocks, and moves README headings up one level', () => {
    expect(splitAtH2(README).map((p) => p.heading)).toEqual([undefined, 'Usage', 'License']);
    const out = join(tmp, `out${n++}`);
    buildSite(fixture(), out);
    const usage = readFileSync(join(out, 'usage', 'index.html'), 'utf8');
    expect(usage).toContain('<h1 id="usage">Usage</h1>');
    expect(usage).toContain('<h2 id="options-in-detail">Options in detail</h2>');
    expect(usage).toContain('# a shell comment, not a heading\n## not a section either');
  });

  it('escapes raw HTML in Markdown: no script reaches a page', () => {
    const out = join(tmp, `out${n++}`);
    buildSite(fixture(), out);
    const home = readFileSync(join(out, 'index.html'), 'utf8');
    expect(home).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    for (const page of pagesOf(out)) {
      const text = readFileSync(join(out, page), 'utf8');
      expect(text, page).not.toMatch(/<script|\sstyle=|\son[a-z]+=/i);
    }
  });

  it('rewrites links between docs, sends repository files to GitHub, and marks external links', () => {
    const out = join(tmp, `out${n++}`);
    buildSite(fixture(), out);
    const home = readFileSync(join(out, 'index.html'), 'utf8');
    expect(home).toContain('<a href="/usage/">Usage</a>');
    expect(home).toContain('<a href="/hosted/#costs">the hosted doc</a>');
    expect(home).toContain(
      '<a href="https://github.com/edwardjgriggs/widedoor/blob/main/CHANGELOG.md" rel="noopener noreferrer">the changelog</a>',
    );
    expect(home).toContain(
      '<a href="https://github.com/GSA/openacr" rel="noopener noreferrer">OpenACR</a>',
    );
    const usage = readFileSync(join(out, 'usage', 'index.html'), 'utf8');
    expect(usage).toContain('<a href="/">the intro</a>');
    expect(usage).toContain('<a href="#options-in-detail">details</a>');
    expect(readFileSync(join(out, 'about', 'index.html'), 'utf8')).toContain(
      '<a href="/usage/#options-in-detail">Options</a>',
    );
    const hosted = readFileSync(join(out, 'hosted', 'index.html'), 'utf8');
    // A runbook is not on the site: the link goes to the repository.
    expect(hosted).toContain(
      'href="https://github.com/edwardjgriggs/widedoor/blob/main/docs/hosted-runbook.md" rel="noopener noreferrer"',
    );
    expect(hosted).toContain('<a href="/about/#license">README</a>');
    // Table alignment is a class, not an inline style (the CSP has no unsafe-inline).
    expect(hosted).toContain('<th class="align-right">Cost</th>');
  });

  it('stops on a link to nothing', () => {
    const files = (readme: string) => new Map([['README.md', readme]]);
    const none = () => undefined;
    for (const readme of [
      '# W\n\n[x](#nowhere)\n',
      '# W\n\n[x](missing.md)\n',
      '# W\n\n[x](../outside.md)\n',
      '# W\n\n[x](docs/gone.md#a)\n',
    ])
      expect(() => renderSite(files(readme), none, ''), readme).toThrow(BrokenLinkError);
    expect(() => renderSite(files('# W\n\n![logo](logo.png)\n'), none, '')).toThrow(/image/);
  });

  it('gives identical bytes for the same input', () => {
    const a = join(tmp, `out${n++}`);
    const b = join(tmp, `out${n++}`);
    buildSite(ROOT, a);
    buildSite(ROOT, b);
    const pages = pagesOf(a);
    expect(pagesOf(b)).toEqual(pages);
    for (const page of pages)
      expect(readFileSync(join(b, page)).equals(readFileSync(join(a, page))), page).toBe(true);
  });
});

describe('the real docs', () => {
  const out = join(tmp, 'real');
  const written = buildSite(ROOT, out);
  const html = written.filter((p) => p.endsWith('.html'));
  const read = (page: string) => readFileSync(join(out, page), 'utf8');
  const idsOf = (text: string) => new Set([...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

  it('leave out every operator runbook', () => {
    for (const runbook of RUNBOOKS)
      expect(written).not.toContain(`${runbook.replace(/\.md$/, '')}/index.html`);
    expect(written).toContain('hosted/index.html');
  });

  it('have no broken internal link', () => {
    for (const page of html)
      for (const [, href] of read(page).matchAll(/\shref="([^"]+)"/g)) {
        if (/^https?:/.test(href as string)) continue;
        const [path, fragment] = (href as string).split('#');
        const target =
          path === ''
            ? page
            : path === '/site.css'
              ? 'site.css'
              : `${(path as string).replace(/^\//, '')}index.html`;
        expect(written, `${page} -> ${href}`).toContain(target);
        if (fragment !== undefined && target.endsWith('.html'))
          expect(idsOf(read(target)).has(fragment), `${page} -> ${href}`).toBe(true);
      }
  });

  it('introduce no en or em dash', () => {
    for (const page of written) expect(read(page), page).not.toMatch(/[\u2013\u2014]/);
  });

  it('give every page the frame: lang, one h1, a skip link, a nav with one current page, the disclaimer', () => {
    expect(DISCLAIMER).toBe(REPORT_DISCLAIMER);
    for (const page of html) {
      const text = read(page);
      expect(text, page).toMatch(/^<!doctype html>\n<html lang="en">/);
      expect(text.match(/<h1[\s>]/g), page).toHaveLength(1);
      expect(text, page).toContain('<a class="skip-link" href="#main">Skip to the content</a>');
      expect(text, page).toMatch(/<main id="main" tabindex="-1"( class="has-toc")?>/);
      expect(text, page).toContain('<nav aria-label="Docs">');
      expect(text.match(/aria-current="page"/g)?.length ?? 0, page).toBe(
        page === '404.html' ? 0 : 1,
      );
      expect(text, page).toContain(DISCLAIMER);
      expect(text, page).not.toMatch(/<script|\sstyle=/i);
    }
  });
});

describe('vercel.json', () => {
  const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as {
    framework: unknown;
    installCommand: string;
    buildCommand: string;
    outputDirectory: string;
    cleanUrls: boolean;
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };

  it('builds the static site with the docs script and serves it with clean URLs', () => {
    expect(config.framework).toBeNull();
    // Vercel's own install never runs: installCommand is the scoped one, with only the docs
    // workspace and the root (for tsx), and no install scripts.
    expect(config.installCommand).toBe(
      'npm ci --ignore-scripts --workspace @widedoor/docs --include-workspace-root',
    );
    expect(config.buildCommand).toBe('npm run docs:build');
    expect(config.outputDirectory).toBe('packages/docs/dist');
    expect(config.cleanUrls).toBe(true);
  });

  it('sits at the repository root, which is the Vercel Root Directory, and nowhere else', () => {
    // Vercel reads vercel.json only from the Root Directory (fix round 1 item 1).
    expect(existsSync(join(ROOT, 'packages', 'docs', 'vercel.json'))).toBe(false);
    // Never in a Docker build context.
    expect(readFileSync(join(ROOT, '.dockerignore'), 'utf8')).toMatch(/^vercel\.json$/m);
  });

  it('sends the CSP, nosniff, no-referrer, an empty Permissions-Policy and COOP on every path', () => {
    expect(config.headers).toHaveLength(1);
    expect(config.headers[0]!.source).toBe('/(.*)');
    expect(Object.fromEntries(config.headers[0]!.headers.map((h) => [h.key, h.value]))).toEqual({
      'Content-Security-Policy':
        "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
  });

  it('the build is not part of npm run build, and its output is not committed', () => {
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['docs:build']).toBe('tsx packages/docs/scripts/build.ts');
    expect(scripts.build).not.toContain('docs');
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8')).toMatch(/^dist\/$/m);
  });
});

// Task 3b.11 fix round 1, items 4 to 6.
describe('fix round 1', () => {
  const render = (files: Record<string, string>, kinds: Record<string, 'file' | 'dir'> = {}) =>
    renderSite(new Map(Object.entries(files)), (path) => kinds[path], '');

  it('closes a fence only on the same character at least as long (item 4)', () => {
    const readme = [
      '# W',
      '',
      '````md',
      '```',
      '## not a section',
      '```',
      '````',
      '',
      '## Real',
      '',
      '~~~',
      '```',
      '## still code',
      '~~~',
      '',
      '## Last',
      '',
    ].join('\n');
    expect(splitAtH2(readme).map((p) => p.heading)).toEqual([undefined, 'Real', 'Last']);
    const site = render({ 'README.md': readme });
    expect(site.get('index.html')).toContain('## not a section');
    expect(site.get('real/index.html')).toContain('## still code');
    expect([...site.keys()].sort()).toEqual([
      '404.html',
      'index.html',
      'last/index.html',
      'real/index.html',
      'site.css',
    ]);
  });

  it('links a folder to GitHub tree/ and a file to blob/ (item 5)', () => {
    const site = render(
      {
        'README.md':
          '# W\n\nSee [docker](docker/), [corpus](corpus) and [the file](docker/README.md).\n',
      },
      { docker: 'dir', corpus: 'dir', 'docker/README.md': 'file' },
    );
    const home = site.get('index.html') ?? '';
    expect(home).toContain('href="https://github.com/edwardjgriggs/widedoor/tree/main/docker"');
    expect(home).toContain('href="https://github.com/edwardjgriggs/widedoor/tree/main/corpus"');
    expect(home).toContain(
      'href="https://github.com/edwardjgriggs/widedoor/blob/main/docker/README.md"',
    );
  });

  it('numbers repeated heading ids over the whole README, as GitHub does (item 6)', () => {
    const readme = [
      '# W',
      '',
      'Go to [the second example](#example-1) or [the first](#example).',
      '',
      '## Usage',
      '',
      '### Example',
      '',
      'One.',
      '',
      '## Docker',
      '',
      '### Example',
      '',
      'Two.',
      '',
    ].join('\n');
    const site = render({ 'README.md': readme });
    expect(site.get('usage/index.html')).toContain('<h2 id="example">Example</h2>');
    expect(site.get('docker/index.html')).toContain('<h2 id="example-1">Example</h2>');
    const home = site.get('index.html') ?? '';
    expect(home).toContain('<a href="/docker/#example-1">the second example</a>');
    expect(home).toContain('<a href="/usage/#example">the first</a>');
  });
});

describe('the information architecture', () => {
  const readme = [
    '# W',
    '',
    'See [the hosted part](#hosted-scanner) and [the license](#license).',
    '',
    '## Status',
    '',
    'Early.',
    '',
    '## Install',
    '',
    'Run it.',
    '',
    '## Usage',
    '',
    '### One',
    '',
    'a',
    '',
    '### Two',
    '',
    'b',
    '',
    '### Three',
    '',
    'c',
    '',
    '## Hosted scanner',
    '',
    'In short. See [the doc](docs/hosted.md).',
    '',
    '## License',
    '',
    'Apache-2.0.',
    '',
  ].join('\n');
  const files = { 'README.md': readme, 'docs/hosted.md': '# The hosted scanner\n\nAll of it.\n' };
  const site = renderSite(new Map(Object.entries(files)), () => undefined, '');

  it('gives a README summary of a doc no page, and sends its links to the doc', () => {
    expect([...site.keys()].sort()).toEqual([
      '404.html',
      'about/index.html',
      'hosted/index.html',
      'index.html',
      'install/index.html',
      'site.css',
      'usage/index.html',
    ]);
    expect(SUMMARIES['hosted-scanner']).toBe('docs/hosted.md');
    expect(site.get('index.html')).toContain('<a href="/hosted/">the hosted part</a>');
  });

  it('gathers the About sections on one page, each under its own h2', () => {
    const about = site.get('about/index.html') ?? '';
    expect(about).toContain('<h1 id="about">About</h1>');
    expect(about).toContain('<h2 id="status">Status</h2>');
    expect(about).toContain('<h2 id="license">License</h2>');
    expect(site.get('index.html')).toContain('<a href="/about/#license">the license</a>');
  });

  it('groups the nav, with shorter labels, and lists every written page once', () => {
    const home = site.get('index.html') ?? '';
    const nav = /<nav aria-label="Docs">([\s\S]*?)<\/nav>/.exec(home)?.[1] ?? '';
    expect([...nav.matchAll(/<p class="nav-title">([^<]+)</g)].map((m) => m[1])).toEqual([
      'Get started',
      'Guides',
      'Reference',
    ]);
    expect([...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([
      '/',
      '/install/',
      '/usage/',
      '/hosted/',
      '/about/',
    ]);
    expect(nav).toContain('aria-current="page">Overview</a>');
    expect(nav).toContain('>Hosted scanner</a>');
    expect(NAV_GROUPS.flatMap((g) => g.slugs)).toContain('reports');
  });

  it(`lists the h2s of a page with at least ${TOC_MIN} under its h1, and no list on a short page`, () => {
    const usage = site.get('usage/index.html') ?? '';
    expect(usage).toContain('<main id="main" tabindex="-1" class="has-toc">');
    expect(usage).toMatch(
      /<h1 id="usage">Usage<\/h1>\n<aside class="toc" aria-label="On this page">[\s\S]*<a href="#one">One<\/a>[\s\S]*<a href="#three">Three<\/a>[\s\S]*<\/aside>\n<div class="doc">/,
    );
    expect(site.get('install/index.html')).not.toContain('class="toc"');
  });

  it('puts cards on the home page only, for pages the site has', () => {
    const home = site.get('index.html') ?? '';
    expect(home).toContain('<a class="card" href="/usage/">');
    expect(home).not.toContain('href="/reports/"');
    expect(site.get('usage/index.html')).not.toContain('class="cards"');
  });
});

describe('slugify', () => {
  it('writes anchors as GitHub does', () => {
    expect(slugify('Licenses in the image')).toBe('licenses-in-the-image');
    expect(slugify('What is and is not automated')).toBe('what-is-and-is-not-automated');
    expect(slugify('widedoor ui --report')).toBe('widedoor-ui---report');
    expect(slugify('GitHub Action (v1)')).toBe('github-action-v1');
  });
});
