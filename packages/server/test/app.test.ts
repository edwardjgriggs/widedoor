import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  FindingSchema,
  REVIEW_DIR,
  findingId,
  recordReview,
  type Asset,
  type ChecklistItem,
  type ProfileId,
} from '@widedoor/core';
import {
  TOKEN_HEADER,
  WIDEDOOR_VERSION,
  buildAcr,
  parseJsonReport,
  type ScanReport,
} from '@widedoor/report';
import {
  MAX_UPLOADS_IN_FLIGHT,
  SERVER_ERROR,
  startLocalServer,
  type UiServer,
} from '../src/app.ts';
import { JOB_THREW } from '../src/jobs.ts';
import { reportBodyOf } from '../src/report-file.ts';
import type { RecordSummary } from '../src/reviews.ts';
import {
  buildReport,
  type ScanHooks,
  type ScanInputs,
  type ScanOutcome,
  type ScanRequest,
} from '../src/engine.ts';
import { hostTag } from '../src/lifecycle.ts';
import { SECURITY_HEADERS } from '../src/security.ts';
import type { StaticFile } from '../src/static-files.ts';
import { UNUSED_UPLOAD_MS, sweepStaleUploads, type UploadTimer } from '../src/uploads.ts';

// Failures a real file system gives only by chance, on purpose: a review write
// that fails (a locked or read-only widedoor-review/) and a rebuild that throws.
const faults = vi.hoisted(() => ({
  record: undefined as Error | undefined,
  rebuild: undefined as Error | undefined,
  /** Runs while a review is being written (the upload expiry test fires its clock there). */
  during: undefined as (() => void) | undefined,
}));
vi.mock('../src/reviews.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/reviews.ts')>();
  return {
    ...real,
    recordManualReview: (...args: Parameters<typeof real.recordManualReview>) => {
      faults.during?.();
      return faults.record ? Promise.reject(faults.record) : real.recordManualReview(...args);
    },
  };
});
vi.mock('../src/engine.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/engine.ts')>();
  return {
    ...real,
    buildReport: (...args: Parameters<typeof real.buildReport>) => {
      if (faults.rebuild) throw faults.rebuild;
      return real.buildReport(...args);
    },
  };
});
import { MAX_PDF_UPLOAD_BYTES } from '../src/uploads.ts';

/*
 * The widedoor ui API over real loopback sockets, with a stand-in scan
 * engine (the browser and docker suites run the real one): the order of the
 * request checks, uploads, scan jobs and what a job writes, the checklist,
 * review records, attachments and exports.
 */

const TOKEN = 'app-token_0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const tmp = mkdtempSync(join(tmpdir(), 'widedoor-app-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const FILES = new Map<string, StaticFile>([
  ['/index.html', { body: new Uint8Array(Buffer.from('<!doctype html>')), type: 'text/html' }],
]);

/** A whole 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const PDF = Buffer.from('%PDF-1.7\n%%EOF\n');
const SHOT = 'wd_0123456789abcdef.png';

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const A: Asset = { kind: 'web', uri: 'https://site.example/a', contentHash: hash('a') };

/** What a one-page scan found: one contrast fail that has a screenshot. */
function sampleInputs(profile: ProfileId = '508+wcag21aa'): ScanInputs {
  const asset = A;
  const location = { selector: '#low' };
  const fail = FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(asset.uri, location, 'axe-core', 'color-contrast'),
    asset,
    location,
    source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId: 'color-contrast' },
    criteria: { wcag: ['1.4.3'] },
    outcome: 'fail',
    impact: 'serious',
    evidence: { screenshot: SHOT },
  });
  return {
    profile,
    pdfDocumentType: 'non-web',
    startedAt: new Date('2026-10-25T12:00:00.000Z'),
    finishedAt: new Date('2026-10-25T12:01:00.000Z'),
    scope: { web: { urls: [asset.uri], truncated: false } },
    web: {
      engine: { name: 'axe-core', version: '4.14.0' },
      assets: [asset],
      findings: [fail],
      errors: [],
      skipped: [],
      warnings: [],
      truncated: false,
    },
  };
}

/** Its report with no review records applied. */
const sampleReport = (profile?: ProfileId): ScanReport =>
  buildReport(sampleInputs(profile), []).report;

type Engine = (request: ScanRequest, hooks: ScanHooks) => Promise<ScanOutcome>;

/** The stand-in engine: one screenshot, two progress steps, then the report (with the request's reviews). */
const finishes =
  (inputs: ScanInputs = sampleInputs()): Engine =>
  async (req, hooks) => {
    writeFileSync(join(req.evidenceDir, SHOT), PNG);
    hooks.progress?.({ done: 0, known: 1, current: A.uri });
    hooks.progress?.({ done: 1, known: 1 });
    const { report } = buildReport(inputs, req.reviews);
    return { kind: 'done', report, inputs, restricted: false, unscannedListed: 0 };
  };

/** A stand-in engine that runs until its signal fires, then ends cancelled. */
const waitsForCancel: Engine = (req, hooks) =>
  new Promise((done) => {
    if (hooks.signal?.aborted) return done({ kind: 'cancelled' });
    writeFileSync(join(req.evidenceDir, SHOT), PNG);
    hooks.progress?.({ done: 0, known: 2, current: 'https://site.example/\u001b[31m' });
    hooks.signal?.addEventListener('abort', () => done({ kind: 'cancelled' }), { once: true });
  });

const servers: UiServer[] = [];
afterEach(async () => {
  faults.record = undefined;
  faults.rebuild = undefined;
  faults.during = undefined;
  for (const s of servers.splice(0)) await s.close();
});

let n = 0;
interface Setup {
  server: UiServer;
  root: string;
  /** The engine the next scan job runs. */
  engine: { run: Engine; requests: ScanRequest[] };
  /** What the server logged. */
  logs: string[];
}

async function setup(
  options: {
    config?: string;
    current?: boolean;
    maxHeldUploadBytes?: number;
    now?: () => number;
    uploadTimer?: UploadTimer;
  } = {},
): Promise<Setup> {
  const root = join(tmp, `r${n++}`);
  mkdirSync(root, { recursive: true });
  if (options.config !== undefined)
    writeFileSync(join(root, 'widedoor.config.yaml'), options.config);
  const engine: Setup['engine'] = { run: finishes(), requests: [] };
  const logs: string[] = [];
  const report = sampleReport();
  const server = await startLocalServer({
    files: FILES,
    root: { dir: root },
    token: TOKEN,
    env: {},
    log: (line) => void logs.push(line),
    ...(options.now ? { now: options.now } : {}),
    ...(options.uploadTimer ? { uploadTimer: options.uploadTimer } : {}),
    ...(options.maxHeldUploadBytes !== undefined
      ? { maxHeldUploadBytes: options.maxHeldUploadBytes }
      : {}),
    ...(options.current
      ? {
          // As a report file is loaded: no scan inputs.
          current: {
            report,
            body: reportBodyOf(report, join(root, 'no-evidence'), root),
            evidenceDir: join(root, 'no-evidence'),
          },
        }
      : {}),
    performScan: (req, hooks) => {
      engine.requests.push(req);
      return engine.run(req, hooks ?? {});
    },
  });
  servers.push(server);
  return { server, root, engine, logs };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
}

interface CallOptions {
  /** Headers to set; undefined drops a default (host, token, origin, content-type). */
  headers?: Record<string, string | undefined>;
  body?: string | Buffer | object;
}

function call(server: UiServer, method: string, path: string, options: CallOptions = {}) {
  const origin = `http://127.0.0.1:${server.port}`;
  const raw =
    options.body === undefined
      ? undefined
      : typeof options.body === 'string' || Buffer.isBuffer(options.body)
        ? options.body
        : JSON.stringify(options.body);
  const headers: Record<string, string | undefined> = {
    host: `127.0.0.1:${server.port}`,
    [TOKEN_HEADER]: TOKEN,
    ...(method !== 'GET' ? { origin } : {}),
    ...(raw !== undefined && !Buffer.isBuffer(raw) ? { 'content-type': 'application/json' } : {}),
    // As a browser sends it.
    ...(raw !== undefined ? { 'content-length': String(Buffer.byteLength(raw)) } : {}),
    ...options.headers,
  };
  const set = Object.fromEntries(
    Object.entries(headers).filter((e): e is [string, string] => e[1] !== undefined),
  );
  return new Promise<Reply>((done, fail) => {
    const req = request(
      { host: '127.0.0.1', port: server.port, method, path, headers: set, setHost: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          done({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString() });
        });
      },
    );
    req.once('error', (e: NodeJS.ErrnoException) =>
      // The server may close the socket on a body it refused before reading it all.
      e.code === 'ECONNRESET' || e.code === 'EPIPE' ? undefined : fail(e),
    );
    if (raw !== undefined) req.write(raw);
    req.end();
  });
}

const json = (r: Reply) => JSON.parse(r.text);

