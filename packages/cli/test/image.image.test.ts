import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IN_CONTAINER_WARNING,
  ISOLATED_HOST_ENV,
  NOT_ISOLATED_WARNING,
  VERAPDF_IMAGE_REF,
} from '@widedoor/pdf';
import { parseJsonReport } from '@widedoor/report';
import { CORPUS, ROOT, reportValidator } from './helpers.ts';

/*
 * The Widedoor image (npm run test:image; needs Docker and the pinned
 * verapdf/cli:v1.30.3 image). Builds widedoor:dev from the repo's Dockerfile
 * (cached layers make a rebuild quick), then runs it the way the README says:
 * web and PDF scans in separate runs with the README's hardening flags, only
 * the report folder mounted writable, and the PDFs mounted read-only with no
 * network. The corpus web pages come from a second container on an internal
 * Docker network (no route to the internet). With WIDEDOOR_TEST_IMAGE set, the
 * suite tests that image as it is and builds nothing.
 */

const PREBUILT = process.env.WIDEDOOR_TEST_IMAGE;
const IMAGE = PREBUILT ?? 'widedoor:dev';
const BUILD_TIMEOUT = 1_200_000;
const TIMEOUT = 300_000;
const SECCOMP = join(ROOT, 'docker', 'chromium-seccomp.json');
const LABEL = 'io.widedoor.image-test=1';
const PDFS = ['clean-pdfua', 'scanned-image-only', 'tagged-broken', 'untagged'];
const id = randomUUID().slice(0, 8);
const network = `widedoor-image-test-${id}`;
const site = `widedoor-image-site-${id}`;
let tmp: string;

const docker = (args: readonly string[], timeout = TIMEOUT): SpawnSyncReturns<string> =>
  spawnSync('docker', args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });

/** The hardening the README recommends, plus the Chromium seccomp profile. */
const hardened = [
  '--rm',
  '--init',
  '--label',
  LABEL,
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--read-only',
  '--tmpfs',
  '/tmp:rw,nosuid,size=512m',
];
const seccomp = ['--security-opt', `seccomp=${SECCOMP}`];
/** On POSIX the container runs as the host user, so the reports are the host user's files. */
const asHostUser =
  typeof process.getuid === 'function' && typeof process.getgid === 'function'
    ? ['--user', `${process.getuid()}:${process.getgid()}`]
    : [];

// Serves basenames of *.html files from /site, nothing else.
const SERVER = [
  "const http = require('node:http'), fs = require('node:fs'), path = require('node:path');",
  'http.createServer((req, res) => {',
  "  const name = path.basename(new URL(req.url, 'http://x').pathname);",
  "  const file = path.join('/site', name);",
  "  if (!name.endsWith('.html') || !fs.existsSync(file)) return void res.writeHead(404).end();",
  "  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fs.readFileSync(file));",
  "}).listen(8080, '0.0.0.0', () => console.log('ready'));",
].join('\n');

