import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  OPENACR_CATALOG_ID,
  SUPPORT_DOCS_NOTE,
  OPENACR_FILES,
  checkAcrTables,
  contactFields,
  buildAcr,
  checkOpenAcrCatalog,
  checkOpenAcrSchema,
  loadOpenAcrCatalog,
  openAcrVendorDir,
  serializeOpenAcr,
  toOpenAcr,
  type Acr,
} from '../src/index.ts';
import {
  HOSTILE_META,
  HOSTILE_NOTES_SAFE,
  META,
  NONCHARACTERS_SAFE,
  PAGE,
  acrReport,
  automated,
  decidedReport,
  hostileReferenceReport,
  manual,
} from './acr-fixture.ts';
import { PAYLOAD, fixtureReport } from './fixture.ts';
import { reviewFixtureReport } from './review-fixture.ts';

/*
 * OpenACR output against the vendored GSA schema (draft-07, Ajv strict) and
 * catalog. The checks here run on the parsed YAML, independently of the ones
 * serializeOpenAcr runs before it returns.
 */

const read = (name: string) => readFileSync(new URL(name, openAcrVendorDir), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenACR is checked by the schema, not by types
type Doc = any;

function schemaValidator(name: string) {
  const ajv = new Ajv({ strict: true, allErrors: true });
  return ajv.compile(JSON.parse(read(name)));
}

describe('vendored OpenACR files', () => {
  const source = read('SOURCE.md');

  it('are the files SOURCE.md records, unmodified', () => {
    const recorded = new Map(
      [...source.matchAll(/^\| `([^`]+)` +\| `[^`]+` +\| `([0-9a-f]{64})` \|$/gm)].map((m) => [
        m[1] as string,
        m[2] as string,
      ]),
    );
    expect([...recorded.keys()].sort()).toEqual(
      [...Object.values(OPENACR_FILES), 'LICENSE.md'].sort(),
    );
    for (const [name, sha256] of recorded) {
      const bytes = readFileSync(new URL(name, openAcrVendorDir));
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(sha256);
    }
    expect(source).toContain('https://github.com/GSA/openacr');
    // The catalog id is the vendored file's name, which is the upstream file's name.
    const upstream = /^\| `([^`]+)` +\| `catalog\/([^`]+)` +\|/m.exec(source);
    expect(upstream?.[1]).toBe(OPENACR_FILES.catalog);
    expect(upstream?.[2]).toBe(OPENACR_FILES.catalog);
    expect(upstream?.[2]).toBe(`${OPENACR_CATALOG_ID}.yaml`);
    expect(source).toContain('86f890a07a2a193d2a9404fb57d2cc2d62a60a4f');
    expect(read('LICENSE.md')).toMatch(/CC0 1\.0 Universal/);
  });

  it('has a catalog that passes the catalog schema, with the five terms', () => {
    const validate = schemaValidator(OPENACR_FILES.catalogSchema);
    const raw = parse(read(OPENACR_FILES.catalog));
    expect(validate(raw), JSON.stringify(validate.errors)).toBe(true);
    const catalog = loadOpenAcrCatalog();
    expect(catalog.title).toBe('VPAT® 2.5 Revised Section 508 Edition');
    expect(catalog.terms.map((t) => t.id)).toEqual([
      'supports',
      'partially-supports',
      'does-not-support',
      'not-applicable',
      'not-evaluated',
    ]);
  });
});

