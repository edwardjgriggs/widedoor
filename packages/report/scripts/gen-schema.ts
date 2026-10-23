import { mkdirSync, writeFileSync } from 'node:fs';
import { serializeReportJsonSchema } from '../src/model.ts';

const out = new URL('../schema/report.v1.json', import.meta.url);
mkdirSync(new URL('../schema/', import.meta.url), { recursive: true });
writeFileSync(out, serializeReportJsonSchema());
console.log(`wrote ${out.pathname}`);
