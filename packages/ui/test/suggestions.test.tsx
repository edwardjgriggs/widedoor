import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FindingSchema, findingId, loadStandardsData } from '@widedoor/core';
import { aiSuggestable, loadPlainData, overriddenFails } from '@widedoor/report';
import type { AiSuggestionsDoc } from '../../server/src/ai-types.ts';
import { PAGE, fixtureReport } from '../../report/test/fixture.ts';
import { ReportView } from '../src/ReportView.tsx';
import { SuggestionsPanel, type SuggestionsPanelProps } from '../src/SuggestionsView.tsx';
import type { UiData } from '../src/data.ts';

/*
 * The AI fix suggestions panel and the per-finding buttons (Task 3b.8),
 * rendered statically: hidden when unavailable, a confirm step with Cancel
 * that shows exactly what is sent, results as text with the AI-generated
 * label on every entry and patches in <pre>, and no link or apply button
 * anywhere. Hostile text from the model stays text.
 */

type Element = DefaultTreeAdapterMap['element'];
type Node = DefaultTreeAdapterMap['node'];
const isElement = (n: Node): n is Element => 'tagName' in n;
function find(n: Node, test: (e: Element) => boolean): Element[] {
  const out: Element[] = [];
  const visit = (x: Node) => {
    if (isElement(x) && test(x)) out.push(x);
    if ('childNodes' in x) x.childNodes.forEach(visit);
  };
  visit(n);
  return out;
}
const textOf = (n: Node): string =>
  n.nodeName === '#text' && 'value' in n
    ? n.value
    : 'childNodes' in n
      ? n.childNodes.map(textOf).join('')
      : '';

const LABEL =
  'AI-generated. Review before use. Suggestions do not change any result in the report.' as const;
const HOSTILE = '<script>alert(1)</script><a href="https://evil.example/">click</a>';

const DOC: AiSuggestionsDoc = {
  schemaVersion: 1,
  $id: 'urn:widedoor:schema:ai-suggestions:v1',
  label: LABEL,
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  createdAt: '2026-10-29T13:00:00.000Z',
  report: { startedAt: '2026-10-29T12:00:00.000Z', findings: 3 },
  limits: {
    maxGroups: 25,
    maxRequestsPerMinute: 10,
    concurrency: 2,
    maxOutputTokens: 4096,
    maxInputTokensTotal: 200000,
  },
  entries: [
    {
      group: 'g1',
      findingIds: ['wd_0000000000000001'],
      request: {
        ruleId: 'image-alt',
        criteria: ['1.1.1'],
        assetKind: 'web',
        selector: 'img.logo',
        snippet: '<img src="/logo.png">',
        redactions: [],
      },
      delivered: true,
      status: 'ok',
      suggestion: {
        kind: 'web-patch',
        summary: `Add alt text. ${HOSTILE}`,
        patch: '<img src="/logo.png" alt="Acme">',
        notes: 'See https://evil.example/ for more.',
      },
    },
    {
      group: 'g2',
      findingIds: ['wd_0000000000000002'],
      request: {
        ruleId: 'pdf-title',
        criteria: ['2.4.2'],
        assetKind: 'pdf',
        page: 1,
        redactions: [],
      },
      delivered: true,
      status: 'ok',
      suggestion: {
        kind: 'pdf-steps',
        summary: 'Set the document title.',
        tool: 'word',
        steps: ['Open File, Info.', 'Type the title.'],
      },
    },
    {
      group: 'g3',
      findingIds: ['wd_0000000000000003'],
      request: { ruleId: 'label', criteria: ['1.3.1'], assetKind: 'web', redactions: [] },
      delivered: false,
      status: 'not-sent',
      reason: 'Past the group limit.',
    },
  ],
  totals: { requests: 2, inputTokens: 100, outputTokens: 50, skippedGroups: 1 },
};

const props = (over: Partial<SuggestionsPanelProps> = {}): SuggestionsPanelProps => ({
  availability: { available: true, provider: 'anthropic', model: 'claude-opus-5-5' },
  busy: false,
  status: '',
  onAll: () => {},
  onConfirm: () => {},
  onCancel: () => {},
  onDownload: () => {},
  ...over,
});
const render = (p: SuggestionsPanelProps) => renderToStaticMarkup(<SuggestionsPanel {...p} />);