describe('OpenACR validation', () => {
  const doc: Doc = parse(serializeOpenAcr(buildAcr(decidedReport(), META)));

  it('rejects a document the schema does not allow, so the check is real', () => {
    expect(checkOpenAcrSchema(doc)).toEqual([]);
    expect(checkOpenAcrSchema({ ...doc, author: {} })).not.toEqual([]);
    expect(checkOpenAcrSchema({ ...doc, product: { version: '1' } })).not.toEqual([]);
    expect(checkOpenAcrSchema({ ...doc, version: 'one' })).not.toEqual([]);
  });

  it('rejects ids the catalog does not have', () => {
    expect(checkOpenAcrCatalog(doc)).toEqual([]);
    const level = structuredClone(doc);
    level.chapters.success_criteria_level_a.criteria[0].components[0].adherence.level = 'pass';
    expect(checkOpenAcrCatalog(level)).toEqual([
      'level pass of criterion 1.1.1 (web) is not a catalog term',
    ]);
    const num = structuredClone(doc);
    num.chapters.success_criteria_level_a.criteria[0].num = '1.4.3';
    expect(checkOpenAcrCatalog(num)).toEqual([
      'criterion 1.4.3 is not in chapter success_criteria_level_a',
    ]);
    const component = structuredClone(doc);
    component.chapters.functional_performance_criteria.criteria[0].components[0].name = 'web';
    expect(checkOpenAcrCatalog(component)).toEqual([
      'component web is not one criterion 302.1 lists',
    ]);
    const chapter = structuredClone(doc);
    chapter.chapters.success_criteria_level_aaaa = { criteria: [] };
    expect(checkOpenAcrCatalog(chapter)).toEqual([
      'chapter success_criteria_level_aaaa is not in the catalog',
    ]);
  });

  it('rejects a table outside the catalog, one also omitted, and one the catalog disables', () => {
    const acr = buildAcr(decidedReport(), META);
    expect(checkAcrTables(acr)).toEqual([]);
    const renamed = structuredClone(acr);
    const first = renamed.tables[0];
    if (!first) throw new Error('no table');
    first.id = 'success_criteria_level_aaaa';
    expect(checkAcrTables(renamed)).toEqual([
      'table success_criteria_level_aaaa is not a catalog chapter',
    ]);
    // toOpenAcr would drop that table unseen, so serializeOpenAcr runs the check.
    expect(() => serializeOpenAcr(renamed)).toThrow(
      /failed validation \(a Widedoor bug\): table success_criteria_level_aaaa is not a catalog chapter/,
    );
    const both = structuredClone(acr);
    both.omitted.push({ id: 'software', label: 'Chapter 5: Software', reason: 'Left out.' });
    expect(checkAcrTables(both)).toEqual(['table software is both reported and omitted']);
    const cat = structuredClone(loadOpenAcrCatalog());
    const software = cat.chapters.find((c) => c.id === 'software');
    if (!software) throw new Error('no software chapter');
    software.disabled = true;
    expect(checkAcrTables(acr, cat)).toEqual(['table software is disabled in the catalog']);
  });

  it('rejects a chapter or criterion the catalog disables, and a disabled chapter with criteria', () => {
    const chapterOff = structuredClone(loadOpenAcrCatalog());
    const software = chapterOff.chapters.find((c) => c.id === 'software');
    if (!software) throw new Error('no software chapter');
    software.disabled = true;
    expect(checkOpenAcrCatalog(doc, chapterOff)).toEqual([
      'chapter software is disabled in the catalog but lists criteria',
    ]);
    const rowOff = structuredClone(loadOpenAcrCatalog());
    const c111 = rowOff.chapters[0]?.criteria.find((c) => c.id === '1.1.1');
    if (!c111) throw new Error('no 1.1.1');
    c111.disabled = true;
    expect(checkOpenAcrCatalog(doc, rowOff)).toEqual([
      'criterion 1.1.1 is disabled in the catalog',
    ]);
    const listed = structuredClone(doc);
    listed.chapters.hardware.criteria = [];
    expect(checkOpenAcrCatalog(listed)).toEqual([]);
    listed.chapters.hardware.criteria = [{ num: '402.1', components: [] }];
    expect(checkOpenAcrCatalog(listed)).toContain(
      'chapter hardware is disabled but lists criteria',
    );
  });

  it('throws instead of returning a document that fails, naming the problem', () => {
    const acr = buildAcr(decidedReport(), META);
    const bad: Acr = structuredClone(acr);
    const first = bad.tables[0]?.rows[0]?.components[0];
    if (!first) throw new Error('no cell');
    (first as { term: string }).term = 'pass';
    expect(() => serializeOpenAcr(bad)).toThrow(
      /failed validation \(a Widedoor bug\): level pass of criterion 1\.1\.1 \(web\)/,
    );
    const noProduct = buildAcr(decidedReport(), { vendor: { name: 'Example Agency' } });
    expect(() => serializeOpenAcr(noProduct)).toThrow(/must have required property 'name'/);
  });
});

