import { writeFileSync } from 'node:fs';
import { format, resolveConfig } from 'prettier';
import { Document } from 'yaml';

export const dataDir = new URL('../../data/', import.meta.url);

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'widedoor-data-generator' } });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Writes a generated data file: header comment, YAML body, then Prettier so the
 * output matches `npm run format:check`. `decorate` can attach node comments.
 */
export async function writeYaml(
  fileName: string,
  header: string[],
  data: unknown,
  decorate?: (doc: Document) => void,
): Promise<void> {
  const doc = new Document(data, { aliasDuplicateObjects: false });
  doc.commentBefore = [' GENERATED FILE. Do not edit by hand.', ...header.map((l) => ` ${l}`)].join(
    '\n',
  );
  decorate?.(doc);
  const out = new URL(fileName, dataDir);
  const config = (await resolveConfig(out)) ?? {};
  const text = await format(doc.toString({ lineWidth: 0 }), { ...config, parser: 'yaml' });
  writeFileSync(out, text);
  console.log(`wrote ${out.pathname}`);
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
