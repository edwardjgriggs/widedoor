import { REPORT_STYLE, html, reportCsp, type SafeHtml } from '@widedoor/report';
import type { AiSuggestions, SentRecord, SuggestionEntry } from './model.js';

/*
 * ai-suggestions.html: the suggestions document as one self-contained page,
 * built like the HTML report. The CSP meta tag comes first in head and allows
 * only the one inline style block, by hash; there are no scripts, links,
 * images or forms. Every string, above all the model's answers and the
 * scanned snippets, goes through report's html tag, which escapes it; a
 * patch is shown in <pre> as text. The AI-generated label is at the top and
 * on every entry. A delivered entry shows what was sent beside its result;
 * an undelivered one is listed under "Not sent" with its reason only, since
 * nothing of it left the machine. Prettier leaves the templates alone
 * (prettier.config.js), so their text is the output.
 */

const STYLE = `${REPORT_STYLE}.ai-label { font-weight: bold; }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 1rem; }
article { border-top: 1px solid currentColor; padding-top: 0.5rem; margin-top: 1.5rem; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
`;

// No images, so no img-src; reportCsp throws at load if the style needs escaping.
const CSP = reportCsp(STYLE);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Text with its line breaks kept. */
const lines = (value: string) =>
  html`${value.split('\n').map((line, i) => html`${i > 0 ? html`<br>` : ''}${line}`)}`;

const label = (text: string) => html`<p class="ai-label">${text}</p>\n`;

function sentRecord(r: SentRecord): SafeHtml {
  const row = (term: string, value: string | number | undefined) =>
    value === undefined || value === '' ? '' : html`<dt>${term}</dt><dd>${value}</dd>\n`;
  const removed =
    r.redactions.length === 0
      ? 'nothing'
      : r.redactions.map((x) => `${x.kind} (${x.count})`).join(', ');
  return html`<section>
<h4>What was sent</h4>
<dl>
${row('Rule', r.ruleId)}${row('Criteria', r.criteria.join(', '))}${row('Kind', r.assetKind === 'web' ? 'web page element' : 'PDF')}${row('Selector', r.selector)}${row('Page', r.page)}${row('Structure path', r.structPath)}${row('What is wrong', r.plain?.what)}${row('How to fix', r.plain?.fix)}${row('Removed before sending', removed)}</dl>
${r.snippet !== undefined ? html`<p>Snippet, after redaction:</p>\n<pre>${r.snippet}</pre>\n` : ''}</section>\n`;
}

function result(e: SuggestionEntry): SafeHtml {
  const s = e.suggestion;
  if (e.status !== 'ok' || !s)
    return html`<section>
<h4>No suggestion</h4>
<p>Status: ${e.status}. ${e.reason ?? ''}</p>
</section>\n`;
  if (s.kind === 'web-patch')
    return html`<section>
<h4>Suggested change</h4>
<p>${s.summary}</p>
<p>Replacement markup for the flagged element:</p>
<pre>${s.patch}</pre>
${s.notes !== undefined ? html`<p>${lines(s.notes)}</p>\n` : ''}</section>\n`;
  return html`<section>
<h4>Suggested steps (${s.tool})</h4>
<p>${s.summary}</p>
<ol>\n${s.steps.map((step) => html`<li>${step}</li>\n`)}</ol>
</section>\n`;
}

const findings = (e: SuggestionEntry) =>
  html`<p>Applies to ${plural(e.findingIds.length, 'finding', 'findings')}: ${e.findingIds.join(', ')}</p>\n`;

function delivered(e: SuggestionEntry, text: string): SafeHtml {
  return html`<article>
<h3>${e.request.ruleId}: ${e.status}</h3>
${label(text)}${findings(e)}<div class="pair">
${sentRecord(e.request)}${result(e)}</div>
</article>\n`;
}

function undelivered(e: SuggestionEntry, text: string): SafeHtml {
  return html`<article>
<h3>${e.request.ruleId}: ${e.status}</h3>
${label(text)}<p>${e.reason ?? ''}</p>
${findings(e)}</article>\n`;
}

/** The suggestions document as a self-contained HTML page; see the module comment. */
export function renderAiSuggestionsHtml(doc: AiSuggestions): string {
  const sent = doc.entries.filter((e) => e.delivered);
  const notSent = doc.entries.filter((e) => !e.delivered);
  const t = doc.totals;
  const answeredBy =
    doc.modelAnswered !== undefined && doc.modelAnswered !== doc.model
      ? `, answered by ${doc.modelAnswered}`
      : '';
  const skipped =
    t.skippedGroups > 0
      ? ` ${plural(t.skippedGroups, 'group was', 'groups were')} past the group limit and ${t.skippedGroups === 1 ? 'was' : 'were'} not sent.`
      : '';
  const notSentPart =
    notSent.length > 0
      ? html`<h2 id="not-sent">Not sent</h2>
<p>Nothing from these groups left this machine.</p>
${notSent.map((e) => undelivered(e, doc.label))}`
      : '';
  const page = html`<!doctype html>
<html lang="en">
<head>
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>AI fix suggestions</title>
<style>${STYLE}</style>
</head>
<body>
<header>
${label(doc.label)}<h1>AI fix suggestions</h1>
<p class="lead">Provider ${doc.provider}, model ${doc.model}${answeredBy}. Created ${doc.createdAt}, for the scan report started ${doc.report.startedAt} (${plural(doc.report.findings, 'finding', 'findings')}).</p>
<p>${plural(t.requests, 'request', 'requests')}, ${t.inputTokens} input tokens and ${t.outputTokens} output tokens reported.${skipped}</p>
</header>
<main>
<h2 id="sent">Suggestions</h2>
${sent.length === 0 ? html`<p>No request was sent.</p>\n` : sent.map((e) => delivered(e, doc.label))}${notSentPart}</main>
</body>
</html>
`;
  return page.toString();
}
