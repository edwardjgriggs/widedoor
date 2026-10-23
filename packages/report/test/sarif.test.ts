import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AjvDraft04 from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER, artifactUri, sarifText, serializeSarif, toSarif } from '../src/index.ts';
import { PDF, SARIF_PAYLOAD, fixtureReport } from './fixture.ts';

/*
 * Offline SARIF validation against the OASIS SARIF 2.1.0 schema vendored in
 * vendor/sarif (draft-04 JSON Schema, so Ajv runs with ajv-draft-04, strict
 * mode and format checks on; see validator() for the one strict check that is off).
 */

const vendor = new URL('../vendor/sarif/', import.meta.url);
const schemaText = readFileSync(new URL('sarif-schema-2.1.0.json', vendor), 'utf8');

function validator() {
  // strictRequired is off only because the OASIS schema lists required properties inside anyOf
  // branches that define them elsewhere; every other strict check stays on.
  const ajv = new AjvDraft04.default({ strict: true, strictRequired: false, allErrors: true });
  addFormats.default(ajv);
  return ajv.compile(JSON.parse(schemaText));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SARIF is checked by the schema, not by types
type Sarif = any;

describe('vendored SARIF schema', () => {
  it('is the file recorded in source.json, unmodified', () => {
    const source = JSON.parse(readFileSync(new URL('source.json', vendor), 'utf8'));
    expect(createHash('sha256').update(schemaText).digest('hex')).toBe(source.sha256);
    expect(readFileSync(new URL('LICENSE.md', vendor), 'utf8')).toMatch(
      /Copyright © OASIS Open 2023/,
    );
  });

  it('rejects an invalid log, so the validation is real', () => {
    const validate = validator();
    expect(validate({ version: '2.1.0', runs: [{ tool: {} }] })).toBe(false);
    expect(validate({ version: '2.0.0', runs: [] })).toBe(false);
  });
});

describe('SARIF report', () => {
  const sarif: Sarif = toSarif(fixtureReport());
  const run = sarif.runs[0];

  it('validates against the SARIF 2.1.0 schema', () => {
    const validate = validator();
    expect(validate(sarif), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('has one result per fail record, including records that share an id', () => {
    const fails = fixtureReport().findings.filter((f) => f.outcome === 'fail');
    expect(run.results).toHaveLength(fails.length);
    expect(run.results.map((r: Sarif) => r.kind)).toEqual(fails.map(() => 'fail'));
  });

  it('gives each rule its WCAG criteria and a help URL', () => {
    const byId = new Map(run.tool.driver.rules.map((r: Sarif) => [r.id, r]));
    const label: Sarif = byId.get('axe-core/label');
    expect(label.properties.wcag).toEqual(['4.1.2']);
    expect(label.properties.tags).toContain('WCAG 4.1.2');
    expect(label.helpUri).toBe('https://dequeuniversity.com/rules/axe/4.14/label');
    const figure: Sarif = byId.get('verapdf/7.3-1');
    expect(figure.helpUri).toBe(
      'https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html',
    );
    for (const r of run.tool.driver.rules) {
      expect(r.helpUri, r.id).toMatch(/^https:\/\//);
      expect(r.properties.wcag.length, r.id).toBeGreaterThan(0);
    }
    for (const r of run.results) expect(run.tool.driver.rules[r.ruleIndex].id).toBe(r.ruleId);
  });

  it('locates web results by page and selector, PDF results by file and page', () => {
    const web = run.results.find((r: Sarif) => r.ruleId === 'axe-core/label');
    expect(web.locations[0].logicalLocations[0]).toEqual({
      fullyQualifiedName: 'form > input#phone',
      kind: 'element',
    });
    const pdf = run.results.find((r: Sarif) => r.ruleId === 'verapdf/7.3-1');
    expect(pdf.locations[0].physicalLocation).toEqual({
      artifactLocation: { uri: 'docs/annual%20report.pdf' },
      properties: { page: 2 },
    });
    expect(pdf.locations[0].logicalLocations[0].fullyQualifiedName).toBe(
      'Document/Sect[1]/Figure[1]',
    );
    expect(artifactUri(PDF.uri)).toBe('docs/annual%20report.pdf');
  });

  it('states the disclaimer in the run properties', () => {
    expect(run.properties.disclaimer).toBe(DISCLAIMER);
  });

  it('reports scan errors as tool notifications, with a location only for real locations', () => {
    expect(run.invocations[0].executionSuccessful).toBe(false);
    const notes = run.invocations[0].toolExecutionNotifications.filter(
      (n: Sarif) => n.level === 'error',
    );
    expect(notes).toHaveLength(2);
    const js = notes.find((n: Sarif) => n.properties.code === 'unsupported-url');
    expect(js.locations).toBeUndefined();
    expect(js.message.text).toContain('(javascript:alert(5))');
    const pdf = notes.find((n: Sarif) => n.properties.code === 'malformed-pdf');
    expect(pdf.locations[0].physicalLocation.artifactLocation.uri).toBe('docs/broken.pdf');
  });

  it('lists the engines as tool extensions', () => {
    expect(run.tool.extensions).toEqual([
      { name: 'axe-core', version: '4.14.0' },
      { name: 'veraPDF', version: '1.30.3' },
      { name: 'Widedoor PDF checks', version: '0.0.0' },
    ]);
  });

  it('escapes SARIF placeholders and embedded links in message text', () => {
    expect(sarifText('{0} [a](https://x) \\')).toBe('{{0}} \\[a\\](https://x) \\\\');
    const link = run.results.find((r: Sarif) => r.ruleId === 'axe-core/link-name');
    const message: string = link.message.text;
    expect(message).toContain('{{0}} \\[Fix guide\\](https://evil.example/login)');
    // No unescaped placeholder or link is left: drop escaped pairs, then look for syntax.
    const bare = message.replace(/\{\{|\}\}|\\[[\]\\]/g, '');
    expect(bare).not.toMatch(/[{}]|\[[^\]]*\]\(/);
    // The selector stays unescaped where no consumer interprets it.
    expect(link.locations[0].logicalLocations[0].fullyQualifiedName).toContain(SARIF_PAYLOAD);
    for (const r of run.results)
      expect(r.message.text.replace(/\{\{|\}\}/g, '')).not.toMatch(/[{}]/);
    for (const n of run.invocations[0].toolExecutionNotifications)
      expect(n.message.text.replace(/\{\{|\}\}/g, '')).not.toMatch(/[{}]/);
  });

  it('turns paths into URIs', () => {
    expect(artifactUri('C:/scans/a b.pdf')).toBe('file:///C:/scans/a%20b.pdf');
    expect(artifactUri('https://example.com/x')).toBe('https://example.com/x');
    expect(artifactUri('https://example.com/?q="<a>')).toBe('https://example.com/?q=%22%3Ca%3E');
    expect(artifactUri('javascript:alert(1)')).toBe('javascript%3Aalert(1)');
  });

  it('matches its snapshot', async () => {
    await expect(serializeSarif(fixtureReport())).toMatchFileSnapshot('__snapshots__/report.sarif');
  });
});