/** Every file and folder under a folder, with a SHA-256 of each file's bytes. */
const treeOf = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .map((e) => {
        const path = join(e.parentPath, e.name);
        const key = relative(dir, path).split(sep).join('/');
        return [
          key,
          e.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'folder',
        ] as const;
      })
      .sort(([x], [y]) => x.localeCompare(y)),
  );

/** Every file under a folder, as relative paths with forward slashes, sorted. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();

interface JobReply {
  id: string;
  status: string;
  progress: { done: number; known: number; current?: string };
  error?: string;
  report?: ScanReport;
}

async function settle(server: UiServer, id: string): Promise<JobReply> {
  for (let i = 0; i < 500; i++) {
    const job = json(await call(server, 'GET', `/api/scans/${id}`)) as JobReply;
    if (job.status !== 'queued' && job.status !== 'running') return job;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('the job did not end');
}

async function upload(server: UiServer, kind: string, body: Buffer, query = '') {
  return call(server, 'POST', `/api/uploads?kind=${kind}${query}`, {
    body,
    headers: { 'content-type': kind === 'pdf' ? 'application/pdf' : 'image/png' },
  });
}

const expectSecured = (r: Reply) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    expect(r.headers[name], name).toBe(value);
};

describe('request checks', () => {
  it('answers 401 without the token, before any other check', async () => {
    const { server } = await setup();
    for (const [method, path] of [
      ['POST', '/api/scans'],
      ['POST', '/api/reviews'],
      ['POST', '/api/uploads?kind=pdf'],
      ['DELETE', `/api/scans/${'0'.repeat(32)}`],
      ['GET', '/api/checklist'],
      ['GET', '/api/export/json'],
      ['GET', '/api/acr'],
      ['GET', '/api/attachments/x.png'],
    ] as const) {
      const r = await call(server, method, path, {
        headers: {
          [TOKEN_HEADER]: undefined,
          origin: 'https://evil.example',
          'content-type': 'text/plain',
        },
        ...(method === 'POST' ? { body: 'x' } : {}),
      });
      expect(r.status, `${method} ${path}`).toBe(401);
      expectSecured(r);
    }
  });

  it('answers 403 for a foreign or missing Origin on every POST and DELETE', async () => {
    const { server } = await setup();
    for (const origin of [
      'https://evil.example',
      `http://127.0.0.1:${server.port + 1}`,
      `http://localhost:${server.port}`,
      'null',
      undefined,
    ])
      for (const [method, path] of [
        ['POST', '/api/scans'],
        ['POST', '/api/reviews'],
        ['POST', '/api/uploads?kind=pdf'],
        ['DELETE', `/api/scans/${'0'.repeat(32)}`],
      ] as const) {
        const r = await call(server, method, path, {
          headers: { origin, 'content-type': 'text/plain' },
          ...(method === 'POST' ? { body: 'x' } : {}),
        });
        expect(r.status, `${method} ${path} ${origin}`).toBe(403);
        expectSecured(r);
      }
  });

  it('takes the Origin of the Host the page used', async () => {
    const { server } = await setup();
    const r = await call(server, 'POST', '/api/scans', {
      headers: {
        host: `localhost:${server.port}`,
        origin: `http://localhost:${server.port}`,
        'content-type': 'text/plain',
      },
      body: 'x',
    });
    expect(r.status).toBe(415);
  });

  it('answers 415 for a body that is not JSON, then 413 over 1 MiB, then 400 for a bad schema', async () => {
    const { server } = await setup();
    for (const path of ['/api/scans', '/api/reviews']) {
      for (const type of [
        undefined,
        'text/plain',
        'application/x-www-form-urlencoded',
        'multipart/form-data',
      ])
        expect(
          (await call(server, 'POST', path, { headers: { 'content-type': type }, body: '{}' }))
            .status,
          `${path} ${type}`,
        ).toBe(415);
      const big = JSON.stringify({ urls: ['https://site.example/'.padEnd(1024 * 1024, 'x')] });
      expect((await call(server, 'POST', path, { body: big })).status).toBe(413);
      const bad = await call(server, 'POST', path, { body: '{"urls": [' });
      expect(bad.status).toBe(400);
      expect(bad.text).toBe('the body is not valid JSON');
    }
    // A charset parameter is fine.
    const charset = await call(server, 'POST', '/api/scans', {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: { nope: true },
    });
    expect(charset.status).toBe(400);
  });

  it.each([
    [{ nope: 1 }, /unknown key "nope"/],
    [{ urls: ['ftp://site.example/'] }, /expected an http or https URL/],
    [{ urls: ['javascript:alert(1)'] }, /expected an http or https URL/],
    [{ urls: Array.from({ length: 501 }, (_, i) => `https://site.example/${i}`) }, /500/],
    [{ urls: 'https://site.example/' }, /urls/],
    [{ maxPages: 0 }, /maxPages/],
    [{ maxPages: 1.5 }, /maxPages/],
    [{ profile: 'wcag22aa' }, /profile/],
    [{ pdfs: ['../../etc/passwd'] }, /upload id/],
  ])('answers 400 with a short message for %j', async (body, message) => {
    const { server } = await setup();
    const r = await call(server, 'POST', '/api/scans', { body });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(message);
    expect(r.text).not.toMatch(/\n\s+at /);
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('answers 400 for maxPages over the config page cap, naming the cap', async () => {
    const { server } = await setup({
      config: 'web:\n  urls: [https://site.example/]\n  maxPages: 5\n',
    });
    const r = await call(server, 'POST', '/api/scans', { body: { maxPages: 6 } });
    expect(r.status).toBe(400);
    expect(r.text).toBe('maxPages must be at most 5 (web.maxPages in the config)');
  });

  it('answers 404 for an unknown API path, with the headers', async () => {
    const { server } = await setup();
    const r = await call(server, 'GET', '/api/nope');
    expect(r.status).toBe(404);
    expectSecured(r);
  });
});

describe('uploads', () => {
  it('stores a PDF under a random 128-bit id, with an optional plain name', async () => {
    const { server } = await setup();
    const r = await upload(server, 'pdf', PDF, '&name=Annual-Report_2026.pdf');
    expect(r.status).toBe(201);
    expect(json(r)).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      kind: 'pdf',
      bytes: PDF.length,
      name: 'Annual-Report_2026.pdf',
    });
    const unnamed = json(await upload(server, 'pdf', PDF));
    expect(unnamed.name).toMatch(/^upload-[0-9a-f]{8}\.pdf$/);
    expect(unnamed.id).not.toBe(json(r).id);
  });

  it('answers 413 for a PDF over 25 MiB and 400 for a file that is not a PDF', async () => {
    const { server } = await setup();
    const big = Buffer.alloc(MAX_PDF_UPLOAD_BYTES + 1, 0x20);
    PDF.copy(big);
    const over = await upload(server, 'pdf', big);
    expect(over.status).toBe(413);
    expect(over.text).toBe('the pdf is over 25 MiB');
    const exact = Buffer.alloc(MAX_PDF_UPLOAD_BYTES, 0x20);
    PDF.copy(exact);
    expect((await upload(server, 'pdf', exact)).status).toBe(201);
    for (const body of [
      Buffer.from('<html>%PDF-'),
      Buffer.from(' %PDF-1.7'),
      Buffer.alloc(0),
      PNG,
    ]) {
      const r = await upload(server, 'pdf', body);
      expect(r.status).toBe(400);
      expect(r.text).toBe('the file is not a PDF (it does not start with %PDF-)');
    }
  });

  it('refuses a PDF name that is not a plain file name', async () => {
    const { server } = await setup();
    for (const name of ['../x.pdf', 'a/b.pdf', 'x.exe', '.x.pdf', 'con.pdf', 'a b.pdf'])
      expect(
        (await upload(server, 'pdf', PDF, `&name=${encodeURIComponent(name)}`)).status,
        name,
      ).toBe(400);
  });

  it('takes images by their bytes, with the review attachment cap', async () => {
    const { server } = await setup();
    expect((await upload(server, 'image', PNG)).status).toBe(201);
    const gif = await upload(server, 'image', Buffer.from('GIF89a'));
    expect(gif.status).toBe(400);
    expect(gif.text).toBe('the file is not a whole PNG or JPEG image');
    // The PNG signature, then markup.
    expect(
      (await upload(server, 'image', Buffer.concat([PNG.subarray(0, 16), Buffer.from('<script>')])))
        .status,
    ).toBe(400);
    expect((await upload(server, 'image', Buffer.alloc(5 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await upload(server, 'image', PNG, '&name=x.pdf')).status).toBe(400);
  });

  it('checks the content type (415) before the kind (400), then that they fit (415)', async () => {
    const { server } = await setup();
    const post = (query: string, type?: string) =>
      call(server, 'POST', `/api/uploads${query}`, {
        body: PDF,
        ...(type ? { headers: { 'content-type': type } } : {}),
      });
    // A type no upload takes is 415 whatever the kind says.
    expect((await post('?kind=exe', 'text/html')).status).toBe(415);
    expect((await post('')).status).toBe(415);
    // A type some upload takes, with no or an unknown kind: 400.
    expect((await post('?kind=exe', 'application/pdf')).status).toBe(400);
    expect((await post('', 'application/octet-stream')).status).toBe(400);
    // A known kind sent as another kind's type: 415.
    const typed = await post('?kind=pdf', 'image/png');
    expect(typed.status).toBe(415);
    expect(typed.text).toBe(
      'a pdf upload must be sent as application/pdf or application/octet-stream',
    );
  });

  it('answers 413 once the uploads held would pass the cap', async () => {
    const { server } = await setup({ maxHeldUploadBytes: PDF.length * 2 });
    expect((await upload(server, 'pdf', PDF)).status).toBe(201);
    expect((await upload(server, 'pdf', PDF)).status).toBe(201);
    const full = await upload(server, 'pdf', PDF);
    expect(full.status).toBe(413);
    expect(full.text).toBe('too many uploads are held; record or scan them first');
  });

  it('deletes an upload nothing used within 15 minutes and frees its bytes, but never one in use', async () => {
    // An injected clock: each timer is held until the test fires it.
    const timers: { fire: () => void; ms: number; live: boolean }[] = [];
    const uploadTimer: UploadTimer = (fire, ms) => {
      const t = { fire, ms, live: true };
      timers.push(t);
      return () => void (t.live = false);
    };
    const elapse = async () => {
      for (const t of timers.splice(0)) if (t.live) t.fire();
      await new Promise((done) => setTimeout(done, 50));
    };
    const { server, engine } = await setup({ maxHeldUploadBytes: 3 * MIB, uploadTimer });
    const big = pdfOf(2 * MIB);
    const { id: old } = json(await upload(server, 'pdf', big));
    expect(timers.map((t) => t.ms)).toEqual([UNUSED_UPLOAD_MS]);
    expect((await upload(server, 'pdf', big)).status).toBe(413);
    await elapse();
    // Expired: gone, and its bytes are free again.
    const scan = await call(server, 'POST', '/api/scans', { body: { pdfs: [old] } });
    expect(scan.status).toBe(400);
    expect(scan.text).toContain(`there is no PDF upload ${old}`);
    const { id: used } = json(await upload(server, 'pdf', big));

    // A running scan claims its upload: firing the clock does not take it away.
    engine.run = waitsForCancel;
    const job = json(await call(server, 'POST', '/api/scans', { body: { pdfs: [used] } }));
    await new Promise((done) => setTimeout(done, 50));
    await elapse();
    await call(server, 'DELETE', `/api/scans/${job.id}`);
    expect((await settle(server, job.id)).status).toBe('cancelled');
    // A cancelled scan hands it back to the clock, so it can be scanned again until it expires.
    expect(timers.filter((t) => t.live)).toHaveLength(1);
    engine.run = finishes();
    const again = json(await call(server, 'POST', '/api/scans', { body: { pdfs: [used] } }));
    expect((await settle(server, again.id)).status).toBe('done');
    expect(timers.filter((t) => t.live)).toEqual([]);
  });

  it('never expires an image a review is writing; one a refused review hands back expires and frees its bytes', async () => {
    const timers: { fire: () => void; live: boolean }[] = [];
    const uploadTimer: UploadTimer = (fire) => {
      const t = { fire, live: true };
      timers.push(t);
      return () => void (t.live = false);
    };
    const elapse = async () => {
      for (const t of timers.splice(0)) if (t.live) t.fire();
      await new Promise((done) => setTimeout(done, 50));
    };
    const { server, root } = await setup({ maxHeldUploadBytes: PNG.length, uploadTimer });
    await scanned(server);
    const item = await openItem(server, '2.1.1');

    // The clock fires while the review is being written: the claimed image is still there.
    const { id: kept } = json(await upload(server, 'image', PNG));
    let liveWhileWriting = -1;
    faults.during = () => {
      liveWhileWriting = timers.filter((t) => t.live).length;
      void elapse();
    };
    const r = await call(server, 'POST', '/api/reviews', {
      body: { item: item.id, outcome: 'pass', reviewer: 'Ann', attachments: [kept] },
    });
    expect(r.status, r.text).toBe(201);
    faults.during = undefined;
    // Claimed: its expiry was stopped before the write began.
    expect(liveWhileWriting).toBe(0);
    expect(
      filesUnder(join(root, 'widedoor-review')).filter((f) => f.endsWith('.png')),
    ).toHaveLength(1);
    expect(timers.filter((t) => t.live)).toEqual([]);

    // A refused review hands its image back to the clock; when it fires, the image is gone and freed.
    const { id: back } = json(await upload(server, 'image', PNG));
    const refused = await call(server, 'POST', '/api/reviews', {
      body: { item: 'ck_0000000000000000', outcome: 'pass', reviewer: 'Ann', attachments: [back] },
    });
    expect(refused.status).toBe(400);
    expect(timers.filter((t) => t.live)).toHaveLength(1);
    expect((await upload(server, 'image', PNG)).status).toBe(413);
    await elapse();
    const gone = await call(server, 'POST', '/api/reviews', {
      body: { item: item.id, outcome: 'pass', reviewer: 'Ann', attachments: [back] },
    });
    expect(gone.status).toBe(400);
    expect(gone.text).toBe(`there is no image upload ${back}`);
    expect((await upload(server, 'image', PNG)).status).toBe(201);
  });

  it('keeps uploads in one private folder and removes it when the server stops', async () => {
    const { server } = await setup();
    const { id } = json(await upload(server, 'pdf', PDF));
    const dirs = readdirSync(tmpdir()).filter((d) => d.startsWith('widedoor-uploads-'));
    const dir = dirs.map((d) => join(tmpdir(), d)).find((d) => existsSync(join(d, `${id}.pdf`)));
    expect(dir).toBeDefined();
    await server.close();
    expect(existsSync(dir as string)).toBe(false);
  });
});

describe('scan jobs', () => {
  it('runs a scan, reports progress and makes the report current, in memory', async () => {
    const { server, root, engine } = await setup();
    expect((await call(server, 'GET', '/api/report')).status).toBe(204);
    const started = await call(server, 'POST', '/api/scans', {
      body: { urls: [A.uri], profile: '508+wcag21aa', maxPages: 3 },
    });
    expect(started.status).toBe(202);
    const view = json(started) as JobReply;
    expect(view).toMatchObject({ status: 'queued', progress: { done: 0, known: 0 } });
    expect(view.id).toMatch(/^[0-9a-f]{32}$/);
    const job = await settle(server, view.id);
    expect(job).toMatchObject({ status: 'done', progress: { done: 1, known: 1 } });
    expect(job.report?.profile.id).toBe('508+wcag21aa');
    // The same defaults as widedoor scan: sandbox on, one page at a time.
    const [req] = engine.requests;
    expect(req?.plan).toMatchObject({
      unsafeNoSandbox: false,
      concurrency: 1,
      profile: '508+wcag21aa',
      web: { urls: [A.uri], maxPages: 3 },
      reviewDir: root,
    });
    // Screenshots go to the job's private work folder, never under the root.
    expect(relative(root, req?.evidenceDir as string).startsWith('..')).toBe(true);
    const current = json(await call(server, 'GET', '/api/report'));
    expect(current.report.assets[0].uri).toBe(A.uri);
    expect(current.screenshots[SHOT]).toMatchObject({ ok: true });
    // Kept while the report is current: the HTML export embeds it.
    expect(existsSync(join(req?.evidenceDir as string, SHOT))).toBe(true);
    const html = await call(server, 'GET', '/api/export/html');
    expect(html.status).toBe(200);
    expect(html.text).toContain('data:image/png;base64,');
  });

  it('writes nothing under the root for a finished job: only a review record does', async () => {
    const { server, root } = await setup({
      config: [
        'web:',
        '  urls: [https://site.example/a]',
        'report:',
        '  formats: [json, html, junit]',
        'acr:',
        '  product: { name: Permit portal }',
        '',
      ].join('\n'),
    });
    const before = filesUnder(root);
    expect(before).toEqual(['widedoor.config.yaml']);
    const { id } = json(await call(server, 'POST', '/api/scans', { body: {} }));
    expect((await settle(server, id)).status).toBe('done');
    for (const format of ['json', 'html', 'openacr', 'vpat-docx'])
      await call(server, 'GET', `/api/export/${format}`);
    expect(filesUnder(root)).toEqual(before);
    const items = json(await call(server, 'GET', '/api/checklist')).items as ChecklistItem[];
    const item = items.find((i) => i.status === 'open');
    const { id: image } = json(await upload(server, 'image', PNG));
    const r = await call(server, 'POST', '/api/reviews', {
      body: { item: item?.id, outcome: 'pass', reviewer: 'Ann', attachments: [image] },
    });
    expect(r.status, r.text).toBe(201);
    const added = filesUnder(root).filter((p) => !before.includes(p));
    expect(added).toHaveLength(2);
    for (const p of added) expect(p.startsWith(`${REVIEW_DIR}/`), p).toBe(true);
    expect(added.filter((p) => p.startsWith(`${REVIEW_DIR}/attachments/`))).toHaveLength(1);
  });

  it.each([
    ['finished', 'done', finishes()],
    [
      'failed',
      'failed',
      (async () => ({
        kind: 'error',
        message: 'the web scan could not run: no browser',
      })) as Engine,
    ],
    ['cancelled', 'cancelled', waitsForCancel],
  ] as const)(
    'leaves the root byte for byte as it was for a %s job, a widedoor-report/ included',
    async (_, status, run) => {
      const { server, root, engine } = await setup({
        config: 'web:\n  urls: [https://site.example/a]\n',
      });
      // A report folder as widedoor scan leaves it, which the server must never touch.
      const out = join(root, 'widedoor-report');
      mkdirSync(join(out, 'evidence'), { recursive: true });
      writeFileSync(join(out, '.widedoor-report'), 'marker');
      writeFileSync(join(out, 'report.json'), '{"old":true}');
      writeFileSync(join(out, 'evidence', SHOT), PNG);
      writeFileSync(join(out, 'notes.txt'), 'mine');
      const before = treeOf(root);
      engine.run = run;
      const { id } = json(await call(server, 'POST', '/api/scans', { body: {} }));
      if (status === 'cancelled') {
        await new Promise((done) => setTimeout(done, 50));
        expect((await call(server, 'DELETE', `/api/scans/${id}`)).status).toBe(202);
      }
      expect((await settle(server, id)).status).toBe(status);
      for (const format of ['json', 'html', 'sarif'])
        await call(server, 'GET', `/api/export/${format}`);
      expect(treeOf(root)).toEqual(before);
    },
  );

  it('escapes the current asset in the progress it reports', async () => {
    const { server, engine } = await setup();
    engine.run = waitsForCancel;
    const { id } = json(await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } }));
    let reply: Reply | undefined;
    for (let i = 0; i < 200; i++) {
      reply = await call(server, 'GET', `/api/scans/${id}`);
      if (json(reply).progress.known === 2) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(reply?.text).not.toContain('\u001b');
    expect(json(reply as Reply).progress.current).toBe('https://site.example/\u001b[31m');
    await call(server, 'DELETE', `/api/scans/${id}`);
    await settle(server, id);
  });

  it('runs one job at a time: a second start is 409', async () => {
    const { server, engine } = await setup();
    engine.run = waitsForCancel;
    const first = json(await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } }));
    const second = await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } });
    expect(second.status).toBe(409);
    expect(second.text).toBe('a scan is already running; wait for it or cancel it');
    await call(server, 'DELETE', `/api/scans/${first.id}`);
    await settle(server, first.id);
    engine.run = finishes();
    expect((await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } })).status).toBe(
      202,
    );
  });

  it('cancels a running job: it writes nothing and leaves the current report alone', async () => {
    const { server, root, engine } = await setup({ current: true });
    engine.run = waitsForCancel;
    const before = (await call(server, 'GET', '/api/report')).text;
    const { id } = json(
      await call(server, 'POST', '/api/scans', { body: { urls: ['https://other.example/'] } }),
    );
    await new Promise((done) => setTimeout(done, 50));
    const cancelled = await call(server, 'DELETE', `/api/scans/${id}`);
    expect(cancelled.status).toBe(202);
    const job = await settle(server, id);
    expect(job.status).toBe('cancelled');
    expect(job.report).toBeUndefined();
    expect(existsSync(join(root, 'widedoor-report'))).toBe(false);
    expect((await call(server, 'GET', '/api/report')).text).toBe(before);
    expect(existsSync(engine.requests[0]?.evidenceDir as string)).toBe(false);
    const again = await call(server, 'DELETE', `/api/scans/${id}`);
    expect(again.status).toBe(409);
    expect(again.text).toBe('the scan has already ended');
  });

  it('answers 404 for an unknown job and keeps only the last one', async () => {
    const { server } = await setup();
    expect((await call(server, 'GET', `/api/scans/${'0'.repeat(32)}`)).status).toBe(404);
    expect((await call(server, 'GET', '/api/scans/..%2F..%2Fetc')).status).toBe(404);
    expect((await call(server, 'DELETE', `/api/scans/${'0'.repeat(32)}`)).status).toBe(404);
    const first = json(await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } }));
    await settle(server, first.id);
    const second = json(await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } }));
    await settle(server, second.id);
    expect((await call(server, 'GET', `/api/scans/${first.id}`)).status).toBe(404);
  });

  it('frees the work folder of a report once another replaces it', async () => {
    const { server, engine } = await setup();
    const first = json(await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } }));
    expect((await settle(server, first.id)).status).toBe('done');
    const kept = engine.requests[0]?.evidenceDir as string;
    expect(existsSync(kept)).toBe(true);
    const second = json(await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } }));
    expect((await settle(server, second.id)).status).toBe('done');
    await expect.poll(() => existsSync(kept)).toBe(false);
    expect(existsSync(engine.requests[1]?.evidenceDir as string)).toBe(true);
  });

  it('fails a job whose review files are not usable, naming the file', async () => {
    const { server, root, engine } = await setup();
    mkdirSync(join(root, REVIEW_DIR));
    writeFileSync(join(root, REVIEW_DIR, 'web-0123456789abcdef.yaml'), 'nope: [\n');
    const { id } = json(await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } }));
    const job = await settle(server, id);
    expect(job.status).toBe('failed');
    // Named relative to the root, never by its absolute path.
    expect(job.error).toMatch(/^widedoor-review\/web-0123456789abcdef\.yaml is not usable: /);
    expect(engine.requests).toEqual([]);
  });

  it('fails a job whose engine reports an error, and leaves the current report alone', async () => {
    const { server, root, engine } = await setup({ current: true });
    engine.run = async () => ({ kind: 'error', message: 'the web scan could not run: no browser' });
    const before = (await call(server, 'GET', '/api/report')).text;
    const { id } = json(await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } }));
    expect(await settle(server, id)).toMatchObject({
      status: 'failed',
      error: 'the web scan could not run: no browser',
    });
    expect((await call(server, 'GET', '/api/report')).text).toBe(before);
    expect(existsSync(join(root, 'widedoor-report'))).toBe(false);
  });

  it('scans uploaded PDFs under their names and deletes the uploads once the job finishes', async () => {
    const { server, engine } = await setup();
    const { id: upload1 } = json(await upload(server, 'pdf', PDF, '&name=brochure.pdf'));
    let staged: string[] = [];
    engine.run = async (req, hooks) => {
      staged = readdirSync(req.plan.pdf?.baseDir as string);
      return finishes()(req, hooks);
    };
    const { id } = json(await call(server, 'POST', '/api/scans', { body: { pdfs: [upload1] } }));
    expect((await settle(server, id)).status).toBe('done');
    expect(engine.requests[0]?.plan.pdf?.files).toEqual(['brochure.pdf']);
    expect(staged).toEqual(['brochure.pdf']);
    const reuse = await call(server, 'POST', '/api/scans', { body: { pdfs: [upload1] } });
    expect(reuse.status).toBe(400);
    expect(reuse.text).toBe(`there is no PDF upload ${upload1}`);
  });

  it('keeps the uploads of a cancelled job, so it can start again', async () => {
    const { server, engine } = await setup();
    const { id: pdf } = json(await upload(server, 'pdf', PDF, '&name=a.pdf'));
    engine.run = waitsForCancel;
    const first = json(await call(server, 'POST', '/api/scans', { body: { pdfs: [pdf] } }));
    await call(server, 'DELETE', `/api/scans/${first.id}`);
    expect((await settle(server, first.id)).status).toBe('cancelled');
    engine.run = finishes();
    const second = json(await call(server, 'POST', '/api/scans', { body: { pdfs: [pdf] } }));
    expect((await settle(server, second.id)).status).toBe('done');
  });

  it('refuses two PDF uploads with one name, and an image upload named as a PDF', async () => {
    const { server } = await setup();
    const a = json(await upload(server, 'pdf', PDF, '&name=same.pdf')).id;
    const b = json(await upload(server, 'pdf', PDF, '&name=SAME.pdf')).id;
    const twice = await call(server, 'POST', '/api/scans', { body: { pdfs: [a, b] } });
    expect(twice.status).toBe(400);
    expect(twice.text).toMatch(/two PDF uploads are named SAME\.pdf/);
    const image = json(await upload(server, 'image', PNG)).id;
    expect((await call(server, 'POST', '/api/scans', { body: { pdfs: [image] } })).status).toBe(
      400,
    );
  });

  it('scans the config scope when the request names nothing, and refuses when there is none', async () => {
    const { server, engine } = await setup({
      config: 'web:\n  urls: [https://config.example/]\n',
    });
    const { id } = json(await call(server, 'POST', '/api/scans', { body: {} }));
    await settle(server, id);
    expect(engine.requests[0]?.plan.web?.urls).toEqual(['https://config.example/']);
    const bare = await setup();
    const none = await call(bare.server, 'POST', '/api/scans', { body: {} });
    expect(none.status).toBe(400);
  });

  it('answers 422 for a config that is not usable', async () => {
    const { server } = await setup({ config: 'nope: 1\n' });
    const r = await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } });
    expect(r.status).toBe(422);
    // Named relative to the root, never by its absolute path.
    expect(r.text).toMatch(/^widedoor\.config\.yaml is not usable: /);
    expect(r.text).not.toContain(tmp);
  });
});

describe('checklist, reviews and attachments', () => {
  async function checklist(server: UiServer) {
    const r = await call(server, 'GET', '/api/checklist');
    expect(r.status, r.text).toBe(200);
    return json(r) as { summary: { total: number }; items: ChecklistItem[]; warnings: string[] };
  }
  const itemFor = (items: ChecklistItem[], id: string) => {
    const found = items.find((i) => i.asset?.uri === A.uri && i.criterion.id === id);
    if (!found) throw new Error(`no item ${id}`);
    return found;
  };

  it('answers 409 without a current report', async () => {
    const { server } = await setup();
    expect((await call(server, 'GET', '/api/checklist')).status).toBe(409);
    const r = await call(server, 'POST', '/api/reviews', {
      body: { item: 'ck_0000000000000000', outcome: 'pass', reviewer: 'Ann' },
    });
    expect(r.status).toBe(409);
  });

  it('records a review with an image upload, lists it as done and serves the attachment', async () => {
    const { server, root } = await setup({ current: true });
    const item = itemFor((await checklist(server)).items, '2.1.1');
    expect(item.status).toBe('open');
    const { id: image } = json(await upload(server, 'image', PNG));
    const r = await call(server, 'POST', '/api/reviews', {
      body: {
        item: item.id,
        outcome: 'pass',
        reviewer: 'Ann Reviewer',
        notes: 'Tabbed through the page.',
        attachments: [image],
      },
    });
    expect(r.status, r.text).toBe(201);
    const recorded = json(r);
    expect(recorded).toMatchObject({
      file: expect.stringMatching(/^widedoor-review\/web-[0-9a-f]{16}\.yaml$/),
      id: expect.stringMatching(/^wd_[0-9a-f]{16}$/),
      asset: { uri: A.uri, kind: 'web' },
      overrides: [],
    });
    expect(readFileSync(join(root, recorded.file), 'utf8')).toContain('reviewer: Ann Reviewer');
    const attachments = readdirSync(join(root, REVIEW_DIR, 'attachments'));
    expect(attachments).toHaveLength(1);
    expect(itemFor((await checklist(server)).items, '2.1.1').status).toBe('done');
    // The upload was used.
    const reused = await call(server, 'POST', '/api/reviews', {
      body: { item: item.id, outcome: 'pass', reviewer: 'Ann', attachments: [image] },
    });
    expect(reused.status).toBe(400);
    const served = await call(server, 'GET', `/api/attachments/${attachments[0]}`);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['content-disposition']).toBe('attachment');
    expect(served.body.equals(PNG)).toBe(true);
    expectSecured(served);
  });

  it('records an override of an automated fail on the same asset', async () => {
    const { server } = await setup({ current: true });
    const report = sampleReport();
    const item = itemFor((await checklist(server)).items, '1.4.3');
    const r = await call(server, 'POST', '/api/reviews', {
      body: {
        item: item.id,
        outcome: 'pass',
        reviewer: 'Ann',
        notes: 'Measured 4.6:1 by hand.',
        overrides: [report.findings[0]?.id],
      },
    });
    expect(r.status, r.text).toBe(201);
    expect(json(r).overrides).toEqual([report.findings[0]?.id]);
  });

  it('answers 400 with the message review record gives, and writes nothing', async () => {
    const { server, root } = await setup({ current: true });
    const item = itemFor((await checklist(server)).items, '2.1.1');
    const unknown = await call(server, 'POST', '/api/reviews', {
      body: { item: 'ck_0000000000000000', outcome: 'pass', reviewer: 'Ann' },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.text).toContain('there is no checklist item ck_0000000000000000');
    const na = await call(server, 'POST', '/api/reviews', {
      body: { item: item.id, outcome: 'not-applicable', reviewer: 'Ann' },
    });
    expect(na.status).toBe(400);
    expect(na.text).toContain('needs --notes');
    const bad = await call(server, 'POST', '/api/reviews', {
      body: { item: item.id, outcome: 'maybe', reviewer: 'Ann' },
    });
    expect(bad.status).toBe(400);
    const pdf = json(await upload(server, 'pdf', PDF)).id;
    const notImage = await call(server, 'POST', '/api/reviews', {
      body: { item: item.id, outcome: 'pass', reviewer: 'Ann', attachments: [pdf] },
    });
    expect(notImage.status).toBe(400);
    expect(notImage.text).toBe(`there is no image upload ${pdf}`);
    expect(existsSync(join(root, REVIEW_DIR))).toBe(false);
  });

  it('serves only plain attachment names from widedoor-review/attachments', async () => {
    const { server, root } = await setup({ current: true });
    mkdirSync(join(root, REVIEW_DIR, 'attachments'), { recursive: true });
    writeFileSync(join(root, REVIEW_DIR, 'secret.png'), PNG);
    writeFileSync(join(root, REVIEW_DIR, 'attachments', 'fake.png'), 'not a png');
    for (const name of [
      '..%2Fsecret.png',
      '%2E%2E%2Fsecret.png',
      'fake.png',
      'missing.png',
      'x.svg',
    ])
      expect((await call(server, 'GET', `/api/attachments/${name}`)).status, name).toBe(404);
  });
});

describe('exports', () => {
  const ACR =
    'web:\n  urls: [https://site.example/a]\nacr:\n  vendor: { name: Example Agency }\n  product: { name: Permit portal }\n';
  const EXPORTS = [
    ['json', 'application/json; charset=utf-8', 'report.json'],
    ['html', 'text/html; charset=utf-8', 'report.html'],
    ['sarif', 'application/sarif+json; charset=utf-8', 'report.sarif'],
    ['junit', 'application/xml; charset=utf-8', 'report.junit.xml'],
    ['openacr', 'application/yaml; charset=utf-8', 'report.openacr.yaml'],
    ['vpat-html', 'text/html; charset=utf-8', 'report.vpat.html'],
    [
      'vpat-docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'report.vpat.docx',
    ],
  ] as const;

  it.each(EXPORTS)('sends %s as an attachment', async (format, type, name) => {
    const { server } = await setup({ config: ACR, current: true });
    const r = await call(server, 'GET', `/api/export/${format}`);
    expect(r.status, r.text).toBe(200);
    expect(r.headers['content-type']).toBe(type);
    expect(r.headers['content-disposition']).toBe(`attachment; filename="${name}"`);
    expect(r.body.length).toBeGreaterThan(0);
    expectSecured(r);
    if (format === 'json') expect(parseJsonReport(r.text).assets[0]?.uri).toBe(A.uri);
    if (format === 'vpat-docx') expect(r.body.subarray(0, 2).toString()).toBe('PK');
    if (format === 'openacr') expect(r.text).toContain('Permit portal');
  });

  it('answers 422 for an ACR without acr.product.name, naming the ACR formats and the config by its root-relative name', async () => {
    const NEEDS = 'the ACR formats (openacr, vpat-html and vpat-docx) need acr.product.name in';
    const { server, root } = await setup({ current: true });
    for (const format of ['openacr', 'vpat-html', 'vpat-docx']) {
      const r = await call(server, 'GET', `/api/export/${format}`);
      expect(r.status).toBe(422);
      expect(r.text).toBe(`${NEEDS} a config file (none was given or found)`);
    }
    expect((await call(server, 'GET', '/api/export/json')).status).toBe(200);
    // With a config that has no acr block: its name relative to the root, never the absolute path.
    writeFileSync(join(root, 'widedoor.config.yaml'), 'web:\n  urls: [https://site.example/a]\n');
    for (const path of ['/api/export/openacr', '/api/acr']) {
      const r = await call(server, 'GET', path);
      expect(r.status).toBe(422);
      expect(r.text).toBe(`${NEEDS} widedoor.config.yaml`);
      expect(r.text).not.toContain(root);
    }
  });

  it('answers 422 for an ACR of a report without the Section 508 view', async () => {
    const { server, engine } = await setup({ config: ACR });
    engine.run = finishes(sampleInputs('wcag21aa'));
    const { id } = json(
      await call(server, 'POST', '/api/scans', { body: { urls: [A.uri], profile: 'wcag21aa' } }),
    );
    await settle(server, id);
    const r = await call(server, 'GET', '/api/export/openacr');
    expect(r.status).toBe(422);
    expect(r.text).toBe(
      'the ACR formats (openacr, vpat-html and vpat-docx) need the Section 508 view, which profile wcag21aa does not have; scan with profile 508 or 508+wcag21aa',
    );
  });

  it('says whether an ACR export would be complete, and why not, as the ACR builder decides', async () => {
    const { server } = await setup({ config: ACR, current: true });
    const r = await call(server, 'GET', '/api/acr');
    expect(r.status, r.text).toBe(200);
    expectSecured(r);
    const want = buildAcr(sampleReport(), {
      vendor: { name: 'Example Agency' },
      product: { name: 'Permit portal' },
    });
    expect(json(r)).toEqual({
      complete: false,
      incomplete: want.incomplete,
      undecided: want.undecided,
    });
    expect(want.incomplete).toEqual(
      expect.arrayContaining([
        'acr.product.description is not set',
        'acr.vendor.contact is not set',
      ]),
    );
  });

  it('answers 422 for the ACR state as for an ACR export, and 409 without a report', async () => {
    const { server } = await setup({ current: true });
    const r = await call(server, 'GET', '/api/acr');
    expect(r.status).toBe(422);
    expect(r.text).toBe((await call(server, 'GET', '/api/export/openacr')).text);
    expect(r.text).toMatch(
      /^the ACR formats \(openacr, vpat-html and vpat-docx\) need acr\.product\.name/,
    );
    const none = await call((await setup({ config: ACR })).server, 'GET', '/api/acr');
    expect(none.status).toBe(409);
    expect(none.text).toBe('there is no report yet; scan or open one first');
  });

  it('answers 404 for an unknown format and 409 without a report', async () => {
    const { server } = await setup();
    expect((await call(server, 'GET', '/api/export/pdf')).status).toBe(404);
    expect((await call(server, 'GET', '/api/export/__proto__')).status).toBe(404);
    const none = await call(server, 'GET', '/api/export/json');
    expect(none.status).toBe(409);
    expect(none.text).toBe('there is no report yet; scan or open one first');
  });
});

const MIB = 1024 * 1024;
/** A PDF upload body of n bytes. */
const pdfOf = (n: number) => {
  const body = Buffer.alloc(n, 0x20);
  PDF.copy(body);
  return body;
};

