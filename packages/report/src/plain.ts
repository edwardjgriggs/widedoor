import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { toPlainData, type PlainData } from './plain-data.js';

export * from './plain-data.js';

export function parsePlainData(text: string): PlainData {
  return toPlainData(parse(text));
}

export const defaultPlainFile = new URL('../data/plain.yaml', import.meta.url);

let cached: PlainData | undefined;

/** Loads and validates data/plain.yaml (or the given file). Throws on any schema problem. */
export function loadPlainData(file?: URL): PlainData {
  if (file) return parsePlainData(readFileSync(file, 'utf8'));
  cached ??= parsePlainData(readFileSync(defaultPlainFile, 'utf8'));
  return cached;
}
