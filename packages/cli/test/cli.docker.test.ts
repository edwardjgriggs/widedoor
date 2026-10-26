import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTAINER_LABEL, dockerImagePresent } from '@widedoor/pdf';
import { DISCLAIMER, parseJsonReport } from '@widedoor/report';
import { containerPrefix } from '@widedoor/server';
import {
  CORPUS,
  alive,
  buildCli,
  descendants,
  interrupt,
  reportValidator,
  runCli,
  sarifValidator,
  serveHtml,
  waitFor,
  type StaticServer,
} from './helpers.ts';

/*
 * End to end (npm run test:docker; needs Docker with verapdf/cli:v1.30.3 and
 * Chromium): one run of the built bin scans the corpus web pages, served on
 * 127.0.0.1, plus the corpus PDFs, writes all three formats and validates each.
 */

const TIMEOUT = 300_000;
const sandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1' ? ['--unsafe-no-sandbox'] : [];
const PDFS = ['clean-pdfua', 'scanned-image-only', 'tagged-broken', 'untagged'];
let site: StaticServer;
let tmp: string;

const labeled = () =>
  spawnSync(
    'docker',
    ['ps', '--all', '--filter', `label=${CONTAINER_LABEL}`, '--format', '{{.Names}}'],
    { encoding: 'utf8' },
  )
    .stdout.split(/\r?\n/)
    .filter(Boolean);

beforeAll(async () => {
  if (!(await dockerImagePresent()))
    throw new Error(
      'Docker or verapdf/cli:v1.30.3 is missing; run docker pull verapdf/cli:v1.30.3',
    );
  buildCli();
  site = await serveHtml(join(CORPUS, 'web'));
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-cli-e2e-'));
}, TIMEOUT);

afterAll(async () => {
  await site?.close();
  rmSync(tmp, { recursive: true, force: true });
});

type Node = DefaultTreeAdapterMap['node'];
const elements = (node: Node, name: string): Node[] => {
  const own = 'tagName' in node && node.tagName === name ? [node] : [];
  const kids = 'childNodes' in node ? node.childNodes.flatMap((c) => elements(c, name)) : [];
  return [...own, ...kids];
};