/** A checklist item as GET /api/checklist sends it, with its record in the review files. */
type RecordedItem = ChecklistItem & { record?: RecordSummary };

async function openItem(server: UiServer, criterion: string): Promise<ChecklistItem> {
  const items = json(await call(server, 'GET', '/api/checklist')).items as ChecklistItem[];
  const item = items.find(
    (i) => i.asset?.uri === A.uri && i.criterion.id === criterion && i.status === 'open',
  );
  if (!item) throw new Error(`no open item for ${criterion}`);
  return item;
}

async function scanned(server: UiServer) {
  const { id } = json(await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } }));
  expect((await settle(server, id)).status).toBe('done');
  return id as string;
}

describe('the held upload cap under parallel uploads', () => {
  it('reserves before the body is read, so parallel uploads never pass the cap', async () => {
    const { server } = await setup({ maxHeldUploadBytes: 10 * MIB });
    const replies = await Promise.all(
      [1, 2, 3, 4].map(() => upload(server, 'pdf', pdfOf(4 * MIB))),
    );
    expect(replies.map((r) => r.status).sort()).toEqual([201, 201, 413, 413]);
    // 8 MiB held. A refused body releases its reservation: exactly the 2 MiB left fit.
    expect((await upload(server, 'pdf', Buffer.alloc(2 * MIB))).status).toBe(400);
    expect((await upload(server, 'pdf', pdfOf(2 * MIB))).status).toBe(201);
    const full = await upload(server, 'pdf', pdfOf(PDF.length));
    expect(full.status).toBe(413);
    expect(full.text).toBe('too many uploads are held; record or scan them first');
  });

  it('reserves the per-kind cap for a body with no length', async () => {
    const { server } = await setup({ maxHeldUploadBytes: 10 * MIB });
    const chunked = await call(server, 'POST', '/api/uploads?kind=pdf', {
      body: PDF,
      headers: { 'content-type': 'application/pdf', 'content-length': undefined },
    });
    expect(chunked.status).toBe(413);
    const image = await call(server, 'POST', '/api/uploads?kind=image', {
      body: PNG,
      headers: { 'content-type': 'image/png', 'content-length': undefined },
    });
    // 5 MiB fits in 10.
    expect(image.status).toBe(201);
  });

  it(`answers 429 to a fifth upload while ${MAX_UPLOADS_IN_FLIGHT} are being read`, async () => {
    const { server, logs } = await setup();
    const size = 64 * 1024;
    const body = pdfOf(size);
    // Uploads whose bodies arrive only when the test says so.
    const open = Array.from({ length: MAX_UPLOADS_IN_FLIGHT }, () => {
      let finish: () => void = () => undefined;
      const reply = new Promise<number>((done, fail) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: server.port,
            method: 'POST',
            path: '/api/uploads?kind=pdf',
            headers: {
              host: `127.0.0.1:${server.port}`,
              origin: `http://127.0.0.1:${server.port}`,
              [TOKEN_HEADER]: TOKEN,
              'content-type': 'application/pdf',
              'content-length': String(size),
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => done(res.statusCode ?? 0));
          },
        );
        req.once('error', fail);
        req.write(body.subarray(0, 16));
        finish = () => req.end(body.subarray(16));
      });
      return { reply, finish: () => finish() };
    });
    await new Promise((done) => setTimeout(done, 300));
    const fifth = await upload(server, 'pdf', pdfOf(size));
    expect(fifth.status).toBe(429);
    expect(fifth.text).toBe(
      `at most ${MAX_UPLOADS_IN_FLIGHT} uploads at once; send this one when another finishes`,
    );
    // Counted as a rate refusal in the refused request log.
    expect(logs).toContain('widedoor ui: refused 1 request (1 rate (429))');
    for (const o of open) o.finish();
    expect(await Promise.all(open.map((o) => o.reply))).toEqual(
      Array(MAX_UPLOADS_IN_FLIGHT).fill(201),
    );
    expect((await upload(server, 'pdf', pdfOf(size))).status).toBe(201);
  });
});

