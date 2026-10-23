import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FindingSchema, findingId, getProfile, type Asset } from '@widedoor/core';
import { buildScanReport, serializeJson, type ScanReport } from '@widedoor/report';
import { UsageError, parseCommand } from '../src/args.ts';
import { main, type Io } from '../src/main.ts';
import { findOnPath } from '@widedoor/pdf';
import {
  ReportFileError,
  URL_HANDLER,
  browserCommand,
  reportBody,
  rundll32Path,
  uiDistDir,
} from '../src/ui.ts';
import { SECURITY_HEADERS, loadStaticFiles, startUiServer } from '../src/ui-server.ts';

/*
 * widedoor ui up to the point where it serves: arguments, the report body
 * (validated report plus screenshots through the containment loader), the
 * browser command and the refusals. The browser suite runs the whole command.
 */

const root = mkdtempSync(join(tmpdir(), 'widedoor-uicmd-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

function io(cwd = root) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { out: (l) => void out.push(l), err: (l) => void err.push(l), cwd };
  return { io: value, out, err };
}

const PAGE: Asset = {
  kind: 'web',
  uri: 'https://example.com/',
  contentHash: `sha256:${'a'.repeat(64)}`,
};

/** A one-page report with one failed check per screenshot path. */
function sampleReport(screenshots: string[] = []): ScanReport {
  const findings = screenshots.map((screenshot, i) => {
    const location = { selector: `img#e${i}` };
    return FindingSchema.parse({
      schemaVersion: 1,
      id: findingId(PAGE.uri, location, 'axe-core', 'image-alt'),
      asset: PAGE,
      location,
      source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId: 'image-alt' },
      criteria: { wcag: ['1.1.1'] },
      outcome: 'fail',
      impact: 'critical',
      evidence: { screenshot },
    });
  });
  return buildScanReport({
    profile: getProfile('wcag21aa'),
    startedAt: '2026-10-22T12:00:00.000Z',
    finishedAt: '2026-10-22T12:01:00.000Z',
    toolVersion: '0.0.0',
    scope: { web: { urls: [PAGE.uri], truncated: false } },
    web: {
      engine: { name: 'axe-core', version: '4.14.0' },
      assets: [PAGE],
      findings,
      errors: [],
      skipped: [],
      warnings: [],
      truncated: false,
      pages: [{ asset: PAGE, title: 'Home' }],
    },
  });
}

let n = 0;
/** A report folder as widedoor scan writes it: report.json and evidence/. */
function reportFolder(report: ScanReport = sampleReport()): string {
  const dir = join(root, `r${n++}`);
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'report.json'), serializeJson(report));
  return dir;
}

