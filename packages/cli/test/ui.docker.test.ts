import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { request, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTAINER_LABEL, dockerImagePresent } from '@widedoor/pdf';
import { parseJsonReport } from '@widedoor/report';
import { containerPrefix } from '@widedoor/server';
import {
  CORPUS,
  alive,
  buildCli,
  buildUi,
  descendants,
  serveHtml,
  waitFor,
  type StaticServer,
} from './helpers.ts';
import { startUi as startUiChild, stopUi, type UiChild } from './ui-page.ts';

/*
 * Scan jobs of widedoor ui with the real engine (npm run test:docker; needs
 * Docker with verapdf/cli:v1.30.3 and Chromium): the built bin serves a root
 * folder, and the API, driven over HTTP, scans an uploaded corpus PDF and a
 * corpus page. A cancelled job stops its work: mid PDF no veraPDF container
 * of the server is left, mid page the browser is closed, and no child
 * process of the scan remains either way.
 */

const TIMEOUT = 300_000;
const PDFS = ['clean-pdfua', 'scanned-image-only', 'tagged-broken', 'untagged'];

let site: StaticServer;
let tmp: string;
let dist: string;
// A page that never answers, so a scan of it is still in flight when it is cancelled.
const held: ServerResponse[] = [];
// A PDF that sends its header and then nothing, so its fetch is still in flight when cancelled.
const heldPdf: ServerResponse[] = [];

const labeled = () =>
  spawnSync(
    'docker',
    ['ps', '--all', '--filter', `label=${CONTAINER_LABEL}`, '--format', '{{.Names}}'],
    { encoding: 'utf8' },
  )
    .stdout.split(/\r?\n/)
    .filter(Boolean);

interface Ui extends UiChild {
  token: string;
  /** Processes below the server before any scan (on Windows, its console host). */
  idle: number[];
}

/** Processes below the server that a scan started. */
const scanProcesses = (ui: Ui) =>
  descendants(ui.child.pid as number).filter((p) => !ui.idle.includes(p));

/** Starts the built bin's ui command on a root folder (ui-page.ts) and trades the printed code for the token. */
async function startUi(root: string): Promise<Ui> {
  const ui = await startUiChild(['--root', root], tmp, dist);
  const code = new URL(ui.url).searchParams.get('code') ?? '';
  const session = await call(ui.port, '', 'POST', '/api/session', undefined, {
    'x-widedoor-code': code,
  });
  expect(session.status).toBe(200);
  return {
    ...ui,
    token: (JSON.parse(session.text) as { token: string }).token,
    idle: descendants(ui.child.pid as number),
  };
}

function call(
  port: number,
  token: string,
  method: string,
  path: string,
  body?: Buffer | object,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const raw = body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  return new Promise((done, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-widedoor-token': token,
          ...(raw !== undefined && !Buffer.isBuffer(body)
            ? { 'content-type': 'application/json' }
            : {}),
          ...headers,
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
    req.end(raw);
  });
}

const api = (ui: Ui, method: string, path: string, body?: object) =>
  call(ui.port, ui.token, method, path, body);

async function uploadPdf(ui: Ui, name: string): Promise<string> {
  const r = await call(
    ui.port,
    ui.token,
    'POST',
    `/api/uploads?kind=pdf&name=${name}.pdf`,
    readFileSync(join(CORPUS, 'pdf', `${name}.pdf`)),
    { 'content-type': 'application/pdf' },
  );
  expect(r.status, r.text).toBe(201);
  return (JSON.parse(r.text) as { id: string }).id;
}

interface Job {
  id: string;
  status: string;
  progress: { done: number; known: number; current?: string };
  error?: string;
  report?: unknown;
}

const job = async (ui: Ui, id: string) =>
  JSON.parse((await api(ui, 'GET', `/api/scans/${id}`)).text) as Job;

async function settle(ui: Ui, id: string, timeoutMs = 240_000): Promise<Job> {
  let last: Job | undefined;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    last = await job(ui, id);
    if (last.status !== 'queued' && last.status !== 'running') return last;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`the job did not end: ${JSON.stringify(last)}`);
}

const own = (ui: Ui) =>
  labeled().filter((n) => n.startsWith(`${containerPrefix(ui.child.pid as number)}-`));

beforeAll(async () => {
  if (!(await dockerImagePresent()))
    throw new Error(
      'Docker or verapdf/cli:v1.30.3 is missing; run docker pull verapdf/cli:v1.30.3',
    );
  buildCli();
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-ui-jobs-'));
  dist = join(tmp, 'dist');
  buildUi(dist);
  site = await serveHtml(join(CORPUS, 'web'), {
    '/hang': (res) => void held.push(res),
    '/slow.pdf': (res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' }).write('%PDF-1.7\n');
      heldPdf.push(res);
    },
  });
}, TIMEOUT);