describe('server errors', () => {
  it('logs the cause of a failed review write and answers a fixed 500', async () => {
    const { server, logs } = await setup();
    await scanned(server);
    const item = await openItem(server, '2.1.1');
    faults.record = new Error(
      "EPERM: operation not permitted, open 'C:\\root\\widedoor-review\\web.yaml'\n    at stack",
    );
    const r = await call(server, 'POST', '/api/reviews', {
      body: { item: item.id, outcome: 'pass', reviewer: 'Ann' },
    });
    expect(r.status).toBe(500);
    expect(r.text).toBe(SERVER_ERROR);
    expect(r.text).not.toMatch(/EPERM|widedoor-review|root/);
    expectSecured(r);
    const lines = logs.filter((l) => l.includes('EPERM'));
    expect(lines).toEqual([
      "widedoor ui: POST /api/reviews: EPERM: operation not permitted, open 'C:\\root\\widedoor-review\\web.yaml'",
    ]);
  });
});

describe('reviews recorded through the API (live report)', () => {
  it('rebuilds a scan job report at once: the report, checklist and exports show the review', async () => {
    const { server } = await setup({
      config: 'acr:\n  vendor: { name: Example Agency }\n  product: { name: Permit portal }\n',
    });
    await scanned(server);
    const before = json(await call(server, 'GET', '/api/report'));
    expect(before.reviews).toBe('live');
    const openacr = (await call(server, 'GET', '/api/export/openacr')).text;
    const vpat = (await call(server, 'GET', '/api/export/vpat-html')).text;
    const acr = json(await call(server, 'GET', '/api/acr'));
    const item = await openItem(server, '2.1.1');
    const r = await call(server, 'POST', '/api/reviews', {
      body: { item: item.id, outcome: 'pass', reviewer: 'Ann Reviewer', notes: 'Tabbed through.' },
    });
    expect(r.status, r.text).toBe(201);

    const after = json(await call(server, 'GET', '/api/report'));
    expect(after.reviews).toBe('live');
    // The scan's own times are kept.
    expect(after.report.startedAt).toBe(before.report.startedAt);
    expect(after.report.finishedAt).toBe(before.report.finishedAt);
    const manual = (after.report as ScanReport).findings.filter(
      (f) => f.source.engine === 'manual',
    );
    expect(manual.map((f) => f.id)).toEqual([json(r).id]);
    const done = (json(await call(server, 'GET', '/api/checklist')).items as ChecklistItem[]).find(
      (i) => i.id === item.id,
    );
    expect(done?.status).toBe('done');
    const openacrAfter = (await call(server, 'GET', '/api/export/openacr')).text;
    const vpatAfter = (await call(server, 'GET', '/api/export/vpat-html')).text;
    expect(openacrAfter).not.toBe(openacr);
    expect(vpatAfter).not.toBe(vpat);
    expect(vpatAfter).toContain('Ann Reviewer');
    // The ACR state the Export screen shows counts the review too.
    expect(json(await call(server, 'GET', '/api/acr')).undecided).toBe(acr.undecided - 1);
    const exported = parseJsonReport((await call(server, 'GET', '/api/export/json')).text);
    expect(exported.findings.some((f) => f.id === json(r).id)).toBe(true);
  });

  it('picks up a review widedoor review record wrote, with no API review in between', async () => {
    const { server, root, logs } = await setup({
      config: 'acr:\n  vendor: { name: Example Agency }\n  product: { name: Permit portal }\n',
    });
    await scanned(server);
    const served = json(await call(server, 'GET', '/api/report'));
    // Unchanged files: nothing is rebuilt (a rebuild would fail here and log).
    faults.rebuild = new Error('should not rebuild');
    await call(server, 'GET', '/api/report');
    await call(server, 'GET', '/api/export/json');
    expect(logs.filter((l) => l.includes('could not be rebuilt'))).toEqual([]);
    faults.rebuild = undefined;
    // The CLI's write path: core recordReview on the root folder.
    const item = await openItem(server, '2.1.1');
    const { record } = await recordReview(root, {
      report: served.report as ScanReport,
      item: item.id,
      outcome: 'pass',
      reviewer: 'CLI Reviewer',
      version: WIDEDOOR_VERSION,
    });
    const after = json(await call(server, 'GET', '/api/report'));
    expect(after.reviews).toBe('live');
    expect((after.report as ScanReport).findings.some((f) => f.id === record.id)).toBe(true);
    expect(after.report.finishedAt).toBe(served.report.finishedAt);
    const exported = parseJsonReport((await call(server, 'GET', '/api/export/json')).text);
    expect(exported.findings.some((f) => f.id === record.id)).toBe(true);
    expect((await call(server, 'GET', '/api/export/vpat-html')).text).toContain('CLI Reviewer');

    // A rebuild that fails keeps the report, and is logged once until the files change again.
    const second = await openItem(server, '2.4.2');
    await recordReview(root, {
      report: after.report as ScanReport,
      item: second.id,
      outcome: 'pass',
      reviewer: 'CLI Reviewer',
      version: WIDEDOOR_VERSION,
    });
    faults.rebuild = new Error('the report does not validate');
    const kept = (await call(server, 'GET', '/api/report')).text;
    await call(server, 'GET', '/api/report');
    await call(server, 'GET', '/api/export/json');
    expect(JSON.parse(kept).report.findings.length).toBe(after.report.findings.length);
    expect(logs.filter((l) => l.includes('could not be rebuilt'))).toHaveLength(1);
  });

  it('shows a report file as scanned, unchanged by a review recorded since', async () => {
    const { server, root } = await setup({ current: true });
    const before = await call(server, 'GET', '/api/report');
    expect(json(before).reviews).toBe('as-scanned');
    const exported = (await call(server, 'GET', '/api/export/json')).text;
    const item = await openItem(server, '2.1.1');
    const r = await call(server, 'POST', '/api/reviews', {
      body: { item: item.id, outcome: 'pass', reviewer: 'Ann' },
    });
    expect(r.status, r.text).toBe(201);
    expect(readdirSync(join(root, REVIEW_DIR)).some((f) => f.endsWith('.yaml'))).toBe(true);
    expect((await call(server, 'GET', '/api/report')).text).toBe(before.text);
    expect((await call(server, 'GET', '/api/export/json')).text).toBe(exported);
  });

  it('sends each checklist item the record the review files hold now, not the report copy', async () => {
    const { server } = await setup({ current: true });
    const before = (await call(server, 'GET', '/api/report')).text;
    const item = await openItem(server, '2.1.1');
    const recordOf = async () =>
      (json(await call(server, 'GET', '/api/checklist')).items as RecordedItem[]).find(
        (i) => i.id === item.id,
      )?.record;
    expect(await recordOf()).toBeUndefined();
    for (const [outcome, reviewer] of [
      ['pass', 'Ann'],
      ['fail', 'Bo'],
    ] as const) {
      const r = await call(server, 'POST', '/api/reviews', {
        body: { item: item.id, outcome, reviewer, notes: 'Checked by hand.' },
      });
      expect(r.status, r.text).toBe(201);
    }
    // Bo's fail is the current record; the as-scanned report is unchanged.
    expect(await recordOf()).toEqual({
      outcome: 'fail',
      reviewer: 'Bo',
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      notes: 'Checked by hand.',
      overrides: 0,
      attachments: 0,
      current: true,
    });
    expect((await call(server, 'GET', '/api/report')).text).toBe(before);
  });

  it('sends the record widedoor review record wrote to a live checklist', async () => {
    const { server, root } = await setup();
    await scanned(server);
    const served = json(await call(server, 'GET', '/api/report'));
    const item = await openItem(server, '2.1.1');
    await recordReview(root, {
      report: served.report as ScanReport,
      item: item.id,
      outcome: 'not-applicable',
      reviewer: 'CLI Reviewer',
      notes: 'No keyboard input on this page.',
      version: WIDEDOOR_VERSION,
    });
    const items = json(await call(server, 'GET', '/api/checklist')).items as RecordedItem[];
    const done = items.find((i) => i.id === item.id);
    expect(done?.status).toBe('done');
    expect(done?.record).toMatchObject({
      outcome: 'not-applicable',
      reviewer: 'CLI Reviewer',
      current: true,
    });
    // Only items with a record carry one.
    expect(items.filter((i) => i.record !== undefined)).toHaveLength(1);
  });

  it('keeps the report as it was and logs the cause when a rebuild fails', async () => {
    const { server, logs } = await setup();
    await scanned(server);
    const before = (await call(server, 'GET', '/api/report')).text;
    const item = await openItem(server, '2.1.1');
    faults.rebuild = new Error('the report does not validate');
    const r = await call(server, 'POST', '/api/reviews', {
      body: { item: item.id, outcome: 'pass', reviewer: 'Ann' },
    });
    // The review itself was recorded.
    expect(r.status, r.text).toBe(201);
    expect((await call(server, 'GET', '/api/report')).text).toBe(before);
    expect(logs).toContain(
      'widedoor ui: the report could not be rebuilt with the recorded reviews, so it shows them as before: the report does not validate',
    );
  });

  it('refuses the same image upload named twice', async () => {
    const { server } = await setup({ current: true });
    const item = await openItem(server, '2.1.1');
    const { id: image } = json(await upload(server, 'image', PNG));
    const r = await call(server, 'POST', '/api/reviews', {
      body: { item: item.id, outcome: 'pass', reviewer: 'Ann', attachments: [image, image] },
    });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/names the same upload twice/);
  });
});

