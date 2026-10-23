import { readFileSync } from 'node:fs';
import AjvDraft04 from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { FindingSchema, findingId, getProfile, type Asset } from '@widedoor/core';
import {
  MAX_SKIPPED_NOTIFICATIONS,
  buildScanReport,
  toSarif,
  type WebRunInput,
} from '../src/index.ts';

/*
 * SARIF and an incomplete scope: executionSuccessful stays tied to scan
 * errors (SARIF semantics), skipped pages and scope gaps are note-level tool
 * notifications (skips capped, the rest counted), and
 * run.properties.scopeComplete says whether anything was left out. Every log
 * still validates against the vendored SARIF 2.1.0 schema.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SARIF is checked by the schema, not by types
type Sarif = any;

const schema = JSON.parse(
  readFileSync(new URL('../vendor/sarif/sarif-schema-2.1.0.json', import.meta.url), 'utf8'),
);
const ajv = new AjvDraft04.default({ strict: true, strictRequired: false, allErrors: true });
addFormats.default(ajv);
const validate = ajv.compile(schema);

const PAGE: Asset = {
  kind: 'web',
  uri: 'https://site.example/',
  contentHash: `sha256:${'a'.repeat(64)}`,
};

function sarifFor(web: Partial<WebRunInput>): Sarif {
  const report = buildScanReport({
    profile: getProfile('wcag21aa'),
    startedAt: '2026-10-23T12:00:00.000Z',
    finishedAt: '2026-10-23T12:01:00.000Z',
    toolVersion: '0.0.0',
    scope: { web: { urls: [PAGE.uri], truncated: false } },
    web: {
      engine: { name: 'axe-core', version: '4.14.0' },
      assets: [PAGE],
      findings: [],
      errors: [],
      skipped: [],
      warnings: [],
      truncated: false,
      ...web,
    },
  });
  const sarif = toSarif(report);
  expect(validate(sarif), JSON.stringify(validate.errors, null, 2)).toBe(true);
  return sarif;
}

const invocation = (s: Sarif) => s.runs[0].invocations[0];
const notes = (s: Sarif) => (invocation(s).toolExecutionNotifications ?? []) as Sarif[];

describe('SARIF scope completeness', () => {
  it('says the scope is complete when nothing was left out', () => {
    const s = sarifFor({});
    expect(invocation(s).executionSuccessful).toBe(true);
    expect(notes(s)).toEqual([]);
    expect(s.runs[0].properties.scopeComplete).toBe(true);
  });

  it('lists skipped pages as notes, capped, without failing the run', () => {
    const skipped = Array.from({ length: MAX_SKIPPED_NOTIFICATIONS + 5 }, (_, i) => ({
      url: `https://site.example/file${i}.pdf`,
      finalUrl: `https://site.example/file${i}.pdf`,
      reason: 'pdf-url',
    }));
    const s = sarifFor({ skipped });
    expect(invocation(s).executionSuccessful).toBe(true);
    const n = notes(s);
    expect(n.every((x) => x.level === 'note')).toBe(true);
    expect(n.filter((x) => x.properties.code === 'pdf-url')).toHaveLength(
      MAX_SKIPPED_NOTIFICATIONS,
    );
    const more = n.find((x) => x.properties.code === 'skipped-more');
    expect(more.properties.count).toBe(5);
    expect(more.message.text).toContain('5 more skipped');
    expect(s.runs[0].properties.scopeComplete).toBe(false);
  });

  it('turns each scope gap, including a truncated crawl, into a note', () => {
    const s = sarifFor({
      truncated: true,
      scopeGaps: ['3 link(s) were not followed: at most 1000 are read from one page'],
    });
    expect(invocation(s).executionSuccessful).toBe(true);
    const gaps = notes(s).filter((x) => x.properties.code === 'scope-gap');
    expect(gaps.map((g) => g.message.text)).toEqual([
      'scope incomplete: the page limit stopped the crawl with pages still queued',
      'scope incomplete: 3 link(s) were not followed: at most 1000 are read from one page',
    ]);
    expect(gaps.every((g) => g.level === 'note')).toBe(true);
    expect(s.runs[0].properties.scopeComplete).toBe(false);
  });

  it('gives a fail with no impact the error level, as it trips the exit gate', () => {
    const unrated = FindingSchema.parse({
      schemaVersion: 1,
      id: findingId(PAGE.uri, { selector: 'img' }, 'axe-core', 'image-alt'),
      asset: PAGE,
      location: { selector: 'img' },
      source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId: 'image-alt' },
      criteria: { wcag: ['1.1.1'] },
      outcome: 'fail',
    });
    const s = sarifFor({ findings: [unrated] });
    expect(s.runs[0].results.map((r: Sarif) => r.level)).toEqual(['error']);
    expect(s.runs[0].tool.driver.rules[0].defaultConfiguration.level).toBe('error');
  });
});
