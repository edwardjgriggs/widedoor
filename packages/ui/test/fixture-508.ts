import {
  FindingSchema,
  findingId,
  getProfile,
  type Asset,
  type Finding,
  type Location,
} from '@widedoor/core';
import { buildScanReport, type ScanReport } from '@widedoor/report';

/*
 * A 508+wcag21aa scan for the parity tests: a web page with an empty title
 * and a non-web PDF (so E205.4 exception notes and Chapter 5 conditions
 * appear in the roll-up), a finding with an ACT rule and a Baseline test, a
 * sitemap and a capped crawl, a pdf-url skip and more skips than the listing
 * cap.
 */

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const PAGE: Asset = { kind: 'web', uri: 'https://example.gov/', contentHash: hash('c') };
const PDF: Asset = { kind: 'pdf', uri: 'docs/form.pdf', contentHash: hash('d') };

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

export function fixture508(): ScanReport {
  const web = [
    record(PAGE, { selector: 'img.hero' }, 'axe-core', 'image-alt', {
      impact: 'critical',
      source: {
        engine: 'axe-core',
        engineVersion: '4.14.0',
        ruleId: 'image-alt',
        actRuleId: '23a2a8',
      },
      criteria: { wcag: ['1.1.1'], section508: ['501.1'], baselineTest: '7.A' },
    }),
    record(PAGE, { selector: 'html' }, 'axe-core', 'html-has-lang', {
      criteria: { wcag: ['3.1.1'] },
      impact: 'serious',
    }),
  ];
  const pdf = [
    record(PDF, { page: 1 }, 'verapdf', '7.3-1', { impact: 'serious' }),
    record(PDF, {}, 'widedoor', 'pdf-reading-order', {
      criteria: { wcag: ['1.3.2'] },
      outcome: 'needs-review',
      impact: 'moderate',
    }),
  ];
  const skipped = [
    {
      url: 'https://example.gov/forms/a.pdf',
      finalUrl: 'https://example.gov/forms/a.pdf',
      reason: 'pdf-url',
    },
    ...Array.from({ length: 24 }, (_, i) => ({
      url: `https://example.gov/old/${i}`,
      finalUrl: `https://elsewhere.example/${i}`,
      reason: 'redirect-off-origin',
    })),
  ];
  return buildScanReport({
    profile: getProfile('508+wcag21aa'),
    startedAt: '2026-10-22T12:00:00.000Z',
    finishedAt: '2026-10-22T12:09:00.000Z',
    toolVersion: '0.0.0',
    scope: {
      web: {
        urls: [PAGE.uri],
        sitemap: 'https://example.gov/sitemap.xml',
        crawl: { sameOrigin: true, maxPages: 2 },
        truncated: true,
      },
      pdf: { files: [PDF.uri], include: ['docs/**/*.pdf'] },
    },
    web: {
      engine: { name: 'axe-core', version: '4.14.0' },
      assets: [PAGE],
      findings: web,
      errors: [],
      skipped,
      warnings: [],
      truncated: true,
      pages: [{ asset: PAGE, title: '' }],
    },
    pdf: {
      engines: {
        verapdf: { version: '1.30.3', runner: 'docker', description: null },
        widedoor: { version: '0.0.0' },
      },
      assets: [PDF],
      findings: pdf,
      informational: [],
      errors: [],
      warnings: [],
    },
  });
}
