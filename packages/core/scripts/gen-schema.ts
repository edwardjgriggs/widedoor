import { mkdirSync, writeFileSync } from 'node:fs';
import { serializeFindingJsonSchema } from '../src/schema.ts';

const out = new URL('../schema/finding.v1.json', import.meta.url);
mkdirSync(new URL('../schema/', import.meta.url), { recursive: true });
writeFileSync(out, serializeFindingJsonSchema());
console.log(`wrote ${out.pathname}`);
