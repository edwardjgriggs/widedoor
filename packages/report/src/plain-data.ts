import { z } from 'zod';
import { PlainSchema, type Finding, type Plain } from '@widedoor/core/browser';

/*
 * Plain-language text per rule (data/plain.yaml): what the problem is, who it
 * affects and how to fix it. Rule ids are looked up in Maps, so an id such as
 * "constructor" or "__proto__" never reaches an object prototype. This module
 * has no file access and no YAML parser, so the browser UI shares it; plain.ts
 * parses and loads the file.
 */

const rules = z.record(z.string().min(1), PlainSchema);

export const PlainDataSchema = z.strictObject({
  'axe-core': rules,
  verapdf: rules,
  widedoor: rules,
});

export type PlainEngine = keyof z.infer<typeof PlainDataSchema>;
export type PlainData = Record<PlainEngine, ReadonlyMap<string, Plain>>;

/** Validates already-parsed plain-language data (the parsed YAML, or the same object as JSON). */
export function toPlainData(value: unknown): PlainData {
  const raw = PlainDataSchema.parse(value);
  return {
    'axe-core': new Map(Object.entries(raw['axe-core'])),
    verapdf: new Map(Object.entries(raw.verapdf)),
    widedoor: new Map(Object.entries(raw.widedoor)),
  };
}

/** The finding's own text if it has any, else the entry for its rule. Manual findings use only their own. */
export function plainFor(finding: Finding, data: PlainData): Plain | undefined {
  if (finding.plain) return finding.plain;
  const engine = finding.source.engine;
  if (engine === 'manual') return undefined;
  return data[engine].get(finding.source.ruleId);
}