afterAll(async () => {
  for (const res of [...held, ...heldPdf]) res.destroy();
  await site?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('widedoor ui scan jobs', () => {
  it(
    'scans an uploaded PDF, under its name, and a page, and writes nothing under the root',
    async () => {
      const root = join(tmp, 'done');
      mkdirSync(root);
      const ui = await startUi(root);
      try {
        const pdf = await uploadPdf(ui, 'clean-pdfua');
        const page = `${site.origin}/alt-fail.html`;
        const started = await api(ui, 'POST', '/api/scans', { urls: [page], pdfs: [pdf] });
        expect(started.status, started.text).toBe(202);
        const ended = await settle(ui, (JSON.parse(started.text) as Job).id);
        expect(ended.status, ended.error).toBe('done');
        expect(ended.progress).toEqual({ done: 2, known: 2 });
        // The report is the current one, in memory; it reaches disk only as a download.
        const exported = await api(ui, 'GET', '/api/export/json');
        expect(exported.status).toBe(200);
        const report = parseJsonReport(exported.text);
        expect(readdirSync(root)).toEqual([]);
        expect(report.assets.map((a) => a.uri).sort()).toEqual(['clean-pdfua.pdf', page].sort());
        expect(report.engines.find((e) => e.name === 'verapdf')?.runner).toBe('docker');
        expect(own(ui)).toEqual([]);
        // The upload was used up.
        const again = await api(ui, 'POST', '/api/scans', { pdfs: [pdf] });
        expect(again.status).toBe(400);
      } finally {
        await stopUi(ui);
      }
    },
    TIMEOUT,
  );

  it(
    'cancels a job mid PDF: no veraPDF container of the server and no child process is left',
    async () => {
      const root = join(tmp, 'cancel-pdf');
      mkdirSync(root);
      const ui = await startUi(root);
      try {
        const pdfs: string[] = [];
        for (const name of PDFS) pdfs.push(await uploadPdf(ui, name));
        const started = await api(ui, 'POST', '/api/scans', { pdfs });
        const { id } = JSON.parse(started.text) as Job;
        await waitFor(() => own(ui).length > 0, 120_000, 'a veraPDF container');
        const children = scanProcesses(ui);
        expect(children.length).toBeGreaterThan(0);
        expect((await job(ui, id)).progress.current).toMatch(/\.pdf$/);
        const cancel = await api(ui, 'DELETE', `/api/scans/${id}`);
        expect(cancel.status, cancel.text).toBe(202);
        expect((await settle(ui, id, 60_000)).status).toBe('cancelled');
        expect(own(ui)).toEqual([]);
        await waitFor(() => children.every((p) => !alive(p)), 10_000, 'child processes to exit');
        // A cancelled job writes nothing.
        expect(existsSync(join(root, 'widedoor-report'))).toBe(false);
        expect((await api(ui, 'GET', '/api/report')).status).toBe(204);
        // The server goes on: the same uploads can be scanned again.
        expect((await api(ui, 'POST', '/api/scans', { pdfs: pdfs.slice(0, 1) })).status).toBe(202);
      } finally {
        await stopUi(ui);
      }
      // Stopping the server mid scan leaves no container either.
      expect(own(ui)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'cancels a job mid PDF fetch by URL at once, not at the fetch time limit',
    async () => {
      const root = join(tmp, 'cancel-fetch');
      mkdirSync(root);
      const ui = await startUi(root);
      try {
        const slow = `${site.origin}/slow.pdf`;
        const started = await api(ui, 'POST', '/api/scans', { urls: [slow] });
        expect(started.status, started.text).toBe(202);
        const { id } = JSON.parse(started.text) as Job;
        await waitFor(() => heldPdf.length > 0, 120_000, 'the PDF fetch to start');
        expect((await job(ui, id)).progress.current).toBe(slow);
        const t0 = Date.now();
        expect((await api(ui, 'DELETE', `/api/scans/${id}`)).status).toBe(202);
        expect((await settle(ui, id, 30_000)).status).toBe('cancelled');
        // Well short of the 60 s fetch limit.
        expect(Date.now() - t0).toBeLessThan(20_000);
        await waitFor(() => heldPdf.every((r) => r.destroyed), 10_000, 'the fetch to close');
        expect(readdirSync(root)).toEqual([]);
      } finally {
        await stopUi(ui);
      }
    },
    TIMEOUT,
  );

  it(
    'cancels a job mid page: the browser is closed and no Chromium process is left',
    async () => {
      const root = join(tmp, 'cancel-web');
      mkdirSync(root);
      const ui = await startUi(root);
      try {
        const hang = `${site.origin}/hang`;
        const started = await api(ui, 'POST', '/api/scans', { urls: [hang] });
        const { id } = JSON.parse(started.text) as Job;
        await waitFor(() => held.length > 0, 60_000, 'the browser to request the page');
        const children = scanProcesses(ui);
        expect(children.length).toBeGreaterThan(0);
        expect((await job(ui, id)).progress.current).toBe(hang);
        expect((await api(ui, 'DELETE', `/api/scans/${id}`)).status).toBe(202);
        expect((await settle(ui, id, 60_000)).status).toBe('cancelled');
        await waitFor(() => children.every((p) => !alive(p)), 10_000, 'Chromium to exit');
        expect(scanProcesses(ui)).toEqual([]);
        expect(existsSync(join(root, 'widedoor-report'))).toBe(false);
      } finally {
        await stopUi(ui);
      }
    },
    TIMEOUT,
  );
});