describe('the log', () => {
  it('has one line per scan start and end, review and export, and no scanned string', async () => {
    const { server, logs, engine } = await setup();
    const id = await scanned(server);
    const item = await openItem(server, '2.1.1');
    const r = await call(server, 'POST', '/api/reviews', {
      body: { item: item.id, outcome: 'pass', reviewer: 'Ann Reviewer' },
    });
    await call(server, 'GET', '/api/export/json');
    engine.run = waitsForCancel;
    const second = json(await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } }));
    await call(server, 'DELETE', `/api/scans/${second.id}`);
    await settle(server, second.id);
    expect(logs).toEqual([
      `widedoor ui: scan ${id} started (1 URLs, 0 uploaded PDFs, 0 PDF URLs)`,
      `widedoor ui: scan ${id} finished`,
      `widedoor ui: review recorded for item ${item.id} (record ${json(r).id})`,
      'widedoor ui: export served (json)',
      `widedoor ui: scan ${second.id} started (1 URLs, 0 uploaded PDFs, 0 PDF URLs)`,
      `widedoor ui: scan ${second.id} cancelled`,
    ]);
    expect(logs.join('\n')).not.toMatch(/site\.example|Ann Reviewer/);
  });
});

describe('the wrong access code log', () => {
  it('logs at most one line per 10 s, and the next line counts the rest', async () => {
    let t = 0;
    const { server, logs } = await setup({ now: () => t });
    const wrong = async (at: number) => {
      t = at;
      const r = await call(server, 'POST', '/api/session', {
        headers: { 'x-widedoor-code': 'wrong' },
      });
      expect(r.status).toBe(401);
    };
    for (const at of [0, 1_000, 2_000, 9_999]) await wrong(at);
    await wrong(10_000);
    await wrong(10_500);
    await wrong(25_000);
    await wrong(40_000);
    const tail = '; if it was not a typo, someone else may be trying it';
    expect(logs).toEqual([
      `widedoor ui: refused a wrong access code${tail}`,
      `widedoor ui: refused a wrong access code (3 more wrong codes since the last line)${tail}`,
      `widedoor ui: refused a wrong access code (1 more wrong code since the last line)${tail}`,
      `widedoor ui: refused a wrong access code${tail}`,
    ]);
  });
});

