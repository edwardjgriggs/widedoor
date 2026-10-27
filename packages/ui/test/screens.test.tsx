import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadStandardsData, reviewChecklist } from '@widedoor/core';
import { loadPlainData } from '@widedoor/report';
import { PAYLOAD } from '../../report/test/fixture.ts';
import {
  EXPIRED,
  HERO,
  KEYBOARD,
  OVERRIDE,
  REVIEWER,
  reviewFixtureReport,
} from '../../report/test/review-fixture.ts';
import type { Finding } from '@widedoor/core';
import { itemsWithRecords } from '../../server/src/reviews.ts';
import type { Checklist, Job } from '../src/api.ts';
import { App } from '../src/App.tsx';
import {
  ChecklistView,
  criterionText,
  groupItems,
  toggleText,
  type ChecklistViewProps,
} from '../src/ChecklistView.tsx';
import {
  AS_SCANNED_NOTE,
  EXPORTS,
  ExportView,
  LIVE_NOTE,
  ReviewsNote,
  type ExportViewProps,
} from '../src/ExportView.tsx';
import { Initial, type InitialState } from '../src/initial.ts';
import {
  REVIEWER_KEY,
  ReviewForm,
  rememberReviewer,
  rememberedReviewer,
  type ReviewFormProps,
} from '../src/ReviewForm.tsx';
import {
  DONE_TEXT,
  PROFILES,
  ScanView,
  pdfName,
  pdfNames,
  progressText,
  urlLines,
} from '../src/ScanView.tsx';
import type { UiData } from '../src/data.ts';

/*
 * The Scan, Checklist and Export screens, the review form and the nav, as
 * static markup with api.ts mocked: rendering must never call the server
 * (only effects and clicks do, which the browser suites drive). Checked:
 * every control has a label, the live and alert regions are there, the
 * checklist is grouped by asset and then criterion with headings, the ACR
 * state and reasons come before the download buttons, and every string from
 * the server, a report or a file name renders as text only.
 */

const calls = vi.hoisted(() => [] as string[]);
vi.mock('../src/api.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/api.ts')>();
  const called = (name: string) => (): never => {
    calls.push(name);
    throw new Error(`${name} was called while rendering`);
  };
  return {
    ...real,
    session: called('session'),
    reportBody: called('reportBody'),
    startScan: called('startScan'),
    getScan: called('getScan'),
    cancelScan: called('cancelScan'),
    upload: called('upload'),
    getChecklist: called('getChecklist'),
    recordReview: called('recordReview'),
    getAcrState: called('getAcrState'),
    download: called('download'),
  };
});

afterEach(() => {
  expect(calls).toEqual([]);
  vi.unstubAllGlobals();
});

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const isElement = (n: Node): n is Element => 'tagName' in n;
const attr = (e: Element, name: string) => e.attrs.find((a) => a.name === name)?.value;
const textOf = (n: Node): string =>
  n.nodeName === '#text' && 'value' in n
    ? n.value
    : 'childNodes' in n
      ? n.childNodes.map(textOf).join('')
      : '';
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
/** The review date of a manual record. */
const dateOf = (f: Finding) => ('review' in f ? f.review.date : '');

function find(n: Node, test: (e: Element) => boolean): Element[] {
  const out: Element[] = [];
  const visit = (x: Node) => {
    if (isElement(x) && test(x)) out.push(x);
    if ('childNodes' in x) x.childNodes.forEach(visit);
  };
  visit(n);
  return out;
}

const doc = (markup: string) => parse(`<!doctype html><html><body>${markup}</body></html>`);

/** Text only: no script, no handler attribute, no link or image from content. */
function expectTextOnly(markup: string) {
  const d = doc(markup);
  expect(find(d, (e) => ['script', 'iframe', 'a', 'img', 'form'].includes(e.tagName))).toEqual([]);
  expect(find(d, (e) => e.attrs.some((a) => a.name.startsWith('on')))).toEqual([]);
}

/** Every input, select and textarea has a label (for=id) or is inside a labelled fieldset with one. */
function expectLabelled(markup: string) {
  const d = doc(markup);
  const labels = new Set(find(d, (e) => e.tagName === 'label').map((l) => attr(l, 'for')));
  const controls = find(d, (e) => ['input', 'select', 'textarea'].includes(e.tagName));
  expect(controls.length).toBeGreaterThan(0);
  for (const c of controls) expect(labels.has(attr(c, 'id')), attr(c, 'id')).toBe(true);
}

