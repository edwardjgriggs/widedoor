import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WIDEDOOR_PDF_VERSION } from '@widedoor/pdf';
import { WIDEDOOR_VERSION } from '@widedoor/report';
import { ROOT } from './helpers.ts';

/*
 * Widedoor's version lives in several places: the report's tool.version
 * (packages/report), widedoor --version (packages/cli), the Widedoor PDF
 * checks' engine version (packages/pdf) and the image's WIDEDOOR_VERSION
 * build argument. A release bumps them together; this test fails if one is
 * left behind.
 */

const version = (pkg: string) =>
  (JSON.parse(readFileSync(join(ROOT, pkg, 'package.json'), 'utf8')) as { version: string })
    .version;

const PACKAGES = [
  '.',
  'packages/core',
  'packages/web',
  'packages/pdf',
  'packages/report',
  'packages/cli',
  'packages/ui',
  'packages/action',
];

describe('the Widedoor version', () => {
  const expected = version('packages/cli');

  it('is the same in every package.json', () => {
    expect(Object.fromEntries(PACKAGES.map((p) => [p, version(p)]))).toEqual(
      Object.fromEntries(PACKAGES.map((p) => [p, expected])),
    );
  });

  it('is what the report and the PDF checks record', () => {
    expect(WIDEDOOR_VERSION).toBe(expected);
    expect(WIDEDOOR_PDF_VERSION).toBe(expected);
  });

  it('is the default WIDEDOOR_VERSION build argument of the image', () => {
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(
      new RegExp(`^ARG WIDEDOOR_VERSION=${expected.replace(/\./g, '\\.')}$`, 'm'),
    );
  });
});