/** No drive letter, UNC path or POSIX absolute path, and none of the test folders. */
const expectNoAbsolutePath = (text: string) => {
  expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
  expect(text).not.toMatch(/\\\\/);
  expect(text).not.toMatch(/(^|[\s'"(=])\/[^\s/]/);
  expect(text).not.toContain(tmp);
  expect(text).not.toContain(tmpdir());
};

describe('no absolute path reaches the page', () => {
  it('names a missing image upload by its file name in the 400 of POST /api/reviews', async () => {
    const { server } = await setup({ current: true });
    const item = await openItem(server, '2.1.1');
    const { id: image } = json(await upload(server, 'image', PNG));
    // The upload's file goes missing between the upload and the review (an antivirus, a cleaner).
    const dir = readdirSync(tmpdir())
      .filter((d) => d.startsWith('widedoor-uploads-'))
      .map((d) => join(tmpdir(), d))
      .find((d) => existsSync(join(d, `${image}.png`)));
    rmSync(join(dir as string, `${image}.png`));
    const r = await call(server, 'POST', '/api/reviews', {
      body: { item: item.id, outcome: 'pass', reviewer: 'Ann', attachments: [image] },
    });
    expect(r.status).toBe(400);
    expect(r.text).toBe(`--attach "${image}.png": no such file`);
    expectNoAbsolutePath(r.text);
  });

  it('names files in a job error root-relative, or by name outside the root; the log has the cause', async () => {
    const { server, root, engine, logs } = await setup();
    const inRoot = join(root, 'docs', 'a.pdf');
    const outside = join(tmp, 'elsewhere', 'b.pdf');
    const message = `the PDF scan could not run: ENOENT: no such file, open '${inRoot}'; '${outside}'; /opt/verapdf/bin/verapdf`;
    engine.run = async () => ({ kind: 'error', message });
    const { id } = json(await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } }));
    const job = await settle(server, id);
    expect(job.status).toBe('failed');
    expect(job.error).toBe(
      "the PDF scan could not run: ENOENT: no such file, open 'docs/a.pdf'; 'b.pdf'; verapdf",
    );
    expectNoAbsolutePath(job.error as string);
    expect(logs).toContain(`widedoor ui: scan ${id} failed: ${message}`);
  });

  it('answers a fixed sentence for a job that threw, and logs the cause', async () => {
    const { server, root, engine, logs } = await setup();
    const file = join(root, 'widedoor-review', 'web.yaml');
    engine.run = async () => {
      throw new Error(`ENOENT: no such file or directory, open '${file}'`);
    };
    const { id } = json(await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } }));
    const job = await settle(server, id);
    expect(job).toMatchObject({ status: 'failed', error: JOB_THREW });
    expect(logs).toContain(
      `widedoor ui: scan ${id} failed: the scan failed: ENOENT: no such file or directory, open '${file}'`,
    );
  });

  it('shows a PDF the scan reads from disk by its name in the progress', async () => {
    const { server, engine } = await setup();
    let current = '';
    engine.run = (req, hooks) =>
      new Promise((done) => {
        current = join(req.evidenceDir, '..', 'pdf', 'report one.pdf');
        hooks.progress?.({ done: 0, known: 1, current });
        hooks.signal?.addEventListener('abort', () => done({ kind: 'cancelled' }), { once: true });
      });
    const { id } = json(await call(server, 'POST', '/api/scans', { body: { urls: [A.uri] } }));
    let job: JobReply | undefined;
    for (let i = 0; i < 500 && job?.progress.current === undefined; i++) {
      job = json(await call(server, 'GET', `/api/scans/${id}`)) as JobReply;
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(current).not.toBe('');
    expect(job?.progress.current).toBe('report one.pdf');
    await call(server, 'DELETE', `/api/scans/${id}`);
    await settle(server, id);
  });

  it('names a review file lock root-relative in a 422', async () => {
    const { server, root } = await setup({ current: true });
    const item = await openItem(server, '2.1.1');
    const file = `web-${createHash('sha256').update(A.uri).digest('hex').slice(0, 16)}.yaml`;
    // A folder at the lock name: review record refuses it with a ConfigError naming the lock.
    mkdirSync(join(root, REVIEW_DIR, `${file}.lock`), { recursive: true });
    const r = await call(server, 'POST', '/api/reviews', {
      body: { item: item.id, outcome: 'pass', reviewer: 'Ann' },
    });
    expect(r.status).toBe(422);
    expect(r.text.startsWith(`widedoor-review/${file}.lock is not usable: `)).toBe(true);
    expectNoAbsolutePath(r.text);
  });
});