const roleText = (markup: string, role: string) =>
  find(doc(markup), (e) => attr(e, 'role') === role).map((e) => norm(textOf(e)));

// Test wrappers: the first state of a screen comes through the Initial context, never a prop.
const ScanScreen = ({ initial }: { initial?: NonNullable<InitialState['scan']> }) => (
  <Initial.Provider value={initial ? { scan: initial } : {}}>
    <ScanView onEnded={async () => true} />
  </Initial.Provider>
);
const ChecklistScreen = ({
  initial,
  ...props
}: ChecklistViewProps & { initial?: NonNullable<InitialState['checklist']> }) => (
  <Initial.Provider value={initial ? { checklist: initial } : {}}>
    <ChecklistView {...props} />
  </Initial.Provider>
);
const ReviewFormWith = ({
  initial,
  ...props
}: ReviewFormProps & { initial?: NonNullable<InitialState['review']> }) => (
  <Initial.Provider value={initial ? { review: initial } : {}}>
    <ReviewForm {...props} />
  </Initial.Provider>
);
const ExportScreen = ({
  initial,
  ...props
}: ExportViewProps & { initial?: NonNullable<InitialState['export']> }) => (
  <Initial.Provider value={initial ? { export: initial } : {}}>
    <ExportView {...props} />
  </Initial.Provider>
);

const data: UiData = {
  plain: loadPlainData(),
  wcagTitle: new Map(),
  provisionTitle: new Map(),
  errata: new Map(),
};

describe('the nav', () => {
  it('marks the current screen and has one h1 per screen', () => {
    const report = renderToStaticMarkup(<App data={data} />);
    const current = find(doc(report), (e) => attr(e, 'aria-current') === 'page');
    expect(current.map((e) => textOf(e))).toEqual(['Report']);
    const nav = find(doc(report), (e) => e.tagName === 'nav')[0] as Element;
    expect(attr(nav, 'aria-label')).toBe('Screens');
    expect(find(nav, (e) => e.tagName === 'button').map((e) => textOf(e))).toEqual([
      'Report',
      'Scan',
      'Checklist',
      'Export',
    ]);
    expect(find(doc(report), (e) => e.tagName === 'h1').map((e) => textOf(e))).toEqual([
      'Accessibility report',
    ]);

    const scan = renderToStaticMarkup(
      <Initial.Provider value={{ screen: 'scan' }}>
        <App data={data} />
      </Initial.Provider>,
    );
    expect(
      find(doc(scan), (e) => attr(e, 'aria-current') === 'page').map((e) => textOf(e)),
    ).toEqual(['Scan']);
    expect(find(doc(scan), (e) => e.tagName === 'h1').map((e) => textOf(e))).toEqual([
      'Scan pages and PDFs',
    ]);
    // The heading takes focus on a screen change, so it must be focusable from script only.
    expect(attr(find(doc(scan), (e) => e.tagName === 'h1')[0] as Element, 'tabindex')).toBe('-1');
    // Report stays mounted, hidden, so its filters and a running scan carry on.
    const hidden = find(doc(scan), (e) => e.attrs.some((a) => a.name === 'hidden'));
    expect(hidden).toHaveLength(1);
    expect(norm(textOf(hidden[0] as Element))).toContain('Open a report');
  });
});

const job = (over: Partial<Job>): Job => ({
  id: 'a'.repeat(32),
  status: 'running',
  progress: { done: 0, known: 0 },
  ...over,
});

