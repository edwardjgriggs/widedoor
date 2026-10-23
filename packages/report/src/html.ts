import { createHash } from 'node:crypto';
import { loadStandardsData, type Finding, type StandardsData } from '@widedoor/core';
import { ScreenshotLoader, type ScreenshotLimits } from './evidence.js';
import { escapeHtml, html, type SafeHtml } from './escape.js';
import { axeRuleUrl, understandingUrl } from './links.js';
import { DISCLAIMER, type ScanReport } from './model.js';
import { loadPlainData, plainFor, type PlainData } from './plain.js';
import { REPORT_STYLE as STYLE } from './style.js';
import { IMPACT_ORDER, notEvaluated, summarize } from './summary.js';
import {
  EXPIRED_NOTE,
  IMPACT_LABEL,
  MAX_SKIPPED_LISTED,
  STANDARD_LABEL,
  TEXT,
  assetCounts,
  assetFindings,
  assetKindText,
  cardBadges,
  cardHeading,
  conditionText,
  crawlText,
  datesText,
  engineName,
  engineText,
  errorText,
  exceptionNotes,
  exceptionText,
  findingCards,
  findingHeading,
  findingPlace,
  informationalText,
  leadText,
  manualReviews,
  moreSkippedText,
  notTestedText,
  profileText,
  recordText,
  reviewerText,
  smallScreenText,
  summaryRows,
  unscannedAssets,
  type Criterion,
  type FindingCard,
} from './view.js';

export { MAX_SKIPPED_LISTED } from './view.js';

/*
 * The HTML report (spec sections 8 and 10): one self-contained file with no
 * scripts. Every string from the scan goes through the html tag, which
 * escapes it. The CSP meta tag comes first in head and allows only the one
 * inline style block (by hash) and, when screenshots are embedded, data:
 * images. Finding ids are not unique keys: two records can share one, so
 * nothing here is keyed or anchored by finding id.
 */

export interface HtmlOptions {
  plain?: PlainData;
  data?: StandardsData;
  /** Folder that evidence.screenshot paths are relative to. Without it no screenshots are embedded. */
  evidenceDir?: string;
  screenshots?: ScreenshotLimits;
}

// The style is ours and has no character the escape changes, so the hashed text is the text the page holds.
if (escapeHtml(STYLE) !== STYLE) throw new Error('the report style must not need escaping');
const STYLE_HASH = createHash('sha256').update(STYLE, 'utf8').digest('base64');

/** Why a skipped page was not scanned, in words that fit its reason. */
const skipNote = (s: ScanReport['skipped'][number]) =>
  s.reason === 'pdf-url'
    ? html`${TEXT.pdfUrlSkip}`
    : html`Not scanned: it went to <span class="uri">${s.finalUri}</span> (${s.reason})`;

const skipItem = (s: ScanReport['skipped'][number]) =>
  s.reason === 'pdf-url'
    ? html`<span class="uri">${s.uri}</span>${TEXT.pdfUrlItem}`
    : html`<span class="uri">${s.uri}</span> went to <span class="uri">${s.finalUri}</span> (${s.reason})`;

const moreSkipped = (n: number) => html`${moreSkippedText(n)}`;

/** A list of items, one per line, or the fallback when there are none. */
const list = (items: SafeHtml[], fallback: SafeHtml | string = TEXT.none) =>
  items.length > 0
    ? html`<ul>\n${items.map((i) => html`<li>${i}</li>\n`)}</ul>`
    : html`${fallback}`;

interface Context {
  report: ScanReport;
  plain: PlainData;
  shots: ScreenshotLoader;
  wcagTitle: Map<string, string>;
  provisionTitle: Map<string, string>;
}