describe('SuggestionsPanel', () => {
  it('renders nothing when AI is unavailable', () => {
    expect(render(props({ availability: { available: false, reason: 'off' } }))).toBe('');
  });

  it('offers "Suggest fixes for all" and names the provider and model', () => {
    const html = render(props());
    const doc = parse(html);
    const buttons = find(doc, (e) => e.tagName === 'button').map((e) => textOf(e));
    expect(buttons).toEqual(['Suggest fixes for all']);
    expect(html).toContain('anthropic (claude-opus-5-5)');
  });

  it('confirms with Cancel first, showing exactly what will be sent', () => {
    const html = render(
      props({
        confirm: {
          preview: {
            dryRun: true,
            provider: 'anthropic',
            model: 'claude-opus-5-5',
            system: 'SYSTEM PROMPT',
            messages: [`Rule: image-alt ${HOSTILE}`],
            estimatedInputTokens: 42,
            skipped: 1,
          },
          scope: 'every failed check',
        },
      }),
    );
    const doc = parse(html);
    const [confirm] = find(doc, (e) =>
      e.attrs.some((a) => a.name === 'class' && a.value === 'confirm'),
    );
    expect(confirm).toBeDefined();
    expect(textOf(find(confirm!, (e) => e.tagName === 'h3')[0]!)).toBe(
      'Send to anthropic (claude-opus-5-5)?',
    );
    const buttons = find(confirm!, (e) => e.tagName === 'button').map((e) => textOf(e));
    expect(buttons).toEqual(['Cancel', 'Send 1 request']);
    const pres = find(confirm!, (e) => e.tagName === 'pre').map((e) => textOf(e));
    expect(pres).toEqual(['SYSTEM PROMPT', `Rule: image-alt ${HOSTILE}`]);
    expect(textOf(confirm!)).toContain('1 group is past the group limit');
    expect(find(doc, (e) => e.tagName === 'a' || e.tagName === 'script')).toEqual([]);
  });

  it('shows results as text, with the label on every entry and patches in <pre>', () => {
    const html = render(props({ result: DOC }));
    const doc = parse(html);
    const entries = find(
      doc,
      (e) => e.tagName === 'li' && e.attrs.some((a) => a.value === 'finding'),
    );
    expect(entries).toHaveLength(3);
    for (const entry of entries) expect(textOf(entry)).toContain(LABEL);
    const patch = find(entries[0]!, (e) => e.tagName === 'pre')[0]!;
    expect(textOf(patch)).toBe('<img src="/logo.png" alt="Acme">');
    expect(textOf(entries[0]!)).toContain(HOSTILE);
    expect(find(entries[1]!, (e) => e.tagName === 'ol')[0]).toBeDefined();
    expect(textOf(entries[2]!)).toContain('Not sent; nothing of it left this machine.');
    // Text only: no link, no script, no image, and no apply button.
    expect(find(doc, (e) => ['a', 'script', 'img', 'iframe'].includes(e.tagName))).toEqual([]);
    const buttons = find(doc, (e) => e.tagName === 'button').map((e) => textOf(e));
    expect(buttons).toEqual([
      'Suggest fixes for all',
      'Download ai-suggestions.json',
      'Download ai-suggestions.html',
    ]);
    expect(buttons.some((b) => /apply/i.test(b))).toBe(false);
  });

  it('"What was sent" shows the plain text and what the report file said, as text', () => {
    const entry = DOC.entries[0]!;
    const sent: AiSuggestionsDoc = {
      ...DOC,
      entries: [
        {
          ...entry,
          request: {
            ...entry.request,
            plain: { what: 'The image has no text alternative.', fix: 'Add an alt attribute.' },
            reportRule: `img-alt ${HOSTILE}`,
            reportCriteria: ['9.9.9', HOSTILE],
          },
        },
      ],
    };
    const doc = parse(render(props({ result: sent })));
    const [details] = find(doc, (e) => e.tagName === 'details');
    const terms = find(details!, (e) => e.tagName === 'dt').map((e) => textOf(e));
    const values = find(details!, (e) => e.tagName === 'dd').map((e) => textOf(e));
    expect(terms).toEqual([
      'Rule',
      'Criteria',
      'Selector',
      'Rule id in the report file',
      'Other criteria in the report file',
      'What is wrong',
      'How to fix',
    ]);
    expect(values.slice(3)).toEqual([
      `img-alt ${HOSTILE}`,
      `9.9.9, ${HOSTILE}`,
      'The image has no text alternative.',
      'Add an alt attribute.',
    ]);
    expect(find(doc, (e) => ['a', 'script'].includes(e.tagName))).toEqual([]);
  });
});

