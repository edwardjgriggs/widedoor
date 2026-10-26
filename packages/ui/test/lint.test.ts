import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

/*
 * The viewer may only create text nodes, and the code the browser bundle runs
 * must stay free of Node. The repo's ESLint config enforces both; this checks
 * each ban fires where it should and nowhere else.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: ROOT });

/** The rule ids ESLint reports for the code, linted as the given repo file. */
async function rules(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${file}` });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'parse-error');
}

const UI = 'packages/ui/src/probe.tsx';
const banned = async (code: string, file = UI) =>
  (await rules(code, file)).includes('no-restricted-syntax');
const nodeImport = async (code: string, file: string) =>
  (await rules(code, file)).includes('@typescript-eslint/no-restricted-imports');

// Loading the config and the TypeScript parser takes seconds the first time.
beforeAll(() => rules('export {};', UI), 120_000);

describe('the UI lint ban on HTML sinks', () => {
  it.each([
    'export const A = (p: { s: string }) => <div dangerouslySetInnerHTML={{ __html: p.s }} />;',
    "import { createElement } from 'react';\nexport const a = (s: string) => createElement('div', { dangerouslySetInnerHTML: { __html: s } });",
    "export const a = (s: string) => ({ ['dangerouslySetInnerHTML']: { __html: s } });",
    'export function f(e: HTMLElement, s: string) { e.innerHTML = s; }',
    "export function f(e: HTMLElement, s: string) { e['innerHTML'] = s; }",
    'export function f(e: HTMLElement, s: string) { e.outerHTML = s; }',
    "export function f(e: HTMLElement, s: string) { e.insertAdjacentHTML('beforeend', s); }",
    'export function f(s: string) { document.write(s); }',
    'export function f(s: string) { document.writeln(s); }',
    'export function f(s: string) { return document.createRange().createContextualFragment(s); }',
    'export function f(e: HTMLElement, s: string) { e.setHTMLUnsafe(s); }',
    'export function f(s: string) { return Document.parseHTMLUnsafe(s); }',
    "export function f(s: string) { return new DOMParser().parseFromString(s, 'text/html'); }",
    "export function f(s: string) { document.execCommand('insertHTML', false, s); }",
    'export const A = (p: { s: string }) => <iframe title="x" srcDoc={p.s} />;',
    'export const A = () => <iframe title="x" />;',
    'export const A = () => <script />;',
    'export const A = (p: { s: string }) => <a href={p.s}>x</a>;',
    'export const A = (p: { s: string }) => <img src={p.s} alt="" />;',
  ])('refuses %s', async (code) => {
    expect(await banned(code)).toBe(true);
  });

  it.each([
    'export function f(s: string) { return eval(s); }',
    "export function f(s: string) { return new Function('x', s); }",
    "export function f() { setTimeout('alert(1)', 1); }",
  ])('refuses code from strings: %s', async (code) => {
    const found = await rules(code, UI);
    expect(found.some((r) => ['no-eval', 'no-new-func', 'no-implied-eval'].includes(r))).toBe(true);
  });

  it('allows text rendering', async () => {
    expect(
      await banned('export const A = (p: { s: string }) => <div title={p.s}>{p.s}</div>;'),
    ).toBe(false);
    expect(
      await banned('export function f(e: HTMLElement, s: string) { e.textContent = s; }'),
    ).toBe(false);
  });

  it('applies to packages/ui only', async () => {
    const code = 'export function f(e: HTMLElement, s: string) { e.innerHTML = s; }';
    expect(await banned(code, 'packages/report/src/probe.ts')).toBe(false);
    expect(await banned(code, 'packages/ui/test/probe.ts')).toBe(true);
  });
});

describe('the lint ban on Node in browser code', () => {
  it.each([
    ["import { readFileSync } from 'node:fs';\nexport const r = readFileSync;", UI],
    ["import { join } from 'path';\nexport const j = join;", UI],
    ["import { parse } from 'yaml';\nexport const p = parse;", UI],
    [
      "import { loadStandardsData } from '@widedoor/core';\nexport const l = loadStandardsData;",
      UI,
    ],
    ["import { renderHtml } from '@widedoor/report';\nexport const r = renderHtml;", UI],
    [
      "import { createHash } from 'node:crypto';\nexport const c = createHash;",
      'packages/report/src/view.ts',
    ],
    ["import { parse } from 'yaml';\nexport const p = parse;", 'packages/report/src/plain-data.ts'],
    [
      "import { loadPlainData } from './plain.js';\nexport const l = loadPlainData;",
      'packages/report/src/summary.ts',
    ],
    [
      "import { ScreenshotLoader } from './evidence.js';\nexport const s = ScreenshotLoader;",
      'packages/report/src/browser.ts',
    ],
    [
      "import { findingId } from './finding-id.js';\nexport const f = findingId;",
      'packages/core/src/schema.ts',
    ],
    [
      "import { loadStandardsData } from './data.js';\nexport const l = loadStandardsData;",
      'packages/core/src/rollup.ts',
    ],
  ])('refuses %s in %s', async (code, file) => {
    expect(await nodeImport(code, file)).toBe(true);
  });

  it('allows type-only imports and the Node entries themselves', async () => {
    expect(
      await nodeImport(
        "import type { StandardsData } from './data.js';\nexport type S = StandardsData;",
        'packages/core/src/rollup.ts',
      ),
    ).toBe(false);
    expect(
      await nodeImport(
        "import type { Finding } from '@widedoor/core';\nexport type F = Finding;",
        UI,
      ),
    ).toBe(false);
    expect(
      await nodeImport(
        "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;",
        'packages/report/src/plain.ts',
      ),
    ).toBe(false);
  });
});

describe('lint disables in the viewer', () => {
  /** Every eslint-disable comment under packages/ui/src, with the line it lets through. */
  function disables(): { file: string; comment: string; next: string }[] {
    const src = join(ROOT, 'packages', 'ui', 'src');
    return readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .flatMap((file) => {
        const lines = readFileSync(join(src, file), 'utf8').split(/\r?\n/);
        return lines.flatMap((line, i) =>
          line.includes('eslint-disable')
            ? [{ file, comment: line.trim(), next: (lines[i + 1] ?? '').trim() }]
            : [],
        );
      });
  }

  it('are exactly the three checked sinks: SafeLink, the validated screenshot and attachment', () => {
    const found = disables();
    expect(found.map((d) => d.file.replace(/\\/g, '/'))).toEqual([
      'ReportView.tsx',
      'ReportView.tsx',
      'ReportView.tsx',
    ]);
    for (const d of found)
      expect(d.comment).toMatch(/eslint-disable-next-line no-restricted-syntax -- \S/);
    expect(found[0]?.next).toMatch(/^return isWebUrl\(href\) \? <a href=\{href\}>/);
    expect(found[1]?.next).toMatch(/^<img className="shot" src=\{image\.dataUri\}/);
    expect(found[2]?.next).toMatch(/^<img key=\{i\} className="shot" src=\{image\.dataUri\}/);
  });

  it('are reported when they no longer suppress anything', async () => {
    const [result] = await eslint.lintText(
      '// eslint-disable-next-line no-restricted-syntax -- nothing here\nexport const a = 1;',
      { filePath: `${ROOT}${UI}` },
    );
    expect(result?.messages.map((m) => m.message)).toEqual([
      expect.stringMatching(/Unused eslint-disable directive/),
    ]);
    expect(result?.errorCount).toBe(1);
  });
});
