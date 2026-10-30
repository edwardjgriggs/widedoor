import { fileURLToPath } from 'node:url';
import { buildSite } from '../src/site.ts';

/*
 * npm run docs:build: README.md and docs/*.md of this repository to
 * packages/docs/dist (emptied first). Never part of npm run build; Vercel
 * runs it (vercel.json), and nothing here deploys anything.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = fileURLToPath(new URL('../dist/', import.meta.url));
const files = buildSite(root, out);
process.stdout.write(`docs: wrote ${files.length} files to packages/docs/dist\n`);
