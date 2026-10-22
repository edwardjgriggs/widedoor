import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'playwright';
import type { AxeResults } from 'axe-core';
import type { ExpectedEntry } from './corpus.ts';

/** The tags Widedoor runs axe-core with: WCAG 2.0 and 2.1, levels A and AA. */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const require = createRequire(import.meta.url);
const axePackage = require.resolve('axe-core/package.json');
export const axeVersion: string = JSON.parse(readFileSync(axePackage, 'utf8')).version;
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/** Runs the installed axe-core in the page and returns one triple per (rule, outcome). */
export async function runAxe(page: Page): Promise<ExpectedEntry[]> {
  await page.addScriptTag({ content: axeSource });
  const results = await page.evaluate(
    (tags) =>
      (
        window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<AxeResults> } }
      ).axe.run(document, { runOnly: { type: 'tag', values: tags } }),
    AXE_TAGS,
  );
  const triples = (list: AxeResults['passes'], outcome: ExpectedEntry['outcome']) =>
    list.map((r) => ({ engine: 'axe-core' as const, ruleId: r.id, outcome }));
  return [
    ...triples(results.violations, 'fail'),
    ...triples(results.incomplete, 'needs-review'),
    ...triples(results.passes, 'pass'),
    ...triples(results.inapplicable, 'not-applicable'),
  ];
}
