import {
  FindingSchema,
  findingId,
  getProfile,
  type Asset,
  type Finding,
  type Location,
} from '@widedoor/core';
import { buildScanReport, type ScanReport } from '../src/index.ts';

/*
 * A fixed scan for the snapshot tests: one web page and one PDF, every
 * outcome the reporters treat differently, two records that share a finding
 * id, and hostile strings in every field that comes from a scan (uri,
 * selector, snippet, error message, warning, scope).
 */

/** SARIF message syntax: a placeholder and an embedded link (SARIF 2.1.0 sections 3.11.5 and 3.11.6). */
export const SARIF_PAYLOAD = '{0} [Fix guide](https://evil.example/login) [x](1) \\[y\\]';

export const PAYLOAD = `</style></textarea><script>alert(1)</script>"><img src=x onerror=alert(2)>`;

const hash = (c: string) => `sha256:${c.repeat(64)}`;
export const PAGE: Asset = {
  kind: 'web',
  uri: `https://example.com/contact?q="><script>alert(3)</script>`,
  contentHash: hash('a'),
};
export const PDF: Asset = { kind: 'pdf', uri: 'docs/annual report.pdf', contentHash: hash('b') };

function record(
  asset: Asset,
  location: Location,
  engine: 'axe-core' | 'verapdf' | 'widedoor',
  ruleId: string,
  rest: Partial<Finding>,
): Finding {
  const version = engine === 'axe-core' ? '4.14.0' : engine === 'verapdf' ? '1.30.3' : '0.0.0';
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(asset.uri, location, engine, ruleId),
    asset,
    location,
    source: { engine, engineVersion: version, ruleId },
    criteria: { wcag: ['1.1.1'] },
    outcome: 'fail',
    ...rest,
  });
}

const label = record(PAGE, { selector: 'form > input#phone' }, 'axe-core', 'label', {
  criteria: { wcag: ['4.1.2'] },
  impact: 'critical',
  evidence: { snippet: '<input id="phone" type="tel">', screenshot: 'wd_label.png' },
});

export const FINDINGS: Finding[] = [
  label,
  // A second record with the same id (findingId ignores outcome and evidence).
  { ...label, evidence: { snippet: `<input id="phone" aria-label='${PAYLOAD}'>` } },
  record(PAGE, { selector: `p[title="${PAYLOAD}"]` }, 'axe-core', 'color-contrast', {
    criteria: { wcag: ['1.4.3'] },
    impact: 'serious',
    evidence: { snippet: `<p class="faint">${PAYLOAD}</p>`, viewport: { width: 320, height: 256 } },
  }),
  record(
    PAGE,
    { selector: `a[href^="javascript:"][id="${SARIF_PAYLOAD}"]` },
    'axe-core',
    'link-name',
    {
      criteria: { wcag: ['2.4.4', '4.1.2'] },
      impact: 'serious',
      evidence: { snippet: '<a href="javascript:alert(4)"></a>' },
    },
  ),
  record(PAGE, { selector: 'img.logo' }, 'axe-core', 'image-alt', {
    outcome: 'needs-review',
    impact: 'moderate',
  }),
  record(PAGE, { selector: 'html' }, 'axe-core', 'document-title', {
    criteria: { wcag: ['2.4.2'] },
    outcome: 'pass',
  }),
  record(PDF, { page: 2, structPath: 'Document/Sect[1]/Figure[1]' }, 'verapdf', '7.3-1', {
    impact: 'serious',
  }),
  record(PDF, {}, 'widedoor', 'pdf-title-displayed', {
    criteria: { wcag: ['2.4.2'] },
    impact: 'serious',
  }),
  record(PDF, {}, 'widedoor', 'pdf-reading-order', {
    criteria: { wcag: ['1.3.2'] },
    outcome: 'needs-review',
    impact: 'moderate',
  }),
];

export const REVIEWS: Finding[] = [
  FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(PAGE.uri, { selector: 'body' }, 'manual', 'keyboard'),
    asset: PAGE,
    location: { selector: 'body' },
    source: { engine: 'manual', engineVersion: '0.0.0', ruleId: 'keyboard' },
    criteria: { wcag: ['2.1.2'] },
    outcome: 'pass',
    plain: {
      what: 'Keyboard focus never gets stuck.',
      who: 'Keyboard users.',
      fix: 'Nothing to fix.',
    },
    review: {
      reviewer: `Edward ${PAYLOAD}`,
      date: '2026-10-21',
      notes: 'Tabbed through the whole page.',
      expiresOnChangeOf: PAGE.contentHash,
    },
  }),
];

export function fixtureReport(): ScanReport {
  return buildScanReport({
    profile: getProfile('wcag21aa'),
    startedAt: '2026-10-22T12:00:00.000Z',
    finishedAt: '2026-10-22T12:05:00.000Z',
    toolVersion: '0.0.0',
    scope: {
      web: { urls: [PAGE.uri, `javascript:alert(5)`], truncated: false },
      pdf: { files: [PDF.uri, 'docs/broken.pdf'], include: [] },
    },
    web: {
      engine: { name: 'axe-core', version: '4.14.0' },
      assets: [PAGE],
      findings: FINDINGS.filter((f) => f.asset.kind === 'web'),
      errors: [
        { uri: 'javascript:alert(5)', code: 'unsupported-url', message: `cannot scan ${PAYLOAD}` },
      ],
      skipped: [
        {
          url: 'https://example.com/out',
          finalUrl: `https://evil.example/${PAYLOAD}`,
          reason: 'redirect-off-origin',
        },
      ],
      warnings: [`Chromium ran without its OS sandbox <b>${PAYLOAD}</b>`],
      truncated: false,
      pages: [{ asset: PAGE, title: `Contact us ${PAYLOAD}` }],
    },
    pdf: {
      engines: {
        verapdf: { version: '1.30.3', runner: 'docker', description: null },
        widedoor: { version: '0.0.0' },
      },
      assets: [PDF],
      findings: FINDINGS.filter((f) => f.asset.kind === 'pdf'),
      informational: [
        {
          uri: PDF.uri,
          engine: 'verapdf',
          ruleId: '5-1',
          outcome: 'fail',
          reason: 'no PDF/UA identification',
        },
      ],
      errors: [
        { uri: 'docs/broken.pdf', code: 'malformed-pdf', engine: 'verapdf', message: 'not a PDF' },
      ],
      warnings: [],
    },
    reviews: REVIEWS,
  });
}
