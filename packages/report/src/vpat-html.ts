import type { Acr } from './acr.js';
import { html, type SafeHtml } from './escape.js';
import { reportCsp } from './html.js';
import { REPORT_STYLE } from './style.js';
import { vpatOutline, type VpatBlock } from './vpat.js';

/*
 * The ACR as one self-contained HTML file in the VPAT® 2.5Rev Revised Section
 * 508 layout (vpat.ts holds the order and the text). Like the HTML report it
 * has no scripts, fonts or images: the CSP meta tag comes first in head and
 * allows only the one inline style block, by hash. Every string goes through
 * the html tag, which escapes it. Each heading opens a section labelled by
 * it, so the tables sit under their Table or Chapter heading.
 */

const STYLE = `${REPORT_STYLE}section[aria-labelledby=draft] { border: 3px solid var(--fail); padding: 0 1rem 0.5rem; margin: 1rem 0; }
section[aria-labelledby=draft] h2 { margin-top: 0.75rem; color: var(--fail); border-bottom: none; }
td p, th p { margin: 0 0 0.5rem; }
`;

// No images, so no img-src; reportCsp throws at load if the style needs escaping.
const CSP = reportCsp(STYLE);

/** Text with its line breaks kept. */
const text = (value: string) =>
  html`${value.split('\n').map((line, i) => html`${i > 0 ? html`<br>` : ''}${line}`)}`;

/** A table cell's lines: one paragraph each when there are several. */
const cell = (lines: readonly string[]) =>
  lines.length === 1 ? text(lines[0] ?? '') : html`${lines.map((l) => html`<p>${text(l)}</p>`)}`;

function block(b: VpatBlock): SafeHtml {
  switch (b.kind) {
    case 'heading':
      return b.level === 2
        ? html`<h2 id="${b.id}">${b.text}</h2>\n`
        : html`<h3 id="${b.id}">${b.text}</h3>\n`;
    case 'field':
      return html`<p><span class="label">${b.label}:</span> ${text(b.text)}</p>\n`;
    case 'paragraph':
      return html`<p>${text(b.text)}</p>\n`;
    case 'list':
      return html`<ul>\n${b.items.map((i) => html`<li>${text(i)}</li>\n`)}</ul>\n`;
    case 'table':
      return html`<table>
<thead><tr>${b.head.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead>
<tbody>
${b.rows.map((r) => html`<tr><th scope="row">${r.header}</th>${r.cells.map((c) => html`<td>${cell(c)}</td>`)}</tr>\n`)}</tbody>
</table>\n`;
  }
}

/** The blocks, each heading opening a section that runs to the next heading of its level or above. */
function sections(blocks: readonly VpatBlock[]): SafeHtml {
  const parts: SafeHtml[] = [];
  let open = 0;
  for (const b of blocks) {
    if (b.kind === 'heading') {
      const depth = b.level - 1;
      for (; open >= depth; open--) parts.push(html`</section>\n`);
      parts.push(html`<section aria-labelledby="${b.id}">\n`);
      open = depth;
    }
    parts.push(block(b));
  }
  for (; open > 0; open--) parts.push(html`</section>\n`);
  return html`${parts}`;
}

/** Renders the ACR as a VPAT® 2.5Rev 508 HTML file (a DRAFT that never names the template unless acr.complete). */
export function renderVpatHtml(acr: Acr): string {
  const o = vpatOutline(acr);
  const banner = o.draft
    ? html`<section aria-labelledby="draft">
<h2 id="draft">${o.draft.heading}</h2>
<p>${o.draft.lead}</p>
<ul>\n${o.draft.reasons.map((r) => html`<li>${r}</li>\n`)}</ul>
</section>\n`
    : '';
  const page = html`<!doctype html>
<html lang="en">
<head>
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${o.title}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
${banner}<h1>${o.title}</h1>
${o.version !== undefined ? html`<p class="lead">${o.version}</p>\n` : ''}</header>
<main>
${sections(o.blocks)}</main>
</body>
</html>
`;
  return page.toString();
}
