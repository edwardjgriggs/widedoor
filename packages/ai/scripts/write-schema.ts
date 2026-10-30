import { mkdirSync, writeFileSync } from 'node:fs';
import { serializeAiSuggestionsJsonSchema } from '../src/model.ts';

const out = new URL('../schema/ai-suggestions.v1.json', import.meta.url);
mkdirSync(new URL('../schema/', import.meta.url), { recursive: true });
writeFileSync(out, serializeAiSuggestionsJsonSchema());
console.log(`wrote ${out.pathname}`);
