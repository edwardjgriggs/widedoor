import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProfile, type Asset } from '@widedoor/core';
import {
  DISCLAIMER,
  SafeHtml,
  ScanReportCheckedSchema,
  ScreenshotLoader,
  buildScanReport,
  escapeHtml,
  html,
  renderHtml,
  type ScanReport,
} from '../src/index.ts';
import { FINDINGS, PAGE, PAYLOAD, fixtureReport } from './fixture.ts';
import { expectInert, inspect } from './inert.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

function textOf(node: Node): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  if ('tagName' in node && (node.tagName === 'style' || node.tagName === 'script')) return '';
  return 'childNodes' in node ? node.childNodes.map(textOf).join('') : '';
}

function elements(doc: Node, match: (e: Element) => boolean): Element[] {
  const out: Element[] = [];
  const visit = (n: Node) => {
    if ('tagName' in n && match(n)) out.push(n);
    if ('childNodes' in n) n.childNodes.forEach(visit);
  };
  visit(doc);
  return out;
}

const headings = (doc: Node, tag: string) => elements(doc, (e) => e.tagName === tag).map(textOf);

const cardHeadings = (doc: Node) =>
  elements(
    doc,
    (e) => e.tagName === 'li' && e.attrs.some((a) => a.name === 'class' && a.value === 'card'),
  )
    .flatMap((li) => elements(li, (e) => e.tagName === 'h3'))
    .map(textOf);

/** The criterion table row for an id under a standard caption. */
function row(doc: Node, standard: string, id: string): string {
  const table = elements(doc, (e) => e.tagName === 'table').find((t) =>
    elements(t, (e) => e.tagName === 'caption').some((c) => textOf(c) === standard),
  );
  const tr =
    table &&
    elements(table, (e) => e.tagName === 'tr').find((r) =>
      elements(r, (e) => e.tagName === 'th').some((th) => textOf(th) === id),
    );
  if (!tr) throw new Error(`no ${standard} row ${id}`);
  return textOf(tr);
}

describe('escapeHtml', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('shows control, bidi and other invisible characters as visible markers', () => {
    const c = (...codes: number[]) => String.fromCodePoint(...codes);
    expect(escapeHtml(`a${c(0x202e)}b${c(0x2066)}c\u0007d\u001be\u0000f`)).toBe(
      'a[U+202E]b[U+2066]c[U+0007]d[U+001B]e[U+0000]f',
    );
    expect(escapeHtml('tab\tnew\nline\r')).toBe('tab\tnew\nline\r');
    expect(escapeHtml(String.fromCharCode(0xd800))).toBe('[U+D800]');
    // Tag characters (astral), zero-width space and joiner, word joiner, soft hyphen,
    // line separator, a noncharacter, a Hangul filler and a variation selector.
    expect(
      escapeHtml(c(0xe0041, 0x200b, 0x200d, 0x2060, 0xad, 0x2028, 0xfdd0, 0x3164, 0xfe0f)),
    ).toBe('[U+E0041][U+200B][U+200D][U+2060][U+00AD][U+2028][U+FDD0][U+3164][U+FE0F]');
    expect(escapeHtml('caf\u00e9 \u00fcber')).toBe('caf\u00e9 \u00fcber');
  });

  it('round-trips hostile text through text and attribute context', () => {
    const doc = parse(
      `<!doctype html><title>t</title>${html`<p title="${PAYLOAD}" data-x='${PAYLOAD}'>${PAYLOAD}</p>`}`,
    );
    const body = (doc.childNodes[1] as Element).childNodes[1] as Element;
    expect(body.childNodes).toHaveLength(1);
    const p = body.childNodes[0] as Element;
    expect(p.attrs).toEqual([
      { name: 'title', value: PAYLOAD },
      { name: 'data-x', value: PAYLOAD },
    ]);
    expect(textOf(p)).toBe(PAYLOAD);
  });

  it('does not let anything but the html tag make SafeHtml', () => {
    expect(() => new SafeHtml(Symbol('SafeHtml'), '<script></script>')).toThrow();
    expect(html`${html`<b>`}${'<b>'}`.toString()).toBe('<b>&lt;b&gt;');
    expect(html`${['<i>', html`<i>`, null, undefined, false, 0]}`.toString()).toBe('&lt;i&gt;<i>0');
  });
});

