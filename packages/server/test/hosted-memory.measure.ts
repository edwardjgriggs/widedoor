import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FindingSchema, findingId, getProfile, type Asset, type Finding } from '@widedoor/core';
import { buildScanReport, serializeJson } from '@widedoor/report';
import { createHostedApi } from '../src/hosted/api.ts';
import { VERIFIED_TIER } from '../src/hosted/limits.ts';
import { resultBodyMax } from '../src/hosted/protocol.ts';
import { fakeFly, settle } from './hosted-api-fixtures.ts';

/*
 * Measures the API's memory for one near-cap verified result through the real result
 * path (the control app's PUT: readResult, serializeJson, renderHtml, the kept Buffers).
 * Not a test: npm test never runs it (no .test.ts name). Run from the repo root:
 *
 *   npx tsx packages/server/test/hosted-memory.measure.ts --at=512,896
 *
 * For each of two shapes it writes one result body to a temp file: a report whose finding
 * snippets are all double quotes (the shape that grows most: each quote is 2 bytes in
 * reportJson, 4 in the body, 6 in the HTML), and the same with one U+2019 per snippet, so
 * every string V8 builds from it is two-byte (twice the heap of the one-byte shape). Then,
 * in fresh Node processes with --expose-gc:
 *   1. one run at a roomy heap, sampling heapUsed (every 2 ms, and before and after each
 *      step) and reading the peak RSS (resourceUsage().maxRSS) against the RSS once the
 *      body is loaded;
 *   2. a search for the smallest --max-old-space-size (MB, to 16 MB) at which the result
 *      still ends done;
 *   3. one run under each heap flag given with --at.
 * It prints, per shape, one JSON line for 1 and 2, and one per --at flag.
 */

const MiB = 1024 * 1024;
const self = fileURLToPath(import.meta.url);

/** A report of `count` findings whose snippets are `quotes` double quotes (and `extra`) each. */
function report(count: number, quotes: number, extra: string) {
  const page: Asset = {
    kind: 'web',
    uri: 'https://site.example.org/',
    contentHash: `sha256:${'a'.repeat(64)}`,
  };
  const findings: Finding[] = [];
  for (let i = 0; i < count; i++) {
    const location = { selector: `div#n${i}` };
    findings.push(
      FindingSchema.parse({
        schemaVersion: 1,
        id: findingId(page.uri, location, 'axe-core', 'image-alt'),
        asset: page,
        location,
        source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId: 'image-alt' },
        criteria: { wcag: ['1.1.1'] },
        outcome: 'fail',
        impact: 'critical',
        evidence: { snippet: `${'"'.repeat(quotes)}${extra}` },
      }),
    );
  }
  return buildScanReport({
    profile: getProfile('wcag21aa'),
    startedAt: '2026-10-28T12:00:00.000Z',
    finishedAt: '2026-10-28T12:01:00.000Z',
    toolVersion: '0.0.0',
    scope: { web: { urls: [page.uri], truncated: false } },
    web: {
      engine: { name: 'axe-core', version: '4.14.0' },
      assets: [page],
      findings,
      errors: [],
      skipped: [],
      warnings: [],
      truncated: false,
      pages: [{ asset: page, title: 'Home' }],
    },
  });
}

/** Writes the largest body of this shape under both caps; returns its sizes. */
function generate(file: string, extra: string) {
  const count = 64;
  // Each quote is 2 bytes of reportJson; leave 256 KiB for the rest of the report.
  let quotes = Math.floor((VERIFIED_TIER.reportMaxBytes - 256 * 1024) / (2 * count));
  let reportJson = serializeJson(report(count, quotes, extra));
  while (Buffer.byteLength(reportJson) > VERIFIED_TIER.reportMaxBytes) {
    quotes -= 1024;
    reportJson = serializeJson(report(count, quotes, extra));
  }
  const body = JSON.stringify({ status: 'done', reportJson });
  if (Buffer.byteLength(body) > resultBodyMax('verified')) throw new Error('body over the cap');
  writeFileSync(file, body);
  return {
    reportJsonBytes: Buffer.byteLength(reportJson),
    bodyBytes: Buffer.byteLength(body),
    resultBodyMax: resultBodyMax('verified'),
  };
}