describe('the Scan screen', () => {
  it('labels every control and has a status and an alert region', () => {
    const markup = renderToStaticMarkup(<ScanScreen />);
    expectLabelled(markup);
    expect(roleText(markup, 'status')).toEqual(['']);
    expect(roleText(markup, 'alert')).toEqual(['']);
    const d = doc(markup);
    const options = find(d, (e) => e.tagName === 'option');
    // The config's profile by default: the request then leaves it out.
    expect(options.map((o) => attr(o, 'value'))).toEqual(['', '508+wcag21aa', '508', 'wcag21aa']);
    expect(options.map((o) => textOf(o))).toEqual(PROFILES.map((p) => p.label));
    expect(textOf(options[0] as Element)).toBe('As in widedoor.config.yaml');
    expect(attr(find(d, (e) => e.tagName === 'select')[0] as Element, 'value')).toBeUndefined();
    expect(
      options.filter((o) => attr(o, 'selected') !== undefined).map((o) => attr(o, 'value')),
    ).toEqual(['']);
    expect(norm(textOf(d))).toContain('0 URLs listed.');
    const buttons = find(d, (e) => e.tagName === 'button');
    expect(buttons.map((b) => [textOf(b), attr(b, 'aria-disabled')])).toEqual([
      ['Start scan', 'false'],
      ['Cancel scan', 'true'],
    ]);
  });

  it('shows a scan in progress as text, with the current asset escaped', () => {
    const current = `https://site.example/${PAYLOAD}${String.fromCharCode(0x202e)}`;
    const running = job({ progress: { done: 1, known: 3, current } });
    const markup = renderToStaticMarkup(
      <ScanScreen
        initial={{
          urls: 'https://a.example/\n\n  https://b.example/  \n',
          pdfs: [
            {
              file: new File(['%PDF'], `${PAYLOAD}.pdf`),
              state: { status: 'uploaded', id: 'b'.repeat(32) },
            },
          ],
          state: { phase: 'scanning', job: running, status: progressText(running) },
        }}
      />,
    );
    expectTextOnly(markup);
    const [status] = roleText(markup, 'status');
    expect(status).toBe(norm(`Scanning 2 of 3: https://site.example/${PAYLOAD}[U+202E]`));
    expect(norm(textOf(doc(markup)))).toContain('2 URLs listed.');
    expect(norm(textOf(doc(markup)))).toContain(`${norm(PAYLOAD)}.pdf: uploaded`);
    const d = doc(markup);
    expect(find(d, (e) => e.tagName === 'button').map((b) => attr(b, 'aria-disabled'))).toEqual([
      'true',
      'false',
    ]);
    expect(attr(find(d, (e) => e.tagName === 'textarea')[0] as Element, 'disabled')).toBe('');
  });

  it('shows an error in the alert region, as text', () => {
    const markup = renderToStaticMarkup(
      <ScanScreen
        initial={{ state: { phase: 'idle', status: '', error: `The scan failed: ${PAYLOAD}` } }}
      />,
    );
    expectTextOnly(markup);
    expect(roleText(markup, 'alert')).toEqual([norm(`The scan failed: ${PAYLOAD}`)]);
  });

  it('words progress, URLs and PDF names as the server takes them', () => {
    expect(progressText(job({ status: 'queued' }))).toBe('The scan is queued.');
    expect(progressText(job({}))).toBe('Starting the scan.');
    expect(progressText(job({ progress: { done: 2, known: 2 } }))).toBe('Scanned 2 of 2.');
    expect(progressText(job({ cancelling: true }))).toBe('Cancelling the scan.');
    expect(urlLines(' a \r\n\r\n b\n')).toEqual(['a', 'b']);
    expect(pdfName('Annual Report (final).PDF')).toBe('Annual-Report-final-.pdf');
    expect(pdfName('..hidden.pdf')).toBe('hidden.pdf');
    expect(pdfName('???.pdf')).toBeUndefined();
    expect(DONE_TEXT).toMatch(/^The scan finished\./);
    // Unique within one scan, case aside, as the server requires.
    expect(pdfNames(['Report 1.pdf', 'Report-1.pdf', 'report-1.PDF', '???.pdf', 'b.pdf'])).toEqual([
      'Report-1.pdf',
      'Report-1-2.pdf',
      'report-1-3.pdf',
      undefined,
      'b.pdf',
    ]);
  });
});

/** The checklist widedoor ui would serve for the review fixture: an override, a pass and an expired record. */
function fixtureChecklist(): Checklist {
  const report = reviewFixtureReport();
  const manual = report.findings.filter((f) => f.source.engine === 'manual');
  const automated = { ...report, findings: report.findings.filter((f) => !manual.includes(f)) };
  const state = reviewChecklist(automated, manual, loadStandardsData());
  return JSON.parse(
    JSON.stringify({
      summary: state.summary,
      items: itemsWithRecords(state),
      warnings: [PAYLOAD],
    }),
  ) as Checklist;
}

