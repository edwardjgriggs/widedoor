import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { loadStandardsData } from '../../packages/core/src/data.ts';
import {
  ACT_BASE,
  ACT_COMMIT,
  ACT_INDEX,
  ACT_LICENSE,
  ACT_MIRROR,
  ACT_TO_OUTCOME,
  type ActOutcome,
} from './lib/act.ts';
import {
  ManifestSchema,
  corpusPath,
  expectedPathFor,
  readManifest,
  writeJson,
  type ManifestItem,
} from './lib/corpus.ts';

/*
 * Vendors the W3C ACT rules test cases for every ACT rule that axe-map.yaml
 * references, plus the test assets they load, into corpus/act (files kept
 * byte for byte). Writes provisional expected files from each test case's ACT
 * outcome and replaces the ACT entries in manifest.json. Run verify-web.ts with
 * --record afterwards to confirm them against axe-core.
 *
 * Assets over MAX_ASSET_BYTES are not vendored; a test case that needs one is
 * listed in manifest.notVendored with its pinned upstream URL instead. Nothing
 * is written when the vendored total would exceed MAX_BYTES.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ASSET_BYTES = 1024 * 1024;

interface Testcase {
  ruleId: string;
  ruleName: string;
  expected: ActOutcome;
  testcaseId: string;
  testcaseTitle: string;
  relativePath: string;
  url: string;
  approved?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The W3C site rate-limits bursts (HTTP 429), so files are fetched from the
 * repository it publishes from, at a pinned commit; paths are identical.
 */