/** One PUT of the body file through the real control app; prints the numbers. */
async function measureOnce(file: string) {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) throw new Error('run with --expose-gc');
  const fly = fakeFly();
  const api = createHostedApi({
    fly: fly.client,
    image: `registry.fly.io/widedoor-scan@sha256:${'0'.repeat(64)}`,
    controlUrl: 'http://127.0.0.1:8081',
    publicOrigin: 'https://widedoor.example.net',
    resolveTier: () => Promise.resolve('verified'),
  });
  const taken = api.jobs.submit({
    tier: 'verified',
    profile: '508+wcag21aa',
    target: { kind: 'url', url: 'https://site.example.org/', host: 'site.example.org' },
  });
  if (!taken.ok) throw new Error('job refused');
  await settle();
  const token = fly.created[0]?.token ?? '';
  // As it arrives off the network: one Buffer, outside the heap.
  const body = readFileSync(file);
  gc();
  const base = process.memoryUsage();
  let peakHeap = base.heapUsed;
  const sample = () => (peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed));
  const timer = setInterval(sample, 2);
  const res = await api.controlApp.request(`/internal/jobs/${taken.view.id}/result`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
  });
  sample();
  clearInterval(timer);
  const status = api.jobs.view(taken.view.id)?.status;
  const after = process.memoryUsage();
  gc();
  const kept = process.memoryUsage();
  api.stop();
  console.log(
    JSON.stringify({
      put: res.status,
      status,
      retainedBytes: api.jobs.retained,
      baseHeapMiB: +(base.heapUsed / MiB).toFixed(1),
      peakHeapMiB: +(peakHeap / MiB).toFixed(1),
      peakHeapGrowthMiB: +((peakHeap - base.heapUsed) / MiB).toFixed(1),
      baseRssMiB: +(base.rss / MiB).toFixed(1),
      peakRssMiB: +((process.resourceUsage().maxRSS * 1024) / MiB).toFixed(1),
      peakRssGrowthMiB: +((process.resourceUsage().maxRSS * 1024 - base.rss) / MiB).toFixed(1),
      afterRssMiB: +(after.rss / MiB).toFixed(1),
      keptHeapMiB: +(kept.heapUsed / MiB).toFixed(1),
      // arrayBuffers is part of external: the two are given apart, never added.
      keptExternalMiB: +(kept.external / MiB).toFixed(1),
      keptArrayBuffersMiB: +(kept.arrayBuffers / MiB).toFixed(1),
    }),
  );
  process.exitCode = status === 'done' ? 0 : 1;
}

/** Runs measureOnce in a fresh Node with these flags; its JSON line, or undefined if it failed. */
function child(file: string, flags: string[]): Record<string, unknown> | undefined {
  const r = spawnSync(
    process.execPath,
    [...flags, '--expose-gc', '--import', 'tsx', self, 'once', file],
    { encoding: 'utf8', maxBuffer: 16 * MiB, timeout: 300_000 },
  );
  if (r.status !== 0) return undefined;
  const line = r.stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as Record<string, unknown>;
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  if (mode === 'once' && file !== undefined) return measureOnce(file);
  const dir = mkdtempSync(join(tmpdir(), 'widedoor-measure-'));
  const at = process.argv.find((a) => a.startsWith('--at='))?.slice('--at='.length);
  try {
    for (const [shape, extra] of [
      ['one-byte', ''],
      ['two-byte', '\u2019'],
    ] as const) {
      const bodyFile = join(dir, `body-${shape}.json`);
      const sizes = generate(bodyFile, extra);
      const roomy = child(bodyFile, ['--max-old-space-size=4096']);
      if (roomy === undefined) throw new Error(`the roomy run failed (${shape})`);
      let low = 16;
      let high = 4096;
      while (high - low > 16) {
        const mid = Math.floor((low + high) / 2);
        if (child(bodyFile, [`--max-old-space-size=${mid}`]) !== undefined) high = mid;
        else low = mid;
      }
      console.log(
        JSON.stringify({
          shape,
          node: process.version,
          ...sizes,
          ...roomy,
          smallestHeapFlagMB: high,
        }),
      );
      // The same run under the heap flags given (`--at=512,896`), as the API would run.
      for (const mb of at?.split(',') ?? [])
        console.log(
          JSON.stringify({
            shape,
            heapFlagMB: Number(mb),
            ...(child(bodyFile, [`--max-old-space-size=${mb}`]) ?? { status: 'failed' }),
          }),
        );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