beforeAll(async () => {
  const version = docker(['version', '--format', '{{.Server.Version}}'], 60_000);
  if (version.status !== 0) throw new Error(`Docker is not running: ${version.stderr}`);
  if (PREBUILT === undefined) {
    const built = docker(['build', '--tag', IMAGE, ROOT], BUILD_TIMEOUT);
    if (built.status !== 0) throw new Error(`docker build failed:\n${built.stderr.slice(-4000)}`);
  } else if (docker(['image', 'inspect', IMAGE]).status !== 0) {
    throw new Error(`WIDEDOOR_TEST_IMAGE ${IMAGE} is not present locally`);
  }
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-image-'));
  const net = docker(['network', 'create', '--internal', '--label', LABEL, network]);
  if (net.status !== 0) throw new Error(net.stderr);
  const started = docker([
    'run',
    '--detach',
    ...hardened,
    '--name',
    site,
    '--network',
    network,
    '--volume',
    `${join(CORPUS, 'web')}:/site:ro`,
    '--entrypoint',
    'node',
    IMAGE,
    '-e',
    SERVER,
  ]);
  if (started.status !== 0) throw new Error(started.stderr);
  for (let i = 0; i < 100; i++) {
    if (docker(['logs', site]).stdout.includes('ready')) return;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  throw new Error('the corpus site container did not start');
}, BUILD_TIMEOUT);

afterAll(() => {
  const left = docker(['ps', '--all', '--quiet', '--filter', `label=${LABEL}`]).stdout.split(/\s+/);
  const ids = left.filter(Boolean);
  if (ids.length) docker(['rm', '--force', ...ids]);
  docker(['network', 'rm', network]);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('the widedoor image', () => {
  it('runs as a fixed non-root user, marks itself isolated and carries veraPDF 1.30.3', () => {
    const config = JSON.parse(
      docker(['image', 'inspect', '--format', '{{json .Config}}', IMAGE]).stdout,
    ) as { User: string; Env: string[]; WorkingDir: string; Entrypoint: string[] };
    expect(config.User).toBe('10001:10001');
    expect(config.Env).toContain(`${ISOLATED_HOST_ENV}=1`);
    expect(config.WorkingDir).toBe('/work');
    expect(config.Entrypoint).toEqual(['node', '/app/packages/cli/dist/bin.js']);
    const v = docker([
      'run',
      '--rm',
      '--label',
      LABEL,
      '--entrypoint',
      'verapdf',
      IMAGE,
      '--version',
    ]);
    expect(v.status, v.stderr).toBe(0);
    expect(v.stdout).toMatch(/^veraPDF 1\.30\.3$/m);
  });

  it('ships no package managers, no .npmrc, no setuid or setgid file and a read-only veraPDF config', () => {
    const sh = (script: string) =>
      docker(['run', '--rm', '--label', LABEL, '--entrypoint', 'sh', IMAGE, '-c', script]);
    // npm, npx, corepack and yarn are removed; node and the CLI remain.
    const tools = sh('for t in npm npx corepack yarn yarnpkg; do command -v $t; done; echo end');
    expect(tools.stdout.trim()).toBe('end');
    expect(sh('ls -A /app').stdout.split(/\s+/)).not.toContain('.npmrc');
    const special = sh('find / -xdev -perm /6000 -type f; echo end');
    expect(special.stdout.trim()).toBe('end');
    // veraPDF reads the config created at build time and cannot change it.
    const config = sh(
      'test -f /opt/verapdf/config/validator.xml && echo present; ' +
        'test -w /opt/verapdf/config || echo locked; test -w /opt/verapdf/config/validator.xml || echo locked',
    );
    expect(config.stdout.split(/\s+/).filter(Boolean)).toEqual(['present', 'locked', 'locked']);
  });

  it(
    'veraPDF in the image reports the same rules as the pinned veraPDF image',
    () => {
      const args = [
        '--flavour',
        'ua1',
        '--format',
        'json',
        '--success',
        '--maxfailuresdisplayed',
        '5',
      ];
      const rules = (out: string) => {
        const found: string[] = [];
        JSON.parse(out, (_key, value: unknown) => {
          const v = value as Record<string, unknown> | null;
          if (v && typeof v === 'object' && 'clause' in v && 'testNumber' in v)
            found.push(
              `${String(v.clause)}-${String(v.testNumber)} ${String(v.status)} ${String(v.failedChecks)}`,
            );
          return value;
        });
        return found.sort();
      };
      for (const pdf of PDFS) {
        const input = readFileSync(join(CORPUS, 'pdf', `${pdf}.pdf`));
        const run = (image: string, entrypoint: string[]) =>
          spawnSync(
            'docker',
            [
              'run',
              '--rm',
              '--interactive',
              '--network',
              'none',
              '--label',
              LABEL,
              ...entrypoint,
              image,
              ...args,
            ],
            { input, encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 64 * 1024 * 1024 },
          );
        const ours = run(IMAGE, ['--entrypoint', 'verapdf']);
        const upstream = run(VERAPDF_IMAGE_REF, []);
        expect(ours.stdout.length, `${pdf}: ${ours.stderr}`).toBeGreaterThan(0);
        expect(rules(ours.stdout), pdf).toEqual(rules(upstream.stdout));
      }
    },
    TIMEOUT,
  );

  it(
    'scans the corpus web pages with the Chromium sandbox on and writes reports to a mounted folder',
    () => {
      const pages = readdirSync(join(CORPUS, 'web')).filter((f) => f.endsWith('.html'));
      // Only the report folder is mounted, writable (README: web pages).
      const out = join(tmp, 'web');
      mkdirSync(out);
      const r = docker([
        'run',
        ...hardened,
        ...seccomp,
        ...asHostUser,
        '--network',
        network,
        '--volume',
        `${out}:/work/out`,
        IMAGE,
        'scan',
        ...pages.map((p) => `http://${site}:8080/${p}`),
        '--out',
        'out',
      ]);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toContain(
        `Scanned ${pages.length} pages and files (${pages.length} web, 0 PDF); 0 scan errors`,
      );
      const text = readFileSync(join(out, 'report.json'), 'utf8');
      const validate = reportValidator();
      expect(validate(JSON.parse(text)), JSON.stringify(validate.errors)).toBe(true);
      const report = parseJsonReport(text);
      expect(report.errors).toEqual([]);
      // No unsafeNoSandbox warning: Chromium ran with its OS sandbox.
      expect(report.warnings).toEqual([]);
      expect(report.assets).toHaveLength(pages.length);
      expect(report.findings.some((f) => f.outcome === 'fail')).toBe(true);
      expect(readdirSync(join(out, 'evidence')).some((f) => f.endsWith('.png'))).toBe(true);
      if (asHostUser.length)
        expect(statSync(join(out, 'report.json')).uid).toBe(process.getuid?.());
    },
    TIMEOUT,
  );

  it(
    'refuses to scan without the seccomp profile rather than drop the sandbox',
    () => {
      const r = docker([
        'run',
        ...hardened,
        '--network',
        network,
        IMAGE,
        'scan',
        `http://${site}:8080/alt-fail.html`,
        '--out',
        '/tmp/out',
      ]);
      expect(r.status).toBe(2);
      expect(r.stdout + r.stderr).toContain('Chromium could not start with its OS sandbox');
    },
    TIMEOUT,
  );

  it(
    'scans mounted PDFs with the bundled veraPDF and no network',
    () => {
      // README: PDFs. No network, inputs read-only, a separate writable report folder.
      const out = join(tmp, 'pdf');
      mkdirSync(out);
      const r = docker([
        'run',
        ...hardened,
        ...asHostUser,
        '--network',
        'none',
        '--volume',
        `${join(CORPUS, 'pdf')}:/work/pdf:ro`,
        '--volume',
        `${out}:/work/out`,
        IMAGE,
        'scan',
        ...PDFS.map((p) => `pdf/${p}.pdf`),
        '--out',
        'out',
      ]);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      const report = parseJsonReport(readFileSync(join(out, 'report.json'), 'utf8'));
      expect(report.errors).toEqual([]);
      // veraPDF has no sandbox of its own in the image: the in-container warning says so.
      expect(report.warnings).toEqual([IN_CONTAINER_WARNING]);
      expect(report.warnings).not.toContain(NOT_ISOLATED_WARNING);
      if (asHostUser.length)
        expect(statSync(join(out, 'report.json')).uid).toBe(process.getuid?.());
      expect(report.engines.find((e) => e.name === 'verapdf')).toMatchObject({
        version: '1.30.3',
        runner: 'local',
      });
      // Same results as the corpus expectations (scanned with the Docker runner).
      for (const pdf of PDFS) {
        const expected = JSON.parse(
          readFileSync(join(CORPUS, 'expected', 'pdf', `${pdf}.json`), 'utf8'),
        ) as {
          expected: { engine: string; ruleId: string; outcome: string; provisional?: boolean }[];
        };
        const uri = `pdf/${pdf}.pdf`;
        const actual = new Set([
          ...report.findings
            .filter((f) => f.asset.uri === uri)
            .map((f) => `${f.source.engine} ${f.source.ruleId} ${f.outcome}`),
          ...report.informational
            .filter((i) => i.uri === uri)
            .map((i) => `${i.engine} ${i.ruleId} ${i.outcome}`),
        ]);
        const missing = expected.expected
          .filter((e) => e.engine !== 'axe-core' && !e.provisional)
          .map((e) => `${e.engine} ${e.ruleId} ${e.outcome}`)
          .filter((k) => !actual.has(k));
        expect(missing, pdf).toEqual([]);
      }
    },
    TIMEOUT,
  );
});