function standards(ctx: Context, f: Finding, wcag: Iterable<string>, s508: Iterable<string>) {
  const { engine, ruleId, engineVersion } = f.source;
  const items: SafeHtml[] = [];
  for (const id of wcag) {
    const title = ctx.wcagTitle.get(id);
    items.push(
      title ? html`WCAG <a href="${understandingUrl(title)}">${id} ${title}</a>` : html`WCAG ${id}`,
    );
  }
  for (const id of s508) items.push(html`Section 508 ${id} ${ctx.provisionTitle.get(id)}`);
  if (f.criteria.baselineTest)
    items.push(html`ICT Testing Baseline test ${f.criteria.baselineTest}`);
  const rule =
    engine === 'axe-core'
      ? html`<a href="${axeRuleUrl(ruleId, engineVersion)}">${ruleId}</a>`
      : html`${ruleId}`;
  items.push(html`Rule: ${engineName(engine)} ${engineVersion}, ${rule}`);
  if (f.source.actRuleId) items.push(html`W3C ACT rule ${f.source.actRuleId}`);
  return html`<details>\n<summary>${TEXT.standardsAndRule}</summary>\n${list(items)}\n</details>\n`;
}

function cards(ctx: Context): SafeHtml {
  const sorted = findingCards(ctx.report.findings, ctx.report.assets);
  if (sorted.length === 0)
    return html`<p>${ctx.report.assets.length === 0 ? TEXT.nothingScanned : TEXT.noFindings}</p>\n`;

  const card = (c: FindingCard) => {
    const p = plainFor(c.first, ctx.plain);
    const b = cardBadges(c);
    const badges = [
      html`<li class="badge">${b.impact}</li>\n`,
      b.fails ? html`<li class="badge fail">${b.fails}</li>\n` : '',
      b.reviews ? html`<li class="badge review">${b.reviews}</li>\n` : '',
      html`<li class="badge">${b.assets}</li>\n`,
    ];
    const advice = p
      ? html`<p><span class="label">${TEXT.whoAffects}</span> ${p.who}</p>\n<p><span class="label">${TEXT.howToFix}</span> ${p.fix}</p>\n`
      : '';
    return html`<li class="card">\n<h3>${cardHeading(c, p)}</h3>\n<ul class="badges">\n${badges}</ul>\n${advice}${standards(ctx, c.first, c.wcag, c.section508)}</li>\n`;
  };
  return html`<ol class="cards">\n${sorted.map(card)}</ol>\n`;
}

function finding(ctx: Context, f: Finding): SafeHtml {
  const p = plainFor(f, ctx.plain);
  const outcome =
    f.outcome === 'fail'
      ? html`<li class="badge fail">${TEXT.problem}</li>\n`
      : html`<li class="badge review">${TEXT.checkByHand}</li>\n`;
  const viewport = f.evidence?.viewport;
  const snippet = f.evidence?.snippet;
  const shot = f.evidence?.screenshot;
  const image = shot === undefined ? undefined : ctx.shots.load(shot);
  const picture =
    image === undefined
      ? ''
      : image.ok
        ? html`<img class="shot" src="${image.dataUri}" alt="${TEXT.screenshotAlt}">\n`
        : html`<p>Screenshot left out: ${image.reason}.</p>\n`;
  return html`<li class="finding">
<ul class="badges">\n${outcome}<li class="badge">${IMPACT_LABEL[f.impact ?? 'unrated']}</li>\n</ul>
<h4>${findingHeading(f, p)}</h4>
<p>${findingPlace(f)}</p>
${viewport ? html`<p>${smallScreenText(viewport)}</p>\n` : ''}${snippet ? html`<pre><code>${snippet}</code></pre>\n` : ''}${picture}${standards(ctx, f, f.criteria.wcag ?? [], f.criteria.section508 ?? [])}</li>\n`;
}

