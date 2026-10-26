import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REVIEW_DIR, getProfile, loadReviews, reviewChecklist, type Asset } from '@widedoor/core';
import { TOKEN_HEADER, buildScanReport, serializeJson } from '@widedoor/report';
import { loadReportFile, startLocalServer } from '@widedoor/server';
import { main, type Io } from '../src/main.ts';

/*
 * widedoor review record and POST /api/reviews of widedoor ui write the same
 * review file at the same time (Task 2.10 review focus 4): both go through
 * recordReview's lock, so the YAML stays whole and no record is lost.
 */

const root = mkdtempSync(join(tmpdir(), 'widedoor-review-race-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TOKEN = 'race-token_0123456789abcdefghijklmnopqrstuvwxyzABCDE';
const A: Asset = {
  kind: 'web',
  uri: 'https://site.example/a',
  contentHash: `sha256:${'a'.repeat(64)}`,
};

const quiet = (): Io => ({ out: () => undefined, err: () => undefined, cwd: root });

function post(port: number, path: string, body: object): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          [TOKEN_HEADER]: TOKEN,
          'content-type': 'application/json',
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => done({ status: res.statusCode ?? 0, text }));
      },
    );
    req.once('error', fail);
    req.end(JSON.stringify(body));
  });
}

describe('a CLI record and a server record at once', () => {
  it('keeps every record of both, in one whole YAML file', async () => {
    const report = buildScanReport({
      profile: getProfile('wcag21aa'),
      startedAt: '2026-10-25T12:00:00.000Z',
      finishedAt: '2026-10-25T12:01:00.000Z',
      toolVersion: '0.0.0',
      scope: { web: { urls: [A.uri], truncated: false } },
      web: {
        engine: { name: 'axe-core', version: '4.14.0' },
        assets: [A],
        findings: [],
        errors: [],
        skipped: [],
        warnings: [],
        truncated: false,
      },
    });
    writeFileSync(join(root, 'report.json'), serializeJson(report));
    // Items on one asset: every record lands in the same review file.
    const items = reviewChecklist(report, [])
      .items.filter((i) => i.asset?.uri === A.uri && i.status === 'open')
      .slice(0, 16);
    expect(items).toHaveLength(16);
    const server = await startLocalServer({
      files: new Map([['/index.html', { body: new Uint8Array(1), type: 'text/html' }]]),
      root: { dir: root },
      current: loadReportFile(join(root, 'report.json'), root),
      token: TOKEN,
      env: {},
    });
    try {
      const results = await Promise.all(
        items.map((item, i) =>
          i % 2 === 0
            ? main(
                [
                  'review',
                  'record',
                  '--report',
                  'report.json',
                  '--item',
                  item.id,
                  '--outcome',
                  'pass',
                  '--reviewer',
                  'CLI',
                ],
                quiet(),
              ).then((code) => ({ by: 'cli', ok: code === 0, detail: String(code) }))
            : post(server.port, '/api/reviews', {
                item: item.id,
                outcome: 'pass',
                reviewer: 'Server',
              }).then((r) => ({ by: 'server', ok: r.status === 201, detail: r.text })),
        ),
      );
      expect(results.filter((r) => !r.ok)).toEqual([]);
    } finally {
      await server.close();
    }
    const files = readdirSync(join(root, REVIEW_DIR)).filter((f) => f.endsWith('.yaml'));
    expect(files).toHaveLength(1);
    // Whole YAML, every record there once.
    const parsed = parse(readFileSync(join(root, REVIEW_DIR, files[0] as string), 'utf8'));
    expect(parsed).toBeTruthy();
    const { reviews } = await loadReviews(root);
    expect(reviews).toHaveLength(items.length);
    const by = (name: string) => reviews.filter((r) => 'review' in r && r.review.reviewer === name);
    expect(by('CLI')).toHaveLength(8);
    expect(by('Server')).toHaveLength(8);
    const done = reviewChecklist(report, reviews).items.filter((i) =>
      items.some((x) => x.id === i.id),
    );
    expect(done.every((i) => i.status === 'done')).toBe(true);
  });
});
