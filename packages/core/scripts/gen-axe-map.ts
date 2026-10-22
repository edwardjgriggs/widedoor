import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import { dataDir, writeYaml } from './lib/write-yaml.ts';

// Builds data/axe-map.yaml from the installed axe-core (exact-pinned
// devDependency). Only rules tagged with the WCAG 2.0/2.1 A/AA tags that
// Widedoor runs are included; best-practice rules are out of scope.
type AxeRule = { ruleId: string; tags: string[]; actIds?: string[] };
type Axe = { version: string; getRules(tags?: string[]): AxeRule[] };

const require = createRequire(import.meta.url);
const axe = require('axe-core') as Axe;

const RUN_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// SC outside WCAG 2.0/2.1 A/AA (for example AAA 2.1.3) go to wcagOutOfScope.
const inScope = new Set(
  (
    parse(readFileSync(new URL('wcag.yaml', dataDir), 'utf8')) as { criteria: { id: string }[] }
  ).criteria.map((c) => c.id),
);

const rules = axe
  .getRules()
  .filter((r) => r.tags.some((t) => RUN_TAGS.includes(t)))
  .map((r) => {
    const tagged = r.tags.flatMap((t) => {
      const m = t.match(/^wcag(\d)(\d)(\d{1,2})$/);
      return m ? [`${m[1]}.${m[2]}.${m[3]}`] : [];
    });
    const wcag = tagged.filter((sc) => inScope.has(sc));
    const wcagOutOfScope = tagged.filter((sc) => !inScope.has(sc));
    if (!wcag.length) throw new Error(`${r.ruleId} has run tags but no A/AA wcagNNN tag`);
    const status = r.tags.includes('deprecated')
      ? 'deprecated'
      : r.tags.includes('experimental')
        ? 'experimental'
        : undefined;
    return {
      id: r.ruleId,
      wcag,
      ...(wcagOutOfScope.length ? { wcagOutOfScope } : {}),
      actRules: r.actIds ?? [],
      decides: false,
      ...(status ? { status } : {}),
    };
  })
  .sort((a, b) => a.id.localeCompare(b.id));

console.log(`axe-core ${axe.version}: ${rules.length} rules`);

await writeYaml(
  'axe-map.yaml',
  [
    `Source: axe-core ${axe.version} (MPL-2.0), rule metadata from axe.getRules().`,
    `Scope: rules tagged ${RUN_TAGS.join(', ')}. wcag comes from wcagNNN tags; actRules from actIds.`,
    'decides is false for every rule: no rule pass here is proven to satisfy a whole SC, so a pass',
    'never settles a criterion on its own. Regenerate: npm run data:axe -w @widedoor/core',
  ],
  {
    meta: {
      sources: ['https://www.npmjs.com/package/axe-core', 'https://github.com/dequelabs/axe-core'],
      engine: 'axe-core',
      engineVersion: axe.version,
      retrieved: new Date().toISOString().slice(0, 10),
    },
    rules,
  },
);
