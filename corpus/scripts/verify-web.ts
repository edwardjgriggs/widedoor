import { existsSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type BrowserContext } from 'playwright';
import { axeVersion, runAxe } from './lib/axe.ts';
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
 * Runs axe-core (WCAG 2.0/2.1 A and AA tags) on every web item in the manifest
 * and compares the results with corpus/expected.
 *
 *   corpus items: exact match (see README). Any difference fails the run.
 *   ACT items:    the ACT-level outcome over the mapped axe rules must equal the
 *                 expected outcome. A confirmed item that disagrees fails the run;
 *                 a provisional one is counted.
 *
 * --record rewrites the ACT expected files and manifest notes from this run:
 * agreeing items become confirmed, disagreeing ones provisional with a note. A
 * confirmed item that now disagrees still fails the run and is left as it was,
 * unless --allow-downgrade is also passed.
 */

const record = process.argv.includes('--record');
const allowDowngrade = process.argv.includes('--allow-downgrade');
const confirmedBy = `axe-core ${axeVersion}`;

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

const inCorpus = (file: string) => {
  const rel = relative(resolve(corpusDir), resolve(file));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * No page may reach the network or files outside corpus/: corpus file URLs and
 * data URLs load, ACT URLs come from corpus/act, everything else is blocked.
 */
async function isolate(context: BrowserContext): Promise<void> {
  await context.routeWebSocket(/.*/, (ws) => ws.close());
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file:')) {
      return inCorpus(fileURLToPath(url)) ? route.continue() : route.abort('blockedbyclient');
    }
    if (url.startsWith(ACT_BASE)) {
      const rel = decodeURIComponent(
        new URL(url).pathname.slice(new URL(ACT_BASE).pathname.length),
      );
      const file = corpusPath(`act/${rel}`);
      if (rel && inCorpus(file) && existsSync(file)) {
        return route.fulfill({
          body: readFileSync(file),
          contentType: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        });
      }
      return route.fulfill({ status: 404, body: '' });
    }
    return route.abort('blockedbyclient');
  });
}

interface Outcome {
  item: ManifestItem;
  ok: boolean;
  detail: string;
}

async function check(context: BrowserContext, item: ManifestItem): Promise<Outcome> {
  const expected = readExpected(item.expected);
  const page = await context.newPage();
  let actual: ExpectedEntry[];
  try {
    const url = item.act ? item.act.url : pathToFileURL(corpusPath(item.path)).href;
    await page.goto(url, { waitUntil: 'load' });
    actual = await runAxe(page);
  } catch (e) {
    return { item, ok: false, detail: `axe did not run: ${(e as Error).message.split('\n')[0]}` };
  } finally {
    await page.close();
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
const browser = await chromium.launch();
const results: Outcome[] = [];
try {
  const queue = [...items];
  const workers = Array.from({ length: 4 }, async () => {
    const context = await browser.newContext();
    await isolate(context);
    for (let item = queue.shift(); item; item = queue.shift())
      results.push(await check(context, item));
    await context.close();
  });
  await Promise.all(workers);
} finally {
  await browser.close();
}
results.sort((a, b) => a.item.path.localeCompare(b.item.path));

let failures = 0;
const corpus = results.filter((r) => r.item.source === 'corpus');
for (const r of corpus.filter((r) => !r.ok)) {
  failures++;
  console.error(`FAIL ${r.item.path}: ${r.detail}`);
}

const act = results.filter((r) => r.item.source === 'act');
let disagree = 0;
for (const r of act) {
  const file = readExpected(r.item.expected);
  const downgrade = !file.provisional && !r.ok;
  if (downgrade && !(record && allowDowngrade)) {
    failures++;
    console.error(`FAIL ${r.item.path}: ${r.detail}`);
  } else if (record) {
    writeJson(r.item.expected, {
      ...file,
      confirmedBy: r.ok ? confirmedBy : null,
      provisional: !r.ok,
    });
    if (r.ok) delete r.item.note;
    else r.item.note = `Provisional: ${r.detail}.`;
  }
  if (!r.ok) disagree++;
}
if (record) writeJson('manifest.json', manifest);

console.log(
  `corpus/web: ${corpus.filter((r) => r.ok).length}/${corpus.length} pages match ${confirmedBy}`,
);
console.log(
  `corpus/act: ${act.length - disagree}/${act.length} test cases agree with ${confirmedBy}` +
    (record ? ' (recorded)' : ''),
);
if (failures) {
  console.error(`${failures} item(s) do not match their expected findings`);
  process.exitCode = 1;
}