function assets(ctx: Context): SafeHtml {
  const { report } = ctx;
  const titles = new Map(report.titles.map((x) => [x.uri, x.title]));
  const { unscanned, skippedOver } = unscannedAssets(report);
  if (report.assets.length === 0 && unscanned.length === 0) return html`<p>${TEXT.noAssets}</p>\n`;
  const section = (uri: string, kind: string, i: number, note?: SafeHtml) => {
    const found = assetFindings(report.findings, uri, report.assets);
    const body =
      note !== undefined && found.length === 0
        ? ''
        : found.length > 0
          ? html`<ol class="findings">\n${found.map((f) => finding(ctx, f))}</ol>\n`
          : html`<p>${TEXT.nothingHere}</p>\n`;
    const id = `asset-${i + 1}`;
    const title = titles.get(uri);
    const header =
      title === undefined
        ? html`<h3 id="${id}" class="uri">${uri}</h3>\n`
        : html`<h3 id="${id}">${title === '' ? TEXT.emptyTitle : title}</h3>\n<p class="uri">${uri}</p>\n`;
    const lead = note ?? html`${assetCounts(found)}`;
    return html`<section aria-labelledby="${id}">
${header}<p class="lead">${assetKindText(kind)}. ${lead}</p>
${body}</section>\n`;
  };
  const others = unscanned.map((u, i) =>
    section(
      u.uri,
      u.kind,
      report.assets.length + i,
      'error' in u ? html`Not scanned (${u.error.code}): ${u.error.message}` : skipNote(u.skip),
    ),
  );
  const over = skippedOver > 0 ? html`<p>${moreSkipped(skippedOver)}</p>\n` : '';
  return html`${report.assets.map((a, i) => section(a.uri, a.kind, i))}${others}${over}`;
}

function summary(ctx: Context): SafeHtml {
  const s = summarize(ctx.report);
  const t = TEXT.summary;
  const row = (label: string, ...cells: number[]) =>
    html`<tr><th scope="row">${label}</th>${cells.map((c) => html`<td>${c}</td>`)}</tr>\n`;
  return html`<table>
<caption>${t.counts}</caption>
<thead><tr><th scope="col">${t.what}</th><th scope="col">${t.number}</th></tr></thead>
<tbody>
${summaryRows(s).map(([label, n]) => row(label, n))}</tbody>
</table>
<table>
<caption>${t.byImpact}</caption>
<thead><tr><th scope="col">${t.impact}</th><th scope="col">${t.problems}</th><th scope="col">${t.toCheck}</th></tr></thead>
<tbody>
${IMPACT_ORDER.map((i) => row(IMPACT_LABEL[i], s.failsByImpact[i], s.needsReviewByImpact[i]))}</tbody>
</table>\n`;
}

/** The level's reason, plus the applicability condition and any profile exception (spec section 4). */
function why(c: Criterion): SafeHtml {
  const notes: SafeHtml[] = [html`${c.reason}`];
  if (c.condition) notes.push(html`${conditionText(c.condition)}`);
  for (const e of exceptionNotes(c)) notes.push(html`${exceptionText(e)}`);
  return html`${notes.map((n, i) => html`${i > 0 ? html`<br>\n` : ''}${n}`)}`;
}

function rollupTables(ctx: Context): SafeHtml {
  const head = TEXT.rollupColumns.map((c) => html`<th scope="col">${c}</th>`);
  const table = (s: ScanReport['rollup']['standards'][number]) => html`<table>
<caption>${STANDARD_LABEL[s.standard] ?? s.standard}</caption>
<thead><tr>${head}</tr></thead>
<tbody>
${s.criteria.map((c) => html`<tr><th scope="row">${c.id}</th><td>${c.title}</td><td>${c.level}</td><td>${why(c)}</td></tr>\n`)}</tbody>
</table>\n`;
  return html`${ctx.report.rollup.standards.map(table)}`;
}