describe('HTML report', () => {
  const report = fixtureReport();
  const page = renderHtml(report);
  const doc = parse(page);
  const text = textOf(doc);

  it('is inert: only allowlisted elements, attributes and links, CSP first in head', () => {
    const r = expectInert(page);
    expect(r.images).toEqual([]);
  });

  it('shows every hostile string as text', () => {
    expect(text).toContain(PAYLOAD);
    expect(text).toContain('<input id="phone" aria-label=');
    expect(serialize(doc)).not.toContain('<script>');
  });

  it('puts the sections in order and ends with the disclaimer', () => {
    expect(headings(doc, 'h2')).toEqual([
      'What to fix first',
      'Results by page and file',
      'Summary',
      'Results by criterion',
      'How this was tested',
      'About this report',
    ]);
    expect(text).toContain(DISCLAIMER);
  });

  it('sorts the cards by impact, then rules with problems, then count, then engine and rule', () => {
    expect(cardHeadings(doc)).toEqual([
      'A form field has no label.',
      'Text does not stand out enough from its background.',
      'A link has no text.',
      'An image has no alt text.',
      'The PDF does not show a title in its window.',
      'An image has no text alternative.',
      'A person needs to check that the tags read in the same order as the page.',
    ]);
    // One more link-name problem puts that card ahead of color-contrast.
    const link = FINDINGS.find((f) => f.source.ruleId === 'link-name');
    const more: ScanReport = { ...report, findings: [...report.findings, ...(link ? [link] : [])] };
    expect(cardHeadings(parse(renderHtml(more))).slice(1, 3)).toEqual([
      'A link has no text.',
      'Text does not stand out enough from its background.',
    ]);
  });

  it('shows both records that share a finding id', () => {
    expect(headings(doc, 'h4').filter((h) => h === 'A form field has no label.')).toHaveLength(2);
    expect(page).not.toMatch(/id="wd_/);
  });

  it('heads a page section with its title, escaped, and lists unscanned assets', () => {
    expect(headings(doc, 'h3')).toContain(`Contact us ${PAYLOAD}`);
    expect(text).toContain('Not scanned (unsupported-url): cannot scan');
    expect(text).toContain('Not scanned (malformed-pdf): not a PDF');
    expect(text).toContain('Not scanned: it went to');
  });

  it('lists reviewers and manual review records, escaped', () => {
    expect(text).toContain(`Edward ${PAYLOAD}: 1 record, reviewed 2026-10-21`);
    expect(text).toContain(
      `Edward ${PAYLOAD}, 2026-10-21: pass for WCAG 2.1.2 on ${PAGE.uri}. Notes: Tabbed through the whole page.`,
    );
    const stale: ScanReport = {
      ...report,
      assets: report.assets.map((a) =>
        a.uri === PAGE.uri ? { ...a, contentHash: `sha256:${'c'.repeat(64)}` } : a,
      ),
    };
    expect(textOf(parse(renderHtml(stale)))).toContain(
      '(expired: the content changed since this review',
    );
  });

  it('lists a criterion as not tested when any asset has no deciding result', () => {
    // 4.1.2 fails on the web page, so its level is Does Not Support, but the PDF is untested.
    expect(text).toMatch(/4\.1\.2 Name, Role, Value: \d+ of \d+ pages and files not evaluated/);
  });

  it('collapses standards references and notes missing screenshots', () => {
    expect(page).toContain('<summary>Standards and rule</summary>');
    expect(text).toContain('Screenshot left out: no evidence folder was given.');
  });

  it('matches its snapshot', async () => {
    await expect(page).toMatchFileSnapshot('__snapshots__/report.html');
  });
});

describe('HTML report under the 508 profile', () => {
  const pdf: Asset = { kind: 'pdf', uri: 'docs/a.pdf', contentHash: `sha256:${'d'.repeat(64)}` };
  const web: Asset = {
    kind: 'web',
    uri: 'https://example.com/',
    contentHash: `sha256:${'e'.repeat(64)}`,
  };
  const build = (assets: Asset[]) =>
    buildScanReport({
      profile: getProfile('508'),
      startedAt: '2026-10-22T12:00:00.000Z',
      finishedAt: '2026-10-22T12:00:01.000Z',
      toolVersion: '0.0.0',
      scope: {},
      ...(assets.some((a) => a.kind === 'pdf')
        ? {
            pdf: {
              engines: {
                verapdf: { version: '1.30.3', runner: null, description: null },
                widedoor: { version: '0.0.0' },
              },
              assets: assets.filter((a) => a.kind === 'pdf'),
              findings: [],
              informational: [],
              errors: [],
              warnings: [],
            },
          }
        : {}),
      ...(assets.some((a) => a.kind === 'web')
        ? {
            web: {
              engine: { name: 'axe-core' as const, version: '4.14.0' },
              assets: assets.filter((a) => a.kind === 'web'),
              findings: [],
              errors: [],
              skipped: [],
              warnings: [],
              truncated: false,
            },
          }
        : {}),
    });

  it('notes the E205.4 exception on a criterion that is not applicable to PDFs', () => {
    const doc = parse(renderHtml(build([pdf])));
    const bypass = row(doc, 'Section 508', '2.4.1');
    expect(bypass).toContain('Not Applicable');
    expect(bypass).toContain(
      'Not applicable to 1 PDF under E205.4: Non-Web documents shall not be required',
    );
  });

  it('shows the applicability condition of a Chapter 5 item', () => {
    const doc = parse(renderHtml(build([web])));
    expect(row(doc, 'Section 508', '502.3.1')).toContain(
      'Condition (501.1): Applies only if the web application',
    );
    expect(row(doc, 'Section 508', '502.2.1')).toContain(
      'Condition (502.2.1): Applies only to platform software',
    );
  });
});

describe('HTML report of a scan where nothing could be scanned', () => {
  const report = buildScanReport({
    profile: getProfile('508+wcag21aa'),
    startedAt: '2026-10-22T12:00:00.000Z',
    finishedAt: '2026-10-22T12:00:01.000Z',
    toolVersion: '0.0.0',
    scope: { web: { urls: ['https://example.com/'], truncated: false } },
    web: {
      engine: { name: 'axe-core', version: '4.14.0' },
      assets: [],
      findings: [],
      errors: [
        { uri: 'https://example.com/', code: 'navigation-failed', message: 'net::ERR_FAILED' },
      ],
      skipped: [],
      warnings: [],
      truncated: false,
    },
  });

  it('lists every criterion under what was not tested', () => {
    const page = renderHtml(report);
    const doc = parse(page);
    expectInert(page);
    const dd = elements(doc, (e) => e.tagName === 'dt').find(
      (dt) => textOf(dt) === 'What was not tested',
    );
    expect(dd).toBeDefined();
    const text = textOf(doc);
    expect(text).toContain('1.1.1 Non-text Content: 1 of 1 page or file not evaluated');
    expect(text).not.toMatch(/Criteria not tested \(no deciding result\)0/);
    for (const s of report.rollup.standards)
      for (const c of s.criteria.filter((c) => c.scope === 'asset' && c.level !== 'Not Applicable'))
        expect(text, c.id).toContain(`${c.id} ${c.title}: `);
  });
});

describe('skipped pages', () => {
  const skippedReport = (skipped: { url: string; finalUrl: string; reason: string }[]) =>
    buildScanReport({
      profile: getProfile('wcag21aa'),
      startedAt: '2026-10-22T12:00:00.000Z',
      finishedAt: '2026-10-22T12:00:01.000Z',
      toolVersion: '0.0.0',
      scope: { web: { urls: ['https://example.com/'], truncated: false } },
      web: {
        engine: { name: 'axe-core', version: '4.14.0' },
        assets: [],
        findings: [],
        errors: [],
        skipped,
        warnings: [],
        truncated: false,
      },
    });

  it('words a PDF link and an off-origin redirect each by its reason', () => {
    const page = renderHtml(
      skippedReport([
        {
          url: 'https://example.com/a.pdf',
          finalUrl: 'https://example.com/a.pdf',
          reason: 'pdf-url',
        },
        {
          url: 'https://example.com/out',
          finalUrl: 'https://other.example/',
          reason: 'redirect-off-origin',
        },
      ]),
    );
    expectInert(page);
    const text = textOf(parse(page));
    expect(text).toContain(
      'Not scanned: PDFs linked by URL are not fetched yet. Download the file and scan it as a local PDF (pdf-url).',
    );
    expect(text).toContain('https://example.com/a.pdf: a PDF link, not fetched (pdf-url)');
    expect(text).not.toContain('it went to https://example.com/a.pdf');
    expect(text).toContain('Not scanned: it went to https://other.example/ (redirect-off-origin)');
    expect(text).toContain(
      'https://example.com/out went to https://other.example/ (redirect-off-origin)',
    );
  });

  it('lists at most 20 skipped pages and counts the rest', () => {
    const many = Array.from({ length: 45 }, (_, i) => ({
      url: `https://example.com/f/${i}.pdf`,
      finalUrl: `https://example.com/f/${i}.pdf`,
      reason: 'pdf-url',
    }));
    const text = textOf(parse(renderHtml(skippedReport(many))));
    expect(text).toContain('https://example.com/f/19.pdf: a PDF link');
    expect(text).not.toContain('https://example.com/f/20.pdf');
    expect(
      text.split('25 more skipped pages and files are listed in the JSON report.'),
    ).toHaveLength(3);
  });
});

describe('structure does not depend on content', () => {
  it('gives a hostile report the same elements and attributes as a benign twin', () => {
    // Probe payloads: raw-text breakouts, svg animate, meta refresh, base, comments,
    // CDATA, MathML links, invisible characters and SARIF message syntax.
    const hostile = [
      '</title></style></textarea></noscript></xmp></plaintext><script>alert(1)</script>',
      '"><svg><animate attributeName=href values="x;javascript:alert(1)"/><a href=//evil.example>x</a>',
      `'><meta http-equiv=refresh content="0;url=https://evil.example"><base href=//evil.example/>`,
      '<!--<img src=x onerror=alert(1)>--><![CDATA[]]><math><mi xlink:href=javascript:alert(1)>',
      String.fromCodePoint(0, 0x202e, 0x2066, 0xe0041, 0x200b, 0x2028, 0xfdd0),
      '{0} [click](https://evil.example)',
    ].join(' ');
    const suffixed = (suffix: string) => {
      let report: ScanReport = fixtureReport();
      const leaves: (string | number)[][] = [];
      const walk = (o: unknown, path: (string | number)[]) => {
        if (typeof o === 'string') leaves.push(path);
        else if (o && typeof o === 'object')
          for (const [k, v] of Object.entries(o))
            walk(v, [...path, Array.isArray(o) ? Number(k) : k]);
      };
      walk(report, []);
      let changed = 0;
      for (const path of leaves) {
        const trial = structuredClone(report) as unknown as Record<string | number, unknown>;
        let at = trial;
        for (const k of path.slice(0, -1)) at = at[k] as Record<string | number, unknown>;
        const last = path.at(-1) as string | number;
        at[last] = `${at[last] as string}${suffix}`;
        const parsed = ScanReportCheckedSchema.safeParse(trial);
        if (parsed.success) {
          report = parsed.data;
          changed++;
        }
      }
      return { report, changed };
    };
    const bad = suffixed(` ${hostile}`);
    const good = suffixed(' zzz');
    expect(bad.changed).toBe(good.changed);
    expect(bad.changed).toBeGreaterThan(100);
    const hostilePage = renderHtml(bad.report);
    expectInert(hostilePage);
    expect(inspect(hostilePage).shape).toEqual(inspect(renderHtml(good.report)).shape);
  });
});

describe('screenshots', () => {
  let root: string;
  let evidence: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'widedoor-report-'));
    evidence = join(root, 'evidence');
    mkdirSync(join(evidence, 'sub'), { recursive: true });
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(evidence, 'ok.png'), PNG);
    writeFileSync(join(evidence, 'sub', 'nested.png'), PNG);
    writeFileSync(join(evidence, 'fake.png'), 'not a png');
    writeFileSync(join(evidence, 'big.png'), Buffer.concat([PNG, Buffer.alloc(4096)]));
    writeFileSync(join(root, 'outside', 'secret.png'), PNG);
    // A junction needs no special rights on Windows and is a symbolic link elsewhere.
    symlinkSync(join(root, 'outside'), join(evidence, 'link'), 'junction');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const load = (path: string, limits = {}) => new ScreenshotLoader(evidence, limits).load(path);
  const NOT_PLAIN = {
    ok: false,
    reason: 'the path is not a plain path inside the evidence folder',
  };
  const NOT_IN_FOLDER = { ok: false, reason: 'the file is not in the evidence folder' };

  it('embeds a PNG inside the evidence folder', () => {
    expect(load('ok.png')).toMatchObject({
      ok: true,
      dataUri: `data:image/png;base64,${PNG.toString('base64')}`,
    });
    expect(load('sub/nested.png').ok).toBe(true);
    expect(load('sub\\nested.png').ok).toBe(process.platform === 'win32');
  });

  it('refuses, before touching the disk, paths that are not plain relative paths', () => {
    for (const path of [
      '../outside/secret.png',
      'sub/../ok.png',
      '..\\outside\\secret.png',
      'D:secret.png',
      'C:/Windows/win.ini',
      '/etc/passwd',
      '\\\\server\\share\\x.png',
      resolve(evidence, 'ok.png'),
      '.',
      './ok.png',
      'sub//nested.png',
      '',
      'ok.png\0x',
    ])
      expect(load(path), path).toEqual(NOT_PLAIN);
  });

  it('gives one reason for a missing file and a file outside the folder', () => {
    expect(load('link/secret.png')).toEqual(NOT_IN_FOLDER);
    expect(load('missing.png')).toEqual(NOT_IN_FOLDER);
  });

  it('refuses directories, non-PNG and oversized files and stops at the report total', () => {
    expect(load('sub')).toEqual({ ok: false, reason: 'the path is not a regular file' });
    expect(load('fake.png')).toEqual({ ok: false, reason: 'the file is not a PNG image' });
    expect(load('big.png', { maxBytes: 1024 })).toEqual({
      ok: false,
      reason: 'the file is over the size limit',
    });
    const loader = new ScreenshotLoader(evidence, { maxTotalBytes: PNG.length + 10 });
    expect(loader.load('ok.png').ok).toBe(true);
    expect(loader.load('sub/nested.png')).toEqual({
      ok: false,
      reason: 'the report reached its screenshot size limit',
    });
  });

  it('allows data: images in the CSP only when one is embedded', () => {
    const report = fixtureReport();
    writeFileSync(join(evidence, 'wd_label.png'), PNG);
    const page = renderHtml(report, { evidenceDir: evidence });
    const r = expectInert(page);
    expect(r.images).toHaveLength(1);
    const outside = renderHtml(report, { evidenceDir: join(root, 'outside') });
    expect(expectInert(outside).images).toEqual([]);
    expect(outside).toContain('Screenshot left out: the file is not in the evidence folder.');
  });
});