describe('the per-finding button', () => {
  const standards = loadStandardsData();
  const data: UiData = {
    plain: loadPlainData(),
    wcagTitle: new Map(standards.wcag.criteria.map((c) => [c.id, c.title])),
    provisionTitle: new Map(standards.section508.provisions.map((p) => [p.id, p.title])),
    errata: new Map(standards.errata.criteria.map((c) => [c.id, c.citations])),
  };
  const report = fixtureReport();
  const view = (onSuggest?: () => void, suggestDisabled?: boolean) =>
    renderToStaticMarkup(
      <ReportView
        report={report}
        data={data}
        screenshots={new Map()}
        {...(onSuggest ? { onSuggest } : {})}
        {...(suggestDisabled !== undefined ? { suggestDisabled } : {})}
      />,
    );
  const suggestButtons = (markup: string) =>
    find(
      parse(markup),
      (e) => e.tagName === 'button' && textOf(e).startsWith('Suggest a fix (AI)'),
    );

  it('shows on every failed finding only when given onSuggest', () => {
    const without = view();
    expect(without).not.toContain('Suggest a fix (AI)');
    const fails = report.findings.filter((f) => f.outcome === 'fail').length;
    expect(fails).toBeGreaterThan(0);
    const withIt = view(() => {});
    expect(withIt.split('Suggest a fix (AI)').length - 1).toBe(fails);
  });

  // Final fix round 1 item 18: not where buildGroups would skip (aiSuggestable).
  it('is not on a manual fail, which a run never sends', () => {
    const manualFail = FindingSchema.parse({
      schemaVersion: 1,
      id: findingId(PAGE.uri, { selector: 'body' }, 'manual', 'keyboard'),
      asset: PAGE,
      location: { selector: 'body' },
      source: { engine: 'manual', engineVersion: '0.0.0', ruleId: 'keyboard' },
      criteria: { wcag: ['2.1.2'] },
      outcome: 'fail',
      review: {
        reviewer: 'Reviewer',
        date: '2026-10-21',
        notes: 'Focus is trapped in the dialog.',
        expiresOnChangeOf: PAGE.contentHash,
      },
    });
    const withManual = { ...report, findings: [...report.findings, manualFail] };
    const markup = renderToStaticMarkup(
      <ReportView report={withManual} data={data} screenshots={new Map()} onSuggest={() => {}} />,
    );
    // The manual fail is listed, without a button.
    expect(markup).toContain('Focus is trapped in the dialog.');
    const automated = report.findings.filter(aiSuggestable(overriddenFails(report))).length;
    expect(automated).toBe(report.findings.filter((f) => f.outcome === 'fail').length);
    expect(suggestButtons(markup)).toHaveLength(automated);
  });

  // 3b.8 fix round 1 item 2.
  it('is disabled on every finding while a suggestion is prepared, confirmed or run', () => {
    const disabled = (markup: string) =>
      suggestButtons(markup).map((b) => b.attrs.some((a) => a.name === 'disabled'));
    const fails = report.findings.filter((f) => f.outcome === 'fail').length;
    expect(disabled(view(() => {}))).toEqual(Array(fails).fill(false));
    expect(disabled(view(() => {}, false))).toEqual(Array(fails).fill(false));
    expect(disabled(view(() => {}, true))).toEqual(Array(fails).fill(true));
  });
});

// 3b.8 fix round 1 item 1: the places focus moves to can take it (WCAG 2.4.3).
describe('SuggestionsPanel focus targets', () => {
  it('the status line, the results heading and the error take focus by script only', () => {
    const doc = parse(render(props({ result: DOC, error: 'It failed.', status: 'Ready.' })));
    const tabIndex = (e: Element | undefined) => e?.attrs.find((a) => a.name === 'tabindex')?.value;
    expect(tabIndex(find(doc, (e) => e.attrs.some((a) => a.value === 'status'))[0])).toBe('-1');
    expect(tabIndex(find(doc, (e) => e.attrs.some((a) => a.value === 'alert'))[0])).toBe('-1');
    expect(tabIndex(find(doc, (e) => e.tagName === 'h3' && textOf(e) === 'Suggestions')[0])).toBe(
      '-1',
    );
  });
});

describe('the suggestion sources', () => {
  it('use no HTML sink and no link', () => {
    for (const file of ['SuggestionsView.tsx']) {
      const source = readFileSync(join(import.meta.dirname, '..', 'src', file), 'utf8');
      expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML|<a\b|href=/);
    }
  });
});
