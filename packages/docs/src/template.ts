/*
 * The page around each doc: a skip link, the site name, a nav of every page
 * (the current one marked with aria-current), the doc in main (its one h1
 * comes from the doc), and the report disclaimer in the footer. No script,
 * no inline style: the CSP allows the site's own stylesheet only.
 */

/** Spec section 10; packages/report's DISCLAIMER (a test checks they agree). */
export const DISCLAIMER =
  'This report documents the testing performed. It is not a certification of conformance.';

export interface NavItem {
  href: string;
  label: string;
  slug: string;
}

export const NOT_FOUND_BODY =
  '<h1 id="page-not-found">Page not found</h1>\n<p>There is no page at this address. The navigation lists every page of the Widedoor docs.</p>\n';

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
<p class="site-name"><a href="/">Widedoor docs</a></p>
</header>
<div class="layout">
<nav aria-label="Docs">
<ul>
${items}
</ul>
</nav>
<main id="main" tabindex="-1">
${options.body.trimEnd()}
</main>
</div>
<footer class="site-footer">
<p>Every Widedoor report states: "${escape(DISCLAIMER)}"</p>
<p>Widedoor is open source under the Apache-2.0 license.</p>
</footer>
</body>
</html>
`;
}
