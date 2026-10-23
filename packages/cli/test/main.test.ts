import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CLI_VERSION, main, type Io } from '../src/main.ts';

/*
 * main() in process, for every path that ends before a scan starts: help,
 * version, usage and config errors. Scans run in the browser and docker suites.
 */

const root = mkdtempSync(join(tmpdir(), 'widedoor-main-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { out: (l) => void out.push(l), err: (l) => void err.push(l), cwd };
  return { io: value, out, err };
}

let n = 0;
const folder = (files: Record<string, string> = {}) => {
  const dir = join(root, `d${n++}`);
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
};

describe('main', () => {
  it('prints help and the version with exit 0', async () => {
    const h = io(root);
    expect(await main(['--help'], h.io)).toBe(0);
    expect(h.out.join('\n')).toContain('Usage: widedoor scan');
    const v = io(root);
    expect(await main(['--version'], v.io)).toBe(0);
    expect(v.out).toEqual([CLI_VERSION]);
  });

  it('prints usage and exits 2 with no config and no targets', async () => {
    for (const argv of [['scan'], []]) {
      const r = io(folder());
      expect(await main(argv, r.io)).toBe(2);
      expect(r.err.join('\n')).toContain('Usage: widedoor scan');
    }
  });

  it('exits 2 on a bad argument', async () => {
    const r = io(root);
    expect(await main(['scan', 'page.html'], r.io)).toBe(2);
    expect(r.err[0]).toMatch(/local files must be PDFs/);
  });

  it('discovers widedoor.config.yaml and exits 2 on its problems', async () => {
    const dir = folder({
      'widedoor.config.yaml': 'web:\n  urls: [https://example.com/]\nai:\n  enabled: true\n',
    });
    const r = io(dir);
    expect(await main(['scan'], r.io)).toBe(2);
    expect(r.err).toEqual([
      `widedoor: ${join(dir, 'widedoor.config.yaml')} is not usable:`,
      '  ai.enabled: AI fix suggestions are not supported yet; set ai.enabled to false',
    ]);
  });

  it('reads --config relative to the working folder', async () => {
    const dir = folder({ 'conf/w.yaml': 'nope: 1\n' });
    const r = io(dir);
    expect(await main(['scan', '--config', 'conf/w.yaml'], r.io)).toBe(2);
    expect(r.err[1]).toBe('  (top level): unknown key "nope"');
    const missing = io(dir);
    expect(await main(['scan', '--config', 'missing.yaml'], missing.io)).toBe(2);
    expect(missing.err[1]).toBe('  no such file');
  });

  it('exits 2 on a bad review file before any scan starts', async () => {
    const dir = folder({
      'widedoor.config.yaml': 'web:\n  urls: [https://example.com/]\n',
      'widedoor-review/r.yaml': 'outcome: pass\n',
    });
    const r = io(dir);
    expect(await main(['scan'], r.io)).toBe(2);
    expect(r.err[0]).toContain(join('widedoor-review', 'r.yaml'));
  });

  it('escapes control characters from arguments it echoes', async () => {
    const r = io(root);
    expect(await main(['scan', `x${String.fromCharCode(0x1b)}[2J.html`], r.io)).toBe(2);
    expect(r.err[0]).toContain('x\\x1b[2J.html');
  });
});
