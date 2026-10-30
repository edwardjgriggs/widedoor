import { describe, expect, it } from 'vitest';
import { renderAiSuggestionsHtml } from '../src/html.ts';
import {
  AI_LABEL,
  AI_SUGGESTIONS_SCHEMA_ID,
  DEFAULT_AI_LIMITS,
  type AiSuggestions,
  type SuggestionEntry,
} from '../src/model.ts';

const HOSTILE =
  '<script>alert(1)</script>[docs](https://evil.example/x)<a href="https://evil.example">x</a>';

const request = (snippet: string) => ({
  ruleId: 'image-alt',
  criteria: ['WCAG 1.1.1'],
  assetKind: 'web' as const,
  selector: 'img.logo',
  snippet,
  plain: { what: 'An image has no text alternative.', fix: 'Add alt text.' },
  redactions: [{ kind: 'query-string', count: 1 }],
});

const entries: SuggestionEntry[] = [
  {
    group: '0123456789abcdef',
    findingIds: ['wd_0123456789abcdef', 'wd_0123456789abcde0'],
    request: request(`<img src="/logo.png?[redacted]" title="${HOSTILE}">`),
    delivered: true,
    status: 'ok',
    suggestion: {
      kind: 'web-patch',
      summary: `Add alt text. ${HOSTILE}`,
      patch: `<img src="/logo.png" alt="Acme"><script>steal()</script>`,
      notes: `Line one.${String.fromCharCode(10)}${HOSTILE}`,
    },
    usage: { inputTokens: 120, outputTokens: 40 },
  },
  {
    group: '1123456789abcdef',
    findingIds: ['wd_1123456789abcdef'],
    request: {
      ruleId: '7.3-1',
      criteria: ['WCAG 1.1.1'],
      assetKind: 'pdf',
      page: 2,
      structPath: 'Document[0]/Figure[1]',
      redactions: [],
    },
    delivered: true,
    status: 'ok',
    suggestion: {
      kind: 'pdf-steps',
      summary: 'Add alternate text in Word.',
      tool: 'word',
      steps: ['Right-click the picture.', `Choose Edit Alt Text. ${HOSTILE}`],
    },
  },
  {
    group: '2123456789abcdef',
    findingIds: ['wd_2123456789abcdef'],
    request: request('<img src="/b.png">'),
    delivered: true,
    status: 'invalid',
    reason: 'the suggestion contained a link',
  },
  {
    group: '3123456789abcdef',
    findingIds: ['wd_3123456789abcdef'],
    request: request('<img src="/NOT-SENT-SNIPPET.png">'),
    delivered: false,
    status: 'skipped-budget',
    reason: 'the input token budget would be passed',
  },
  {
    group: '4123456789abcdef',
    findingIds: ['wd_4123456789abcdef'],
    request: request('<img src="/also-not-sent.png">'),
    delivered: false,
    status: 'not-sent',
    reason: `stopped after a fatal error: ${HOSTILE}`,
  },
];

const doc: AiSuggestions = {
  schemaVersion: 1,
  $id: AI_SUGGESTIONS_SCHEMA_ID,
  label: AI_LABEL,
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  modelAnswered: 'claude-opus-4-8',
  createdAt: '2026-10-29T13:00:00.000Z',
  report: { startedAt: '2026-10-29T12:00:00.000Z', findings: 9 },
  limits: { ...DEFAULT_AI_LIMITS },
  entries,
  totals: { requests: 3, inputTokens: 120, outputTokens: 40, skippedGroups: 7 },
};

const page = renderAiSuggestionsHtml(doc);
const count = (pattern: RegExp) => (page.match(pattern) ?? []).length;
/** The part of the page from one heading to the next h2. */
const section = (id: string) => {
  const start = page.indexOf(`id="${id}"`);
  const end = page.indexOf('<h2', start + 1);
  return page.slice(start, end < 0 ? undefined : end);
};

describe('renderAiSuggestionsHtml', () => {
  it('carries the report CSP first in head and no script, link or image element', () => {
    expect(page).toMatch(
      // Escaped like the HTML report's own CSP attribute (the quotes are &#39;).
      /^<!doctype html>\n<html lang="en">\n<head>\n<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;sha256-[A-Za-z0-9+/=]+&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;">/,
    );
    expect(count(/<script/gi)).toBe(0);
    expect(count(/<a[\s>]/gi)).toBe(0);
    expect(count(/<img/gi)).toBe(0);
    expect(count(/<iframe/gi)).toBe(0);
  });

  it('shows hostile answer text as escaped text only', () => {
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).toContain('[docs](https://evil.example/x)');
    expect(page).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;');
    expect(page).toContain(
      '<pre>&lt;img src=&quot;/logo.png&quot; alt=&quot;Acme&quot;&gt;&lt;script&gt;steal()&lt;/script&gt;</pre>',
    );
  });

  it('shows the label at the top and on every entry', () => {
    expect(count(new RegExp(AI_LABEL.replace(/[.]/g, '\\.'), 'g'))).toBe(1 + entries.length);
    expect(page.indexOf(AI_LABEL)).toBeLessThan(page.indexOf('<main>'));
  });

  it('shows what was sent beside each delivered suggestion', () => {
    const sent = section('sent');
    expect(sent).toContain('What was sent');
    expect(sent).toContain('img.logo');
    expect(sent).toContain('&lt;img src=&quot;/logo.png?[redacted]&quot;');
    expect(sent).toContain('Document[0]/Figure[1]');
    expect(sent).toContain('query-string');
    expect(sent).toContain('Right-click the picture.');
    expect(sent).toContain('the suggestion contained a link');
    expect(count(/What was sent/g)).toBe(3);
  });

  it('lists undelivered entries under Not sent, with their reason and no suggestion or request', () => {
    const notSent = section('not-sent');
    expect(notSent).toContain('Not sent');
    expect(notSent).toContain('the input token budget would be passed');
    expect(notSent).toContain('stopped after a fatal error: &lt;script&gt;');
    expect(notSent).not.toContain('What was sent');
    expect(page).not.toContain('NOT-SENT-SNIPPET');
    expect(page).not.toContain('also-not-sent');
    expect(section('sent')).not.toContain('the input token budget would be passed');
  });

  it('states the totals, the groups past the limit and the models', () => {
    expect(page).toContain('7 groups were past the group limit and were not sent.');
    expect(page).toContain('3 requests');
    expect(page).toContain('claude-opus-5-5');
    expect(page).toContain('claude-opus-4-8');
  });
});