describe('the Checklist screen', () => {
  const report = reviewFixtureReport();
  const checklist = fixtureChecklist();
  const markup = renderToStaticMarkup(
    <ChecklistScreen report={report} onRecorded={async () => undefined} initial={{ checklist }} />,
  );

  it('groups items by page or file, then criterion, under headings', () => {
    const d = doc(markup);
    const headings = find(d, (e) => /^h[2-4]$/.test(e.tagName)).map(
      (e) => `${e.tagName} ${norm(textOf(e))}`,
    );
    const groups = groupItems(checklist.items);
    expect(groups.length).toBeGreaterThan(1);
    const want = [
      'h2 Filter the checklist',
      'h2 Records not applied',
      'h2 Items to check by hand',
      ...groups.flatMap((g) => [
        `h3 ${g.heading}`,
        ...g.items.map((i) => `h4 ${norm(criterionText(i.criterion))}`),
      ]),
    ];
    expect(headings).toEqual(want);
    expect(checklist.items).toHaveLength(
      find(d, (e) => e.tagName === 'li' && attr(e, 'class') === 'item').length,
    );
  });

  it('counts each status in the filter and says how many it shows', () => {
    const d = doc(markup);
    const options = find(d, (e) => e.tagName === 'option').map((o) => norm(textOf(o)));
    const n = (s: string) => checklist.items.filter((i) => i.status === s).length;
    expect(options).toEqual([
      `Every status (${checklist.items.length})`,
      `Open (${n('open')})`,
      `Done (${n('done')})`,
      `Expired (${n('expired')})`,
      `Failed an automated check (${n('failed-automated')})`,
    ]);
    expect(n('done')).toBeGreaterThan(0);
    // The new-scan note region (empty), then the count.
    expect(roleText(markup, 'status')).toEqual([
      '',
      `Showing ${checklist.items.length} of ${checklist.items.length} items.`,
    ]);
    const open = renderToStaticMarkup(
      <ChecklistScreen
        report={report}
        onRecorded={async () => undefined}
        initial={{ checklist, filter: 'open' }}
      />,
    );
    expect(roleText(open, 'status')).toEqual([
      '',
      `Showing ${n('open')} of ${checklist.items.length} items.`,
    ]);
    expect(find(doc(open), (e) => attr(e, 'class') === 'item')).toHaveLength(n('open'));
  });

  it('shows the Baseline tests, steps, condition, related findings and current record', () => {
    const text = norm(textOf(doc(markup)));
    const hero = checklist.items.find((i) => i.related.includes(HERO.id));
    expect(hero?.status).toBe('done');
    expect(text).toContain('axe-core image-alt: fail (set aside by a reviewer)');
    expect(text).toContain(`Recorded: Pass, by ${norm(REVIEWER)} on ${dateOf(OVERRIDE)}`);
    expect(text).toContain('Sets aside 1 automated fail');
    expect(text).toContain(`Recorded: Pass, by Grace Hopper on ${dateOf(KEYBOARD)}.`);
    expect(text).toContain(
      `Recorded before the page or file changed (expired): Pass, by Grace Hopper on ${dateOf(EXPIRED)}`,
    );
    expect(text).toMatch(/ICT Testing Baseline tests: \d/);
    expect(text).toContain('Steps:');
    const condition = checklist.items.find((i) => i.condition);
    if (condition?.condition)
      expect(text).toContain(
        norm(`Condition (${condition.condition.provision}): ${condition.condition.text}`),
      );
    expect(text).toContain(norm(PAYLOAD));
    expectTextOnly(markup);
  });

  it('shows the record the checklist sends, never the older one in the report', () => {
    // The report still holds the keyboard pass; a newer fail was recorded since.
    const item = checklist.items.find((i) => i.criterion.id === '2.1.1' && i.record);
    if (!item) throw new Error('no keyboard item');
    const newer: Checklist = {
      ...checklist,
      items: checklist.items.map((i) =>
        i.id === item.id
          ? {
              ...i,
              record: {
                outcome: 'fail',
                reviewer: 'Bo',
                date: '2026-10-26',
                overrides: 0,
                attachments: 0,
                current: true,
              },
            }
          : i,
      ),
    };
    const text = norm(
      textOf(
        doc(
          renderToStaticMarkup(
            <ChecklistScreen
              report={report}
              reviews="as-scanned"
              onRecorded={async () => undefined}
              initial={{ checklist: newer }}
            />,
          ),
        ),
      ),
    );
    expect(text).toContain('Recorded: Fail, by Bo on 2026-10-26.');
    const old = `Recorded: Pass, by Grace Hopper on ${dateOf(KEYBOARD)}.`;
    expect(norm(textOf(doc(markup)))).toContain(old);
    expect(text).not.toContain(old);
    // The Checklist screen says the served report is as scanned, as Report and Export do.
    expect(text).toContain(AS_SCANNED_NOTE);
    expect(norm(textOf(doc(markup)))).not.toContain(AS_SCANNED_NOTE);
  });

  it('opens the review form under its item, with an override checkbox per related fail', () => {
    const item = checklist.items.find((i) => i.related.includes(HERO.id));
    if (!item) throw new Error('no item for the hero image');
    const open = renderToStaticMarkup(
      <ChecklistScreen
        report={report}
        onRecorded={async () => undefined}
        initial={{ checklist, open: item.id }}
      />,
    );
    expectLabelled(open);
    expectTextOnly(open);
    const d = doc(open);
    const toggle = find(d, (e) => attr(e, 'aria-expanded') === 'true');
    expect(toggle).toHaveLength(1);
    expect(attr(toggle[0] as Element, 'aria-controls')).toBe(`review-${item.id}`);
    expect(find(d, (e) => attr(e, 'id') === `review-${item.id}`)).toHaveLength(1);
    expect(find(d, (e) => e.tagName === 'legend').map((e) => textOf(e))).toEqual([
      'Outcome',
      'Automated fails to set aside as false positives (with a Pass)',
    ]);
    const labels = find(d, (e) => e.tagName === 'label').map((e) => norm(textOf(e)));
    expect(labels).toEqual(
      expect.arrayContaining([
        'Pass',
        'Fail',
        'Not applicable',
        'Notes',
        'Reviewer name',
        `axe-core image-alt on ${HERO.asset.uri}`,
        'Images to attach (PNG or JPEG, optional)',
      ]),
    );
    const radios = find(d, (e) => attr(e, 'type') === 'radio');
    expect(new Set(radios.map((r) => attr(r, 'name'))).size).toBe(1);
  });

  it('shows the server refusal of a review in the form alert, as text', () => {
    const item = checklist.items[0];
    if (!item) throw new Error('no item');
    const form = renderToStaticMarkup(
      <ReviewFormWith
        id="f"
        item={item}
        overridable={[]}
        onRecorded={() => undefined}
        onCancel={() => undefined}
        initial={{ outcome: 'pass', reviewer: 'Ann', error: `Refused: ${PAYLOAD}` }}
      />,
    );
    expectTextOnly(form);
    expect(roleText(form, 'alert')).toEqual([norm(`Refused: ${PAYLOAD}`)]);
    expect(
      find(doc(form), (e) => attr(e, 'checked') !== undefined).map((e) => attr(e, 'value')),
    ).toEqual(['pass']);
  });

  it('remembers the reviewer name, and works with storage blocked', () => {
    const store = new Map([[REVIEWER_KEY, 'Ann Reviewer']]);
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null } });
    expect(rememberedReviewer()).toBe('Ann Reviewer');
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    expect(rememberedReviewer()).toBe('');
    // Saving with storage blocked does nothing, and does not throw.
    expect(() => rememberReviewer('Ann')).not.toThrow();
    const setItem = vi.fn(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    vi.stubGlobal('window', { localStorage: { setItem } });
    expect(() => rememberReviewer('Ann')).not.toThrow();
    expect(setItem).toHaveBeenCalledWith(REVIEWER_KEY, 'Ann');
  });

  it('names every toggle by its criterion and its page or file', () => {
    const names = checklist.items.map(toggleText);
    expect(new Set(names).size).toBe(names.length);
    const toggles = find(doc(markup), (e) => attr(e, 'aria-expanded') !== undefined).map((e) =>
      norm(textOf(e)),
    );
    expect(toggles).toEqual(
      groupItems(checklist.items).flatMap((g) => g.items.map((i) => norm(toggleText(i)))),
    );
  });

  it('says it works on the served report when Report shows an opened file', () => {
    const shown = renderToStaticMarkup(
      <ChecklistScreen
        report={report}
        fileShown
        onRecorded={async () => undefined}
        initial={{ checklist }}
      />,
    );
    expect(norm(textOf(doc(shown)))).toContain(
      'The Report screen shows a file you opened. The checklist is of the report widedoor ui holds',
    );
    expect(norm(textOf(doc(markup)))).not.toContain('The Report screen shows a file you opened.');
  });

  it('says why when the checklist cannot be loaded', () => {
    const failed = renderToStaticMarkup(
      <ChecklistScreen
        onRecorded={async () => undefined}
        initial={{ error: 'The checklist could not be loaded: there is no report yet.' }}
      />,
    );
    // With initial.error and no checklist, rendering must not start a load either.
    expect(roleText(failed, 'alert')).toEqual([
      'The checklist could not be loaded: there is no report yet.',
    ]);
  });
});

