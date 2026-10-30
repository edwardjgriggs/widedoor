import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseJsonReport } from '@widedoor/report';
import { runAgent } from '../src/hosted/agent-bin.ts';
import { makePdf } from '../../pdf/test/fixtures.ts';
import {
  NO_LEAKS,
  PUBLIC_V4,
  SITE,
  agentEnv,
  localPathForms,
  pdfJob,
  redirect,
  scanInLab,
  startControl,
  urlJob,
  type FakeControl,
} from './hosted-fixtures.ts';
import { startLab, type Lab } from '../../web/test/ssrf-fixtures.ts';

/*
 * Hosted PDF scans with veraPDF (npm run test:docker; needs Docker with
 * verapdf/cli:v1.30.3): an upload, the 100-page cap (Review Focus 5), a PDF by
 * URL that redirects to another public host (ledger R25), and agent-bin with
 * the built agent-child.js (npm run build first).
 */

const CDN = 'cdn.example.net';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const builtChild = fileURLToPath(new URL('../dist/hosted/agent-child.js', import.meta.url));

describe('hosted PDF scans', () => {
  let lab: Lab;
  let control: FakeControl | undefined;
  beforeAll(async () => {
    lab = await startLab({ names: { [SITE]: [PUBLIC_V4], [CDN]: [PUBLIC_V4] } });
  });
  afterAll(() => lab.close());
  afterEach(async () => {
    lab.routes.clear();
    await control?.close();
    control = undefined;
  });

  it('scans an uploaded PDF under its name, with no absolute path in the report', async () => {
    const { result } = await scanInLab(lab, pdfJob('Annual report.pdf'), {
      pdf: await makePdf({ pages: 2 }),
    });
    expect(result.status, result.error).toBe('done');
    const report = parseJsonReport(result.reportJson as string);
    expect(report.assets.map((a) => a.uri)).toEqual(['Annual report.pdf']);
    expect(report.scope.pdf?.files).toEqual(['Annual report.pdf']);
    expect(report.findings.length).toBeGreaterThan(0);
    const text = result.reportJson ?? '';
    for (const form of localPathForms([tmpdir(), homedir(), process.cwd(), repo]))
      expect(text).not.toContain(form);
  });

  it('a 101-page PDF fails with too-many-pages', async () => {
    const { result } = await scanInLab(lab, pdfJob(), { pdf: await makePdf({ pages: 101 }) });
    expect(result.status).toBe('failed');
    // The hosted limit in its own words, never the scanner's text (which names maxPages).
    expect(result.error).toBe('the PDF has more than 100 pages, the hosted limit');
    // 100 pages is still in.
    const { result: hundred } = await scanInLab(lab, pdfJob(), {
      pdf: await makePdf({ pages: 100 }),
    });
    expect(hundred.status, hundred.error).toBe('done');
  });

  it('scans a PDF by URL that redirects to another public host, through the proxy', async () => {
    const pdf = await makePdf({ pages: 1 });
    lab.routes.set('/docs/a.pdf', redirect(`http://${CDN}/files/a.pdf`));
    lab.routes.set('/files/a.pdf', (_req, res) =>
      res.writeHead(200, { 'content-type': 'application/pdf' }).end(Buffer.from(pdf)),
    );
    const { result } = await scanInLab(lab, urlJob(`http://${SITE}/docs/a.pdf`));
    expect(result.status, result.error).toBe('done');
    const report = parseJsonReport(result.reportJson as string);
    // The report names where the PDF was found.
    expect(report.assets.map((a) => a.uri)).toEqual([`http://${CDN}/files/a.pdf`]);
    expect(lab.dials.length).toBeGreaterThan(0);
    expect(lab.leaks()).toEqual(NO_LEAKS);
  });

  it('agent-bin runs the built scan child for an upload and sends its report', async () => {
    expect(existsSync(builtChild), 'run npm run build first').toBe(true);
    const pdf = await makePdf({ pages: 1 });
    control = await startControl({ input: pdfJob(), pdf });
    const code = await runAgent({
      env: agentEnv(control),
      child: [process.execPath, builtChild],
      log: () => undefined,
    });
    expect(code).toBe(0);
    const sent = control.results[0] as { status: string; reportJson: string };
    expect(sent.status).toBe('done');
    expect(parseJsonReport(sent.reportJson).assets.map((a) => a.uri)).toEqual(['report.pdf']);
    // The JSON report only (R37).
    expect(Object.keys(sent).sort()).toEqual(['reportJson', 'status']);
  });
});