describe('widedoor scan, web and PDF in one run', () => {
  it(
    'scans the corpus, writes HTML, JSON and SARIF that validate, and exits 1',
    async () => {
      const pages = readdirSync(join(CORPUS, 'web')).filter((f) => f.endsWith('.html'));
      const project = join(tmp, 'project');
      mkdirSync(join(project, 'pdf'), { recursive: true });
      for (const p of PDFS)
        copyFileSync(join(CORPUS, 'pdf', `${p}.pdf`), join(project, 'pdf', `${p}.pdf`));
      // The scope comes from the config: web.urls, plus a PDF glob relative to the config folder.
      writeFileSync(
        join(project, 'widedoor.config.yaml'),
        [
          'profile: 508+wcag21aa',
          'web:',
          '  urls:',
          ...pages.map((p) => `    - ${site.origin}/${p}`),
          'pdf:',
          '  include: ["pdf/*.pdf"]',
          'report:',
          '  formats: [html, json, sarif]',
          '  failOn: serious',
          '',
        ].join('\n'),
      );
      const dir = join(tmp, 'all');
      let pid = 0;
      const r = await runCli(['scan', '--out', dir, '--concurrency', '2', ...sandbox], {
        cwd: project,
        onStart: (c) => (pid = c.pid as number),
      });
      expect(r.code, r.stderr).toBe(1);
      expect(r.stdout).toMatch(/Exit 1: \d+ failed checks at or above serious\./);
      expect(r.stdout).toContain(`Scanned ${pages.length + PDFS.length} pages and files`);

      const json = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
      const validate = reportValidator();
      expect(validate(json), JSON.stringify(validate.errors)).toBe(true);
      const report = parseJsonReport(readFileSync(join(dir, 'report.json'), 'utf8'));
      expect(report.errors).toEqual([]);
      expect(report.assets.filter((a) => a.kind === 'web')).toHaveLength(pages.length);
      expect(
        report.assets
          .filter((a) => a.kind === 'pdf')
          .map((a) => a.uri)
          .sort(),
      ).toEqual(PDFS.map((p) => `pdf/${p}.pdf`));
      expect(report.engines.map((e) => e.name).sort()).toEqual(['axe-core', 'verapdf', 'widedoor']);
      expect(report.engines.find((e) => e.name === 'verapdf')?.runner).toBe('docker');
      expect(report.findings.some((f) => f.asset.kind === 'pdf' && f.outcome === 'fail')).toBe(
        true,
      );

      const sarif = JSON.parse(readFileSync(join(dir, 'report.sarif'), 'utf8'));
      const validateSarif = sarifValidator();
      expect(validateSarif(sarif), JSON.stringify(validateSarif.errors)).toBe(true);
      expect(sarif.runs[0].results.length).toBeGreaterThan(0);

      const html = readFileSync(join(dir, 'report.html'), 'utf8');
      const doc = parse(html);
      expect(elements(doc, 'title')).toHaveLength(1);
      expect(elements(doc, 'script')).toEqual([]);
      expect(html).toContain(DISCLAIMER);
      // Screenshots land in <out>/evidence and the HTML report embeds them from there.
      const shots = readdirSync(join(dir, 'evidence')).filter((f) => f.endsWith('.png'));
      expect(shots.length).toBeGreaterThan(0);
      expect(elements(doc, 'img').length).toBeGreaterThan(0);

      expect(labeled().filter((n) => n.startsWith(`${containerPrefix(pid)}-`))).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'exits 2 when a PDF cannot be scanned, and still writes the reports',
    async () => {
      const dir = join(tmp, 'malformed');
      const r = await runCli(['scan', 'pdf/malformed.pdf', 'pdf/untagged.pdf', '--out', dir], {
        cwd: CORPUS,
      });
      expect(r.code).toBe(2);
      expect(r.stdout).toContain('Scan error: pdf/malformed.pdf: malformed-pdf');
      const report = parseJsonReport(readFileSync(join(dir, 'report.json'), 'utf8'));
      expect(report.errors.map((e) => e.code)).toEqual(['malformed-pdf']);
      expect(report.assets.map((a) => a.uri)).toEqual(['pdf/untagged.pdf']);
    },
    TIMEOUT,
  );

  it(
    'fetches the corpus PDFs by URL (pdf.urls) and matches corpus/expected for each',
    async () => {
      // One URL does not end in .pdf: listed in pdf.urls, only the bytes decide.
      const paths = Object.fromEntries(
        PDFS.map((p) => [p, p === 'clean-pdfua' ? `/reports/${p}` : `/docs/${p}.pdf`]),
      );
      const pdfSite = await serveHtml(join(CORPUS, 'web'), {
        ...Object.fromEntries(
          PDFS.map((p) => [
            paths[p] as string,
            (res: ServerResponse) =>
              void res
                .writeHead(200, { 'content-type': 'application/pdf' })
                .end(readFileSync(join(CORPUS, 'pdf', `${p}.pdf`))),
          ]),
        ),
        // An old address of untagged.pdf: its asset is recorded once, under the final URL.
        '/old/untagged': (res: ServerResponse) =>
          void res.writeHead(301, { location: '/docs/untagged.pdf' }).end(),
      });
      try {
        const project = join(tmp, 'by-url');
        mkdirSync(project, { recursive: true });
        const urls = PDFS.map((p) => `${pdfSite.origin}${paths[p]}`);
        // As listed: an upper-case scheme and a fragment, and the redirecting old address,
        // all of which normalize to the URLs above.
        const listed = [
          ...urls.map((u, i) => (i === 0 ? `${u.replace('http:', 'HTTP:')}#page=1` : u)),
          `${pdfSite.origin}/old/untagged`,
        ];
        writeFileSync(
          join(project, 'widedoor.config.yaml'),
          [
            'pdf:',
            '  urls:',
            ...listed.map((u) => `    - ${u}`),
            'report:',
            '  formats: [json]',
            '',
          ].join('\n'),
        );
        const dir = join(tmp, 'by-url-out');
        const r = await runCli(['scan', '--out', dir], { cwd: project });
        expect(r.code, r.stderr).toBe(1);
        const report = parseJsonReport(readFileSync(join(dir, 'report.json'), 'utf8'));
        expect(report.errors).toEqual([]);
        expect(report.skipped).toEqual([]);
        expect(report.assets.map((a) => a.uri)).toEqual(urls);
        for (const [i, name] of PDFS.entries()) {
          const uri = urls[i] as string;
          const bytes = readFileSync(join(CORPUS, 'pdf', `${name}.pdf`));
          expect(report.assets[i]?.contentHash).toBe(
            `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          );
          // corpus/expected, compared as corpus:verify does (compareExact in
          // corpus/scripts/lib/corpus.ts, which sits outside this package's rootDir, so
          // the rule is restated here): every non-provisional expected entry is there,
          // and no fail or needs-review is unexpected.
          const expected: {
            engine: string;
            ruleId: string;
            outcome: string;
            provisional?: boolean;
          }[] = JSON.parse(
            readFileSync(join(CORPUS, 'expected', 'pdf', `${name}.json`), 'utf8'),
          ).expected;
          const key = (e: { engine: string; ruleId: string; outcome: string }) =>
            `${e.engine} ${e.ruleId} ${e.outcome}`;
          const actual = [
            ...report.findings
              .filter((f) => f.asset.uri === uri)
              .map((f) => ({
                engine: f.source.engine,
                ruleId: f.source.ruleId,
                outcome: f.outcome,
              })),
            ...report.informational.filter((x) => x.uri === uri),
          ];
          const got = new Set(actual.map(key));
          const want = new Set(expected.filter((e) => !e.provisional).map(key));
          expect(
            [...want].filter((k) => !got.has(k)),
            `${name}: missing`,
          ).toEqual([]);
          expect(
            actual
              .filter((a) => a.outcome === 'fail' || a.outcome === 'needs-review')
              .map(key)
              .filter((k) => !want.has(k)),
            `${name}: unexpected`,
          ).toEqual([]);
        }
      } finally {
        await pdfSite.close();
      }
    },
    TIMEOUT,
  );
});

describe('lifecycle', () => {
  it(
    'removes leftover containers of dead runs before scanning',
    async () => {
      // A labeled container named for a process that does not exist: what a crashed run leaves.
      const dead = `${containerPrefix(999_999_999)}-leftover`;
      const created = spawnSync(
        'docker',
        ['create', '--label', CONTAINER_LABEL, '--name', dead, 'verapdf/cli:v1.30.3', '--version'],
        { encoding: 'utf8' },
      );
      expect(created.status, created.stderr).toBe(0);
      const r = await runCli(
        ['scan', 'pdf/untagged.pdf', '--out', join(tmp, 'sweep'), '--format', 'json'],
        {
          cwd: CORPUS,
        },
      );
      expect(r.stderr).toContain('removed 1 leftover veraPDF container');
      expect(labeled()).not.toContain(dead);
      expect(r.code).toBe(1);
    },
    TIMEOUT,
  );

  it(
    'stops veraPDF on an interrupt: exits 2 with no container or child process left',
    async () => {
      let pid = 0;
      let children: number[] = [];
      const r = await runCli(
        ['scan', ...PDFS.map((p) => `pdf/${p}.pdf`), '--out', join(tmp, 'int')],
        {
          cwd: CORPUS,
          onStart: (child) => {
            pid = child.pid as number;
            void (async () => {
              await waitFor(
                () => labeled().some((n) => n.startsWith(`${containerPrefix(pid)}-`)),
                120_000,
                'a veraPDF container',
              );
              children = descendants(pid);
              interrupt(child);
            })();
          },
        },
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('interrupted');
      expect(labeled().filter((n) => n.startsWith(`${containerPrefix(pid)}-`))).toEqual([]);
      expect(children.length).toBeGreaterThan(0);
      await waitFor(() => children.every((p) => !alive(p)), 10_000, 'child processes to exit');
    },
    TIMEOUT,
  );
});

describe('pdf.documentType (spec D20)', () => {
  // Under Section 508, a non-web PDF gets the E205.4 exceptions (2.4.1, 2.4.5, 3.2.3, 3.2.4).
  const exceptionRows = (report: ReturnType<typeof parseJsonReport>) =>
    report.rollup.standards
      .filter((s) => s.standard === '508')
      .flatMap((s) => s.criteria)
      .filter((c) => c.assets.some((a) => a.reason === 'profile-not-applicable'))
      .map((c) => c.id)
      .sort();

  for (const [value, rows] of [
    ['non-web', ['2.4.1', '2.4.5', '3.2.3', '3.2.4']],
    ['web', []],
  ] as const)
    it(
      `${value}: the report records it and the 508 view ${rows.length ? 'applies' : 'drops'} the E205.4 exceptions`,
      async () => {
        const project = join(tmp, `doctype-${value}`);
        mkdirSync(join(project, 'pdf'), { recursive: true });
        copyFileSync(join(CORPUS, 'pdf', 'untagged.pdf'), join(project, 'pdf', 'untagged.pdf'));
        writeFileSync(
          join(project, 'widedoor.config.yaml'),
          `profile: '508'\npdf:\n  include: ["pdf/*.pdf"]\n  documentType: ${value}\n`,
        );
        const r = await runCli(['scan', '--out', 'reports', '--format', 'json,sarif'], {
          cwd: project,
        });
        expect(r.code, r.stdout + r.stderr).toBe(1);
        const report = parseJsonReport(
          readFileSync(join(project, 'reports', 'report.json'), 'utf8'),
        );
        expect(report.profile).toEqual({ id: '508', pdfDocumentType: value });
        expect(exceptionRows(report)).toEqual([...rows]);
        const sarif = JSON.parse(readFileSync(join(project, 'reports', 'report.sarif'), 'utf8'));
        expect(sarif.runs[0].properties.pdfDocumentType).toBe(value);
      },
      TIMEOUT,
    );

  it(
    'records a pdf.include that matches nothing as a warning and a scope gap',
    async () => {
      const project = join(tmp, 'no-match');
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'widedoor.config.yaml'), 'pdf:\n  include: ["docs/*.pdf"]\n');
      const r = await runCli(['scan', '--out', 'reports', '--format', 'json'], { cwd: project });
      // Nothing was scanned, so exit 2, but the reports still say why.
      expect(r.code, r.stdout + r.stderr).toBe(2);
      const report = parseJsonReport(readFileSync(join(project, 'reports', 'report.json'), 'utf8'));
      const gap = 'no PDF files matched pdf.include (docs/*.pdf)';
      expect(report.warnings).toContain(gap);
      expect(report.scopeGaps).toEqual([gap]);
    },
    TIMEOUT,
  );
});
