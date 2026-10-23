import { describe, expect, it } from 'vitest';
import { FindingSchema, loadStandardsData, type Asset } from '@widedoor/core';
import {
  STRUCT_PATH_MAX,
  isValidLanguageTag,
  locationFromContext,
  normalizeVerapdfReport,
  parseVerapdfOutput,
  truncateSnippet,
  widedoorFindings,
  type PdfInspection,
  type VerapdfReport,
} from '../src/index.ts';
import { result, verapdfReport, type Summary } from './fixtures.ts';

const data = loadStandardsData();
const asset: Asset = {
  kind: 'pdf',
  uri: 'docs/report.pdf',
  contentHash: `sha256:${'a'.repeat(64)}`,
};

function report(summaries: Summary[], version?: string): VerapdfReport {
  const parsed = parseVerapdfOutput(result(verapdfReport(summaries, version)));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.report;
}

describe('locationFromContext', () => {
  it('reads the 1-based page of content on a page', () => {
    expect(
      locationFromContext('root/document[0]/pages[4]/contentStream[0]/content[0]/contentItem[2]'),
    ).toEqual({ page: 5 });
  });

  it('builds a structure path from the struct tree steps', () => {
    expect(
      locationFromContext(
        'root/document[0]/StructTreeRoot[0](11 0 obj PDStructTreeRoot)/K[0](12 0 obj SEDocument Document)/K[3](19 0 obj SEFigure Figure)',
      ),
    ).toEqual({ structPath: 'Document[0]/Figure[3]' });
  });

  it('cleans structure types and caps long paths with a hash', () => {
    const step = (i: number) => `K[${i}](${i} 0 obj SEP P<script>)`;
    const ctx = `root/document[0]/StructTreeRoot[0]/${Array.from({ length: 200 }, (_, i) => step(i)).join('/')}`;
    const { structPath } = locationFromContext(ctx);
    expect(structPath?.length).toBe(STRUCT_PATH_MAX);
    expect(structPath).toMatch(/^P_script_\[0\]\//);
    expect(structPath).toMatch(/\.\.\. \[sha256:[0-9a-f]{16}\]$/);
    expect(locationFromContext(`${ctx}/K[999](1 0 obj SEP P)`)).not.toEqual({ structPath });
  });

  it('falls back to the document', () => {
    expect(locationFromContext('root')).toEqual({});
    expect(locationFromContext('root/document[0]/Outlines[0](outline 48 0)')).toEqual({});
  });
});

describe('parseVerapdfOutput', () => {
  it('accepts a JSON report from a compliant or non-compliant run', () => {
    expect(parseVerapdfOutput(result(verapdfReport([]), 0)).ok).toBe(true);
    expect(parseVerapdfOutput(result(verapdfReport([]), 1)).ok).toBe(true);
  });

  it('turns every other run into an error code', () => {
    const cases: [Parameters<typeof parseVerapdfOutput>[0], string][] = [
      [{ ...result(''), timedOut: true }, 'timeout'],
      [{ ...result('{"rep'), truncated: true }, 'output-too-large'],
      [result('STDIN is not a valid PDF document.\n', 7), 'malformed-pdf'],
      [result('STDIN is an encrypted PDF document.\n', 8), 'encrypted-pdf'],
      // Text alone never decides: a non-JSON run with exit 1 is a failed run, not a malformed PDF.
      [result('STDIN is not a valid PDF document.\n', 1), 'verapdf-failed'],
      [{ ...result('', 2), stderr: 'java.lang.OutOfMemoryError' }, 'verapdf-failed'],
      [result('not json', 1), 'verapdf-failed'],
      [result('{"report":{}}', 1), 'verapdf-failed'],
    ];
    for (const [run, code] of cases) {
      const parsed = parseVerapdfOutput(run);
      expect(parsed.ok ? 'ok' : parsed.code, code).toBe(code);
    }
  });

  it('reads parsing and encryption failures from the batch summary', () => {
    const empty = (batchSummary: object) =>
      JSON.stringify({
        report: { buildInformation: { releaseDetails: [] }, jobs: [{}], batchSummary },
      });
    const parse = (s: string) => {
      const p = parseVerapdfOutput(result(s));
      return p.ok ? 'ok' : p.code;
    };
    expect(parse(empty({ failedParsingJobs: 1 }))).toBe('malformed-pdf');
    expect(parse(empty({ failedEncryptedJobs: 1 }))).toBe('encrypted-pdf');
    expect(parse(empty({}))).toBe('verapdf-failed');
  });

  it('rejects a job that did not end normally', () => {
    const json = JSON.parse(verapdfReport([]));
    json.report.jobs[0].validationResult[0].jobEndStatus = 'timeout';
    const parsed = parseVerapdfOutput(result(JSON.stringify(json)));
    expect(parsed.ok ? 'ok' : parsed.code).toBe('verapdf-failed');
  });
});

describe('normalizeVerapdfReport', () => {
  it('gives one fail per location, a pass for checked rules and not-applicable for unchecked ones', () => {
    const { findings, informational, version } = normalizeVerapdfReport(
      report([
        {
          clause: '7.1',
          testNumber: 3,
          status: 'failed',
          checks: [
            {
              status: 'failed',
              context: 'root/document[0]/pages[0]/contentItem[0]',
              errorMessage: 'Untagged content',
            },
            {
              status: 'failed',
              context: 'root/document[0]/pages[0]/contentItem[1]',
              errorMessage: 'Untagged content',
            },
            {
              status: 'failed',
              context: 'root/document[0]/pages[2]/contentItem[0]',
              errorMessage: 'Untagged content',
            },
          ],
          failedChecks: 5,
        },
        { clause: '7.1', testNumber: 10, status: 'failed', checks: [], failedChecks: 1 },
        { clause: '6.2', testNumber: 1, status: 'passed', passedChecks: 1 },
        { clause: '7.5', testNumber: 1, status: 'passed', passedChecks: 0 },
        { clause: '7.1', testNumber: 8, status: 'failed' },
        { clause: '5', testNumber: 1, status: 'passed', passedChecks: 0 },
      ]),
      asset,
      data.verapdf,
    );
    expect(version).toBe('1.30.3');
    for (const f of findings) {
      expect(FindingSchema.safeParse(f).success).toBe(true);
      expect(f.asset).toEqual(asset);
      expect(f.source).toEqual({
        engine: 'verapdf',
        engineVersion: '1.30.3',
        ruleId: f.source.ruleId,
      });
    }
    const brief = findings.map((f) => [
      f.source.ruleId,
      f.outcome,
      f.location,
      f.evidence?.snippet,
    ]);
    expect(brief).toEqual([
      [
        '7.1-3',
        'fail',
        { page: 1 },
        'Untagged content (2 checks failed here) (2 checks more failed for this rule, not listed)',
      ],
      ['7.1-3', 'fail', { page: 3 }, 'Untagged content'],
      ['7.1-10', 'fail', {}, '1 check failed'],
      ['6.2-1', 'pass', {}, undefined],
      ['7.5-1', 'not-applicable', {}, undefined],
    ]);
    expect(findings[0]?.criteria).toEqual({ wcag: ['1.3.1'] });
    // Fails carry the rule's impact from the map; passes and not-applicable carry none.
    const impactOf = (id: string) => data.verapdf.rules.find((r) => r.id === id)?.impact;
    expect(findings.map((f) => f.impact)).toEqual([
      impactOf('7.1-3'),
      impactOf('7.1-3'),
      impactOf('7.1-10'),
      undefined,
      undefined,
    ]);
    expect(impactOf('6.2-1')).toBe('critical');
    expect(impactOf('7.3-1')).toBe('serious');
    expect(informational.map((i) => [i.ruleId, i.outcome, i.uri])).toEqual([
      ['7.1-8', 'fail', 'docs/report.pdf'],
      ['5-1', 'not-applicable', 'docs/report.pdf'],
    ]);
    expect(informational[0]?.reason).toMatch(/./);
  });

  it('caps snippets taken from the PDF', () => {
    const { findings } = normalizeVerapdfReport(
      report([
        {
          clause: '7.2',
          testNumber: 34,
          status: 'failed',
          checks: [{ status: 'failed', context: 'root', errorMessage: 'x'.repeat(5000) }],
        },
      ]),
      asset,
      data.verapdf,
    );
    expect(findings[0]?.evidence?.snippet?.length).toBe(300);
  });

  it('replaces control and bidi characters from the PDF', () => {
    const esc = String.fromCharCode(0x1b);
    const rlo = String.fromCharCode(0x202e);
    const nul = String.fromCharCode(0);
    const raw = `${esc}]8;;https://evil${String.fromCharCode(7)}Click${rlo}fdp.exe${nul}`;
    const snippet = truncateSnippet(raw);
    for (const c of [esc, nul, String.fromCharCode(7), rlo])
      expect(snippet.includes(c)).toBe(false);
    expect(snippet.split(String.fromCharCode(0xfffd))).toHaveLength(5);
    expect(snippet).toContain('Click');
    expect(truncateSnippet('line one\nline\ttwo')).toBe('line one\nline\ttwo');
  });

  it('keeps every finding of a report whose PDF strings say "not a valid PDF"', () => {
    const hostile = 'K[0](12 0 obj SENot a valid PDF Not a valid PDF)';
    const json = verapdfReport([
      {
        clause: '7.1',
        testNumber: 5,
        status: 'failed',
        checks: [
          {
            status: 'failed',
            context: `root/document[0]/StructTreeRoot[0]/${hostile}`,
            errorMessage:
              'Non-standard type "Not a valid PDF" is not mapped. STDIN is not a valid PDF document.',
          },
        ],
      },
    ]);
    const parsed = parseVerapdfOutput(result(json, 1));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { findings } = normalizeVerapdfReport(parsed.report, asset, data.verapdf);
    expect(findings.map((f) => `${f.source.ruleId} ${f.outcome}`)).toEqual(['7.1-5 fail']);
  });

  it('refuses rules missing from the map, another specification and another version', () => {
    const unknown = report([{ clause: '99.9', testNumber: 1, status: 'passed' }]);
    expect(() => normalizeVerapdfReport(unknown, asset, data.verapdf)).toThrow(
      /not in verapdf-map/,
    );
    const other = report([{ clause: '6.2', testNumber: 1, status: 'passed' }]);
    other.report.jobs[0]!.validationResult![0]!.details.ruleSummaries[0]!.specification =
      'ISO 19005-1';
    expect(() => normalizeVerapdfReport(other, asset, data.verapdf)).toThrow(/ISO 19005-1/);
    const old = report([], '1.28.2');
    expect(() => normalizeVerapdfReport(old, asset, data.verapdf)).toThrow(/pinned to 1\.30\.3/);
  });
});

describe('isValidLanguageTag', () => {
  it('accepts BCP 47 tags and refuses the rest', () => {
    for (const tag of ['en', 'en-US', 'fr-CA', 'zh-Hant-TW'])
      expect(isValidLanguageTag(tag), tag).toBe(true);
    for (const tag of ['', 'english language', 'en_US', '123', 'e'.repeat(9)])
      expect(isValidLanguageTag(tag), tag).toBe(false);
  });

  it('refuses tags that name no language: undetermined and private use', () => {
    for (const tag of ['und', 'UND', 'x-klingon', 'qaa', 'qtz-US'])
      expect(isValidLanguageTag(tag), tag).toBe(false);
    expect(isValidLanguageTag('qua')).toBe(true);
  });
});

describe('widedoorFindings', () => {
  const base: PdfInspection = {
    pages: 3,
    title: 'Annual report',
    displayDocTitle: true,
    lang: 'en-US',
    outlineItems: 0,
    tagged: false,
    structureTypes: [],
    structureTruncated: false,
    imageOnlyPages: [],
  };
  const run = (info: Partial<PdfInspection>, longDocumentPages?: number) =>
    widedoorFindings({ ...base, ...info }, asset, data.widedoor, '0.0.0', {
      ...(longDocumentPages ? { longDocumentPages } : {}),
    }).map((f) => {
      expect(FindingSchema.safeParse(f).success).toBe(true);
      return `${f.source.ruleId} ${f.outcome}${'page' in f.location ? ` p${f.location.page}` : ''}`;
    });

  it('passes a clean short untagged document and leaves bookmarks not applicable', () => {
    expect(run({})).toEqual([
      'pdf-title-displayed pass',
      'pdf-language pass',
      'pdf-image-only pass',
      'pdf-bookmarks not-applicable',
    ]);
  });

  it('fails a missing title, a hidden title, a missing or malformed language', () => {
    expect(run({ title: null })).toContain('pdf-title-displayed fail');
    expect(run({ displayDocTitle: false })).toContain('pdf-title-displayed fail');
    expect(run({ lang: null })).toContain('pdf-language fail');
    expect(run({ lang: 'english' })).toContain('pdf-language pass');
    expect(run({ lang: 'en US' })).toContain('pdf-language fail');
  });

  it('fails each image-only page by page number', () => {
    const out = run({ imageOnlyPages: [1, 3] });
    expect(out).toContain('pdf-image-only fail p1');
    expect(out).toContain('pdf-image-only fail p3');
    expect(out).not.toContain('pdf-image-only pass');
  });

  it('asks for review of a long document with no bookmarks, from a configurable length', () => {
    expect(run({ pages: 10 })).toContain('pdf-bookmarks needs-review');
    expect(run({ pages: 9 })).toContain('pdf-bookmarks not-applicable');
    expect(run({ pages: 10, outlineItems: 2 })).toContain('pdf-bookmarks pass');
    expect(run({ pages: 3 }, 3)).toContain('pdf-bookmarks needs-review');
  });

  it('emits the review items once each, only where they apply', () => {
    expect(run({ tagged: true })).toContain('pdf-reading-order needs-review');
    expect(run({ tagged: true }).filter((s) => /alt-text|table-logic/.test(s))).toEqual([]);
    const both = run({ tagged: true, structureTypes: ['Document', 'Figure', 'Table', 'TD'] });
    expect(both.filter((s) => s.endsWith('needs-review'))).toEqual([
      'pdf-reading-order needs-review',
      'pdf-alt-text-quality needs-review',
      'pdf-table-logic needs-review',
    ]);
  });

  it('asks for alt text and table review when the structure was too large to read in full', () => {
    const out = run({ tagged: true, structureTruncated: true });
    expect(out).toContain('pdf-alt-text-quality needs-review');
    expect(out).toContain('pdf-table-logic needs-review');
  });

  it('gives every fail and needs-review the rule impact from the map', () => {
    const findings = widedoorFindings(
      { ...base, title: null, imageOnlyPages: [1], pages: 12, tagged: true },
      asset,
      data.widedoor,
      '0.0.0',
    );
    const impact = Object.fromEntries(
      findings.map((f) => [`${f.source.ruleId} ${f.outcome}`, f.impact ?? null]),
    );
    expect(impact).toEqual({
      'pdf-title-displayed fail': 'serious',
      'pdf-language pass': null,
      'pdf-image-only fail': 'critical',
      'pdf-bookmarks needs-review': 'moderate',
      'pdf-reading-order needs-review': 'moderate',
    });
  });

  it('keeps the title in evidence as given, capped', () => {
    const [title] = widedoorFindings(
      { ...base, title: `<img src=x onerror=alert(1)>${'t'.repeat(400)}`, displayDocTitle: false },
      asset,
      data.widedoor,
      '0.0.0',
    );
    expect(title?.evidence?.snippet?.startsWith('Title "<img src=x onerror=alert(1)>')).toBe(true);
    expect(title?.evidence?.snippet?.length).toBe(300);
  });
});
