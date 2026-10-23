import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebScanner, isInside, type InterceptDecision } from '@widedoor/web';
import {
  actAgreement,
  compareExact,
  corpusDir,
  corpusPath,
  readExpected,
  readManifest,
  writeJson,
  type ExpectedEntry,
  type ManifestItem,
} from './lib/corpus.ts';
import { ACT_BASE } from './lib/act.ts';

/*
 * Runs the shipped web adapter (@widedoor/web: hardened Chromium, axe-core with
 * WCAG 2.0/2.1 A and AA tags, desktop plus 320px reflow pass) on every web item
 * in the manifest and compares the results with corpus/expected.
 *
 *   corpus items: exact match (see README). Any difference fails the run.
 *   ACT items:    the expected outcome is the ACT outcome. The ACT-level outcome
 *                 over the mapped axe rules must equal it, or equal the item's
 *                 recorded knownDisagreement exactly. Any other result (a new
 *                 disagreement, a known one that went away, an unrecorded item)
 *                 fails the run. Not-vendored test cases are skipped.
 *
 * --record rewrites the ACT expected files and manifest from this run: agreeing
 * items become confirmed, disagreeing ones provisional with a knownDisagreement.
 * A confirmed item that now disagrees still fails the run and is left as it
 * was, unless --allow-downgrade is also passed.
 */

const record = process.argv.includes('--record');
const allowDowngrade = process.argv.includes('--allow-downgrade');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt',
  '.css': 'text/css',
  '.js': 'text/javascript',
};

const actDir = corpusPath('act');

/**
 * No page may reach the network: ACT URLs are served from corpus/act and every
 * other http(s) request is blocked. The adapter itself keeps file: URLs inside
 * corpus/ and closes WebSockets.
 */
function offline(url: string): InterceptDecision {
  if (!url.startsWith(ACT_BASE)) return 'abort';
  const rel = decodeURIComponent(new URL(url).pathname.slice(new URL(ACT_BASE).pathname.length));
  const file = corpusPath(`act/${rel}`);
  if (rel && isInside(actDir, file) && existsSync(file)) {
    return {
      body: readFileSync(file),
      contentType: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    };
  }
  return { status: 404, body: '' };
}

interface Outcome {
  item: ManifestItem;
  ok: boolean;
  detail: string;
}

async function check(scanner: WebScanner, item: ManifestItem): Promise<Outcome> {
  const expected = readExpected(item.expected);
  const url = item.act ? item.act.url : pathToFileURL(corpusPath(item.path)).href;
  const scan = await scanner.scanPage(url);
  if (scan.error) {
    // Stable tokens: these strings are what knownDisagreement records.
    const detail =
      scan.error.code === 'non-html-document'
        ? 'not-run: non-html-document'
        : `axe did not run: ${scan.error.message}`;
    return { item, ok: false, detail };
  }
  const seen = new Set<string>();
  const actual: ExpectedEntry[] = [];
  for (const f of scan.findings) {
    const entry = { engine: 'axe-core' as const, ruleId: f.source.ruleId, outcome: f.outcome };
    const k = `${entry.ruleId} ${entry.outcome}`;
    if (!seen.has(k)) actual.push(entry);
    seen.add(k);
  }

  if (item.source === 'corpus') {
    const { missing, unexpected } = compareExact('axe-core', expected.expected, actual);
    const lines = [
      ...missing.map((k) => `missing ${k}`),
      ...unexpected.map((k) => `unexpected ${k}`),
    ];
    if (expected.confirmedBy !== confirmedBy) lines.push(`confirmedBy is ${expected.confirmedBy}`);
    return { item, ok: lines.length === 0, detail: lines.join('; ') };
  }

  const { ok, detail } = actAgreement(expected.expected, actual);
  return { item, ok, detail };
}

const manifest = readManifest();
const items = manifest.items.filter((i) => i.kind === 'web');
const scanner = await WebScanner.launch({ fileRoot: corpusDir, intercept: offline });
const confirmedBy = `axe-core ${scanner.engineVersion}`;
const results: Outcome[] = [];
try {
  const queue = [...items];
  const workers = Array.from({ length: 4 }, async () => {
    for (let item = queue.shift(); item; item = queue.shift())
      results.push(await check(scanner, item));
  });
  await Promise.all(workers);
} finally {
  await scanner.close();
}
results.sort((a, b) => a.item.path.localeCompare(b.item.path));

let failures = 0;
const corpus = results.filter((r) => r.item.source === 'corpus');
for (const r of corpus.filter((r) => !r.ok)) {
  failures++;
  console.error(`FAIL ${r.item.path}: ${r.detail}`);
}

const act = results.filter((r) => r.item.source === 'act');
const counts = { agree: 0, known: 0 };
const fail = (path: string, why: string) => {
  failures++;
  console.error(`FAIL ${path}: ${why}`);
};
for (const r of act) {
  const file = readExpected(r.item.expected);
  const known = r.item.knownDisagreement;
  const isKnown = !r.ok && known?.engine === confirmedBy && known.result === r.detail;
  if (r.ok) counts.agree++;
  if (isKnown) counts.known++;

  if (!record) {
    if (r.ok && known)
      fail(r.item.path, 'known disagreement no longer occurs; rerun with --record');
    else if (r.ok && file.provisional)
      fail(r.item.path, 'agrees but is not recorded; rerun with --record');
    else if (!r.ok && !isKnown) fail(r.item.path, `new disagreement: ${r.detail}`);
    continue;
  }
  if (!r.ok && !file.provisional && !allowDowngrade) {
    fail(r.item.path, `confirmed item now disagrees: ${r.detail}`);
    continue;
  }
  writeJson(r.item.expected, {
    ...file,
    confirmedBy: r.ok ? confirmedBy : null,
    provisional: !r.ok,
  });
  if (r.ok) {
    if (known) {
      console.log(
        `recorded ${r.item.path}:\n  old: ${known.engine}: ${known.result}\n  new: agrees`,
      );
    }
    delete r.item.note;
    delete r.item.knownDisagreement;
  } else {
    if (known && !isKnown) {
      console.log(
        `recorded ${r.item.path}:\n  old: ${known.engine}: ${known.result}\n  new: ${confirmedBy}: ${r.detail}`,
      );
    }
    r.item.note = `Known disagreement: the expected outcome is the ACT outcome; ${confirmedBy} differs (${r.detail}).`;
    r.item.knownDisagreement = { engine: confirmedBy, result: r.detail };
    if (!isKnown) counts.known++;
  }
}
if (record) writeJson('manifest.json', manifest);

console.log(
  `corpus/web: ${corpus.filter((r) => r.ok).length}/${corpus.length} pages match ${confirmedBy}`,
);
console.log(
  `corpus/act: ${counts.agree}/${act.length} test cases agree with ${confirmedBy}, ` +
    `${counts.known} known disagreements, ${manifest.notVendored.length} not vendored (skipped)` +
    (record ? ' (recorded)' : ''),
);
if (failures) {
  console.error(`${failures} item(s) do not match their expected findings`);
  process.exitCode = 1;
}