describe('the Export screen', () => {
  const REASONS = [
    '12 criteria are Not Evaluated',
    `the scope is incomplete: ${PAYLOAD}`,
    'acr.vendor.contact is not set',
  ];

  it('lists every reason a draft is not complete before the download buttons', () => {
    const markup = renderToStaticMarkup(
      <ExportScreen
        reviews="live"
        initial={{
          acr: { kind: 'ready', state: { complete: false, incomplete: REASONS, undecided: 12 } },
        }}
      />,
    );
    expectTextOnly(markup);
    const text = norm(textOf(doc(markup)));
    expect(text).toContain('The ACR is a draft. It is not complete because:');
    const firstButton = text.indexOf(EXPORTS[0]?.label ?? '-');
    for (const reason of REASONS) {
      expect(text).toContain(norm(reason));
      expect(text.indexOf(norm(reason))).toBeLessThan(firstButton);
    }
    expect(text.indexOf(LIVE_NOTE)).toBeGreaterThanOrEqual(0);
    const buttons = find(doc(markup), (e) => e.tagName === 'button').map((b) => textOf(b));
    expect(buttons).toEqual([
      'Check the ACR again',
      ...EXPORTS.map((x) => `${x.label} (${x.file})`),
    ]);
    expect(roleText(markup, 'status')).toEqual(['']);
    expect(roleText(markup, 'alert')).toEqual(['']);
  });

  it('says when the ACR is complete, when it cannot be made, and a failed download', () => {
    const complete = renderToStaticMarkup(
      <ExportScreen
        initial={{
          acr: { kind: 'ready', state: { complete: true, incomplete: [], undecided: 0 } },
        }}
      />,
    );
    expect(norm(textOf(doc(complete)))).toContain('The ACR is complete.');
    const refused = renderToStaticMarkup(
      <ExportScreen
        reviews="as-scanned"
        initial={{
          acr: {
            kind: 'refused',
            message: 'An ACR cannot be exported: the openacr format needs acr.product.name.',
          },
          error: `report.openacr.yaml could not be exported: ${PAYLOAD}`,
        }}
      />,
    );
    expectTextOnly(refused);
    const text = norm(textOf(doc(refused)));
    expect(text).toContain('An ACR cannot be exported: the openacr format needs acr.product.name.');
    expect(text).toContain(AS_SCANNED_NOTE);
    expect(roleText(refused, 'alert')).toEqual([
      norm(`report.openacr.yaml could not be exported: ${PAYLOAD}`),
    ]);
  });

  it('words the memory-only and as-scanned notes as ruled', () => {
    expect(renderToStaticMarkup(<ReviewsNote reviews="live" />)).toBe(
      '<p class="note">This report is kept only while widedoor ui runs. Export it to keep a copy.</p>',
    );
    expect(renderToStaticMarkup(<ReviewsNote reviews="as-scanned" />)).toBe(
      '<p class="note">Reviews recorded after this report was made are not in it. Run a new scan to include them.</p>',
    );
    expect(renderToStaticMarkup(<ReviewsNote reviews={undefined} />)).toBe('');
  });
});