describe('widedoor ui arguments', () => {
  it('parses the command and its two options', () => {
    expect(parseCommand(['ui'])).toEqual({ command: 'ui', open: true });
    expect(parseCommand(['ui', '--report', 'out/report.json', '--no-open'])).toEqual({
      command: 'ui',
      report: 'out/report.json',
      open: false,
    });
  });

  it.each([
    [['ui', 'out/report.json'], /takes no targets/],
    [['ui', '--profile', '508'], /--profile is not an option of widedoor ui/],
    [['ui', '--out', 'x'], /--out is not an option of widedoor ui/],
    [['ui', '--report', ''], /--report needs a file/],
    [['scan', '--report', 'r.json'], /--report is an option of widedoor ui/],
    [['scan', '--no-open'], /--no-open is an option of widedoor ui/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
    expect(() => parseCommand(argv)).toThrow(message);
  });
});

describe('browserCommand', () => {
  const url = 'http://127.0.0.1:51234/?code=AbC_d-9';
  const found = (path: string | undefined) => () => path;

  it('opens the URL on Windows with System32 rundll32.exe by absolute path, never by bare name', () => {
    // url.dll's FileProtocolHandler keeps the query string; explorer.exe drops such a URL.
    expect(URL_HANDLER).toBe('url.dll,FileProtocolHandler');
    expect(browserCommand(url, 'win32', found(undefined), { SystemRoot: 'D:\\Win' })).toEqual([
      'D:\\Win\\System32\\rundll32.exe',
      ['url.dll,FileProtocolHandler', url],
    ]);
    for (const env of [{}, { SystemRoot: 'relative' }, { SystemRoot: '' }])
      expect(browserCommand(url, 'win32', found(undefined), env)[0]).toBe(
        'C:\\Windows\\System32\\rundll32.exe',
      );
    expect(rundll32Path({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\rundll32.exe');
  });

  it('opens open or xdg-open only from an absolute PATH entry, as one argument', () => {
    expect(browserCommand(url, 'darwin', found('/usr/bin/open'))).toEqual(['/usr/bin/open', [url]]);
    expect(browserCommand(url, 'linux', found('/usr/bin/xdg-open'))).toEqual([
      '/usr/bin/xdg-open',
      [url],
    ]);
    expect(() => browserCommand(url, 'linux', found(undefined))).toThrow(/xdg-open was not found/);
    expect(() => browserCommand(url, 'darwin', found('open'))).toThrow(/open was not found/);
  });

  it('looks the POSIX opener up with the PATH search that skips relative entries', () => {
    const dir = join(root, 'bin');
    mkdirSync(dir, { recursive: true });
    const name = 'widedoor-opener-probe';
    const ext = process.platform === 'win32' ? '.exe' : '';
    writeFileSync(join(dir, `${name}${ext}`), '');
    expect(findOnPath(name, { PATH: ['.', '', dir].join(delimiter) })).toBe(
      join(dir, `${name}${ext}`),
    );
    expect(findOnPath(name, { PATH: ['.', ''].join(delimiter) })).toBeUndefined();
  });

  it.each([
    'http://evil.example/?code=x',
    'http://127.0.0.1:1/?code=x&calc.exe',
    'http://127.0.0.1:1/?code=x" & calc',
    'file:///C:/Windows/System32/calc.exe',
    'http://127.0.0.1:1/?code=',
    'http://127.0.0.1:1/?code=x\n',
    'http://127.0.0.1:1/?token=x',
  ])('refuses %j', (bad) => {
    expect(() => browserCommand(bad, 'win32')).toThrow(/unexpected URL/);
  });
});

describe('uiDistDir', () => {
  it('takes an absolute WIDEDOOR_UI_DIST, refuses a relative one, else resolves @widedoor/ui', () => {
    const abs = join(root, 'other-dist');
    expect(uiDistDir({ WIDEDOOR_UI_DIST: abs })).toBe(abs);
    expect(() => uiDistDir({ WIDEDOOR_UI_DIST: 'dist' })).toThrow(/absolute/);
    expect(uiDistDir({})).toMatch(/[\\/]ui[\\/]dist$/);
  });
});

describe('reportBody', () => {
  it('returns the validated report and its screenshots, loaded only from evidence/', () => {
    const report = sampleReport(['wd_label.png', '../outside.png', 'fake.png', 'wd_label.png']);
    const dir = reportFolder(report);
    writeFileSync(join(dir, 'evidence', 'wd_label.png'), PNG);
    writeFileSync(join(dir, 'evidence', 'fake.png'), 'not a png');
    writeFileSync(join(dir, 'outside.png'), PNG);
    const body = JSON.parse(reportBody(join(dir, 'report.json')));
    expect(body.report).toEqual(JSON.parse(serializeJson(report)));
    expect(body.screenshots).toEqual({
      'wd_label.png': { ok: true, dataUri: `data:image/png;base64,${PNG.toString('base64')}` },
      '../outside.png': {
        ok: false,
        reason: 'the path is not a plain path inside the evidence folder',
      },
      'fake.png': { ok: false, reason: 'the file is not a PNG image' },
    });
  });

  it.each([
    ['not JSON', '{"schemaVersion":', /not valid JSON/],
    ['another JSON file', '{"name":"x"}', /not a Widedoor JSON report at schemaVersion/],
  ])('refuses %s', (_, text, message) => {
    const dir = reportFolder();
    writeFileSync(join(dir, 'report.json'), text);
    expect(() => reportBody(join(dir, 'report.json'))).toThrow(ReportFileError);
    expect(() => reportBody(join(dir, 'report.json'))).toThrow(message);
  });

  it('refuses a folder and a missing file', () => {
    expect(() => reportBody(root)).toThrow(/not a file/);
    expect(() => reportBody(join(root, 'nope.json'))).toThrow(/cannot be read/);
  });
});

describe('widedoor ui refusals', () => {
  it('exits 2 for an unusable report and prints its path escaped', async () => {
    const h = io();
    expect(await main(['ui', '--report', 'no\u001b[31mpe.json', '--no-open'], h.io)).toBe(2);
    expect(h.err.join('\n')).toMatch(/no\\x1b\[31mpe\.json is not usable: it cannot be read/);
    expect(h.err.join('\n')).not.toContain('\u001b');
    expect(h.out).toEqual([]);
  });

  it('names WIDEDOOR_UI_DIST, on stderr, when it is set, and blames it when it is not a build', async () => {
    const before = process.env.WIDEDOOR_UI_DIST;
    process.env.WIDEDOOR_UI_DIST = join(root, 'no-such-dist');
    try {
      const h = io();
      expect(await main(['ui', '--no-open'], h.io)).toBe(2);
      expect(h.err[0]).toContain('serving the viewer from');
      expect(h.err[0]).toContain('(WIDEDOOR_UI_DIST)');
      expect(h.err[1]).toMatch(
        /WIDEDOOR_UI_DIST names .*no-such-dist, which is not a built viewer/,
      );
      expect(h.err.join('\n')).not.toContain('npm run build');
    } finally {
      if (before === undefined) delete process.env.WIDEDOOR_UI_DIST;
      else process.env.WIDEDOOR_UI_DIST = before;
    }
  });
});

describe('malformed requests', () => {
  it('answer 400 with the security headers', async () => {
    const dir = join(root, 'dist');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const server = await startUiServer({ files: loadStaticFiles(dir) });
    try {
      const reply = await new Promise<string>((done, fail) => {
        const socket = connect(server.port, '127.0.0.1', () => socket.write('NOT HTTP\r\n\r\n'));
        let text = '';
        socket.setEncoding('utf8');
        socket.on('data', (c: string) => (text += c));
        socket.on('end', () => done(text));
        socket.once('error', fail);
      });
      expect(reply).toMatch(/^HTTP\/1\.1 400 /);
      for (const [name, value] of Object.entries(SECURITY_HEADERS))
        expect(reply).toContain(`${name}: ${value}\r\n`);
    } finally {
      await server.close();
    }
  });
});
