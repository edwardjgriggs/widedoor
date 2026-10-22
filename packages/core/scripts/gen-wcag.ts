import { isMap, isSeq, type Document } from 'yaml';
import { decodeEntities, fetchText, writeYaml } from './lib/write-yaml.ts';

// Builds data/wcag.yaml from the W3C Recommendations. WCAG 2.1 supplies ids,
// titles and levels; WCAG 2.0 decides which criteria were added in 2.1.
const WCAG21 = 'https://www.w3.org/TR/WCAG21/';
const WCAG20 = 'https://www.w3.org/TR/WCAG20/';

const html21 = await fetchText(WCAG21);
const html20 = await fetchText(WCAG20);

const edition21 = html21.match(/<time class="dt-published" datetime="(\d{4}-\d{2}-\d{2})"/)?.[1];
if (!edition21) throw new Error('WCAG 2.1 publication date not found');

const in20 = new Set(
  [...html20.matchAll(/<strong class="sc-handle">(\d\.\d{1,2}\.\d{1,2}) /g)].map((m) => m[1]),
);
if (in20.size !== 61) throw new Error(`expected 61 WCAG 2.0 criteria, found ${in20.size}`);

const sections = html21.split(/(?=<section id="[^"]+" class="guideline">)/);
const criteria: { id: string; title: string; level: string; version: '2.0' | '2.1' }[] = [];
let total = 0;
for (const s of sections) {
  const head = s.match(
    /^<section id="[^"]+" class="guideline">.*?<bdi class="secno">Success Criterion (\d\.\d{1,2}\.\d{1,2}) <\/bdi>([^<]+)<\/h4>/s,
  );
  if (!head) continue;
  total++;
  const level = s.match(/<p class="conformance-level">\(Level (A{1,3})\)<\/p>/)?.[1];
  if (!level) throw new Error(`no level for ${head[1]}`);
  if (level === 'AAA') continue;
  const id = head[1]!;
  criteria.push({
    id,
    title: decodeEntities(head[2]!),
    level,
    version: in20.has(id) ? '2.0' : '2.1',
  });
}
if (total !== 78) throw new Error(`expected 78 WCAG 2.1 criteria, found ${total}`);

const count = (v: string) => criteria.filter((c) => c.version === v).length;
console.log(`A/AA: ${criteria.length} (2.0: ${count('2.0')}, 2.1: ${count('2.1')})`);

const decorate = (doc: Document) => {
  const seq = doc.get('criteria', true);
  if (!isSeq(seq)) return;
  for (const item of seq.items) {
    if (isMap(item) && item.get('id') === '4.1.1') {
      item.commentBefore = [
        ' 4.1.1 Parsing: W3C errata of 2023-04-18 (https://www.w3.org/WAI/WCAG21/errata/) removed one',
        ' note and added two, including: "This Success Criterion should be considered as always',
        ' satisfied for any content using HTML or XML." WCAG 2.2 marks 4.1.1 obsolete and removed.',
        ' Section 508 incorporates WCAG 2.0, so the 508 profile keeps 4.1.1.',
      ].join('\n');
    }
  }
};

await writeYaml(
  'wcag.yaml',
  [
    'Source: W3C WCAG 2.1 Recommendation and WCAG 2.0 Recommendation.',
    'Regenerate: npm run data:wcag -w @widedoor/core',
  ],
  {
    meta: {
      sources: [WCAG21, WCAG20],
      edition: `WCAG 2.1 W3C Recommendation, edition of ${edition21}`,
      retrieved: new Date().toISOString().slice(0, 10),
    },
    criteria,
  },
  decorate,
);
