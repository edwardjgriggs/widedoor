import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { Ajv, type ValidateFunction } from 'ajv';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { Acr, AcrTable } from './acr.js';

/*
 * OpenACR (GSA, https://github.com/GSA/openacr): the ACR as YAML. The schema
 * and the VPAT 2.5 Revised Section 508 edition catalog are vendored in
 * vendor/openacr (SOURCE.md records the commit and sha256). The document is
 * built as data and serialized by the yaml library, then parsed back and
 * checked: Ajv against the schema, and every chapter, criterion, component and
 * term id against the catalog, as OpenACR's own validator does. A document
 * that fails is a Widedoor bug, so serializeOpenAcr throws instead of
 * returning it.
 */

export const OPENACR_CATALOG_ID = '2.5-edition-wcag-2.0-508-en';

export const OPENACR_FILES = {
  schema: 'openacr-0.1.0.json',
  catalogSchema: 'openacr-catalog-0.1.0.json',
  catalog: `${OPENACR_CATALOG_ID}.yaml`,
} as const;

export const openAcrVendorDir = new URL('../vendor/openacr/', import.meta.url);

const label = z.string();
const CatalogSchema = z.object({
  title: z.string().min(1),
  standards: z.array(
    z.object({
      id: z.string().min(1),
      label,
      report_heading: z.string().min(1),
      chapters: z.array(z.string()),
    }),
  ),
  chapters: z.array(
    z.object({
      id: z.string().min(1),
      label,
      order: z.int(),
      // The catalog schema does not define disabled; this catalog sets it nowhere, a later one might.
      disabled: z.boolean().optional(),
      criteria: z.array(
        z.object({
          id: z.string().min(1),
          handle: z.string().optional(),
          components: z.array(z.string()).min(1),
          disabled: z.boolean().optional(),
        }),
      ),
    }),
  ),
  components: z.array(z.object({ id: z.string().min(1), label })),
  terms: z.array(z.object({ id: z.string().min(1), label, description: z.string().min(1) })),
});
export type OpenAcrCatalog = z.infer<typeof CatalogSchema>;

const read = (name: string) => readFileSync(new URL(name, openAcrVendorDir), 'utf8');

let catalog: OpenAcrCatalog | undefined;

/** The vendored catalog. Throws if it is missing or not shaped as the catalog schema says. */
export function loadOpenAcrCatalog(): OpenAcrCatalog {
  catalog ??= CatalogSchema.parse(parse(read(OPENACR_FILES.catalog)));
  return catalog;
}

let validator: ValidateFunction | undefined;

function schemaValidator(): ValidateFunction {
  validator ??= new Ajv({ strict: true, allErrors: true }).compile(
    JSON.parse(read(OPENACR_FILES.schema)),
  );
  return validator;
}

