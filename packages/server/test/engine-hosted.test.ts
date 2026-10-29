import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebScanOptions, WebScanResult } from '@widedoor/web';
import { buildPlan } from '../src/config.ts';
import { performHostedScan, performScan } from '../src/engine.ts';

/*
 * Ledger R5: what the engine hands scanWeb for a CLI-style request (unchanged:
 * an evidence folder, none of the hosted network settings, absolute paths
 * kept) and for a hosted one (the proxy, fetcher and page policy, no evidence
 * folder, every absolute path named by its file name). scanWeb is replaced by
 * a spy that returns one page error quoting a path in the job's stage and a
 * path outside every known folder.
 */

const calls: WebScanOptions[] = [];
let errorText = '';

vi.mock('@widedoor/web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@widedoor/web')>();
  return {
    ...actual,
    scanWeb: async (_scope: unknown, options: WebScanOptions): Promise<WebScanResult> => {
      calls.push(options);
      return {
        engine: { name: 'axe-core', version: '4.14.0' },
        pages: [],
        assets: [],
        findings: [],
        errors: [{ uri: 'https://site.example/', code: 'navigation-failed', message: errorText }],
        skipped: [],
        pdfs: [],
        warnings: [],
        truncated: false,
        scopeGaps: [],
        unscannedListed: 0,
        maxPages: 6,
      };
    },
  };
});

/** A path outside the temp folder, the stage and home: only 'name' mode hides it. */
const OUTSIDE = '/opt/ms-playwright/chromium-1234/chrome-linux/chrome';

describe('the engine and scanWeb (ledger R5)', () => {
  let stage: string;
  beforeAll(() => {
    stage = mkdtempSync(join(tmpdir(), 'widedoor-engine-test-'));
  });
  afterAll(() => rmSync(stage, { recursive: true, force: true }));
  beforeEach(() => {
    calls.length = 0;
    errorText = `net::ERR_FAILED at ${join(stage, 'pdf', 'staged.pdf')} launching ${OUTSIDE}`;
  });

  const plan = () =>
    buildPlan({ targets: ['https://site.example/'], unsafeNoSandbox: false }, undefined, stage);

  it('a CLI request: an evidence folder, no hosted settings, other paths kept', async () => {
    const outcome = await performScan({ plan: plan(), reviews: [], evidenceDir: stage });
    expect(calls).toHaveLength(1);
    const options = calls[0] as WebScanOptions;
    expect(options.evidenceDir).toBe(stage);
    for (const key of [
      'proxy',
      'fetcher',
      'pagePolicy',
      'requestGuard',
      'userAgent',
      'maxPolicySkips',
    ] as const)
      expect(options).not.toHaveProperty(key);
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    // 'keep': the path outside the known folders stays as the CLI's user would see it.
    expect(outcome.report.errors[0]?.message).toContain(OUTSIDE);
  });

  it('a hosted request: the hosted settings, no evidence folder, every path by its name', async () => {
    const fetcher = Object.assign(async () => {
      throw new Error('not used');
    }, {});
    const pagePolicy = async () => 'scan' as const;
    const requestGuard = () => true;
    const outcome = await performHostedScan({
      plan: { ...plan(), reviewDir: stage },
      reviews: [],
      hosted: {
        proxy: { server: 'http://127.0.0.1:3128' },
        requestGuard,
        fetcher,
        userAgent: 'Widedoor test',
        pagePolicy,
        maxPolicySkips: 24,
        pdfMaxPages: 100,
        linkedPdfs: false,
      },
    });
    const options = calls[0] as WebScanOptions;
    expect(options).not.toHaveProperty('evidenceDir');
    expect(options).toMatchObject({
      proxy: { server: 'http://127.0.0.1:3128' },
      userAgent: 'Widedoor test',
      maxPolicySkips: 24,
    });
    expect(options.fetcher).toBe(fetcher);
    expect(options.pagePolicy).toBe(pagePolicy);
    expect(options.requestGuard).toBe(requestGuard);
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    const message = outcome.report.errors[0]?.message ?? '';
    expect(message).toBe('net::ERR_FAILED at pdf/staged.pdf launching chrome');
    expect(message).not.toContain(stage);
  });
});
