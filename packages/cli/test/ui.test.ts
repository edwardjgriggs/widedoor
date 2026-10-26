import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { UsageError, parseCommand } from '../src/args.ts';
import { main, type Io } from '../src/main.ts';
import { findOnPath } from '@widedoor/pdf';
import { URL_HANDLER, browserCommand, rundll32Path, uiRoot } from '../src/ui.ts';

/*
 * widedoor ui up to the point where it serves: arguments, the root folder,
 * the browser command and the refusals. The report body and the server are
 * @widedoor/server's (its tests); the browser suite runs the whole command.
 */

const root = mkdtempSync(join(tmpdir(), 'widedoor-uicmd-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function io(cwd = root) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { out: (l) => void out.push(l), err: (l) => void err.push(l), cwd };
  return { io: value, out, err };
}

describe('widedoor ui arguments', () => {
  it('parses the command and its four options', () => {
    expect(parseCommand(['ui'])).toEqual({ command: 'ui', open: true });
    expect(
      parseCommand(['ui', '--report', 'out/report.json', '--config', 'w.yaml', '--no-open']),
    ).toEqual({
      command: 'ui',
      report: 'out/report.json',
      config: 'w.yaml',
      open: false,
    });
    expect(parseCommand(['ui', '--root', 'site'])).toEqual({
      command: 'ui',
      root: 'site',
      open: true,
    });
    // --config alone names the config, and its folder is the root.
    expect(parseCommand(['ui', '--config', 'w.yaml'])).toEqual({
      command: 'ui',
      config: 'w.yaml',
      open: true,
    });
    expect(() => parseCommand(['ui', '--config', ''])).toThrow(/--config needs a file/);
    expect(() => parseCommand(['ui', '--root', ''])).toThrow(/--root needs a folder/);
  });

  it.each([
    [['ui', 'out/report.json'], /takes no targets/],
    [['ui', '--profile', '508'], /--profile is not an option of widedoor ui/],
    [['ui', '--out', 'x'], /--out is not an option of widedoor ui/],
    [['ui', '--report', ''], /--report needs a file/],
    [['ui', '--root', 'a', '--config', 'w.yaml'], /takes --root or --config, not both/],
    [['ui', '--config', 'w.yaml', '--root', 'a'], /takes --root or --config, not both/],
    [['scan', '--root', 'a'], /--root is an option of widedoor ui/],
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

describe('uiRoot', () => {
  it('is --root, else the folder of --config, else the working folder', () => {
    const site = join(root, 'site');
    mkdirSync(site, { recursive: true });
    expect(uiRoot({}, site)).toEqual({ dir: site });
    expect(uiRoot({ root: 'site' }, root)).toEqual({ dir: site });
    const config = join(site, 'other.yaml');
    writeFileSync(config, 'web:\n  urls: [https://example.com/]\n');
    expect(uiRoot({ config: 'site/other.yaml' }, root)).toEqual({ dir: site, configFile: config });
    expect(uiRoot({ root: 'nowhere' }, root)).toBeUndefined();
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

  it('exits 2 for --root with --config, with the reason', async () => {
    const h = io();
    expect(await main(['ui', '--root', '.', '--config', 'w.yaml', '--no-open'], h.io)).toBe(2);
    expect(h.err[0]).toBe(
      'widedoor: widedoor ui takes --root or --config, not both: the folder of the config file is the root',
    );
  });

  it('exits 2 for a --root that is not a folder, and for a config that is not usable', async () => {
    writeFileSync(join(root, 'file.txt'), 'x');
    for (const name of ['file.txt', 'missing\u001b[31m']) {
      const h = io();
      expect(await main(['ui', '--root', name, '--no-open'], h.io)).toBe(2);
      expect(h.err[0]).toMatch(/ is not a folder$/);
      expect(h.err.join('\n')).not.toContain('\u001b');
    }
    const bad = join(root, 'bad-config');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'widedoor.config.yaml'), 'nope: 1\n');
    for (const argv of [
      ['ui', '--root', bad, '--no-open'],
      ['ui', '--config', join(bad, 'widedoor.config.yaml'), '--no-open'],
      ['ui', '--config', join(root, 'missing.yaml'), '--no-open'],
    ]) {
      const h = io();
      expect(await main(argv, h.io), argv.join(' ')).toBe(2);
      expect(h.err[0]).toMatch(/ is not usable:$/);
    }
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