/** Problems with an OpenACR document under the vendored schema (Ajv, draft-07); empty when it is valid. */
export function checkOpenAcrSchema(doc: unknown): string[] {
  const validate = schemaValidator();
  if (validate(doc)) return [];
  return (validate.errors ?? []).map(
    (e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`,
  );
}

type Doc = Record<string, unknown>;
const isObject = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Problems with an OpenACR document's ids under the catalog; empty when every
 * chapter is a catalog chapter, a chapter disabled in the document or the
 * catalog lists no criteria, every criterion is in its chapter once and not
 * disabled in the catalog, every component is one the criterion lists, and
 * every level is a catalog term.
 */
export function checkOpenAcrCatalog(doc: unknown, cat: OpenAcrCatalog = loadOpenAcrCatalog()) {
  const problems: string[] = [];
  if (!isObject(doc)) return ['the document is not a mapping'];
  const terms = new Set(cat.terms.map((t) => t.id));
  const chapters = isObject(doc.chapters) ? doc.chapters : {};
  for (const [id, chapter] of Object.entries(chapters)) {
    const known = cat.chapters.find((c) => c.id === id);
    if (!known) {
      problems.push(`chapter ${id} is not in the catalog`);
      continue;
    }
    const criteria = isObject(chapter) && Array.isArray(chapter.criteria) ? chapter.criteria : [];
    if (isObject(chapter) && chapter.disabled === true && criteria.length > 0)
      problems.push(`chapter ${id} is disabled but lists criteria`);
    if (known.disabled === true && criteria.length > 0)
      problems.push(`chapter ${id} is disabled in the catalog but lists criteria`);
    const seen = new Set<string>();
    for (const criterion of criteria) {
      const num = isObject(criterion) ? String(criterion.num) : '';
      const row = known.criteria.find((c) => c.id === num);
      if (!row) {
        problems.push(`criterion ${num} is not in chapter ${id}`);
        continue;
      }
      if (row.disabled === true) problems.push(`criterion ${num} is disabled in the catalog`);
      if (seen.has(num)) problems.push(`criterion ${num} is listed twice in chapter ${id}`);
      seen.add(num);
      const components =
        isObject(criterion) && Array.isArray(criterion.components) ? criterion.components : [];
      if (components.length === 0) problems.push(`criterion ${num} has no components`);
      for (const component of components) {
        const name = isObject(component) ? String(component.name) : '';
        if (!row.components.includes(name))
          problems.push(`component ${name} is not one criterion ${num} lists`);
        const adherence = isObject(component) ? component.adherence : undefined;
        const level = isObject(adherence) ? String(adherence.level) : '';
        if (!terms.has(level))
          problems.push(`level ${level} of criterion ${num} (${name}) is not a catalog term`);
      }
    }
  }
  return problems;
}

/**
 * Problems with an ACR's tables before it becomes a document: toOpenAcr writes
 * only catalog chapters, so a table under any other id, one also listed as
 * omitted (written disabled) or one the catalog disables would drop out of
 * the file unseen or be written where the catalog has no place for it.
 */
export function checkAcrTables(acr: Acr, cat: OpenAcrCatalog = loadOpenAcrCatalog()): string[] {
  const omitted = new Set(acr.omitted.map((o) => o.id));
  return acr.tables.flatMap((t) => {
    const known = cat.chapters.find((c) => c.id === t.id);
    if (!known) return [`table ${t.id} is not a catalog chapter`];
    return [
      ...(known.disabled === true ? [`table ${t.id} is disabled in the catalog`] : []),
      ...(omitted.has(t.id) ? [`table ${t.id} is both reported and omitted`] : []),
    ];
  });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]+$/;

/**
 * Where acr.vendor.contact goes in an OpenACR contact, by its shape: an email
 * address in email, an http(s) URL in website, a phone number (7 or more
 * digits) in phone, anything else in address. The schema requires email, so
 * it is empty unless the contact is an email address.
 */
export function contactFields(contact: string | undefined): Record<string, string> {
  if (contact === undefined) return { email: '' };
  if (EMAIL.test(contact)) return { email: contact };
  if (/^https?:\/\/\S+$/i.test(contact)) return { email: '', website: contact };
  if (PHONE.test(contact) && (contact.match(/\d/g) ?? []).length >= 7)
    return { email: '', phone: contact };
  return { email: '', address: contact };
}

/** The OpenACR document for an ACR, as data. */
export function toOpenAcr(acr: Acr): Doc {
  const { vendor, product } = acr.meta;
  const vendorName = vendor?.name?.trim() ? vendor.name : 'Unnamed vendor';
  const contact = () => ({
    ...(vendor?.name !== undefined ? { company_name: vendor.name } : {}),
    ...contactFields(vendor?.contact),
  });
  const notes = [...(acr.meta.notes !== undefined ? [acr.meta.notes] : []), ...acr.notes];
  const reported = new Map(acr.tables.map((t) => [t.id, t]));
  const omitted = new Map(acr.omitted.map((o) => [o.id, o]));
  const chapters: Doc = {};
  for (const c of loadOpenAcrCatalog().chapters) {
    const table = reported.get(c.id);
    if (table) chapters[c.id] = chapter(table);
    else {
      const o = omitted.get(c.id);
      if (o) chapters[c.id] = { disabled: true, notes: o.reason };
    }
  }
  return {
    title: `${acr.complete ? '' : 'DRAFT '}${vendorName} Accessibility Conformance Report`,
    product: {
      name: product?.name,
      ...(product?.version !== undefined ? { version: product.version } : {}),
      ...(product?.description !== undefined ? { description: product.description } : {}),
    },
    author: contact(),
    vendor: contact(),
    report_date: acr.meta.reportDate,
    notes: notes.join('\n\n'),
    evaluation_methods_used: acr.methods.join('\n'),
    legal_disclaimer: acr.disclaimer,
    catalog: OPENACR_CATALOG_ID,
    chapters,
  };
}

function chapter(table: AcrTable): Doc {
  return {
    ...(table.notes.length > 0 ? { notes: table.notes.join('\n\n') } : {}),
    criteria: table.rows.map((row) => ({
      num: row.id,
      components: row.components.map((c) => ({
        name: c.id,
        adherence: { level: c.term, notes: c.remarks },
      })),
    })),
  };
}

/**
 * OpenACR YAML for an ACR. Throws if the document fails the schema or the
 * catalog check (a bug). Strings are quoted by the YAML 1.1 rules, so a
 * reader that still resolves 1.1 timestamps (js-yaml, which OpenACR's own
 * tools use) reads 2026-10-23 as text; the text must read the same as 1.1
 * and as 1.2.
 */
export function serializeOpenAcr(acr: Acr): string {
  const text = stringify(toOpenAcr(acr), { version: '1.1', lineWidth: 0 });
  const doc: unknown = parse(text);
  const problems = [
    ...checkAcrTables(acr),
    ...checkOpenAcrSchema(doc),
    ...checkOpenAcrCatalog(doc),
  ];
  if (!isDeepStrictEqual(doc, parse(text, { version: '1.1' })))
    problems.push('the YAML reads differently under YAML 1.1 and 1.2');
  if (problems.length > 0)
    throw new Error(
      `the OpenACR report failed validation (a Widedoor bug): ${problems.join('; ')}`,
    );
  return text;
}
