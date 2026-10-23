import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseJsonReport } from '@widedoor/report';
import {
  CORPUS,
  alive,
  buildCli,
  descendants,
  envWithoutTools,
  interrupt,
  runCli,
  serveHtml,
  waitFor,
  type StaticServer,
} from './helpers.ts';

/*
 * The built bin as a child process, zero-config (no widedoor.config.yaml):
 * corpus pages served over HTTP on 127.0.0.1, never the internet. No Docker:
 * the PDF case here is the one where veraPDF is missing.
 */

const TIMEOUT = 120_000;
const sandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1' ? ['--unsafe-no-sandbox'] : [];
let site: StaticServer;
let tmp: string;
let hangs = 0;

beforeAll(async () => {
  buildCli();
  site = await serveHtml(join(CORPUS, 'web'), {
    // Sends headers and never finishes the body, so the browser is busy when the interrupt comes.
    '/hang.html': (res) => {
      hangs++;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<!doctype html><html lang="en"><head><title>Hang</title>');
    },
    // Thousands of PDF links, hidden so axe has little to check.
    '/many-pdfs.html': (res) => {
      const links = Array.from({ length: 3_000 }, (_, i) => `<a href="/f/${i}.pdf">f${i}</a>`);
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          `<!doctype html><html lang="en"><head><title>PDFs</title></head><body><main><h1>PDFs</h1><div hidden>${links.join(' ')}</div></main></body></html>`,
        );
    },
  });
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-cli-'));
}, TIMEOUT);