function methodology(ctx: Context): SafeHtml {
  const { report } = ctx;
  const { web, pdf } = report.scope;
  const m = TEXT.method;
  const scope: SafeHtml[] = [
    ...(web?.urls ?? []).map((u) => html`Web page: <span class="uri">${u}</span>`),
    ...(web?.sitemap !== undefined ? [html`Sitemap: <span class="uri">${web.sitemap}</span>`] : []),
    ...(web?.crawl ? [html`${crawlText(web.crawl)}`] : []),
    ...(web?.truncated ? [html`${TEXT.truncated}`] : []),
    ...(pdf?.files ?? []).map((u) => html`PDF: <span class="uri">${u}</span>`),
    ...(pdf?.include ?? []).map((u) => html`PDFs matching: <span class="uri">${u}</span>`),
  ];
  const untested = notEvaluated(report).map((u) => html`${notTestedText(u)}`);
  const { reviewers, records: reviews } = manualReviews(report);
  const records = reviews.map((r) => {
    const notes = r.notes ? html`. Notes: ${r.notes}` : '';
    return html`${recordText(r)}<span class="uri">${r.uri}</span>${r.expired ? EXPIRED_NOTE : ''}${notes}`;
  });
  const people = reviewers.map((p) => html`${reviewerText(p)}`);
  const engines = report.engines.map((e) => html`${engineText(e)}`);
  const errors = report.errors.map((e) => html`<span class="uri">${e.uri}</span>${errorText(e)}`);
  const skipped = [
    ...report.skipped.slice(0, MAX_SKIPPED_LISTED).map(skipItem),
    ...(report.skipped.length > MAX_SKIPPED_LISTED
      ? [moreSkipped(report.skipped.length - MAX_SKIPPED_LISTED)]
      : []),
  ];
  const informational =
    report.informational.length > 0
      ? html`<dt>${m.informational}</dt>\n<dd>${informationalText(report.informational.length)}</dd>\n`
      : '';
  return html`<dl>
<dt>${m.tool}</dt>\n<dd>Widedoor ${report.tool.version}</dd>
<dt>${m.engines}</dt>\n<dd>${list(engines)}</dd>
<dt>${m.profile}</dt>\n<dd>${profileText(report)}</dd>
<dt>${m.dates}</dt>\n<dd>${datesText(report)}</dd>
<dt>${m.scope}</dt>\n<dd>${list(scope)}</dd>
<dt>${m.notTested}</dt>
<dd><p>${TEXT.notTestedLead}</p>
${list(untested)}</dd>
<dt>${m.reviewers}</dt>\n<dd>${list(people, TEXT.noReviewers)}</dd>
<dt>${m.records}</dt>\n<dd>${list(records)}</dd>
<dt>${m.errors}</dt>\n<dd>${list(errors)}</dd>
<dt>${m.skipped}</dt>\n<dd>${list(skipped)}</dd>
<dt>${m.warnings}</dt>\n<dd>${list(report.warnings.map((w) => html`${w}`))}</dd>
${informational}</dl>\n`;
}

/** Renders the HTML report. Bad or unsafe screenshots are left out with a note, never embedded. */
export function renderHtml(report: ScanReport, options: HtmlOptions = {}): string {
  const data = options.data ?? loadStandardsData();
  const ctx: Context = {
    report,
    plain: options.plain ?? loadPlainData(),
    shots: new ScreenshotLoader(options.evidenceDir, options.screenshots),
    wcagTitle: new Map(data.wcag.criteria.map((c) => [c.id, c.title])),
    provisionTitle: new Map(data.section508.provisions.map((p) => [p.id, p.title])),
  };
  const h = TEXT.heading;
  const body = html`<header>
<h1>Accessibility report</h1>
<p class="lead">${leadText(report)}</p>
</header>
<main>
<section aria-labelledby="fix">
<h2 id="fix">${h.fix}</h2>
${cards(ctx)}</section>
<section aria-labelledby="by-asset">
<h2 id="by-asset">${h.byAsset}</h2>
${assets(ctx)}</section>
<section aria-labelledby="summary">
<h2 id="summary">${h.summary}</h2>
${summary(ctx)}</section>
<section aria-labelledby="rollup">
<h2 id="rollup">${h.rollup}</h2>
${rollupTables(ctx)}</section>
<section aria-labelledby="method">
<h2 id="method">${h.method}</h2>
${methodology(ctx)}</section>
<section aria-labelledby="disclaimer">
<h2 id="disclaimer">${h.disclaimer}</h2>
<p class="disclaimer">${DISCLAIMER}</p>
</section>
</main>
<footer><p>Made with Widedoor ${report.tool.version}.</p></footer>`;

  // Rendered after the body: the CSP allows data: images only if a screenshot was embedded.
  const csp = [
    "default-src 'none'",
    `style-src 'sha256-${STYLE_HASH}'`,
    ...(ctx.shots.embedded ? ['img-src data:'] : []),
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const page = html`<!doctype html>
<html lang="en">
<head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Accessibility report</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
  return page.toString();
}
