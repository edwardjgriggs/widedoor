/*
 * The page around each doc: a skip link, a header with the site name and the
 * repository link (on the home page, the intro and its calls to action too), a
 * nav of every page in groups (the current one marked with aria-current), the
 * doc in main (its one h1 comes from the doc; a long doc gets an "On this
 * page" list after it, and the home page a set of cards after the doc), and
 * the report disclaimer in the footer. No script, no inline style: the CSP
 * allows the site's own stylesheet only.
 */

/** Spec section 10; packages/report's DISCLAIMER (a test checks they agree). */
export const DISCLAIMER =
  'This report documents the testing performed. It is not a certification of conformance.';

export const REPO_URL = 'https://github.com/edwardjgriggs/widedoor';

export interface NavItem {
  href: string;
  label: string;
  slug: string;
}

export interface NavGroup {
  label: string;
  items: readonly NavItem[];
}

/** An h2 of the page, for its "On this page" list. */
export interface TocEntry {
  id: string;
  text: string;
}

export const NOT_FOUND_BODY =
  '<h1 id="page-not-found">Page not found</h1>\n<p>There is no page at this address. The navigation lists every page of the Widedoor docs.</p>\n';

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The home page's calls to action, each shown only when the site has its page. */
const CALLS: readonly { slug: string; label: string }[] = [
  { slug: 'install', label: 'Install' },
  { slug: 'quick-start', label: 'Quick start' },
];

/** The home page's cards: where to go next, each shown only when the site has its page. */
const CARDS: readonly { slug: string; title: string; text: string }[] = [
  {
    slug: 'usage',
    title: 'Scan pages and PDFs',
    text: 'axe-core in Chromium for web pages and veraPDF for PDFs, from one command.',
  },
  {
    slug: 'reports',
    title: 'Read the reports',
    text: 'HTML for people, JSON and SARIF for tools, and Accessibility Conformance Reports.',
  },
  {
    slug: 'github-action',
    title: 'Gate pull requests',
    text: 'A GitHub Action that fails the check on new barriers and uploads SARIF.',
  },
  {
    slug: 'mcp',
    title: 'Scan from an AI agent',
    text: 'An MCP server so a coding agent can scan pages and read the findings.',
  },
];

const find = (nav: readonly NavGroup[], slug: string) =>
  nav.flatMap((g) => g.items).find((n) => n.slug === slug);

/** The home page's intro, inside the header: no heading, so the doc's h1 stays the only one. */
function hero(nav: readonly NavGroup[]): string {
  const calls = CALLS.flatMap((c) => {
    const item = find(nav, c.slug);
    return item ? [`<a class="button" href="${escape(item.href)}">${escape(c.label)}</a>`] : [];
  });
  calls.push(
    `<a class="button button-quiet" href="${REPO_URL}" rel="noopener noreferrer">Source on GitHub</a>`,
  );
  return `<div class="hero">
<p class="hero-kicker">Section 508 and WCAG 2.1 AA, for websites and PDFs</p>
<p class="hero-title">Accessibility checks you can defend.</p>
<p class="hero-lede">Open source testing with plain-language reports that say what is wrong, who it affects and how to fix it, and never claim conformance they did not test.</p>
<p class="hero-calls">${calls.join('\n')}</p>
</div>
`;
}

function cards(nav: readonly NavGroup[]): string {
  const items = CARDS.flatMap((c) => {
    const item = find(nav, c.slug);
    return item
      ? [
          `<li><a class="card" href="${escape(item.href)}"><span class="card-title">${escape(c.title)}</span><span class="card-text">${escape(c.text)}</span></a></li>`,
        ]
      : [];
  });
  return items.length > 0 ? `<ul class="cards">\n${items.join('\n')}\n</ul>\n` : '';
}

/** The "On this page" list. Not a nav element: the site's one nav is the page list. */
function toc(entries: readonly TocEntry[]): string {
  const items = entries
    .map((e) => `<li><a href="#${escape(e.id)}">${escape(e.text)}</a></li>`)
    .join('\n');
  return `<aside class="toc" aria-label="On this page">
<p class="toc-title">On this page</p>
<ul>
${items}
</ul>
</aside>
`;
}

/** The doc in main: its h1, then the page's list when it has one, then the rest. */
function content(body: string, entries: readonly TocEntry[] | undefined): string {
  const end = body.indexOf('</h1>');
  if (!entries || end === -1) return body.trimEnd();
  const split = end + '</h1>'.length;
  return `${body.slice(0, split)}\n${toc(entries)}<div class="doc">\n${body.slice(split).trim()}\n</div>`;
}

export function page(options: {
  title: string;
  current: string | undefined;
  nav: readonly NavGroup[];
  body: string;
  toc?: readonly TocEntry[];
}): string {
  const groups = options.nav
    .map((g) => {
      const items = g.items
        .map(
          (n) =>
            `<li><a href="${escape(n.href)}"${n.slug === options.current ? ' aria-current="page"' : ''}>${escape(n.label)}</a></li>`,
        )
        .join('\n');
      return `<p class="nav-title">${escape(g.label)}</p>\n<ul>\n${items}\n</ul>`;
    })
    .join('\n');
  const home = options.current === '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(options.title)} | Widedoor docs</title>
<link rel="stylesheet" href="/site.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to the content</a>
<header class="site-header">
<div class="site-bar">
<p class="site-name"><a href="/">Widedoor <span class="site-tag">Docs</span></a></p>
<a class="site-repo" href="${REPO_URL}" rel="noopener noreferrer">GitHub</a>
</div>
${home ? hero(options.nav) : ''}</header>
<div class="layout">
<nav aria-label="Docs">
${groups}
</nav>
<main id="main" tabindex="-1"${options.toc ? ' class="has-toc"' : ''}>
${content(options.body, options.toc)}
${home ? cards(options.nav) : ''}</main>
</div>
<footer class="site-footer">
<div class="site-footer-inner">
<p>Every Widedoor report states: "${escape(DISCLAIMER)}"</p>
<p>Widedoor is open source under the Apache-2.0 license.</p>
</div>
</footer>
</body>
</html>
`;
}