describe('the refused request log', () => {
  it('counts every refusal by kind and logs at most one line per 10 s', async () => {
    let t = 0;
    const { server, logs } = await setup({ now: () => t });
    const refusals = () =>
      logs.filter((l) => l.startsWith('widedoor ui: refused ') && !l.includes('access code'));
    // At t=0 the first refusal logs at once.
    expect(
      (await call(server, 'GET', '/api/report', { headers: { [TOKEN_HEADER]: 'x' } })).status,
    ).toBe(401);
    expect(refusals()).toEqual(['widedoor ui: refused 1 request (1 token)']);
    // Every other kind, within the same 10 s: counted, not logged.
    t = 1_000;
    expect((await call(server, 'GET', '/', { headers: { host: 'evil.example' } })).status).toBe(
      403,
    );
    expect(
      (
        await call(server, 'POST', '/api/scans', {
          headers: { origin: 'https://evil.example' },
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(server, 'POST', '/api/scans', {
          headers: { 'content-type': 'text/plain' },
          body: '{}',
        })
      ).status,
    ).toBe(415);
    expect(
      (await call(server, 'POST', '/api/scans', { body: { urls: ['x'.repeat(MIB)] } })).status,
    ).toBe(413);
    expect((await call(server, 'POST', '/api/scans', { body: { nope: 1 } })).status).toBe(400);
    expect((await call(server, 'POST', '/api/reviews', { body: '{' })).status).toBe(400);
    expect((await upload(server, 'pdf', Buffer.from('not a pdf'))).status).toBe(400);
    expect(
      (
        await call(server, 'POST', '/api/uploads?kind=pdf', {
          body: Buffer.from('x'),
          headers: { 'content-type': 'text/plain' },
        })
      ).status,
    ).toBe(415);
    t = 9_999;
    expect(refusals()).toHaveLength(1);
    // The first refusal 10 s after the last line logs everything since it.
    t = 10_000;
    expect(
      (await call(server, 'GET', '/api/report', { headers: { [TOKEN_HEADER]: undefined } })).status,
    ).toBe(401);
    expect(refusals()).toEqual([
      'widedoor ui: refused 1 request (1 token)',
      'widedoor ui: refused 9 requests since the last line (1 Host, 1 token, 1 Origin, 2 content type, 1 size, 3 schema)',
    ]);
    // What a request carried never reaches the log.
    expect(logs.join('\n')).not.toMatch(/evil|nope/);
  });

  it('logs the refusals counted since the last line when the server stops', async () => {
    let t = 0;
    const { server, logs } = await setup({ now: () => t });
    for (const at of [0, 1, 2]) {
      t = at;
      await call(server, 'GET', '/api/report', { headers: { [TOKEN_HEADER]: 'x' } });
    }
    await server.close();
    expect(logs.filter((l) => l.includes('refused'))).toEqual([
      'widedoor ui: refused 1 request (1 token)',
      'widedoor ui: refused 2 requests since the last line (2 token)',
    ]);
  });
});

describe('sweepStaleUploads', () => {
  it('removes only the uploads folders of dead servers on this host', async () => {
    const parent = mkdtempSync(join(tmp, 'sweep-'));
    const tag = hostTag();
    const make = (name: string) => {
      mkdirSync(join(parent, name));
      writeFileSync(join(parent, name, 'upload.pdf'), PDF);
      return join(parent, name);
    };
    const stale = make(`widedoor-uploads-h${tag}-p999999999-abc`);
    const live = make(`widedoor-uploads-h${tag}-p${process.pid}-def`);
    const otherHost = make('widedoor-uploads-h00000000-p999999999-ghi');
    const untagged = make('widedoor-uploads-jkl');
    const file = join(parent, `widedoor-uploads-h${tag}-p999999998-file`);
    writeFileSync(file, 'not a folder');
    // A link named like a stale folder: never followed, never removed.
    const target = make('target');
    const link = join(parent, `widedoor-uploads-h${tag}-p999999997-lnk`);
    let linked = true;
    try {
      symlinkSync(target, link, 'junction');
    } catch {
      linked = false;
    }
    expect(await sweepStaleUploads(parent, tag, (pid) => pid === process.pid)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    for (const kept of [live, otherHost, untagged, file]) expect(existsSync(kept), kept).toBe(true);
    expect(existsSync(join(target, 'upload.pdf'))).toBe(true);
    if (linked) expect(existsSync(link)).toBe(true);
    // A parent that does not exist sweeps nothing and does not throw.
    expect(await sweepStaleUploads(join(parent, 'missing'), tag)).toBe(0);
  });

  it('names a server uploads folder after this host and process', async () => {
    const { server } = await setup();
    const { id } = json(await upload(server, 'pdf', PDF));
    const dir = readdirSync(tmpdir()).find(
      (d) =>
        d.startsWith(`widedoor-uploads-h${hostTag()}-p${process.pid}-`) &&
        existsSync(join(tmpdir(), d, `${id}.pdf`)),
    );
    expect(dir).toBeDefined();
  });
});
