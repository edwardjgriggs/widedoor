/*
 * The page around each doc: a skip link, a header with the site name and the
 * repository link (on the home page, the intro and its calls to action too), a
 * nav of every page (the current one marked with aria-current), the doc in
 * main (its one h1 comes from the doc), and the report disclaimer in the
 * footer. No script, no inline style: the CSP allows the site's own
 * stylesheet only.
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

export const NOT_FOUND_BODY =
  '<h1 id="page-not-found">Page not found</h1>\n<p>There is no page at this address. The navigation lists every page of the Widedoor docs.</p>\n';

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The home page's calls to action, each shown only when the site has its page. */
const CALLS: readonly { slug: string; label: string }[] = [
  { slug: 'install', label: 'Install' },
  { slug: 'quick-start', label: 'Quick start' },
];

/** The home page's intro, inside the header: no heading, so the doc's h1 stays the only one. */
function hero(nav: readonly NavItem[]): string {
  const calls = CALLS.flatMap((c) => {
    const item = nav.find((n) => n.slug === c.slug);
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

export function page(options: {
  title: string;
  current: string | undefined;
  nav: readonly NavItem[];
  body: string;
}): string {
  const items = options.nav
    .map(
      (n) =>
        `<li><a href="${escape(n.href)}"${n.slug === options.current ? ' aria-current="page"' : ''}>${escape(n.label)}</a></li>`,
    )
    .join('\n');
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
${options.current === '' ? hero(options.nav) : ''}</header>
<div class="layout">
<nav aria-label="Docs">
<p class="nav-title">Documentation</p>
<ul>
${items}
</ul>
</nav>
<main id="main" tabindex="-1">
${options.body.trimEnd()}
</main>
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
