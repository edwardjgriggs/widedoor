import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PdfScanner,
  VERAPDF_IMAGE_REF,
  dockerImagePresent,
  dockerRunArgs,
  dockerRunner,
  parseVerapdfOutput,
} from '../src/index.ts';
import { makePdf } from './fixtures.ts';

// npm run test:docker: needs Docker and `docker pull verapdf/cli:v1.30.3`.

const corpus = fileURLToPath(new URL('../../../corpus/', import.meta.url));
const containers = (prefix: string) =>
  spawnSync('docker', ['ps', '--all', '--quiet', '--filter', `name=${prefix}`], {
    encoding: 'utf8',
  }).stdout.trim();

beforeAll(async () => {
  if (!(await dockerImagePresent()))
    throw new Error(
      `Docker or ${VERAPDF_IMAGE_REF} is missing; run docker pull verapdf/cli:v1.30.3`,
    );
});

describe('veraPDF in Docker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'widedoor-docker-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('scans the corpus PDFs with the docker runner and agrees with the expected files', async () => {
    const scanner = await PdfScanner.create({ verapdf: 'docker', baseDir: corpus });
    expect(scanner.runnerKind).toBe('docker');
    expect(scanner.warnings).toEqual([]);
    for (const name of ['tagged-broken', 'clean-pdfua']) {
      const scan = await scanner.scanFile(`pdf/${name}.pdf`);
      expect(scan.error).toBeUndefined();
      const want = JSON.parse(readFileSync(join(corpus, `expected/pdf/${name}.json`), 'utf8'))
        .expected.filter(
          (e: { outcome: string }) => e.outcome === 'fail' || e.outcome === 'needs-review',
        )
        .map(
          (e: { engine: string; ruleId: string; outcome: string }) =>
            `${e.engine} ${e.ruleId} ${e.outcome}`,
        )
        .sort();
      const got = [
        ...scan.findings.map((f) => `${f.source.engine} ${f.source.ruleId} ${f.outcome}`),
        ...scan.informational.map((i) => `${i.engine} ${i.ruleId} ${i.outcome}`),
      ].filter((k) => / (?:fail|needs-review)$/.test(k));
      expect([...new Set(got)].sort(), name).toEqual(want);
    }
  });

  it('scans a generated 100-page PDF under the default timeouts', async () => {
    writeFileSync(
      join(dir, 'hundred.pdf'),
      await makePdf({ pages: 100, title: 'Hundred', lang: 'en' }),
    );
    const scanner = await PdfScanner.create({ verapdf: 'docker', baseDir: dir });
    const started = Date.now();
    const scan = await scanner.scanFile('hundred.pdf');
    const elapsed = Date.now() - started;
    expect(scan.error).toBeUndefined();
    expect(elapsed).toBeLessThan(120_000);
    const keys = scan.findings.map((f) => `${f.source.engine} ${f.source.ruleId} ${f.outcome}`);
    expect(keys).toContain('widedoor pdf-bookmarks needs-review');
    // Untagged text on every page: veraPDF reports the content as untagged, page by page.
    const pages = new Set(
      scan.findings
        .filter((f) => f.source.ruleId === '7.1-3')
        .map((f) => ('page' in f.location ? f.location.page : 0)),
    );
    expect(pages.size).toBeGreaterThan(1);
  });

  it('refuses the malformed corpus PDF with a malformed-pdf error', async () => {
    const run = await dockerRunner().run(readFileSync(join(corpus, 'pdf/malformed.pdf')), {
      timeoutMs: 120_000,
      maxOutputBytes: 1024 * 1024,
      maxFailuresDisplayed: 1,
    });
    const parsed = parseVerapdfOutput(run);
    expect(parsed.ok ? 'ok' : parsed.code).toBe('malformed-pdf');
  });

  it('removes the container when the deadline passes', async () => {
    const prefix = `widedoor-test-${process.pid}`;
    const run = await dockerRunner({ namePrefix: prefix }).run(await makePdf({ pages: 50 }), {
      timeoutMs: 1_500,
      maxOutputBytes: 64 * 1024 * 1024,
      maxFailuresDisplayed: 1,
    });
    expect(run.timedOut).toBe(true);
    expect(containers(prefix)).toBe('');
  });

  it('stops reading and removes the container past the output cap', async () => {
    const prefix = `widedoor-cap-${process.pid}`;
    const run = await dockerRunner({ namePrefix: prefix }).run(
      readFileSync(join(corpus, 'pdf/untagged.pdf')),
      { timeoutMs: 120_000, maxOutputBytes: 1024, maxFailuresDisplayed: 100 },
    );
    expect(run.truncated).toBe(true);
    expect(run.stdout.length).toBe(1024);
    expect(parseVerapdfOutput(run)).toMatchObject({ ok: false, code: 'output-too-large' });
    expect(containers(prefix)).toBe('');
  });

  it('runs the adapter flags as a non-root user with no network and a read-only root', async () => {
    const args = dockerRunArgs(`widedoor-probe-${process.pid}`, {}, 1);
    const at = args.indexOf(VERAPDF_IMAGE_REF);
    const probe =
      'id -u; cat /proc/net/route | wc -l; touch /probe 2>/dev/null && echo rw || echo ro';
    args.splice(at, args.length - at, '--entrypoint', 'sh', VERAPDF_IMAGE_REF, '-c', probe);
    const r = spawnSync('docker', args, { encoding: 'utf8', input: '' });
    expect(r.status, r.stderr).toBe(0);
    // uid 100; only the header line of the route table (no interface but lo); no writes to /.
    expect(r.stdout.trim().split(/\s+/)).toEqual(['100', '1', 'ro']);
  });
});