afterAll(async () => {
  await site?.close();
  // Windows can hold a just-closed file for a moment (antivirus, indexer): retry the cleanup.
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const out = (name: string) => join(tmp, name);
const scan = (args: string[], cwd = tmp) => runCli(['scan', ...args, ...sandbox], { cwd });

describe('zero-config scans', () => {
  it(
    'exits 1 on a failed check at or above the threshold and writes every format',
    async () => {
      const r = await scan([`${site.origin}/alt-fail.html`, '--out', out('fail')]);
      expect(r.code, r.stderr).toBe(1);
      expect(r.stdout).toMatch(/Exit 1: \d+ failed checks? at or above serious\./);
      for (const ext of ['html', 'json', 'sarif'])
        expect(existsSync(join(out('fail'), `report.${ext}`))).toBe(true);
      const report = parseJsonReport(readFileSync(join(out('fail'), 'report.json'), 'utf8'));
      expect(report.assets.map((a) => a.uri)).toEqual([`${site.origin}/alt-fail.html`]);
      expect(report.profile.id).toBe('508+wcag21aa');
    },
    TIMEOUT,
  );

  it(
    'exits 0 when the fails are below --fail-on, and with --fail-on none',
    async () => {
      // contrast-fail fails color-contrast, which axe rates serious: below --fail-on critical.
      const below = await scan([
        `${site.origin}/contrast-fail.html`,
        '--out',
        out('c'),
        '--fail-on',
        'critical',
        '--format',
        'json',
      ]);
      const report = parseJsonReport(readFileSync(join(out('c'), 'report.json'), 'utf8'));
      const impacts = report.findings.filter((f) => f.outcome === 'fail').map((f) => f.impact);
      expect(impacts.length).toBeGreaterThan(0);
      expect(impacts).not.toContain('critical');
      expect(below.code, below.stdout).toBe(0);
      expect(below.stdout).toContain('Exit 0: no failed check at or above critical.');
      const none = await scan([
        `${site.origin}/alt-fail.html`,
        '--out',
        out('n'),
        '--fail-on',
        'none',
        '--format',
        'json',
      ]);
      expect(none.code).toBe(0);
      expect(none.stdout).toContain('Exit 0: the fail threshold is off');
      expect(existsSync(join(out('n'), 'report.html'))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'exits 0 for a clean page and for a page with needs-review results only',
    async () => {
      const r = await scan([
        `${site.origin}/alt-pass.html`,
        `${site.origin}/landmarks-fail.html`,
        '--out',
        out('clean'),
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const report = parseJsonReport(readFileSync(join(out('clean'), 'report.json'), 'utf8'));
      expect(report.findings.some((f) => f.outcome === 'needs-review')).toBe(true);
      expect(report.findings.some((f) => f.outcome === 'fail')).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'exits 2 when a page cannot be scanned, after writing the reports',
    async () => {
      const r = await scan([
        `${site.origin}/alt-pass.html`,
        `${site.origin}/missing.html`,
        '--out',
        out('err'),
      ]);
      expect(r.code).toBe(2);
      expect(r.stdout).toContain('Exit 2: 1 scan error');
      const report = parseJsonReport(readFileSync(join(out('err'), 'report.json'), 'utf8'));
      expect(report.errors.map((e) => e.uri)).toEqual([`${site.origin}/missing.html`]);
    },
    TIMEOUT,
  );

  it(
    'lists a PDF given by URL as skipped instead of scanning it',
    async () => {
      const r = await scan([
        `${site.origin}/alt-pass.html`,
        `${site.origin}/doc.pdf`,
        '--out',
        out('pdfurl'),
      ]);
      expect(r.code).toBe(0);
      const report = parseJsonReport(readFileSync(join(out('pdfurl'), 'report.json'), 'utf8'));
      expect(report.skipped).toEqual([
        { uri: `${site.origin}/doc.pdf`, finalUri: `${site.origin}/doc.pdf`, reason: 'pdf-url' },
      ]);
      expect(r.stdout).toContain('(pdf-url)');
      const page = readFileSync(join(out('pdfurl'), 'report.html'), 'utf8');
      expect(page).toContain('Not scanned: PDFs linked by URL are not fetched yet.');
      expect(page).toContain('a PDF link, not fetched (pdf-url)');
      expect(page).not.toContain('it went to');
    },
    TIMEOUT,
  );

  it(
    'exits 2 when the only target is a PDF URL, since nothing was scanned',
    async () => {
      const r = await scan([`${site.origin}/doc.pdf`, '--out', out('pdfonly')]);
      expect(r.code).toBe(2);
      expect(r.stdout).toContain('Exit 2: nothing was scanned.');
    },
    TIMEOUT,
  );

  it(
    'lists 20 skipped PDF links and counts the rest when a page carries thousands',
    async () => {
      const dir = mkdtempSync(join(tmp, 'many-'));
      writeFileSync(
        join(dir, 'widedoor.config.yaml'),
        `web:\n  urls: [${site.origin}/many-pdfs.html]\n  crawl: { maxPages: 3 }\n`,
      );
      const r = await runCli(['scan', '--out', join(dir, 'out'), ...sandbox], { cwd: dir });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout.match(/^Skipped: /gm)).toHaveLength(21);
      expect(r.stdout).toContain('Skipped: 80 more, listed in the JSON report.');
      expect(r.stdout).toContain(
        'Warning: 2900 PDF link(s) were not listed: at most 100 are taken from one page',
      );
      const report = parseJsonReport(readFileSync(join(dir, 'out', 'report.json'), 'utf8'));
      expect(report.skipped).toHaveLength(100);
      expect(report.warnings).toContain(
        '2900 PDF link(s) were not listed: at most 100 are taken from one page',
      );
      const page = readFileSync(join(dir, 'out', 'report.html'), 'utf8');
      expect(
        page.split('80 more skipped pages and files are listed in the JSON report.'),
      ).toHaveLength(3);
    },
    TIMEOUT,
  );
});

describe('page cap', () => {
  it(
    'writes the reports, then exits 2 when web.maxPages leaves listed pages unscanned',
    async () => {
      const project = join(tmp, 'cap');
      mkdirSync(project);
      writeFileSync(
        join(project, 'widedoor.config.yaml'),
        [
          'web:',
          '  maxPages: 1',
          '  urls:',
          `    - ${site.origin}/alt-pass.html`,
          `    - ${site.origin}/title-pass.html`,
          `    - ${site.origin}/language-pass.html`,
          '',
        ].join('\n'),
      );
      const r = await scan(['--out', 'reports'], project);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.stdout).toContain(
        'Exit 2: 2 listed pages were not scanned: the page limit (1) was reached; raise web.maxPages in widedoor.config.yaml.',
      );
      const dir = join(project, 'reports');
      for (const ext of ['html', 'json', 'sarif'])
        expect(existsSync(join(dir, `report.${ext}`))).toBe(true);
      const report = parseJsonReport(readFileSync(join(dir, 'report.json'), 'utf8'));
      expect(report.assets).toHaveLength(1);
      expect(report.scope.web?.maxPages).toBe(1);
      expect(report.scopeGaps).toContain(
        '2 listed page(s) were not scanned: at most 1 pages are scanned per run',
      );
      const sarif = JSON.parse(readFileSync(join(dir, 'report.sarif'), 'utf8'));
      expect(sarif.runs[0].properties.scopeComplete).toBe(false);
    },
    TIMEOUT,
  );
});

describe('report folder', () => {
  /** A link to victim/keep.txt at path: a file symlink where allowed, else a junction to victim. */
  const plantLink = (victim: string, path: string) => {
    try {
      symlinkSync(join(victim, 'keep.txt'), path, 'file');
    } catch {
      symlinkSync(victim, path, 'junction');
    }
  };
  const setup = () => {
    const dir = mkdtempSync(join(tmp, 'links-'));
    const victim = join(dir, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'original');
    return { dir, victim, report: join(dir, 'widedoor-report') };
  };
  const untouched = (victim: string) => {
    expect(readdirSync(victim)).toEqual(['keep.txt']);
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('original');
  };

  it(
    'refuses a link planted at report.json or at evidence/, and leaves the target untouched',
    async () => {
      type Setup = ReturnType<typeof setup>;
      const plants: ((t: Setup) => void)[] = [
        (t) => {
          mkdirSync(t.report);
          plantLink(t.victim, join(t.report, 'report.json'));
        },
        (t) => {
          mkdirSync(t.report);
          symlinkSync(t.victim, join(t.report, 'evidence'), 'junction');
        },
        (t) => symlinkSync(t.victim, t.report, 'junction'),
      ];
      for (const plant of plants) {
        const t = setup();
        plant(t);
        const r = await runCli(['scan', `${site.origin}/alt-fail.html`, ...sandbox], {
          cwd: t.dir,
        });
        expect(r.code).toBe(2);
        expect(r.stderr).toContain('the report folder cannot be used');
        expect(r.stderr).toContain('symbolic link or junction');
        untouched(t.victim);
      }
    },
    TIMEOUT,
  );

  it(
    'exits 2 when the report folder is a file or a report name is a folder',
    async () => {
      const t = setup();
      writeFileSync(t.report, 'a file');
      const file = await runCli(['scan', `${site.origin}/alt-pass.html`, ...sandbox], {
        cwd: t.dir,
      });
      expect(file.code).toBe(2);
      expect(file.stderr).toContain('is not a folder');
      rmSync(t.report);
      mkdirSync(join(t.report, 'report.json'), { recursive: true });
      const folder = await runCli(['scan', `${site.origin}/alt-pass.html`, ...sandbox], {
        cwd: t.dir,
      });
      expect(folder.code).toBe(2);
      expect(folder.stderr).toContain('is a folder, not a report file');
    },
    TIMEOUT,
  );

  it(
    'leaves a user folder alone: --out . next to their own report.html is refused, nothing deleted',
    async () => {
      const t = setup();
      writeFileSync(join(t.dir, 'report.html'), 'my own report');
      const r = await runCli(
        ['scan', `${site.origin}/alt-pass.html`, '--out', '.', '--format', 'json', ...sandbox],
        { cwd: t.dir },
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('has no .widedoor-report marker');
      expect(readFileSync(join(t.dir, 'report.html'), 'utf8')).toBe('my own report');
      expect(existsSync(join(t.dir, '.widedoor-report'))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'clears its own folder on the next run, so no report of an earlier run survives',
    async () => {
      const t = setup();
      const first = await runCli(['scan', `${site.origin}/alt-pass.html`, ...sandbox], {
        cwd: t.dir,
      });
      expect(first.code).toBe(0);
      expect(existsSync(join(t.report, '.widedoor-report'))).toBe(true);
      writeFileSync(join(t.report, '.report.json.0123456789ab.tmp'), 'stale');
      const second = await runCli(
        ['scan', `${site.origin}/alt-pass.html`, '--format', 'json', ...sandbox],
        { cwd: t.dir },
      );
      expect(second.code).toBe(0);
      expect(readdirSync(t.report).sort()).toEqual(['.widedoor-report', 'evidence', 'report.json']);
    },
    TIMEOUT,
  );
});

describe('tool errors', () => {
  it(
    'turns PDFs into scan errors that name the Docker image when no veraPDF exists, and exits 2',
    async () => {
      const r = await runCli(['scan', 'pdf/untagged.pdf', '--out', out('nopdf')], {
        cwd: CORPUS,
        env: envWithoutTools(),
      });
      expect(r.code).toBe(2);
      expect(r.stdout).toContain('verapdf-unavailable');
      expect(r.stdout).toContain('docker pull verapdf/cli:v1.30.3');
      expect(r.stdout).toContain('Start Docker');
      const report = parseJsonReport(readFileSync(join(out('nopdf'), 'report.json'), 'utf8'));
      expect(report.errors).toMatchObject([
        { kind: 'pdf', uri: 'pdf/untagged.pdf', code: 'verapdf-unavailable' },
      ]);
    },
    TIMEOUT,
  );

  it(
    'names the fix when Chromium is not installed',
    async () => {
      const empty = mkdtempSync(join(tmp, 'no-browsers-'));
      const r = await runCli(['scan', `${site.origin}/alt-pass.html`, '--out', out('nochrome')], {
        cwd: tmp,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty },
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(
        'Chromium is not installed. Run "npx playwright install chromium"',
      );
    },
    TIMEOUT,
  );

  it('exits 2 with usage when there is neither a config nor a target', async () => {
    const r = await runCli(['scan'], { cwd: tmp });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Usage: widedoor scan');
  });

  it('exits 2 on a bad config and names the problem', async () => {
    const dir = mkdtempSync(join(tmp, 'cfg-'));
    writeFileSync(
      join(dir, 'widedoor.config.yaml'),
      'web:\n  urls: [ftp://example.com/]\n  craw: {}\n',
    );
    const r = await runCli(['scan'], { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('web.urls[0]: expected an http or https URL');
    expect(r.stderr).toContain('web: unknown key "craw"');
  });
});

describe('interrupt', () => {
  it(
    'closes the browser and exits 2 on an interrupt, leaving no child process behind',
    async () => {
      let children: number[] = [];
      const r = await runCli(
        ['scan', `${site.origin}/hang.html`, '--out', out('int'), ...sandbox],
        {
          cwd: tmp,
          onStart: (child) => {
            void (async () => {
              await waitFor(() => hangs > 0, 60_000, 'the page request');
              children = descendants(child.pid as number);
              interrupt(child);
            })();
          },
        },
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('interrupted');
      expect(children.length).toBeGreaterThan(0);
      await waitFor(() => children.every((pid) => !alive(pid)), 10_000, 'child processes to exit');
      expect(existsSync(join(out('int'), 'report.json'))).toBe(false);
    },
    TIMEOUT,
  );
});