async function get(url: string): Promise<Buffer> {
  if (!url.startsWith(ACT_BASE)) throw new Error(`not an ACT url: ${url}`);
  const mirrored = `${ACT_MIRROR}${url.slice(ACT_BASE.length)}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(mirrored, { signal: AbortSignal.timeout(30_000) });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status !== 429 || attempt === 5) throw new Error(`${mirrored}: HTTP ${res.status}`);
    await sleep(10_000 * attempt);
  }
}

const REF = /(?:\b(?:src|href|data|poster)\s*=\s*["']([^"']+)["'])|(?:url\(\s*["']?([^"')]+))/gi;

/** Test assets (under ACT_BASE/test-assets/) a test case or asset loads. */
function assetRefs(body: Buffer, from: string): string[] {
  const out: string[] = [];
  for (const m of body.toString('utf8').matchAll(REF)) {
    const ref = m[1] ?? m[2];
    if (!ref) continue;
    try {
      const url = new URL(ref, from);
      url.hash = '';
      url.search = '';
      if (url.href.startsWith(`${ACT_BASE}test-assets/`)) out.push(url.href);
    } catch {
      // Not a URL; test cases include deliberately invalid references.
    }
  }
  return out;
}

const textual = (url: string) => /\.(?:html?|css|svg|xml)$/i.test(url);

const data = loadStandardsData();
const axeRulesFor = new Map<string, string[]>();
for (const rule of data.axe.rules) {
  for (const act of rule.actRules) axeRulesFor.set(act, [...(axeRulesFor.get(act) ?? []), rule.id]);
}

const index = JSON.parse((await get(ACT_INDEX)).toString('utf8')) as { testcases: Testcase[] };
// Index entries are untrusted: each URL must normalize to ACT_BASE + relativePath.
const cases = index.testcases
  .filter((t) => axeRulesFor.has(t.ruleId))
  .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
for (const t of cases) {
  const href = new URL(t.url).href;
  if (href !== t.url || href !== `${ACT_BASE}${t.relativePath}`) {
    throw new Error(`unexpected test case location: ${t.url} (${t.relativePath})`);
  }
}
const withoutCases = [...axeRulesFor.keys()].filter((id) => !cases.some((t) => t.ruleId === id));

const files = new Map<string, Buffer>();
const refs = new Map<string, string[]>();
for (const t of cases) {
  const body = await get(t.url);
  files.set(t.url, body);
  refs.set(t.url, assetRefs(body, t.url));
}
const missingAssets: string[] = [];
const pending = [...new Set([...refs.values()].flat())];
for (let url = pending.shift(); url; url = pending.shift()) {
  if (files.has(url) || missingAssets.includes(url)) continue;
  try {
    const body = await get(url);
    files.set(url, body);
    refs.set(url, textual(url) ? assetRefs(body, url) : []);
    pending.push(...(refs.get(url) ?? []));
  } catch (e) {
    missingAssets.push(url);
    console.warn(`asset not fetched: ${(e as Error).message}`);
  }
}

/** Every fetched asset a test case loads, directly or through another asset. */
function closure(url: string): string[] {
  const seen = new Set<string>();
  const queue = [...(refs.get(url) ?? [])];
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (seen.has(next) || !files.has(next)) continue;
    seen.add(next);
    queue.push(...(refs.get(next) ?? []));
  }
  return [...seen].sort();
}

const rel = (url: string) => url.slice(ACT_BASE.length);
const vendored: Testcase[] = [];
const skipped: { testcase: Testcase; large: string[] }[] = [];
for (const t of cases) {
  const large = closure(t.url).filter((u) => (files.get(u)?.length ?? 0) > MAX_ASSET_BYTES);
  if (large.length) skipped.push({ testcase: t, large });
  else vendored.push(t);
}
const keep = new Set(vendored.flatMap((t) => [t.url, ...closure(t.url)]));
const total = [...keep].reduce((n, u) => n + (files.get(u)?.length ?? 0), 0);
const caseBytes = vendored.reduce((n, t) => n + (files.get(t.url)?.length ?? 0), 0);
console.log(
  `${vendored.length}/${cases.length} test cases vendored, ${keep.size} files, ${total} bytes ` +
    `(test cases ${caseBytes}, assets ${total - caseBytes}); ${skipped.length} need an asset over ${MAX_ASSET_BYTES} bytes`,
);
if (total > MAX_BYTES) {
  console.error(`over ${MAX_BYTES} bytes; nothing written`);
  process.exit(1);
}

rmSync(corpusPath('act/testcases'), { recursive: true, force: true });
rmSync(corpusPath('act/test-assets'), { recursive: true, force: true });
rmSync(corpusPath('expected/act'), { recursive: true, force: true });
const actRoot = resolve(corpusPath('act'));
const write = (path: string, body: Buffer | string) => {
  if (!resolve(corpusPath(path)).startsWith(actRoot + sep))
    throw new Error(`outside corpus/act: ${path}`);
  mkdirSync(dirname(corpusPath(path)), { recursive: true });
  writeFileSync(corpusPath(path), body);
};
for (const url of keep) write(`act/${rel(url)}`, files.get(url)!);

const retrieved = new Date().toISOString().slice(0, 10);
const items: ManifestItem[] = vendored.map((t) => {
  const path = `act/${t.relativePath}`;
  const expected = expectedPathFor(path);
  const outcome = ACT_TO_OUTCOME[t.expected];
  writeJson(expected, {
    item: path,
    kind: 'web',
    source: 'act',
    expected: (axeRulesFor.get(t.ruleId) ?? []).map((ruleId) => ({
      engine: 'axe-core',
      ruleId,
      outcome,
    })),
    confirmedBy: null,
    provisional: true,
  });
  return {
    path,
    kind: 'web',
    source: 'act',
    expected,
    description: `ACT rule ${t.ruleId} (${t.ruleName}): ${t.testcaseTitle}`,
    act: {
      ruleId: t.ruleId,
      testcaseId: t.testcaseId,
      title: t.testcaseTitle,
      outcome: t.expected,
      ...(t.approved === undefined ? {} : { approved: t.approved }),
      url: t.url,
    },
    note: 'Provisional: not yet run through verify-web.ts --record.',
  };
});

write('act/LICENSE.md', readFileSync(new URL('./act-LICENSE.md', import.meta.url)));
writeJson('act/source.json', {
  source: ACT_INDEX,
  repository: 'https://github.com/w3c/wcag-act-rules',
  commit: ACT_COMMIT,
  license: ACT_LICENSE,
  retrieved,
  selection: 'test cases of every ACT rule referenced by packages/core/data/axe-map.yaml',
  actRules: [...axeRulesFor.keys()].sort(),
  actRulesWithoutTestcases: withoutCases.sort(),
  testcases: vendored.length,
  testcasesNotVendored: skipped.length,
  maxAssetBytes: MAX_ASSET_BYTES,
  files: keep.size,
  bytes: total,
  assetsNotFetched: missingAssets.sort(),
  /** sha256 of every vendored file as fetched; npm test rehashes the files against it. */
  sha256: Object.fromEntries(
    [...keep]
      .map((u) => [rel(u), createHash('sha256').update(files.get(u)!).digest('hex')])
      .sort(([a], [b]) => a!.localeCompare(b!)),
  ),
});

const manifest = readManifest();
const assets = [...keep]
  .filter((u) => u.startsWith(`${ACT_BASE}test-assets/`))
  .map((u) => `act/${u.slice(ACT_BASE.length)}`)
  .sort();
manifest.items = [...manifest.items.filter((i) => i.source !== 'act'), ...items];
manifest.notVendored = skipped.map(({ testcase: t, large }) => ({
  act: {
    ruleId: t.ruleId,
    testcaseId: t.testcaseId,
    title: t.testcaseTitle,
    outcome: t.expected,
    ...(t.approved === undefined ? {} : { approved: t.approved }),
    url: t.url,
  },
  upstream: `${ACT_MIRROR}${rel(t.url)}`,
  reason: `needs assets over ${MAX_ASSET_BYTES} bytes: ${large
    .map((u) => `${rel(u)} (${files.get(u)?.length} bytes)`)
    .join(', ')}`,
}));
manifest.supportFiles = [
  ...manifest.supportFiles.filter((f) => !f.path.startsWith('act/')),
  {
    path: 'act/LICENSE.md',
    description: 'W3C Software and Document License covering the vendored ACT test cases',
  },
  {
    path: 'act/source.json',
    description: 'Source, pinned commit, license and retrieval date of the vendored ACT test cases',
  },
  ...assets.map((path) => ({ path, description: 'ACT test asset loaded by a vendored test case' })),
];
writeJson('manifest.json', ManifestSchema.parse(manifest));
console.log(
  `wrote ${items.length} expected files; ${skipped.length} test cases not vendored; ` +
    `${withoutCases.length} ACT rules have no test cases`,
);
