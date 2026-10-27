import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerImagePresent } from '@widedoor/pdf';
import { parseJsonReport } from '@widedoor/report';
import {
  CORPUS,
  ROOT,
  buildCli,
  reportValidator,
  sarifValidator,
  serveHtml,
  type StaticServer,
} from '../../cli/test/helpers.ts';

/*
 * End to end (npm run test:docker; needs Docker with verapdf/cli:v1.30.3 and
 * Chromium): runs the built action entry the way the composite step does,
 * with the inputs in INPUT_* variables, against corpus pages served on
 * 127.0.0.1 and corpus PDFs, then checks the three reports and the outputs.
 */

const TIMEOUT = 300_000;
const ENTRY = join(ROOT, 'packages', 'action', 'dist', 'entry.js');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const PAGES = ['alt-fail.html', 'alt-pass.html', 'contrast-fail.html', 'xss.html'];
const PDFS = ['clean-pdfua.pdf', 'untagged.pdf'];
let site: StaticServer;
let tmp: string;

beforeAll(async () => {
  if (!(await dockerImagePresent()))
    throw new Error(
      'Docker or verapdf/cli:v1.30.3 is missing; run docker pull verapdf/cli:v1.30.3',
    );
  buildCli();
  execFileSync(process.execPath, [TSC, '-b', 'packages/action'], { cwd: ROOT, stdio: 'pipe' });
  site = await serveHtml(join(CORPUS, 'web'));
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-action-e2e-'));
}, TIMEOUT);

afterAll(async () => {
  await site?.close();
  rmSync(tmp, { recursive: true, force: true });
});

function runEntry(env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.once('error', fail);
    child.once('close', (code) => done({ code, stdout, stderr }));
  });
}

/** name<<delimiter blocks, as the entry writes them. */
function readOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^([a-z-]+)<<(\S+)\n([\s\S]*?)\n\2\n/gm))
    out[m[1] as string] = m[3] as string;
  return out;
}

describe('the action entry against the corpus', () => {
  it(
    'scans web pages and PDFs, writes HTML, JSON and SARIF, sets the outputs and exits 1',
    async () => {
      const project = join(tmp, 'workspace');
      mkdirSync(join(project, 'docs'), { recursive: true });
      for (const p of PDFS) copyFileSync(join(CORPUS, 'pdf', p), join(project, 'docs', p));
      const output = join(tmp, 'github-output');
      const r = await runEntry(
        {
          GITHUB_ACTIONS: 'true',
          GITHUB_OUTPUT: output,
          INPUT_URLS: PAGES.map((p) => `${site.origin}/${p}`).join('\n'),
          INPUT_FILES: PDFS.map((p) => `docs/${p}`).join('\n'),
          INPUT_CONFIG: '',
          INPUT_PROFILE: '508+wcag21aa',
          INPUT_FAIL_ON: 'serious',
          INPUT_OUT: 'widedoor-report',
          INPUT_UPLOAD_SARIF: 'true',
        },
        project,
      );
      expect(r.code, r.stderr).toBe(1);
      const [, token] = /^::stop-commands::(widedoor-[0-9a-f-]{36})\n/.exec(r.stdout) ?? [];
      expect(token).toBeDefined();
      expect(r.stdout.trimEnd().endsWith(`::${token}::`)).toBe(true);
      expect(r.stdout).toContain(`Scanned ${PAGES.length + PDFS.length} pages and files`);

      const dir = join(project, 'widedoor-report');
      const outputs = readOutputs(readFileSync(output, 'utf8'));
      expect(outputs).toEqual({
        'exit-code': '1',
        'report-dir': dir,
        'sarif-file': join(dir, 'report.sarif'),
        'overrides-ignored': 'false',
      });
      expect(existsSync(join(dir, '.widedoor-report'))).toBe(true);

      const json = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
      const validate = reportValidator();
      expect(validate(json), JSON.stringify(validate.errors)).toBe(true);
      const report = parseJsonReport(readFileSync(join(dir, 'report.json'), 'utf8'));
      expect(report.errors).toEqual([]);
      expect(report.assets.filter((a) => a.kind === 'web')).toHaveLength(PAGES.length);
      expect(
        report.assets
          .filter((a) => a.kind === 'pdf')
          .map((a) => a.uri)
          .sort(),
      ).toEqual(PDFS.map((p) => `docs/${p}`));

      const sarif = JSON.parse(readFileSync(join(dir, 'report.sarif'), 'utf8'));
      const validateSarif = sarifValidator();
      expect(validateSarif(sarif), JSON.stringify(validateSarif.errors)).toBe(true);
      expect(sarif.runs[0].results.length).toBeGreaterThan(0);

      const html = readFileSync(join(dir, 'report.html'), 'utf8');
      expect(html).toContain('<html');
      expect(html).not.toMatch(/<script/i);
    },
    TIMEOUT,
  );

  it(
    'exits 0 with fail-on none, and 2 with nothing to scan',
    async () => {
      const project = join(tmp, 'none');
      mkdirSync(project, { recursive: true });
      const output = join(tmp, 'github-output-none');
      const ok = await runEntry(
        {
          GITHUB_OUTPUT: output,
          INPUT_URLS: `${site.origin}/alt-fail.html`,
          INPUT_FILES: '',
          INPUT_FAIL_ON: 'none',
          INPUT_UPLOAD_SARIF: 'false',
        },
        project,
      );
      expect(ok.code, ok.stderr).toBe(0);
      expect(readOutputs(readFileSync(output, 'utf8'))).toMatchObject({
        'exit-code': '0',
        'sarif-file': '',
      });

      const empty = await runEntry(
        { GITHUB_OUTPUT: output, INPUT_URLS: '', INPUT_FILES: '' },
        project,
      );
      expect(empty.code).toBe(2);
      expect(empty.stderr).toContain('nothing to scan');
    },
    TIMEOUT,
  );
});
