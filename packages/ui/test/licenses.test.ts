import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bundledPackages, noticePackages, thirdPartyNotice } from '../licenses.ts';

/*
 * THIRD-PARTY-LICENSES.txt comes from the modules the bundler rendered. A
 * package in the bundle without a license field or file must fail the build.
 */

const root = mkdtempSync(join(tmpdir(), 'widedoor-licenses-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A fake installed package under root/node_modules. */
function pkg(name: string, manifest: Record<string, string>, license?: string): string {
  const dir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...manifest }));
  if (license !== undefined) writeFileSync(join(dir, 'LICENSE'), license);
  return join(dir, 'index.js');
}

const require = createRequire(import.meta.url);
const realId = (name: string) => join(dirname(require.resolve(`${name}/package.json`)), 'index.js');

describe('third-party license notices', () => {
  it('names each npm package with code in the bundle once, and skips our own and virtual modules', () => {
    const a = pkg('alpha', { version: '1.0.0', license: 'MIT' }, 'MIT License\n\nCopyright A');
    const scoped = pkg('@scope/beta', { version: '2.0.0', license: 'ISC' }, 'ISC text');
    const found = bundledPackages([
      '\0virtual:widedoor-data',
      join(root, 'packages', 'report', 'dist', 'model.js'),
      `${a}?commonjs-exports`,
      a.replace(/\\/g, '/'),
      scoped,
    ]);
    expect(found.map((p) => `${p.name} ${p.version} ${p.license}`)).toEqual([
      '@scope/beta 2.0.0 ISC',
      'alpha 1.0.0 MIT',
    ]);
    const notice = thirdPartyNotice([a, scoped]);
    expect(noticePackages(notice)).toEqual(['@scope/beta 2.0.0', 'alpha 1.0.0']);
    expect(notice).toContain('Copyright A');
  });

  it('fails when a bundled package ships no license file', () => {
    const id = pkg('gamma', { version: '1.0.0', license: 'MIT' });
    expect(() => thirdPartyNotice([id])).toThrow(/gamma has no license file/);
  });

  it('fails when a bundled package has no license field', () => {
    const id = pkg('delta', { version: '1.0.0' }, 'some text');
    expect(() => thirdPartyNotice([id])).toThrow(/delta has no license field/);
  });

  it('reads the real packages the viewer bundles', () => {
    const notice = thirdPartyNotice(['react', 'react-dom', 'scheduler', 'zod'].map(realId));
    expect(noticePackages(notice).map((p) => p.split(' ')[0])).toEqual([
      'react',
      'react-dom',
      'scheduler',
      'zod',
    ]);
    expect(notice).toContain('Copyright (c) Meta Platforms, Inc. and affiliates.');
  });
});