describe('OpenACR report', () => {
  it('validates for the test scans: decided, draft, PDF and review fixtures', () => {
    const fail = automated(PAGE, { selector: 'img' }, 'axe-core', 'image-alt', {
      impact: 'critical',
    });
    const reports = [
      decidedReport(),
      acrReport(),
      acrReport({ findings: [fail], scopeGaps: ['a sitemap was read in part'] }),
      reviewFixtureReport(),
    ];
    for (const report of reports) {
      const doc: Doc = parse(serializeOpenAcr(buildAcr(report, META)));
      expect(checkOpenAcrSchema(doc)).toEqual([]);
      expect(checkOpenAcrCatalog(doc)).toEqual([]);
    }
    // The schema validator here is compiled on its own, not the one serializeOpenAcr uses.
    const validate = schemaValidator(OPENACR_FILES.schema);
    expect(validate(parse(serializeOpenAcr(buildAcr(reviewFixtureReport(), META))))).toBe(true);
  });

  it('writes the metadata, the chapters and each cell from the ACR', () => {
    const acr = buildAcr(decidedReport(), { ...META, reportDate: '2026-11-01' });
    const doc: Doc = parse(serializeOpenAcr(acr));
    expect(doc.title).toBe('Example Agency Accessibility Conformance Report');
    expect(doc.product).toEqual({
      name: 'Permit portal',
      version: '2.1',
      description: 'Online permit applications.',
    });
    expect(doc.author).toEqual({
      company_name: 'Example Agency',
      email: 'accessibility@example.gov',
    });
    expect(doc.vendor).toEqual(doc.author);
    expect(doc.report_date).toBe('2026-11-01');
    expect(doc.catalog).toBe('2.5-edition-wcag-2.0-508-en');
    expect(doc.notes.split('\n\n')).toEqual(['Tested on the staging site.', ...acr.notes]);
    expect(doc.evaluation_methods_used).toBe(acr.methods.join('\n'));
    expect(doc.legal_disclaimer).toBe(acr.disclaimer);
    expect(Object.keys(doc.chapters)).toEqual([
      'success_criteria_level_a',
      'success_criteria_level_aa',
      'success_criteria_level_aaa',
      'functional_performance_criteria',
      'hardware',
      'software',
      'support_documentation_and_services',
    ]);
    expect(doc.chapters.hardware).toEqual({ disabled: true, notes: acr.omitted[1]?.reason });
    expect(doc.chapters.success_criteria_level_aaa.disabled).toBe(true);
    const c111 = doc.chapters.success_criteria_level_a.criteria[0];
    expect(c111.num).toBe('1.1.1');
    expect(c111.components.map((c: Doc) => c.name)).toEqual(['web', 'electronic-docs']);
    expect(c111.components[0].adherence).toEqual({
      level: 'supports',
      notes: acr.tables[0]?.rows[0]?.components[0]?.remarks,
    });
    expect(doc.chapters.software.notes).toMatch(
      /502\.3 Accessibility Services is a heading row in the template/,
    );
  });

  it('writes 501.1, 504.2 and 602.3 as chapter notes, never as a criterion with a level', () => {
    const acr = buildAcr(acrReport(), META);
    const doc: Doc = parse(serializeOpenAcr(acr));
    const nums = (id: string): string[] => doc.chapters[id].criteria.map((c: Doc) => c.num);
    expect(nums('software')).not.toContain('501.1');
    expect(nums('software')).not.toContain('504.2');
    expect(nums('software')).toContain('504.2.1');
    expect(nums('support_documentation_and_services')).toEqual([
      '602.2',
      '602.4',
      '603.2',
      '603.3',
    ]);
    const software: string[] = doc.chapters.software.notes.split('\n\n');
    expect(software.slice(0, 2)).toEqual([
      `501.1 Scope - Incorporation of WCAG 2.0 AA is answered in Tables 1 and 2 (the template's cells read "See WCAG 2.x section"), so it has no criterion entry here.`,
      `504.2 Content Creation or Editing is answered in Tables 1 and 2 (the template's cells read "See WCAG 2.x section"), so it has no criterion entry here.`,
    ]);
    expect(doc.chapters.support_documentation_and_services.notes).toBe(
      `602.3 Electronic Support Documentation is answered in Tables 1 and 2 (the template's cells read "See WCAG 2.x section"), so it has no criterion entry here.`,
    );
    // 504.2 marked not applicable (not an authoring tool) is an ordinary criterion again.
    const na = manual(PAGE, { type: 'section508', id: '504.2' }, 'not-applicable', {
      notes: 'Not an authoring tool (504.1).',
    });
    const withNa: Doc = parse(serializeOpenAcr(buildAcr(acrReport({ reviews: [na] }), META)));
    const c504 = withNa.chapters.software.criteria.find((c: Doc) => c.num === '504.2');
    expect(c504.components[0].adherence.level).toBe('not-applicable');
  });

  it('puts the contact in the contact field its shape belongs to', () => {
    expect(contactFields(undefined)).toEqual({ email: '' });
    expect(contactFields('accessibility@example.gov')).toEqual({
      email: 'accessibility@example.gov',
    });
    expect(contactFields('https://example.gov/accessibility')).toEqual({
      email: '',
      website: 'https://example.gov/accessibility',
    });
    expect(contactFields('+1 (757) 555-0100')).toEqual({ email: '', phone: '+1 (757) 555-0100' });
    // Too few digits for a phone number, and a URL that is not http(s).
    expect(contactFields('555-01')).toEqual({ email: '', address: '555-01' });
    expect(contactFields('ftp://example.gov')).toEqual({ email: '', address: 'ftp://example.gov' });
    expect(contactFields('Accessibility Office, 1 Main St, Yorktown VA')).toEqual({
      email: '',
      address: 'Accessibility Office, 1 Main St, Yorktown VA',
    });
    const meta = {
      ...META,
      vendor: { name: 'Example Agency', contact: 'https://example.gov/a11y' },
    };
    const doc: Doc = parse(serializeOpenAcr(buildAcr(decidedReport(), meta)));
    expect(doc.author).toEqual({
      company_name: 'Example Agency',
      email: '',
      website: 'https://example.gov/a11y',
    });
    expect(doc.vendor).toEqual(doc.author);
    // A contact that is not an email address is still a contact: the ACR stays complete.
    expect(doc.title).toBe('Example Agency Accessibility Conformance Report');
  });

  it('titles a draft DRAFT and leaves the email empty when no contact is set', () => {
    const doc: Doc = parse(
      serializeOpenAcr(buildAcr(acrReport(), { product: { name: 'Permit portal' } })),
    );
    expect(doc.title).toBe('DRAFT Unnamed vendor Accessibility Conformance Report');
    expect(doc.author).toEqual({ email: '' });
  });

  it('reads 4.1.1 as supports with the errata citation', () => {
    const doc: Doc = parse(serializeOpenAcr(buildAcr(acrReport(), META)));
    const c = doc.chapters.success_criteria_level_a.criteria.find((x: Doc) => x.num === '4.1.1');
    for (const component of c.components) {
      expect(component.adherence.level).toBe('supports');
      expect(component.adherence.notes).toMatch(
        /on the errata basis, not on a test: WCAG 2\.0 errata/,
      );
    }
  });

  it('keeps hostile metadata and scanned strings as values, never as YAML structure', () => {
    const text = serializeOpenAcr(buildAcr(acrReport(), HOSTILE_META));
    const doc: Doc = parse(text);
    expect(Object.keys(doc)).not.toContain('key');
    expect(doc.product.name).toBe(`Portal\\u202e ${PAYLOAD}`);
    expect(doc.author).toMatchObject({ email: '', address: 'x@example.com\\x0akey: injected' });
    expect(doc.notes.startsWith(`---\nchapters: {}\n${PAYLOAD}\\x07`)).toBe(true);
    // U+FFFE and U+FFFF, which YAML 1.2 does not allow, arrive as text and parse back.
    expect(doc.product.description).toBe(`Line one\nkey: value ${PAYLOAD}${NONCHARACTERS_SAFE}`);
    expect(doc.chapters.success_criteria_level_a.criteria.length).toBeGreaterThan(0);
    // No raw control or bidi character reaches the file.
    const raw = [...text].filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return (code < 0x20 && ch !== '\n') || code === 0x7f || code === 0x202e;
    });
    expect(raw).toEqual([]);
  });

  it('keeps hostile reviewer notes on 504.2 and 602.3 inert, as chapter note text', () => {
    const text = serializeOpenAcr(buildAcr(hostileReferenceReport(), META));
    const doc: Doc = parse(text);
    expect(checkOpenAcrSchema(doc)).toEqual([]);
    expect(checkOpenAcrCatalog(doc)).toEqual([]);
    const software: string = doc.chapters.software.notes;
    const support: string = doc.chapters.support_documentation_and_services.notes;
    expect(software).toContain(
      `Recorded for this row so far; the roll-up leaves it undecided: the 1 applicable asset has no deciding result. A reviewer recorded not applicable on https://example.com/apply: ${HOSTILE_NOTES_SAFE}.`,
    );
    expect(support).toContain(`A result is also on record for this row, Does Not Support: `);
    expect(support).toContain(`${HOSTILE_NOTES_SAFE}.`);
    // Neither row becomes a criterion, and the notes add no key to the document.
    const nums = (id: string): string[] => doc.chapters[id].criteria.map((c: Doc) => c.num);
    expect(nums('software')).not.toContain('504.2');
    expect(nums('support_documentation_and_services')).not.toContain('602.3');
    expect(Object.keys(doc.chapters.software)).toEqual(['notes', 'criteria']);
    const raw = [...text].filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return (code < 0x20 && ch !== '\n') || code === 0x7f || code === 0x202e;
    });
    expect(raw).toEqual([]);
  });

  it('carries the support documentation note in the report notes', () => {
    const doc: Doc = parse(serializeOpenAcr(buildAcr(acrReport(), META)));
    expect(doc.notes.split('\n\n')).toContain(SUPPORT_DOCS_NOTE);
  });

  it('quotes strings a YAML 1.1 reader would take for dates or numbers', () => {
    const text = serializeOpenAcr(buildAcr(acrReport(), { ...META, reportDate: '2026-11-01' }));
    expect(text).toContain('report_date: "2026-11-01"');
    expect(text).not.toMatch(/&a\d|\*a\d/);
    expect(parse(text, { version: '1.1' })).toEqual(parse(text));
  });

  it('is the same text for the same scan', () => {
    const report = reviewFixtureReport();
    expect(serializeOpenAcr(buildAcr(report, META))).toBe(serializeOpenAcr(buildAcr(report, META)));
  });

  it('cannot be built for a WCAG 2.1-only report', () => {
    expect(() => toOpenAcr(buildAcr(fixtureReport(), META))).toThrow(/Section 508 view/);
  });
});
