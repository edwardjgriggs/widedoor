import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { FindingSchema, findingId, getProfile, type Asset } from '@widedoor/core';
import { buildScanReport, renderHtml, serializeJson, type ScanReport } from '@widedoor/report';
import { PinnedResolver, hostedUserAgent } from '@widedoor/web/egress';
import {
  ASSET_CACHE,
  DEFAULT_PDF_NAME,
  CONTROL_REFUSED_LINES_PER_MINUTE,
  JSON_DEADLINE_MS,
  NOT_FOUND_LINES_PER_MINUTE,
  REPORT_HTML_CSP,
  RESULT_DEADLINE_MS,
  UPLOAD_DEADLINE_MS,
  SECURITY_POLICY_URL,
  SELF_SCAN,
  createHostedApi,
  hostedAssets,
  withSecurityHeaders,
  type HostedApi,
  type HostedApiOptions,
} from '../src/hosted/api.ts';
import { loadHostedFiles, main } from '../src/hosted/api-bin.ts';
import { FlyError, type ScanMachine } from '../src/hosted/fly.ts';
import {
  BUSY,
  BUSY_NETWORK,
  CREATE_TIMEOUT_MS,
  HostedJobs,
  MAX_PER_DAY,
  NETWORK_RETRY_S,
  RETENTION_MS,
  START_FAILED,
  SWEEP_DEADLINE_MS,
  SWEEP_EVERY_MS,
  TIMED_OUT,
  TOO_LARGE_TO_KEEP,
  TOO_SLOW,
  UNREADABLE,
} from '../src/hosted/jobs.ts';
import {
  DOWNLOAD_DEADLINE_MS,
  DOWNLOAD_RETRY_S,
  DOWNLOADS_IN_FLIGHT,
  DOWNLOADS_PER_JOB,
  DOWNLOADS_PER_NETWORK,
  DOWNLOADS_PER_WIDE,
  OPEN_TIER,
  downloadDeadlineFor,
} from '../src/hosted/limits.ts';
import {
  DEFAULT_CONTACT_URL,
  JOB_ID,
  JobInputSchema,
  REPORT_TOO_LARGE,
  resultBodyMax,
} from '../src/hosted/protocol.ts';
import { logPrefix } from '../src/hosted/rate-limit.ts';
import { NOT_FOUND } from '../src/hosted/verify.ts';
import { SECURITY_HEADERS, UI_CSP } from '../src/security.ts';
import { UiBuildError } from '../src/static-files.ts';
import { FakeClock, fakeFly, settle } from './hosted-api-fixtures.ts';

/*
 * The hosted API with a fake Fly client, a fake DNS lookup and a fake clock:
 * what starts a machine and what never does, the control routes and their
 * tokens, the caps, retention, cancel, the startup sweep, the reports the API
 * builds itself, the headers on every response, and what the log never holds.
 */

const ORIGIN = 'https://widedoor.example.net';
const CONTACT = 'https://widedoor.example.net/about-scanner?a=1&b=2';
const IMAGE = 'registry.fly.io/widedoor-scan:deployment-01';
const CONTROL = 'http://[fdaa:0:1::2]:8081';
const PUBLIC_V4 = '93.184.215.14';
const NAMES: Record<string, string[]> = {
  'site.example.org': [PUBLIC_V4],
  'private.example.org': ['10.0.0.1'],
};
const IP = '198.51.100.7';

const HOSTED_HTML =
  '<!doctype html><title>hosted page</title><script type="module" crossorigin src="/assets/hosted-abc123.js"></script><link rel="stylesheet" crossorigin href="/assets/hosted-abc123.css">';
const LOCAL_HTML = '<!doctype html><title>local viewer</title>';
const LICENSES = 'Third-party notices';
const tmp = mkdtempSync(join(tmpdir(), 'widedoor-hosted-api-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A UI build in a temp folder: both pages, an asset of each type and the license notice. */
function fakeDist(parts: { hosted?: boolean; licenses?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmp, 'dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), LOCAL_HTML);
  if (parts.hosted !== false) writeFileSync(join(dir, 'hosted.html'), HOSTED_HTML);
  if (parts.licenses !== false) writeFileSync(join(dir, 'THIRD-PARTY-LICENSES.txt'), LICENSES);
  writeFileSync(join(dir, 'assets', 'hosted-abc123.js'), 'console.log(1);');
  writeFileSync(join(dir, 'assets', 'hosted-abc123.css'), 'body{}');
  // The local viewer's script: in the build, never served by the hosted API.
  writeFileSync(join(dir, 'assets', 'index-def456.js'), 'console.log(2);');
  return dir;
}
const DIST = fakeDist();

let opened: HostedApi[] = [];
afterEach(() => {
  for (const api of opened) api.stop();
  opened = [];
});

function setup(extra: Partial<HostedApiOptions> = {}) {
  const clock = new FakeClock();
  const fly = fakeFly();
  const lines: string[] = [];
  const lookups: string[] = [];
  const api = createHostedApi({
    fly: fly.client,
    image: IMAGE,
    controlUrl: CONTROL,
    publicOrigin: ORIGIN,
    contactUrl: CONTACT,
    resolver: () =>
      new PinnedResolver({
        lookup: (host) => {
          lookups.push(host);
          return Promise.resolve(
            (NAMES[host] ?? []).map((address) => ({ address, family: 4 as const })),
          );
        },
      }),
    trustMissingClientIp: true,
    now: clock.now,
    schedule: clock.schedule,
    log: (line) => void lines.push(line),
    ...extra,
  });
  opened.push(api);
  return { api, clock, fly, lines, lookups };
}

type Api = ReturnType<typeof setup>['api'];

const post = (api: Api, body: unknown, headers: Record<string, string> = {}) =>
  api.publicApp.request('/api/scans', {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'fly-client-ip': IP,
      ...headers,
    },
    body: JSON.stringify(body),
  });

/** A multipart upload of one pdf field. */
async function upload(
  api: Api,
  bytes: Uint8Array<ArrayBuffer>,
  name = 'report.pdf',
  headers: Record<string, string> = {},
) {
  const form = new FormData();
  form.append('pdf', new File([bytes], name, { type: 'application/pdf' }));
  return sendForm(api, form, headers);
}

/** POSTs a form as bytes (a FormData body's own stream breaks when the reader stops early). */
async function sendForm(api: Api, form: FormData, headers: Record<string, string> = {}) {
  const encoded = new Response(form);
  return api.publicApp.request('/api/scans', {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'fly-client-ip': IP,
      'content-type': encoded.headers.get('content-type') ?? '',
      ...headers,
    },
    body: new Uint8Array(await encoded.arrayBuffer()),
  });
}

const scanUrl = (path = '/') => `https://site.example.org${path}`;

let ips = 0;
/**
 * A client address in a /24 of its own, so the per-network live job cap (jobs.ts) never
 * comes into a test that is about something else.
 */
const freshIp = () => {
  ips++;
  return `10.${(ips >> 8) & 255}.${ips & 255}.7`;
};

/** Starts one URL scan (from a fresh network by default) and returns its id and its machine's token. */
async function startScan(
  api: Api,
  fly: ReturnType<typeof fakeFly>,
  url = scanUrl(),
  ip = freshIp(),
) {
  const res = await post(api, { url }, { 'fly-client-ip': ip });
  expect(res.status).toBe(202);
  const { id } = (await res.json()) as { id: string };
  await settle();
  const spec = fly.created.find((s) => s.jobId === id);
  return { id, token: spec?.token ?? '' };
}

const control = (
  api: Api,
  id: string,
  route: 'input' | 'pdf' | 'result',
  token?: string,
  body?: unknown,
) =>
  api.controlApp.request(`/internal/jobs/${id}/${route}`, {
    method: route === 'result' ? 'PUT' : 'GET',
    headers: {
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const status = async (api: Api, id: string) =>
  (await (await api.publicApp.request(`/api/scans/${id}`)).json()) as {
    status: string;
    queuePosition?: number;
    message?: string;
  };

const PAGE: Asset = {
  kind: 'web',
  uri: 'https://site.example.org/',
  contentHash: `sha256:${'a'.repeat(64)}`,
};

/** The test report; with a snippet, its one finding carries it (a large report for size tests). */
function sampleReport(snippet?: string): ScanReport {
  const location = { selector: 'img#hero' };
  const finding = FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(PAGE.uri, location, 'axe-core', 'image-alt'),
    asset: PAGE,
    location,
    source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId: 'image-alt' },
    criteria: { wcag: ['1.1.1'] },
    outcome: 'fail',
    impact: 'critical',
    ...(snippet !== undefined ? { evidence: { snippet } } : {}),
  });
  return buildScanReport({
    profile: getProfile('wcag21aa'),
    startedAt: '2026-10-27T12:00:00.000Z',
    finishedAt: '2026-10-27T12:01:00.000Z',
    toolVersion: '0.0.0',
    scope: { web: { urls: [PAGE.uri], truncated: false } },
    web: {
      engine: { name: 'axe-core', version: '4.14.0' },
      assets: [PAGE],
      findings: [finding],
      errors: [],
      skipped: [],
      warnings: [],
      truncated: false,
      pages: [{ asset: PAGE, title: 'Home' }],
    },
  });
}

const doneResult = (reportJson = serializeJson(sampleReport())) => ({ status: 'done', reportJson });

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

describe('POST /api/scans', () => {
  it('passes the default contact URL to scan machines when none is set', async () => {
    const clock = new FakeClock();
    const fly = fakeFly();
    const jobs = new HostedJobs({
      fly: fly.client,
      image: IMAGE,
      controlUrl: CONTROL,
      now: clock.now,
      schedule: clock.schedule,
    });
    jobs.submit({
      tier: 'open',
      profile: '508',
      target: { kind: 'url', url: 'https://site.example.org/', host: 'site.example.org' },
    });
    await settle();
    expect(fly.created[0]?.contactUrl).toBe(DEFAULT_CONTACT_URL);
    jobs.stop();
  });

  it('refuses a contact URL that is not https', () => {
    expect(() => setup({ contactUrl: 'http://widedoor.example.net/contact' })).toThrow(/https/);
    expect(() => setup({ contactUrl: 'mailto:abuse@widedoor.example.net' })).toThrow(/https/);
  });

  it('starts one machine per scan with a fresh token and the right spec', async () => {
    const { api, fly } = setup();
    const a = await startScan(api, fly);
    const b = await startScan(api, fly, scanUrl('/other'));
    expect(fly.created).toHaveLength(2);
    expect(a.id).toMatch(JOB_ID);
    expect(b.id).toMatch(JOB_ID);
    expect(a.id).not.toBe(b.id);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(fly.created[0]).toEqual({
      jobId: a.id,
      token: a.token,
      image: IMAGE,
      controlUrl: CONTROL,
      contactUrl: CONTACT,
      tier: 'open',
    });
    expect((await status(api, a.id)).status).toBe('running');
    const input = await control(api, a.id, 'input', a.token);
    expect(input.status).toBe(200);
    expect(JobInputSchema.parse(await input.json())).toEqual({
      jobId: a.id,
      tier: 'open',
      target: { kind: 'url', url: scanUrl() },
      profile: '508+wcag21aa',
    });
  });

  it('answers 202 with only the id and status, and the client cannot pick the tier', async () => {
    const { api, fly } = setup();
    const res = await post(api, { url: scanUrl(), profile: 'wcag21aa' });
    expect(res.status).toBe(202);
    expect(Object.keys((await res.json()) as object).sort()).toEqual(['id', 'status']);
    for (const extra of [{ tier: 'verified' }, { maxPages: 200 }]) {
      const refused = await post(api, { url: scanUrl(), ...extra });
      expect(refused.status).toBe(400);
    }
    await settle();
    expect(fly.created.map((s) => s.tier)).toEqual(['open']);
  });

  it('refuses a URL resolving to 10.0.0.1, naming the host, and starts no machine', async () => {
    const { api, fly, lines } = setup();
    const res = await post(api, { url: 'https://private.example.org/a/b?c=d' });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('private.example.org');
    expect(error).toContain('private');
    expect(error).not.toContain('/a/b');
    expect(error).not.toContain('c=d');
    await settle();
    expect(fly.created).toHaveLength(0);
    expect(lines.join('\n')).toContain(
      'event=refused reason=private status=400 host=private.example.org',
    );
  });

  it('refuses the metadata address, other private literals, odd ports and names that do not resolve', async () => {
    const { api, fly, lines } = setup();
    for (const url of [
      'http://169.254.169.254/',
      'http://127.0.0.1/',
      'http://[::ffff:10.0.0.1]/',
      'https://site.example.org:8443/',
      'https://nowhere.example.org/',
      'https://localhost/',
    ]) {
      const res = await post(api, { url });
      expect(res.status, url).toBe(400);
    }
    await settle();
    expect(fly.created).toHaveLength(0);
    expect(lines.join('\n')).toContain('reason=metadata');
  });

  it('refuses to scan itself: its own host, *.fly.dev and *.internal', async () => {
    const { api, fly } = setup();
    for (const url of [
      'https://widedoor.example.net/',
      'https://WIDEDOOR.example.net./x',
      'https://widedoor.fly.dev/',
      'http://widedoor-scan.internal/',
    ]) {
      const res = await post(api, { url });
      expect(res.status, url).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(SELF_SCAN);
    }
    await settle();
    expect(fly.created).toHaveLength(0);
  });

  it('refuses a POST without the public Origin with 403', async () => {
    const { api, fly } = setup();
    for (const origin of [undefined, 'https://evil.example.com', 'http://widedoor.example.net']) {
      const res = await api.publicApp.request('/api/scans', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'fly-client-ip': IP,
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify({ url: scanUrl() }),
      });
      expect(res.status).toBe(403);
    }
    await settle();
    expect(fly.created).toHaveLength(0);
  });

  it('refuses a missing or malformed Fly-Client-IP with 400 in production', async () => {
    const { api, fly } = setup({ trustMissingClientIp: false });
    const missing = await api.publicApp.request('/api/scans', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ url: scanUrl() }),
    });
    expect(missing.status).toBe(400);
    expect((await post(api, { url: scanUrl() }, { 'fly-client-ip': 'not-an-ip' })).status).toBe(
      400,
    );
    await settle();
    expect(fly.created).toHaveLength(0);
    expect((await post(api, { url: scanUrl() })).status).toBe(202);
  });

  it('gives the 11th scan in an hour from one IP 429 with Retry-After', async () => {
    const { api, clock } = setup();
    // A body that fails the schema still spends its token (the charge comes first), and
    // takes no job, so the per-network live job cap never comes into it.
    for (let i = 0; i < 10; i++) expect((await post(api, { url: 'nope' })).status).toBe(400);
    const res = await post(api, { url: scanUrl() });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBe(3600);
    expect((await post(api, { url: scanUrl() }, { 'fly-client-ip': '198.51.100.8' })).status).toBe(
      202,
    );
    await clock.advance(60 * 60_000 + 1);
    expect((await post(api, { url: scanUrl() })).status).toBe(202);
  });

  it('shares one bucket across an IPv6 /64, and between ::ffff:a.b.c.d and the IPv4 address', async () => {
    const { api } = setup();
    // Bodies that fail the schema: tokens spent, no jobs taken.
    for (let i = 0; i < 10; i++)
      await post(api, { url: 'nope' }, { 'fly-client-ip': `2001:db8:1:2::${i + 1}` });
    expect(
      (await post(api, { url: scanUrl() }, { 'fly-client-ip': '2001:db8:1:2:ffff::1' })).status,
    ).toBe(429);
    expect(
      (await post(api, { url: scanUrl() }, { 'fly-client-ip': '2001:db8:1:3::1' })).status,
    ).toBe(202);
    for (let i = 0; i < 5; i++)
      await post(api, { url: 'nope' }, { 'fly-client-ip': '203.0.113.9' });
    for (let i = 0; i < 5; i++)
      await post(api, { url: 'nope' }, { 'fly-client-ip': '::ffff:203.0.113.9' });
    expect((await post(api, { url: scanUrl() }, { 'fly-client-ip': '203.0.113.9' })).status).toBe(
      429,
    );
  });

  it('queues a 4th concurrent scan and refuses a 24th with 503', async () => {
    const { api, fly } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      const res = await post(api, { url: scanUrl() }, { 'fly-client-ip': freshIp() });
      expect(res.status).toBe(202);
      ids.push(((await res.json()) as { id: string }).id);
    }
    await settle();
    expect(fly.created).toHaveLength(3);
    expect(await status(api, ids[3] ?? '')).toEqual({
      id: ids[3],
      status: 'queued',
      queuePosition: 1,
    });
    expect((await status(api, ids[22] ?? '')).queuePosition).toBe(20);
    const busy = await post(api, { url: scanUrl() }, { 'fly-client-ip': freshIp() });
    expect(busy.status).toBe(503);
    expect(((await busy.json()) as { error: string }).error).toBe(BUSY);
    // A machine frees up: the first queued job starts.
    const first = fly.created[0];
    await control(api, first?.jobId ?? '', 'result', first?.token, {
      status: 'failed',
      error: 'x',
    });
    await settle();
    expect(fly.created).toHaveLength(4);
    expect(fly.created[3]?.jobId).toBe(ids[3]);
  });

  it('refuses the 301st scan of a UTC day with 503, and takes scans again the next day', async () => {
    const { api, clock } = setup();
    for (let i = 0; i < MAX_PER_DAY; i++) {
      const res = await post(
        api,
        { url: scanUrl() },
        // A /24 each, so the looser per-network bucket never comes into it.
        { 'fly-client-ip': `10.${i >> 8}.${i & 255}.1` },
      );
      expect(res.status).toBe(202);
      // Cancelled at once, so the machine and queue caps never come into it.
      const { id } = (await res.json()) as { id: string };
      expect(
        (
          await api.publicApp.request(`/api/scans/${id}`, {
            method: 'DELETE',
            headers: { origin: ORIGIN },
          })
        ).status,
      ).toBe(200);
    }
    const over = await post(api, { url: scanUrl() }, { 'fly-client-ip': '10.9.9.9' });
    expect(over.status).toBe(503);
    expect(((await over.json()) as { error: string }).error).toBe(BUSY);
    await clock.advance(12 * 60 * 60_000);
    expect((await post(api, { url: scanUrl() }, { 'fly-client-ip': '10.9.9.9' })).status).toBe(202);
  });

  it('refuses an unknown verificationId with the default resolveTier and starts no machine', async () => {
    const { api, fly } = setup();
    const res = await post(api, { url: scanUrl(), verificationId: 'abc' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(NOT_FOUND);
    await settle();
    expect(fly.created).toHaveLength(0);
  });

  it('takes the tier from resolveTier', async () => {
    const seen: (string | undefined)[] = [];
    const { api, fly } = setup({
      resolveTier: (target, verificationId) => {
        seen.push(`${target.hostname} ${verificationId}`);
        return Promise.resolve('verified');
      },
    });
    await startScan(api, fly);
    expect(seen).toEqual(['site.example.org undefined']);
    expect(fly.created[0]?.tier).toBe('verified');
  });
});

describe('PDF uploads', () => {
  it('takes a PDF, hands it to the agent once, then drops it', async () => {
    const { api, fly } = setup();
    const res = await upload(api, PDF, 'Annual report.pdf');
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    await settle();
    const token = fly.created[0]?.token;
    const input = (await (await control(api, id, 'input', token)).json()) as unknown;
    expect(JobInputSchema.parse(input).target).toEqual({
      kind: 'pdf',
      fileName: 'Annual report.pdf',
    });
    const pdf = await control(api, id, 'pdf', token);
    expect(pdf.status).toBe(200);
    expect(Buffer.from(await pdf.arrayBuffer())).toEqual(PDF);
    const again = await control(api, id, 'pdf', token);
    expect(again.status).toBe(404);
  });

  it('replaces an unusable file name with upload.pdf', async () => {
    const { api, fly } = setup();
    const res = await upload(api, PDF, '../etc/<x>.pdf');
    const { id } = (await res.json()) as { id: string };
    await settle();
    const input = JobInputSchema.parse(
      await (await control(api, id, 'input', fly.created[0]?.token)).json(),
    );
    expect(input.target).toEqual({ kind: 'pdf', fileName: DEFAULT_PDF_NAME });
  });

  it('refuses an upload of 25 MiB + 1 byte with 413 and starts no machine', async () => {
    const { api, fly } = setup();
    const big = Buffer.alloc(OPEN_TIER.pdfMaxBytes + 1, 0x20);
    big.write('%PDF-1.7\n');
    const res = await upload(api, big);
    expect(res.status).toBe(413);
    await settle();
    expect(fly.created).toHaveLength(0);
  });

  it('refuses a body past the multipart cap while it streams, with 413', async () => {
    const { api, fly } = setup();
    const big = Buffer.alloc(OPEN_TIER.pdfMaxBytes + 128 * 1024, 0x20);
    big.write('%PDF-1.7\n');
    const res = await upload(api, big);
    expect(res.status).toBe(413);
    await settle();
    expect(fly.created).toHaveLength(0);
  });

  it('refuses a file that is not a PDF with 415 and starts no machine', async () => {
    const { api, fly } = setup();
    const res = await upload(api, Buffer.from('<html>not a pdf</html>'), 'fake.pdf');
    expect(res.status).toBe(415);
    await settle();
    expect(fly.created).toHaveLength(0);
  });

  it('refuses a form with a second file or another field', async () => {
    const { api, fly } = setup();
    for (const extra of [
      (form: FormData) => form.append('pdf', new File([PDF], 'b.pdf')),
      (form: FormData) => form.append('url', 'https://site.example.org/'),
      (form: FormData) => form.append('profile', 'nope'),
    ]) {
      const form = new FormData();
      form.append('pdf', new File([PDF], 'a.pdf'));
      extra(form);
      const res = await sendForm(api, form);
      expect(res.status).toBe(400);
    }
    await settle();
    expect(fly.created).toHaveLength(0);
  });
});

describe('control routes', () => {
  it("refuse another job's token, a finished job's token, a bad id and no token, all with the same 404", async () => {
    const { api, fly } = setup();
    const a = await startScan(api, fly);
    const b = await startScan(api, fly);
    const refusals = [
      await control(api, a.id, 'input', b.token),
      await control(api, a.id, 'input'),
      await control(api, a.id, 'input', `${a.token}x`),
      await control(api, 'not-a-job', 'input', a.token),
      await control(api, 'f'.repeat(32), 'input', a.token),
      await control(api, a.id, 'pdf', a.token),
      await control(api, a.id, 'result', b.token, { status: 'failed', error: 'x' }),
    ];
    expect(
      (await control(api, a.id, 'result', a.token, { status: 'failed', error: 'x' })).status,
    ).toBe(204);
    refusals.push(
      await control(api, a.id, 'input', a.token),
      await control(api, a.id, 'result', a.token, { status: 'failed', error: 'x' }),
      await api.controlApp.request('/internal/jobs'),
      await api.controlApp.request('/healthz'),
      await api.controlApp.request(`/internal/jobs/${b.id}/input`, {
        method: 'POST',
        headers: { authorization: `Bearer ${b.token}` },
      }),
    );
    for (const res of refusals) {
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('');
    }
    // b was untouched by every refusal.
    expect((await control(api, b.id, 'input', b.token)).status).toBe(200);
  });

  it('marks a job failed when its reportJson is not a valid report', async () => {
    const { api, fly } = setup();
    for (const reportJson of ['{}', 'not json', JSON.stringify({ ...sampleReport(), extra: 1 })]) {
      const { id, token } = await startScan(api, fly);
      const res = await control(api, id, 'result', token, doneResult(reportJson));
      expect(res.status).toBe(204);
      expect(await status(api, id)).toEqual({ id, status: 'failed', message: UNREADABLE });
      expect((await api.publicApp.request(`/api/scans/${id}/report.json`)).status).toBe(409);
    }
  });

  it('marks a job failed for a result that is not a JobResult', async () => {
    const { api, fly } = setup();
    const { id, token } = await startScan(api, fly);
    const res = await control(api, id, 'result', token, { status: 'done' });
    expect(res.status).toBe(400);
    expect((await status(api, id)).status).toBe('failed');
    expect(fly.destroyed).toEqual([`m${id.slice(0, 8)}`]);
  });

  it('builds report.json and report.html from the validated report', async () => {
    const { api, fly } = setup();
    const { id, token } = await startScan(api, fly);
    expect((await control(api, id, 'result', token, doneResult())).status).toBe(204);
    expect(await status(api, id)).toEqual({ id, status: 'done' });
    // The token is revoked and the machine destroyed.
    expect((await control(api, id, 'input', token)).status).toBe(404);
    expect(fly.destroyed).toEqual([`m${id.slice(0, 8)}`]);
    const json = await api.publicApp.request(`/api/scans/${id}/report.json`);
    expect(json.status).toBe(200);
    expect(await json.text()).toBe(serializeJson(sampleReport()));
    const page = await api.publicApp.request(`/api/scans/${id}/report.html`);
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('<title>Accessibility report</title>');
  });

  it('refuses a result that carries an HTML report (R37: the API renders its own)', async () => {
    const { api, fly } = setup();
    const { id, token } = await startScan(api, fly);
    const res = await control(api, id, 'result', token, {
      ...doneResult(),
      reportHtml: '<!doctype html><p>from the scan machine</p>',
    });
    expect(res.status).toBe(400);
    expect(await status(api, id)).toMatchObject({ status: 'failed', message: UNREADABLE });
  });
});

describe('per-network live jobs', () => {
  const A = '203.0.113.20';
  const postFrom = (api: Api, ip: string, url = scanUrl()) =>
    post(api, { url }, { 'fly-client-ip': ip });
  const idOf = async (res: Response) => ((await res.json()) as { id: string }).id;

  it('takes one running and one queued per /32; a third gets 429 with Retry-After 60, unread', async () => {
    const { api, fly, lines } = setup();
    const first = await postFrom(api, A);
    expect(first.status).toBe(202);
    const firstId = await idOf(first);
    const second = await postFrom(api, A, scanUrl('/b'));
    expect(second.status).toBe(202);
    const secondId = await idOf(second);
    await settle();
    // The second waits for the first, even with machines free.
    expect(fly.created).toHaveLength(1);
    expect((await status(api, secondId)).status).toBe('queued');
    const body = countedBody();
    const third = await postStream(api, body.stream, 'application/json', A);
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe(String(NETWORK_RETRY_S));
    expect(((await third.json()) as { error: string }).error).toBe(BUSY_NETWORK);
    expect(body.pulled()).toBe(0);
    expect(lines).toContain(
      `widedoor event=refused reason=busy_network status=429 ip=${logPrefix(A)}`,
    );
    // Another network's job starts while the second waits.
    expect((await postFrom(api, freshIp())).status).toBe(202);
    await settle();
    expect(fly.created).toHaveLength(2);
    // The first ends: the second starts.
    const spec = fly.created.find((c) => c.jobId === firstId);
    await control(api, firstId, 'result', spec?.token, { status: 'failed', error: 'x' });
    await settle();
    expect(fly.created.map((c) => c.jobId)).toContain(secondId);
    expect((await status(api, secondId)).status).toBe('running');
  });

  it('counts an IPv6 /64 as one client, and lets a /48 or an IPv4 /24 hold two live jobs', async () => {
    // A fresh API each time, so the machine slots never fill and push a job to the queue.
    const codes = async (ips: string[]) => {
      const { api } = setup();
      const out: number[] = [];
      for (const ip of ips) out.push((await postFrom(api, ip)).status);
      return out;
    };
    expect(await codes(['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:2:ffff::9'])).toEqual([
      202, 202, 429,
    ]);
    expect(await codes(['2001:db8:5:1::1', '2001:db8:5:2::1', '2001:db8:5:3::1'])).toEqual([
      202, 202, 429,
    ]);
    expect(await codes(['10.200.1.1', '10.200.1.2', '10.200.1.3'])).toEqual([202, 202, 429]);
    // An IPv4 address in IPv6 form is the same client.
    expect(await codes(['10.201.1.1', '::ffff:10.201.1.1', '10.201.1.1'])).toEqual([202, 202, 429]);
  });

  it('spends no rate token on a busy_network refusal', async () => {
    const { api } = setup();
    const ids = [await idOf(await postFrom(api, A)), await idOf(await postFrom(api, A))];
    for (let i = 0; i < 9; i++) expect((await postFrom(api, A)).status).toBe(429);
    for (const id of ids) await cancelScan(api, id);
    // Two scans spent 2 tokens; bodies that fail the schema spend the other 8.
    for (let i = 0; i < 8; i++)
      expect((await post(api, { url: 'nope' }, { 'fly-client-ip': A })).status).toBe(400);
    const limited = await postFrom(api, A);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toMatch(/^Too many scans/);
  });

  it.each([
    ['done', 'result'],
    ['failed', 'result'],
    ['cancelled', 'cancel'],
    ['past its cap', 'cap'],
    ['its create failed', 'create'],
  ] as const)('frees the network when a job ends %s', async (_name, how) => {
    const { api, fly, clock } = setup();
    if (how === 'create')
      fly.fake.create = () => Promise.reject(new FlyError(500, 'Fly API 500: x'));
    const { id, token } = await startScan(api, fly, scanUrl(), A);
    const queued = await idOf(await postFrom(api, A, scanUrl('/q')));
    if (how === 'result')
      await control(
        api,
        id,
        'result',
        token,
        _name === 'done' ? doneResult() : { status: 'failed', error: 'x' },
      );
    if (how === 'cancel') await cancelScan(api, id);
    if (how === 'cap') await clock.advance(OPEN_TIER.wallClockMs);
    await settle();
    expect((await status(api, id)).status).not.toMatch(/^(queued|starting|running)$/);
    if (how === 'create')
      fly.fake.create = (spec) => Promise.resolve({ id: `m${spec.jobId.slice(0, 8)}` });
    // The queued job may now start (unless its own create failed too), and the network
    // takes one more queued job, and no more.
    expect(['running', 'starting', 'failed']).toContain((await status(api, queued)).status);
    await cancelScan(api, queued);
    expect((await postFrom(api, A, scanUrl('/x'))).status).toBe(202);
    expect((await postFrom(api, A, scanUrl('/y'))).status).toBe(202);
    expect((await postFrom(api, A, scanUrl('/z'))).status).toBe(429);
  });

  it('frees the queued place when a queued job waits too long', async () => {
    const { api, fly, clock } = setup({ queueWaitMs: 60_000 });
    await startScan(api, fly, scanUrl(), A);
    const queued = await idOf(await postFrom(api, A, scanUrl('/q')));
    expect((await postFrom(api, A)).status).toBe(429);
    await clock.advance(60_000);
    expect(await status(api, queued)).toMatchObject({ status: 'failed', message: BUSY });
    expect((await postFrom(api, A)).status).toBe(202);
  });
});

describe('result size by tier', () => {
  it("refuses an open-tier report over its tier's 8 MiB as too large", async () => {
    const { api, fly, lines } = setup();
    expect(OPEN_TIER.reportMaxBytes).toBe(8 * 1024 * 1024);
    const { id, token } = await startScan(api, fly);
    const res = await control(api, id, 'result', token, {
      status: 'done',
      reportJson: 'x'.repeat(OPEN_TIER.reportMaxBytes + 1),
    });
    expect(res.status).toBe(413);
    expect(await status(api, id)).toMatchObject({ status: 'failed', message: REPORT_TOO_LARGE });
    expect(lines.join('\n')).toContain(`event=scan_failed job=${id} tier=open reason=too_large`);
  });

  it("stops reading a body past its tier's resultBodyMax", async () => {
    const { api, fly } = setup();
    const { id, token } = await startScan(api, fly);
    const body = countedBody(resultBodyMax('open') / 1024 + 2);
    const res = await putResult(api, id, token, body.stream);
    expect(res.status).toBe(413);
    expect(body.pulled()).toBeLessThanOrEqual(resultBodyMax('open') / 1024 + 1);
  });

  it('takes a verified-tier report over 8 MiB to the parse (it is not too large there)', async () => {
    const { api, fly } = setup({ resolveTier: () => Promise.resolve('verified') });
    const { id, token } = await startScan(api, fly);
    const res = await control(api, id, 'result', token, {
      status: 'done',
      reportJson: 'x'.repeat(OPEN_TIER.reportMaxBytes + 1),
    });
    // Not a report, so unreadable; but not refused for its size.
    expect(res.status).toBe(204);
    expect(await status(api, id)).toMatchObject({ status: 'failed', message: UNREADABLE });
  });

  it('counts kept reports at their exact UTF-8 size', async () => {
    const { api, fly } = setup();
    const { id, token } = await startScan(api, fly);
    await control(api, id, 'result', token, doneResult());
    const report = sampleReport();
    expect(api.jobs.retained).toBe(
      Buffer.byteLength(serializeJson(report)) + Buffer.byteLength(renderHtml(report)),
    );
    const json = await api.publicApp.request(`/api/scans/${id}/report.json`);
    expect(await json.text()).toBe(serializeJson(report));
  });
});

describe('control refusals in the log', () => {
  it('logs each refused control request by route and reason only', async () => {
    const { api, lines } = setup();
    const secret = 'secret-token-value-123';
    await control(api, 'f'.repeat(32), 'input', secret);
    await control(api, 'f'.repeat(32), 'pdf');
    await control(api, 'f'.repeat(32), 'result', secret, { status: 'failed', error: 'x' });
    await api.controlApp.request('/internal/elsewhere');
    expect(lines).toEqual([
      'widedoor event=control_refused route=input reason=unauthorized',
      'widedoor event=control_refused route=pdf reason=unauthorized',
      'widedoor event=control_refused route=result reason=unauthorized',
      'widedoor event=control_refused route=other reason=no_route',
    ]);
    expect(lines.join('\n')).not.toMatch(/secret|ffff|elsewhere/);
  });

  it('caps the lines per route at 20 a minute, then gives one count', async () => {
    const { api, clock, lines } = setup();
    for (let i = 0; i < CONTROL_REFUSED_LINES_PER_MINUTE + 5; i++)
      await control(api, 'f'.repeat(32), 'input', 'x');
    expect(lines).toHaveLength(CONTROL_REFUSED_LINES_PER_MINUTE);
    await clock.advance(60_000);
    lines.length = 0;
    await control(api, 'f'.repeat(32), 'pdf', 'x');
    expect(lines).toEqual([
      'widedoor event=control_refused_suppressed route=input count=5',
      'widedoor event=control_refused route=pdf reason=unauthorized',
    ]);
  });
});

describe('report downloads in flight', () => {
  const MiB = 1024 * 1024;
  /** A done verified-tier job with a large kept report (a snippet of `size` bytes). */
  async function bigJob(api: Api, fly: ReturnType<typeof fakeFly>, size: number) {
    const { id, token } = await startScan(api, fly);
    const put = await control(
      api,
      id,
      'result',
      token,
      doneResult(serializeJson(sampleReport('x'.repeat(size)))),
    );
    expect(put.status).toBe(204);
    return id;
  }
  /** A done job with the small test report. */
  async function doneJob(api: Api, fly: ReturnType<typeof fakeFly>) {
    const { id, token } = await startScan(api, fly);
    await control(api, id, 'result', token, doneResult());
    return id;
  }
  const get = (api: Api, id: string, ip = IP, kind: 'json' | 'html' = 'json') =>
    api.publicApp.request(`/api/scans/${id}/report.${kind}`, {
      headers: { 'fly-client-ip': ip },
    });
  const verified = () => setup({ resolveTier: () => Promise.resolve('verified') });
  const arrayBuffers = () => {
    (globalThis as { gc?: () => void }).gc?.();
    return process.memoryUsage().arrayBuffers;
  };
  const SMALL_DEADLINE = downloadDeadlineFor(Buffer.byteLength(serializeJson(sampleReport())));

  it('scales the deadline with the size: 10 s plus 1 s per 256 KiB, at most 120 s', () => {
    expect(downloadDeadlineFor(0)).toBe(10_000);
    expect(downloadDeadlineFor(1)).toBe(11_000);
    expect(downloadDeadlineFor(256 * 1024)).toBe(11_000);
    expect(downloadDeadlineFor(256 * 1024 + 1)).toBe(12_000);
    expect(downloadDeadlineFor(32 * MiB)).toBe(DOWNLOAD_DEADLINE_MS);
    expect(DOWNLOAD_DEADLINE_MS).toBe(120_000);
  });

  it('sends six large downloads at once without copying the reports', async () => {
    const { api, fly } = verified();
    const ids = [await bigJob(api, fly, 16 * MiB), await bigJob(api, fly, 16 * MiB)];
    ids.push(await bigJob(api, fly, 16 * MiB));
    const base = arrayBuffers();
    // Two of each job, each from its own network: six bodies open at once, none read yet.
    const open: Response[] = [];
    for (const id of ids)
      for (let i = 0; i < DOWNLOADS_PER_JOB; i++) open.push(await get(api, id, freshIp()));
    for (const res of open) expect(res.status).toBe(200);
    const grown = arrayBuffers() - base;
    // A copying Response holds each 16 MiB report again (96 MiB or more for six).
    expect(grown).toBeLessThan(16 * MiB);
    for (const res of open) await res.body?.cancel();
  });

  it('sends the stored bytes exactly, JSON and HTML, with the same headers and a length', async () => {
    const { api, fly } = verified();
    const id = await bigJob(api, fly, 300 * 1024);
    const report = sampleReport('x'.repeat(300 * 1024));
    const json = await get(api, id, IP, 'json');
    expect(json.headers.get('content-length')).toBe(
      String(Buffer.byteLength(serializeJson(report))),
    );
    expect(await json.text()).toBe(serializeJson(report));
    const page = await get(api, id, IP, 'html');
    expect(page.headers.get('content-security-policy')).toBe(REPORT_HTML_CSP);
    expect(page.headers.get('content-disposition')).toBe(
      'attachment; filename="widedoor-report.html"',
    );
    expect(await page.text()).toBe(renderHtml(report));
  });

  it('refuses the third download of one job and the 65th in all with 429 and Retry-After 10', async () => {
    expect(DOWNLOADS_IN_FLIGHT).toBe(64);
    const { api, fly, lines } = setup();
    const ids: string[] = [];
    // Two places per job: 32 jobs fill the 64, and one more job is left over.
    for (let i = 0; i < DOWNLOADS_IN_FLIGHT / 2 + 1; i++) ids.push(await doneJob(api, fly));
    const first = ids[0] ?? '';
    const open = [await get(api, first, freshIp()), await get(api, first, freshIp())];
    const third = await get(api, first, IP);
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe(String(DOWNLOAD_RETRY_S));
    expect(((await third.json()) as { error: string }).error).toMatch(/^Too many downloads/);
    expect(lines).toContain(
      `widedoor event=refused reason=busy_download status=429 ip=${logPrefix(IP)}`,
    );
    const last = ids.at(-1) ?? '';
    for (const id of ids.slice(1, -1))
      for (let i = 0; i < 2; i++) open.push(await get(api, id, freshIp()));
    expect(open).toHaveLength(DOWNLOADS_IN_FLIGHT);
    expect(api.inFlightDownloads()).toBe(DOWNLOADS_IN_FLIGHT);
    const over = await get(api, last, freshIp());
    expect(over.status).toBe(429);
    for (const res of open) await res.body?.cancel();
    expect((await get(api, last, freshIp())).status).toBe(200);
  });

  it('holds at most 2 per /64 and 4 per /48 at once; other networks still get theirs', async () => {
    expect(DOWNLOADS_PER_NETWORK).toBe(2);
    expect(DOWNLOADS_PER_WIDE).toBe(4);
    const { api, fly } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await doneJob(api, fly));
    const [a = '', b = '', c = '', d = ''] = ids;
    // One /64 at its maximum (two jobs, so the per-job bound is not what refuses).
    const open = [await get(api, a, '2001:db8:5:1::1'), await get(api, b, '2001:db8:5:1::2')];
    for (const res of open) expect(res.status).toBe(200);
    expect((await get(api, c, '2001:db8:5:1:ffff::9')).status).toBe(429);
    // Another network is not held up by it.
    const other = await get(api, c, '203.0.113.50');
    expect(other.status).toBe(200);
    open.push(other);
    // A second /64 of the same /48 brings the /48 to 4; a third /64 there is refused.
    open.push(await get(api, c, '2001:db8:5:2::1'), await get(api, d, '2001:db8:5:2::2'));
    expect(open.slice(-2).map((r) => r.status)).toEqual([200, 200]);
    expect((await get(api, d, '2001:db8:5:3::1')).status).toBe(429);
    // The IPv4 /24 is bound the same way, and an IPv4 address in IPv6 form is the same client.
    for (const res of open) await res.body?.cancel();
    const v4 = [
      await get(api, a, '10.77.1.1'),
      await get(api, b, '::ffff:10.77.1.1'),
      await get(api, c, '10.77.1.2'),
      await get(api, d, '10.77.1.2'),
    ];
    expect(v4.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect((await get(api, a, '10.77.1.3')).status).toBe(429);
    for (const res of v4) await res.body?.cancel();
    expect(api.inFlightDownloads()).toBe(0);
  });

  it('frees every place (job, network, all) when a download is read, cancelled or past its deadline', async () => {
    const { api, fly, clock, lines } = setup();
    const id = await doneJob(api, fly);
    const fill = async () => [await get(api, id), await get(api, id)];
    const full = async () => {
      expect(api.inFlightDownloads()).toBe(2);
      // The job, IP's /64 and the whole tier are all at their bounds for this job and IP.
      expect((await get(api, id)).status).toBe(429);
    };
    // Read to the end.
    let open = await fill();
    await full();
    await open[0]?.arrayBuffer();
    await open[1]?.arrayBuffer();
    expect(api.inFlightDownloads()).toBe(0);
    // Cancelled (the client went away).
    open = await fill();
    await full();
    lines.length = 0;
    for (const res of open) await res.body?.cancel();
    expect(api.inFlightDownloads()).toBe(0);
    expect(lines).toEqual(
      Array<string>(2).fill(`widedoor event=download_ended reason=cancelled ip=${logPrefix(IP)}`),
    );
    // Past the deadline, which for this small report is 11 s, not 120.
    expect(SMALL_DEADLINE).toBe(11_000);
    open = await fill();
    await full();
    lines.length = 0;
    await clock.advance(SMALL_DEADLINE - 1);
    expect(api.inFlightDownloads()).toBe(2);
    await clock.advance(1);
    expect(api.inFlightDownloads()).toBe(0);
    for (const res of open) await expect(res.arrayBuffer()).rejects.toThrow();
    expect(lines).toEqual(
      Array<string>(2).fill(`widedoor event=download_ended reason=deadline ip=${logPrefix(IP)}`),
    );
    // Each time, the same client could open two more.
    const again = await fill();
    expect(again.map((r) => r.status)).toEqual([200, 200]);
    for (const res of again) await res.body?.cancel();
  });

  it('caps download_ended lines at 20 a minute per network, then one count', async () => {
    const { api, fly, clock, lines } = setup();
    const id = await doneJob(api, fly);
    lines.length = 0;
    for (let i = 0; i < 25; i++) await (await get(api, id)).body?.cancel();
    const ended = lines.filter((l) => l.startsWith('widedoor event=download_ended '));
    expect(ended).toHaveLength(20);
    await clock.advance(60_000);
    lines.length = 0;
    await api.publicApp.request('/healthz');
    expect(lines).toEqual([`widedoor event=download_ended_suppressed count=5 ip=${logPrefix(IP)}`]);
  });

  it.each(['DELETE', 'expiry'] as const)(
    "ends a job's open downloads when its reports drop (%s), freeing their places",
    async (how) => {
      const { api, fly, clock, lines } = verified();
      const id = await bigJob(api, fly, 4 * MiB);
      // Opened a moment before the reports go, unread.
      if (how === 'expiry') await clock.advance(RETENTION_MS - 1_000);
      const open = [await get(api, id, freshIp()), await get(api, id, freshIp())];
      expect(api.inFlightDownloads()).toBe(2);
      lines.length = 0;
      if (how === 'DELETE') expect((await cancelScan(api, id)).status).toBe(200);
      else await clock.advance(1_000);
      expect(api.jobs.retained).toBe(0);
      // Both streams end, and nothing holds a place (or a view of the dropped Buffer).
      expect(api.inFlightDownloads()).toBe(0);
      for (const res of open) await expect(res.arrayBuffer()).rejects.toThrow();
      expect(lines.filter((l) => l.includes('event=download_ended reason=dropped'))).toHaveLength(
        2,
      );
      expect((await get(api, id)).status).toBe(410);
    },
  );
});

describe('report downloads', () => {
  it('carry attachment, nosniff and, for HTML, the sandbox CSP', async () => {
    const { api, fly } = setup();
    const { id, token } = await startScan(api, fly);
    await control(api, id, 'result', token, doneResult());
    for (const ext of ['json', 'html'] as const) {
      const res = await api.publicApp.request(`/api/scans/${id}/report.${ext}`);
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename="widedoor-report.${ext}"`,
      );
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe(
        ext === 'html' ? REPORT_HTML_CSP : SECURITY_HEADERS['content-security-policy'],
      );
    }
    expect(REPORT_HTML_CSP).toMatch(/^sandbox; default-src 'none'; style-src 'sha256-/);
  });

  it('answer 404 for an unknown id and 409 before the scan is done', async () => {
    const { api, fly } = setup();
    const { id } = await startScan(api, fly);
    expect((await api.publicApp.request(`/api/scans/${id}/report.json`)).status).toBe(409);
    expect((await api.publicApp.request(`/api/scans/${'0'.repeat(32)}/report.json`)).status).toBe(
      404,
    );
    expect((await api.publicApp.request('/api/scans/zz/report.html')).status).toBe(404);
    expect((await api.publicApp.request(`/api/scans/${'0'.repeat(32)}`)).status).toBe(404);
  });

  it('expire after 1 hour: the job reads expired and downloads answer 410', async () => {
    const { api, fly, clock } = setup();
    const { id, token } = await startScan(api, fly);
    await control(api, id, 'result', token, doneResult());
    await clock.advance(RETENTION_MS - 1);
    expect((await api.publicApp.request(`/api/scans/${id}/report.json`)).status).toBe(200);
    await clock.advance(1);
    expect((await api.publicApp.request(`/api/scans/${id}/report.json`)).status).toBe(410);
    expect((await api.publicApp.request(`/api/scans/${id}/report.html`)).status).toBe(410);
    const view = await api.publicApp.request(`/api/scans/${id}`);
    expect(view.status).toBe(410);
    expect(await view.json()).toEqual({ id, status: 'expired' });
  });
});

describe('job lifecycle', () => {
  it('cancels a scan: its machine is destroyed, its token revoked and it reads cancelled', async () => {
    const { api, fly, lines } = setup();
    const { id, token } = await startScan(api, fly);
    const res = await api.publicApp.request(`/api/scans/${id}`, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    await settle();
    expect(fly.destroyed).toEqual([`m${id.slice(0, 8)}`]);
    expect(await status(api, id)).toEqual({ id, status: 'cancelled' });
    expect((await control(api, id, 'input', token)).status).toBe(404);
    expect((await api.publicApp.request(`/api/scans/${id}/report.json`)).status).toBe(410);
    expect(lines.join('\n')).toContain(`event=scan_cancelled job=${id}`);
    // A DELETE from another origin changes nothing.
    const other = await startScan(api, fly);
    const refused = await api.publicApp.request(`/api/scans/${other.id}`, { method: 'DELETE' });
    expect(refused.status).toBe(403);
    expect((await status(api, other.id)).status).toBe('running');
  });

  it('destroys the machine of a scan cancelled while its create was in flight', async () => {
    const { api, fly } = setup();
    let answer: (value: { id: string }) => void = () => undefined;
    fly.fake.create = () => new Promise((done) => (answer = done));
    const res = await post(api, { url: scanUrl() });
    const { id } = (await res.json()) as { id: string };
    await api.publicApp.request(`/api/scans/${id}`, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    });
    answer({ id: 'mlate' });
    await settle();
    expect(fly.destroyed).toEqual(['mlate']);
  });

  it('fails and destroys a scan past its cap', async () => {
    const { api, fly, clock, lines } = setup();
    const { id, token } = await startScan(api, fly);
    await clock.advance(OPEN_TIER.wallClockMs - 1);
    expect((await status(api, id)).status).toBe('running');
    await clock.advance(1);
    expect(await status(api, id)).toEqual({ id, status: 'failed', message: TIMED_OUT });
    expect(fly.destroyed).toEqual([`m${id.slice(0, 8)}`]);
    expect((await control(api, id, 'input', token)).status).toBe(404);
    expect(lines.join('\n')).toContain(`event=scan_failed job=${id} tier=open reason=timeout`);
  });

  it('a create that times out revokes the token and destroys the machine found by widedoor_job', async () => {
    const { api, fly, lines } = setup();
    let token: string | undefined;
    let jobId = '';
    fly.fake.create = (spec) => {
      token = spec.token;
      jobId = spec.jobId;
      fly.fake.machines = [
        {
          id: 'mother',
          createdAt: '2026-10-27T11:59:00Z',
          jobId: 'f'.repeat(32),
          state: 'started',
        },
        { id: 'mlost', createdAt: '2026-10-27T12:00:00Z', jobId: spec.jobId, state: 'started' },
      ];
      return Promise.reject(new FlyError(0, 'Fly API timed out'));
    };
    const res = await post(api, { url: scanUrl() });
    expect(res.status).toBe(202);
    await settle();
    expect(fly.destroyed).toEqual(['mlost']);
    expect(await status(api, jobId)).toEqual({
      id: jobId,
      status: 'failed',
      message: START_FAILED,
    });
    expect((await control(api, jobId, 'input', token)).status).toBe(404);
    expect(lines.join('\n')).toContain(`event=fly_create job=${jobId} status=0`);
  });

  it('treats a create with no answer by CREATE_TIMEOUT_MS the same way', async () => {
    const { api, fly, clock } = setup();
    let answer: (value: { id: string }) => void = () => undefined;
    fly.fake.create = (spec) => {
      fly.fake.machines = [
        { id: 'mslow', createdAt: '2026-10-27T12:00:00Z', jobId: spec.jobId, state: 'created' },
      ];
      return new Promise((done) => (answer = done));
    };
    const { id } = (await (await post(api, { url: scanUrl() })).json()) as { id: string };
    await clock.advance(CREATE_TIMEOUT_MS);
    expect(await status(api, id)).toEqual({ id, status: 'failed', message: START_FAILED });
    expect(fly.destroyed).toEqual(['mslow']);
    // The late answer's machine goes too.
    answer({ id: 'mslow' });
    await settle();
    expect(fly.destroyed).toEqual(['mslow', 'mslow']);
  });

  it('fails a scan whose create Fly refuses, logging fly_auth_failed for a 401', async () => {
    const { api, fly, lines } = setup();
    fly.fake.create = () => Promise.reject(new FlyError(401, 'Fly API 401: unauthorized'));
    const { id } = (await (await post(api, { url: scanUrl() })).json()) as { id: string };
    await settle();
    expect(await status(api, id)).toEqual({ id, status: 'failed', message: START_FAILED });
    expect(fly.lists).toHaveLength(0);
    expect(lines).toContain('widedoor event=fly_auth_failed status=401');
  });

  it('logs a destroy 404 (the machine was already gone) with its status', async () => {
    const { api, fly, lines } = setup();
    fly.fake.destroyGone = true;
    const { id, token } = await startScan(api, fly);
    await control(api, id, 'result', token, { status: 'failed', error: 'x' });
    await settle();
    expect(lines.join('\n')).toContain(
      `event=fly_destroy job=${id} machine=m${id.slice(0, 8)} status=404 ms=`,
    );
  });

  it('logs a failed destroy with its status', async () => {
    const { api, fly, lines } = setup();
    fly.fake.destroyError = new FlyError(500, 'Fly API 500: x');
    const { id, token } = await startScan(api, fly);
    await control(api, id, 'result', token, { status: 'failed', error: 'x' });
    await settle();
    expect(lines.join('\n')).toContain(
      `event=fly_destroy job=${id} machine=m${id.slice(0, 8)} status=500`,
    );
  });
});

describe('startup sweep', () => {
  it('destroys every scan machine at the first sweep: a fresh API holds no jobs', async () => {
    const { api, fly, clock, lines } = setup();
    const at = (minutesAgo: number) => new Date(clock.t - minutesAgo * 60_000).toISOString();
    fly.fake.machines = [
      { id: 'mold', createdAt: at(51), jobId: 'a'.repeat(32), state: 'started' },
      { id: 'myoung', createdAt: at(1), jobId: 'b'.repeat(32), state: 'started' },
      { id: 'mnodate', createdAt: 'yesterday', jobId: 'c'.repeat(32), state: 'started' },
    ];
    api.start();
    await settle();
    expect(fly.destroyed).toEqual(['mold', 'myoung', 'mnodate']);
    expect(lines).toContain('widedoor event=fly_sweep destroyed=3 failed=0 foreign=0 first=1');
  });

  it('spares a machine of a job the fresh API already started', async () => {
    const { api, fly, clock } = setup();
    // The job starts before the first sweep lists the machines.
    let release: (machines: ScanMachine[]) => void = () => undefined;
    fly.fake.list = () => new Promise((resolve) => (release = resolve));
    api.start();
    const { id } = await startScan(api, fly);
    release([
      {
        id: `m${id.slice(0, 8)}`,
        createdAt: new Date(clock.t).toISOString(),
        jobId: id,
        state: 'started',
      },
      {
        id: 'mother',
        createdAt: new Date(clock.t).toISOString(),
        jobId: 'd'.repeat(32),
        state: 'started',
      },
    ]);
    await settle();
    expect(fly.destroyed).toEqual(['mother']);
    expect((await status(api, id)).status).toBe('running');
  });

  it('later sweeps destroy only machines older than the longest cap', async () => {
    const { api, fly, clock, lines } = setup();
    api.start();
    await settle();
    const at = (minutesAgo: number) => new Date(clock.t - minutesAgo * 60_000).toISOString();
    fly.fake.machines = [
      { id: 'mold', createdAt: at(51), jobId: 'a'.repeat(32), state: 'started' },
      { id: 'myoung', createdAt: at(49), jobId: 'b'.repeat(32), state: 'started' },
    ];
    lines.length = 0;
    // Every 10 minutes.
    await clock.advance(SWEEP_EVERY_MS);
    expect(fly.lists).toHaveLength(2);
    // mold is now 61 minutes old, myoung 59: both past SWEEP_MAX_AGE_MS (50 minutes).
    expect(fly.destroyed).toEqual(['mold', 'myoung']);
    expect(lines).toContain('widedoor event=fly_sweep destroyed=2 failed=0 foreign=0');
    const before = fly.destroyed.length;
    // A machine created a minute ago stays.
    fly.fake.machines = [
      {
        id: 'mfresh',
        createdAt: new Date(clock.t - 60_000).toISOString(),
        jobId: 'f'.repeat(32),
        state: 'started',
      },
    ];
    await clock.advance(SWEEP_EVERY_MS);
    expect(fly.destroyed).toHaveLength(before);
  });

  it('counts machines without widedoor_role at every sweep and destroys none of them', async () => {
    const { api, fly, lines } = setup();
    fly.fake.foreign = () => Promise.resolve(2);
    api.start();
    await settle();
    expect(lines).toContain('widedoor event=fly_sweep destroyed=0 failed=0 foreign=2 first=1');
    expect(fly.destroyed).toEqual([]);
    fly.fake.foreign = () => Promise.reject(new FlyError(401, 'Fly API 401: no'));
    lines.length = 0;
    await api.jobs.sweep();
    expect(lines).toEqual([
      'widedoor event=fly_auth_failed status=401',
      'widedoor event=fly_sweep status=401 reason=foreign_list_failed',
      'widedoor event=fly_sweep destroyed=0 failed=0',
    ]);
  });

  it('does not block a scan request made during the sweep', async () => {
    const { api, fly } = setup();
    fly.fake.list = () => new Promise(() => undefined);
    api.start();
    await settle();
    const res = await post(api, { url: scanUrl() });
    expect(res.status).toBe(202);
    await settle();
    expect(fly.created).toHaveLength(1);
  });

  it('survives a list failure', async () => {
    const { api, fly, lines } = setup();
    fly.fake.list = () => Promise.reject(new FlyError(403, 'Fly API 403: forbidden'));
    api.start();
    await settle();
    expect(lines).toContain('widedoor event=fly_auth_failed status=403');
    expect(lines).toContain('widedoor event=fly_sweep status=403 reason=list_failed');
    expect((await post(api, { url: scanUrl() })).status).toBe(202);
  });

  it('keeps the next sweep a first sweep until a list succeeds', async () => {
    const { api, fly, clock, lines } = setup();
    fly.fake.list = () => Promise.reject(new FlyError(503, 'Fly API 503: down'));
    api.start();
    await settle();
    expect(lines).toContain('widedoor event=fly_sweep status=503 reason=list_failed');
    // The list works again: a machine a minute old still goes, as at a first sweep.
    const young = () => [
      {
        id: 'myoung',
        createdAt: new Date(clock.t - 60_000).toISOString(),
        jobId: 'b'.repeat(32),
        state: 'started',
      },
    ];
    fly.fake.list = () => Promise.resolve(young());
    lines.length = 0;
    await clock.advance(SWEEP_EVERY_MS);
    expect(fly.destroyed).toEqual(['myoung']);
    expect(lines).toContain('widedoor event=fly_sweep destroyed=1 failed=0 foreign=0 first=1');
    // From then on the age rule applies.
    lines.length = 0;
    await clock.advance(SWEEP_EVERY_MS);
    expect(fly.destroyed).toEqual(['myoung']);
    expect(lines).toContain('widedoor event=fly_sweep destroyed=0 failed=0 foreign=0');
  });
});

describe('logs', () => {
  it('never hold a token, a URL path or query, or a PDF name', async () => {
    const { api, fly, lines, clock } = setup();
    const url = await startScan(
      api,
      fly,
      scanUrl('/secret-path/page?secret-query=1'),
      '2001:db8:1:2::5',
    );
    await control(api, url.id, 'result', url.token, doneResult());
    const res = await upload(api, PDF, 'secret-name.pdf');
    const { id } = (await res.json()) as { id: string };
    await settle();
    const pdfToken = fly.created.find((s) => s.jobId === id)?.token ?? '';
    await control(api, id, 'pdf', pdfToken);
    await clock.advance(OPEN_TIER.wallClockMs);
    await post(api, { url: 'https://private.example.org/secret-path?secret-query' });
    const text = lines.join('\n');
    for (const secret of [url.token, pdfToken, 'secret-path', 'secret-query', 'secret-name'])
      expect(text).not.toContain(secret);
    expect(text).toContain(
      `event=scan_queued job=${url.id} tier=open host=site.example.org ip=2001:db8:1::`,
    );
    expect(text).toContain(`event=scan_done job=${url.id} tier=open ms=`);
    for (const line of lines)
      expect(line).toMatch(/^widedoor event=[a-z_]+( [a-z_]+=[A-Za-z0-9._:%[\]-]*)*$/);
  });
});

describe('every response', () => {
  it('carries the security headers, refusals and 404s included', async () => {
    const { api, fly } = setup();
    const { id, token } = await startScan(api, fly);
    const responses = [
      await api.publicApp.request('/healthz'),
      await api.publicApp.request('/about-scanner'),
      await api.publicApp.request('/nope'),
      await api.publicApp.request(`/api/scans/${id}`),
      await post(api, { url: scanUrl() }, { origin: 'https://evil.example.com' }),
      await post(api, { url: 'http://169.254.169.254/' }),
      await control(api, id, 'input', token),
      await control(api, id, 'input', 'wrong'),
      await api.controlApp.request('/'),
    ];
    for (const res of responses)
      for (const [name, value] of Object.entries(SECURITY_HEADERS))
        expect(res.headers.get(name), `${res.url} ${name}`).toBe(value);
  });

  it('serves /healthz and an escaped /about-scanner with the user agent and the robots.txt opt-out', async () => {
    const { api } = setup();
    expect(await (await api.publicApp.request('/healthz')).text()).toBe('ok');
    const about = await (await api.publicApp.request('/about-scanner')).text();
    expect(about).toContain(hostedUserAgent(CONTACT).replace(/&/g, '&amp;'));
    expect(about).toContain('User-agent: Widedoor');
    expect(about).toContain('href="https://widedoor.example.net/about-scanner?a=1&amp;b=2"');
    expect(about).not.toContain('a=1&b=2');
    // Private reports go to the repository's private vulnerability reporting, not the contact.
    expect(about.replace(/\s+/g, ' ')).toContain(
      "through the repository's private vulnerability reporting instead",
    );
    expect(about).toContain(`<a href="${SECURITY_POLICY_URL}">${SECURITY_POLICY_URL}</a>`);
    expect(SECURITY_POLICY_URL).toBe('https://github.com/edwardjgriggs/widedoor/security/policy');
  });
});

describe('the hosted page', () => {
  const page = () => setup({ staticFiles: loadHostedFiles(DIST) }).api;

  it('serves hosted.html at / with the security headers, no-store', async () => {
    const res = await page().publicApp.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe(HOSTED_HTML);
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      expect(res.headers.get(name), name).toBe(value);
    expect(res.headers.get('content-security-policy')).toBe(UI_CSP);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('serves a built asset with its type, cached as immutable, and the license notice', async () => {
    const api = page();
    const js = await api.publicApp.request('/assets/hosted-abc123.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe(ASSET_CACHE);
    expect(js.headers.get('content-security-policy')).toBe(UI_CSP);
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    const css = await api.publicApp.request('/assets/hosted-abc123.css');
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    const notice = await api.publicApp.request('/THIRD-PARTY-LICENSES.txt');
    expect(notice.status).toBe(200);
    expect(notice.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(notice.headers.get('cache-control')).toBe('no-store');
    expect(await notice.text()).toBe(LICENSES);
  });

  it('never serves the local viewer, hosted.html by name, or any other path (404)', async () => {
    const api = page();
    for (const path of [
      '/index.html',
      '/hosted.html',
      '/assets/',
      '/assets/missing.js',
      '/assets/index-def456.js',
      '/assets/%2e%2e/index.html',
      '/assets/..%2findex.html',
      '/THIRD-PARTY-LICENSES.txt/',
      '/src/hosted/main.tsx',
      '/favicon.ico',
    ]) {
      const res = await api.publicApp.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain('local viewer');
      expect(res.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  it('serves only the assets hosted.html names', () => {
    expect(hostedAssets(HOSTED_HTML)).toEqual([
      '/assets/hosted-abc123.js',
      '/assets/hosted-abc123.css',
    ]);
    expect(
      hostedAssets(
        '<link rel="modulepreload" crossorigin href="/assets/shared-1.js"><img src="/assets/x.png"><a href="/assets/y.js">',
      ),
    ).toEqual(['/assets/shared-1.js']);
  });

  it('logs every 404 by the kind of path, never the path itself', async () => {
    const { api, lines } = setup({ staticFiles: loadHostedFiles(DIST) });
    const probe = 'probe-7f3a91';
    for (const path of [
      `/assets/${probe}.js`,
      `/api/scans/${'f'.repeat(32)}/report.json`,
      `/${probe}.php`,
    ])
      await api.publicApp.request(path, { headers: { 'fly-client-ip': IP } });
    expect(lines).toEqual([
      `widedoor event=refused reason=not_found path_class=static ip=${logPrefix(IP)}`,
      `widedoor event=refused reason=not_found path_class=api ip=${logPrefix(IP)}`,
      `widedoor event=refused reason=not_found path_class=other ip=${logPrefix(IP)}`,
    ]);
    expect(lines.join('\n')).not.toMatch(/probe|ffff|\.php|report\.json/);
  });

  describe('the not_found log cap', () => {
    const OTHER_IP = '203.0.113.9';
    const miss = (api: Api, ip?: string) =>
      api.publicApp.request('/nothing-here', {
        headers: ip === undefined ? {} : { 'fly-client-ip': ip },
      });
    const notFoundLine = (ip: string) =>
      `widedoor event=refused reason=not_found path_class=other ip=${logPrefix(ip)}`;
    const countLine = (count: number, ip: string) =>
      `widedoor event=refused reason=not_found_suppressed count=${count} ip=${logPrefix(ip)}`;

    it('logs 20 lines a minute per network, then one count once the minute is over', async () => {
      const { api, clock, lines } = setup();
      for (let i = 0; i < NOT_FOUND_LINES_PER_MINUTE + 5; i++) {
        const res = await miss(api, IP);
        // Only the log is capped: every request still gets its 404.
        expect(res.status).toBe(404);
      }
      expect(lines).toEqual(Array<string>(NOT_FOUND_LINES_PER_MINUTE).fill(notFoundLine(IP)));
      // Another network has its own minute.
      await miss(api, OTHER_IP);
      expect(lines.at(-1)).toBe(notFoundLine(OTHER_IP));
      await clock.advance(59_999);
      await miss(api, IP);
      expect(lines).toHaveLength(NOT_FOUND_LINES_PER_MINUTE + 1);
      // Any request after the minute reports it: here Fly's health check.
      await clock.advance(1);
      lines.length = 0;
      expect((await api.publicApp.request('/healthz')).status).toBe(200);
      expect(lines).toEqual([countLine(6, IP)]);
      await miss(api, IP);
      expect(lines).toEqual([countLine(6, IP), notFoundLine(IP)]);
    });

    it('writes the count before the next line it allows', async () => {
      const { api, clock, lines } = setup();
      for (let i = 0; i <= NOT_FOUND_LINES_PER_MINUTE; i++) await miss(api, IP);
      await clock.advance(60_000);
      lines.length = 0;
      await miss(api, IP);
      expect(lines).toEqual([countLine(1, IP), notFoundLine(IP)]);
    });

    it('writes no count for a minute that stayed under the cap', async () => {
      const { api, clock, lines } = setup();
      for (let i = 0; i < NOT_FOUND_LINES_PER_MINUTE; i++) await miss(api, IP);
      await clock.advance(60_000);
      lines.length = 0;
      await api.publicApp.request('/healthz');
      expect(lines).toEqual([]);
    });

    it('caps requests with no client IP as one network', async () => {
      const { api, clock, lines } = setup();
      for (let i = 0; i < NOT_FOUND_LINES_PER_MINUTE + 2; i++) await miss(api);
      expect(lines).toHaveLength(NOT_FOUND_LINES_PER_MINUTE);
      await clock.advance(60_000);
      lines.length = 0;
      await api.publicApp.request('/healthz');
      expect(lines).toEqual(['widedoor event=refused reason=not_found_suppressed count=2']);
    });

    it('holds a bounded number of networks, reporting the oldest early', async () => {
      const { api, lines } = setup({ maxNotFoundKeys: 2 });
      for (let i = 0; i < NOT_FOUND_LINES_PER_MINUTE + 3; i++) await miss(api, IP);
      await miss(api, OTHER_IP);
      lines.length = 0;
      // A third network pushes out the oldest window, whose count is written then.
      await miss(api, '192.0.2.44');
      expect(lines).toEqual([countLine(3, IP), notFoundLine('192.0.2.44')]);
      // The dropped network starts a fresh minute.
      lines.length = 0;
      await miss(api, IP);
      expect(lines).toEqual([notFoundLine(IP)]);
    });

    it('reports the counts of open minutes when it stops', async () => {
      const { api, lines } = setup();
      for (let i = 0; i < NOT_FOUND_LINES_PER_MINUTE + 4; i++) await miss(api, IP);
      lines.length = 0;
      api.stop();
      expect(lines).toEqual([countLine(4, IP)]);
    });
  });

  it('answers 404 at / when no build was given', async () => {
    const res = await setup().api.publicApp.request('/');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-security-policy')).toBe(UI_CSP);
  });

  it('keeps no-store on everything but a built asset', async () => {
    const res = await page().publicApp.request('/healthz');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const headers = new Headers({ 'cache-control': 'public, max-age=60' });
    withSecurityHeaders(headers);
    expect(headers.get('cache-control')).toBe('no-store');
  });

  it('loadHostedFiles refuses a build without hosted.html or the license notice', () => {
    expect(() => loadHostedFiles(fakeDist({ hosted: false }))).toThrow(UiBuildError);
    expect(() => loadHostedFiles(fakeDist({ licenses: false }))).toThrow(UiBuildError);
    expect(() => loadHostedFiles(join(tmp, 'missing'))).toThrow(UiBuildError);
  });
});

describe('api-bin', () => {
  const PINNED = `registry.fly.io/widedoor-scan@sha256:${'0123456789abcdef'.repeat(4)}`;
  const env = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
    FLY_API_TOKEN: 'fo1_SECRET-token-value',
    WIDEDOOR_SCAN_IMAGE: PINNED,
    WIDEDOOR_PUBLIC_ORIGIN: ORIGIN,
    WIDEDOOR_CONTACT_URL: 'https://contact.example.net/widedoor',
    WIDEDOOR_CONTROL_HOST: '127.0.0.1',
    WIDEDOOR_UI_DIST: DIST,
    ...extra,
  });

  it('refuses a missing or invalid setting by name, never echoing the value', async () => {
    const cases: [Record<string, string | undefined>, string][] = [
      [{ FLY_API_TOKEN: undefined }, 'FLY_API_TOKEN'],
      [{ FLY_API_TOKEN: 'secret-too-short' }, 'FLY_API_TOKEN'],
      [{ FLY_API_TOKEN: `FlyV1  fm2_${'s'.repeat(30)}` }, 'FLY_API_TOKEN'],
      [{ FLY_API_TOKEN: `fm2_${'s'.repeat(30)}\nX` }, 'FLY_API_TOKEN'],
      [{ WIDEDOOR_SCAN_IMAGE: undefined }, 'WIDEDOOR_SCAN_IMAGE'],
      // Only a digest pin in the scan app's own registry: no tag, no other app or registry.
      [
        { WIDEDOOR_SCAN_IMAGE: 'registry.fly.io/widedoor-scan:secret-label' },
        'WIDEDOOR_SCAN_IMAGE',
      ],
      [
        { WIDEDOOR_SCAN_IMAGE: PINNED.replace('widedoor-scan', 'other-app') },
        'WIDEDOOR_SCAN_IMAGE',
      ],
      [
        { WIDEDOOR_SCAN_IMAGE: PINNED.replace('registry.fly.io', 'docker.io') },
        'WIDEDOOR_SCAN_IMAGE',
      ],
      [{ WIDEDOOR_SCAN_IMAGE: PINNED.toUpperCase() }, 'WIDEDOOR_SCAN_IMAGE'],
      [{ WIDEDOOR_SCAN_IMAGE: `${PINNED}0` }, 'WIDEDOOR_SCAN_IMAGE'],
      [{ WIDEDOOR_SCAN_IMAGE: `${PINNED}\n` }, 'WIDEDOOR_SCAN_IMAGE'],
      [{ WIDEDOOR_SCAN_APP: 'other-app', WIDEDOOR_SCAN_IMAGE: PINNED }, 'WIDEDOOR_SCAN_IMAGE'],
      [{ WIDEDOOR_PUBLIC_ORIGIN: 'http://secret-origin.example.net' }, 'WIDEDOOR_PUBLIC_ORIGIN'],
      [
        { WIDEDOOR_PUBLIC_ORIGIN: 'https://secret-origin.example.net/path' },
        'WIDEDOOR_PUBLIC_ORIGIN',
      ],
      [{ WIDEDOOR_CONTACT_URL: 'http://secret-contact.example.net' }, 'WIDEDOOR_CONTACT_URL'],
      // Required, and never the placeholder that links the about page to itself.
      [{ WIDEDOOR_CONTACT_URL: undefined }, 'WIDEDOOR_CONTACT_URL'],
      [{ WIDEDOOR_CONTACT_URL: DEFAULT_CONTACT_URL }, 'WIDEDOOR_CONTACT_URL'],
      [{ WIDEDOOR_CONTACT_URL: `${ORIGIN}/about-scanner` }, 'WIDEDOOR_CONTACT_URL'],
      [{ WIDEDOOR_CONTACT_URL: 'mailto:secret@example.net' }, 'WIDEDOOR_CONTACT_URL'],
      [{ FLY_REGION: 'secret region' }, 'FLY_REGION'],
      [{ FLY_REGION: 'IAD' }, 'FLY_REGION'],
      [{ WIDEDOOR_CONTROL_HOST: undefined }, 'FLY_PRIVATE_IP'],
      [{ WIDEDOOR_CONTROL_HOST: undefined, FLY_PRIVATE_IP: '10.0.0.1' }, 'FLY_PRIVATE_IP'],
      [{ WIDEDOOR_CONTROL_HOST: undefined, FLY_PRIVATE_IP: 'fdaa:0:1::2%eth0' }, 'FLY_PRIVATE_IP'],
      [
        {
          WIDEDOOR_SCAN_APP: 'Secret_App',
          WIDEDOOR_SCAN_IMAGE: PINNED.replace('widedoor-scan', 'Secret_App'),
        },
        'WIDEDOOR_SCAN_IMAGE',
      ],
    ];
    for (const [extra, name] of cases) {
      const lines: string[] = [];
      const e = env(extra);
      const code = await main({
        env: e,
        signal: AbortSignal.abort(),
        write: (l) => void lines.push(l),
      });
      expect(code, name).toBe(1);
      expect(lines).toEqual([`widedoor event=api_config_error name=${name}`]);
      expect(e.FLY_API_TOKEN).toBeUndefined();
    }
  });

  it('refuses to start without a usable UI build (ui_build), naming no path', async () => {
    for (const dist of [
      join(tmp, 'no-such-build'),
      fakeDist({ hosted: false }),
      fakeDist({ licenses: false }),
      'relative/dist',
    ]) {
      const lines: string[] = [];
      const code = await main({
        env: env({ WIDEDOOR_UI_DIST: dist }),
        signal: AbortSignal.abort(),
        write: (l) => void lines.push(l),
        createFly: () => fakeFly().client,
      });
      expect(code, dist).toBe(1);
      expect(lines).toEqual(['widedoor event=api_config_error name=ui_build']);
    }
  });

  it('accepts a real FlyV1 deploy token and hands it to the Fly client whole', async () => {
    const token = `FlyV1 fm2_${'a'.repeat(300)},fm2_${'b'.repeat(300)}`;
    const lines: string[] = [];
    const fly = fakeFly();
    const seen: string[] = [];
    const code = await main({
      env: env({ FLY_API_TOKEN: token }),
      signal: AbortSignal.abort(),
      write: (l) => void lines.push(l),
      publicHost: '127.0.0.1',
      publicPort: 0,
      controlPort: 0,
      createFly: (options) => {
        seen.push(options.apiToken);
        return fly.client;
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual([token]);
    expect(lines).toContain('widedoor event=api_ready');
    expect(lines.join('\n')).not.toContain('fm2_');
  });

  it("creates scan machines in the API's own region, with the pinned image", async () => {
    const stop = new AbortController();
    const fly = fakeFly();
    let ready: (port: number) => void = () => undefined;
    const port = new Promise<number>((done) => (ready = done));
    const running = main({
      env: env({ FLY_REGION: 'iad' }),
      signal: stop.signal,
      write: () => undefined,
      publicHost: '127.0.0.1',
      publicPort: 0,
      controlPort: 0,
      createFly: () => fly.client,
      onListening: (a) => ready(a.public.port),
    });
    const res = await fetch(`http://127.0.0.1:${await port}/api/scans`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'fly-client-ip': IP },
      // A public IP literal: no DNS lookup is needed to take it.
      body: JSON.stringify({ url: `https://${PUBLIC_V4}/` }),
    });
    expect(res.status).toBe(202);
    await settle();
    expect(fly.created[0]).toMatchObject({
      region: 'iad',
      image: PINNED,
      contactUrl: 'https://contact.example.net/widedoor',
    });
    stop.abort();
    expect(await running).toBe(0);
  });

  it('serves both listeners, the control one on the override host, and stops on the signal', async () => {
    const stop = new AbortController();
    const lines: string[] = [];
    const fly = fakeFly();
    const e = env();
    let ready: (value: { public: number; control: number }) => void = () => undefined;
    const ports = new Promise<{ public: number; control: number }>((done) => (ready = done));
    const running = main({
      env: e,
      signal: stop.signal,
      write: (l) => void lines.push(l),
      publicHost: '127.0.0.1',
      publicPort: 0,
      controlPort: 0,
      createFly: () => fly.client,
      onListening: (a) => ready({ public: a.public.port, control: a.control.port }),
    });
    const { public: pub, control: ctl } = await ports;
    expect(e.FLY_API_TOKEN).toBeUndefined();
    const home = await fetch(`http://127.0.0.1:${pub}/`);
    expect(await home.text()).toBe(HOSTED_HTML);
    expect(home.headers.get('content-security-policy')).toBe(UI_CSP);
    const asset = await fetch(`http://127.0.0.1:${pub}/assets/hosted-abc123.js`);
    expect(asset.headers.get('cache-control')).toBe(ASSET_CACHE);
    expect((await fetch(`http://127.0.0.1:${pub}/index.html`)).status).toBe(404);
    const health = await fetch(`http://127.0.0.1:${pub}/healthz`);
    expect(await health.text()).toBe('ok');
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    const res = await fetch(`http://127.0.0.1:${pub}/api/scans`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'fly-client-ip': IP },
      body: JSON.stringify({ url: 'http://127.0.0.1/' }),
    });
    expect(res.status).toBe(400);
    const internal = await fetch(`http://127.0.0.1:${ctl}/internal/jobs/${'a'.repeat(32)}/input`);
    expect(internal.status).toBe(404);
    stop.abort();
    expect(await running).toBe(0);
    expect(lines).toContain('widedoor event=api_ready');
  });
});

/** A request body that counts the chunks pulled from it and hangs after `chunks` until released. */
function countedBody(chunks = 1_000) {
  let pulled = 0;
  let release: () => void = () => undefined;
  const released = new Promise<void>((done) => (release = done));
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (pulled >= chunks) {
          await released;
          controller.close();
          return;
        }
        pulled++;
        controller.enqueue(new Uint8Array(1024).fill(0x20));
      },
      // Nothing is pulled until a reader asks.
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled, release: () => release() };
}

const postStream = (api: Api, body: ReadableStream<Uint8Array>, type: string, ip = IP) =>
  api.publicApp.request('/api/scans', {
    method: 'POST',
    headers: { origin: ORIGIN, 'fly-client-ip': ip, 'content-type': type },
    body,
    duplex: 'half',
  } as RequestInit);

const cancelScan = (api: Api, id: string | undefined) =>
  api.publicApp.request(`/api/scans/${id ?? ''}`, {
    method: 'DELETE',
    headers: { origin: ORIGIN },
  });

/** Posts n URL scans from n addresses and returns their ids. */
async function postMany(api: Api, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const res = await post(api, { url: scanUrl() }, { 'fly-client-ip': freshIp() });
    ids.push(((await res.json()) as { id: string }).id);
  }
  await settle();
  return ids;
}

/** Creates that answer only when told to. */
function heldCreates(fly: ReturnType<typeof fakeFly>) {
  const answers: ((value: { id: string }) => void)[] = [];
  fly.fake.create = () => new Promise((done) => answers.push(done));
  return answers;
}

describe('memory budget', () => {
  it('answers 503 for a full scanner without reading the body', async () => {
    const { api } = setup();
    await postMany(api, 23);
    expect(api.jobs.canAccept()).toEqual({ ok: false, message: BUSY, reason: 'busy' });
    const body = countedBody();
    const res = await postStream(api, body.stream, 'application/json', '198.51.100.99');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe(BUSY);
    expect(body.pulled()).toBe(0);
  });

  it('reads at most 4 upload bodies at once; the 5th gets 503 unread', async () => {
    const { api, fly } = setup();
    const held = Array.from({ length: 4 }, () => countedBody(2));
    const pending = held.map((b, i) =>
      postStream(api, b.stream, 'multipart/form-data; boundary=x', `198.51.100.${i + 1}`),
    );
    await settle();
    for (const b of held) expect(b.pulled()).toBeGreaterThan(0);
    const fifth = countedBody();
    const res = await postStream(
      api,
      fifth.stream,
      'multipart/form-data; boundary=x',
      '198.51.100.9',
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe(BUSY);
    expect(fifth.pulled()).toBe(0);
    for (const b of held) b.release();
    for (const done of await Promise.all(pending)) expect(done.status).toBe(400);
    // The places are free again.
    expect((await upload(api, PDF)).status).toBe(202);
    await settle();
    expect(fly.created).toHaveLength(1);
  });

  it('refuses an upload past the byte budget, and frees the bytes once the PDF is fetched', async () => {
    // An upload is judged at the largest PDF it may hold, before its body is read.
    const { api, fly } = setup({ maxRetainedBytes: OPEN_TIER.pdfMaxBytes + PDF.length - 1 });
    const first = (await (await upload(api, PDF)).json()) as { id: string };
    expect(api.jobs.retained).toBe(PDF.length);
    const unread = countedBody();
    const over = await postStream(
      api,
      unread.stream,
      'multipart/form-data; boundary=x',
      '198.51.100.8',
    );
    expect(over.status).toBe(503);
    expect(((await over.json()) as { error: string }).error).toBe(BUSY);
    expect(unread.pulled()).toBe(0);
    await settle();
    await control(api, first.id, 'pdf', fly.created[0]?.token);
    expect(api.jobs.retained).toBe(0);
    const next = await upload(api, PDF, 'c.pdf', { 'fly-client-ip': '198.51.100.9' });
    expect(next.status).toBe(202);
  });

  it('checks the budget before it builds the kept Buffers: a report that does not fit costs no copy', async () => {
    const { api, fly } = setup({
      resolveTier: () => Promise.resolve('verified'),
      maxRetainedBytes: 4 * 1024 * 1024,
    });
    // One small report kept: the budget is nearly full for a big one.
    const small = await startScan(api, fly);
    await control(api, small.id, 'result', small.token, doneResult());
    const before = api.jobs.retained;
    expect(before).toBeGreaterThan(0);
    const big = await startScan(api, fly);
    const report = serializeJson(sampleReport('x'.repeat(8 * 1024 * 1024)));
    const from = vi.spyOn(Buffer, 'from');
    const res = await control(api, big.id, 'result', big.token, doneResult(report));
    // No Buffer was made from a string of the report's size: only the budget check ran.
    const bigCopies = from.mock.calls.filter(
      ([value]) => typeof value === 'string' && value.length > 1024 * 1024,
    );
    from.mockRestore();
    expect(res.status).toBe(204);
    expect(await status(api, big.id)).toEqual({
      id: big.id,
      status: 'failed',
      message: TOO_LARGE_TO_KEEP,
    });
    expect(api.jobs.retained).toBe(before);
    expect(bigCopies).toEqual([]);
  });

  it('fails a result past the byte budget with "the report was too large to keep"', async () => {
    const { api, fly } = setup({ maxRetainedBytes: 1024 });
    const { id, token } = await startScan(api, fly);
    expect((await control(api, id, 'result', token, doneResult())).status).toBe(204);
    expect(await status(api, id)).toEqual({ id, status: 'failed', message: TOO_LARGE_TO_KEEP });
    expect(api.jobs.retained).toBe(0);
  });

  it('releases report bytes at expiry and at cancel, and PDF bytes at cancel', async () => {
    const { api, fly, clock } = setup();
    const a = await startScan(api, fly);
    await control(api, a.id, 'result', a.token, doneResult());
    const kept = api.jobs.retained;
    expect(kept).toBeGreaterThan(0);
    const b = await startScan(api, fly, scanUrl(), '198.51.100.8');
    await control(api, b.id, 'result', b.token, doneResult());
    expect(api.jobs.retained).toBe(2 * kept);
    await cancelScan(api, b.id);
    expect(api.jobs.retained).toBe(kept);
    await clock.advance(RETENTION_MS);
    expect(api.jobs.retained).toBe(0);
    const pdf = (await (await upload(api, PDF)).json()) as { id: string };
    expect(api.jobs.retained).toBe(PDF.length);
    await cancelScan(api, pdf.id);
    expect(api.jobs.retained).toBe(0);
  });

  it('fails a job queued past the queue wait as busy and releases its PDF bytes', async () => {
    const { api, fly, clock, lines } = setup({ queueWaitMs: 5 * 60_000 });
    await postMany(api, 3);
    const queued = (await (await upload(api, PDF)).json()) as { id: string };
    expect((await status(api, queued.id)).status).toBe('queued');
    expect(api.jobs.retained).toBe(PDF.length);
    await clock.advance(5 * 60_000 - 1);
    expect((await status(api, queued.id)).status).toBe('queued');
    await clock.advance(1);
    expect(await status(api, queued.id)).toEqual({
      id: queued.id,
      status: 'failed',
      message: BUSY,
    });
    expect(api.jobs.retained).toBe(0);
    expect(fly.created).toHaveLength(3);
    expect(lines.join('\n')).toContain(
      `event=scan_failed job=${queued.id} tier=open reason=queue_wait`,
    );
  });
});

describe('URL checks', () => {
  it('refuses a URL that normalizes past the length cap before any DNS lookup', async () => {
    const { api, fly, lookups } = setup();
    const url = `https://site.example.org/${'a '.repeat(900)}a`;
    expect(url.length).toBeLessThanOrEqual(2048);
    expect(new URL(url).href.length).toBeGreaterThan(2048);
    const res = await post(api, { url });
    expect(res.status).toBe(400);
    expect(lookups).toEqual([]);
    await settle();
    expect(fly.created).toHaveLength(0);
  });
});

describe('machine slots and races', () => {
  it('holds the slot of a job cancelled during its create until the create settles and the machine is gone', async () => {
    const { api, fly } = setup();
    const answers = heldCreates(fly);
    const ids = await postMany(api, 4);
    expect(fly.created).toHaveLength(3);
    await cancelScan(api, ids[0]);
    await settle();
    // Its create is still out, so the 4th job waits.
    expect(fly.created).toHaveLength(3);
    expect(api.jobs.running).toBe(3);
    answers[0]?.({ id: 'mfirst' });
    await settle();
    expect(fly.destroyed).toEqual(['mfirst']);
    expect(fly.created).toHaveLength(4);
    expect(fly.created[3]?.jobId).toBe(ids[3]);
  });

  it('holds the slot after a create timeout until the lookup and destroy have finished', async () => {
    const { api, fly, clock } = setup();
    heldCreates(fly);
    const listed: ((machines: ScanMachine[]) => void)[] = [];
    fly.fake.list = () => new Promise((done) => listed.push(done));
    await postMany(api, 4);
    // All three creates time out; their lookups hang, so the 4th job still waits.
    await clock.advance(CREATE_TIMEOUT_MS);
    expect(listed).toHaveLength(3);
    expect(fly.created).toHaveLength(3);
    expect(api.jobs.running).toBe(3);
    const lostJob = fly.created[0]?.jobId ?? '';
    listed[0]?.([
      { id: 'mlost', createdAt: '2026-10-27T12:00:00Z', jobId: lostJob, state: 'started' },
    ]);
    await settle();
    expect(fly.destroyed).toEqual(['mlost']);
    expect(fly.created).toHaveLength(4);
  });

  it('stops the create timeout when the job ends: no false fly_create status=0, no second destroy pass', async () => {
    const { api, fly, clock, lines } = setup();
    const answers = heldCreates(fly);
    const { id } = (await (await post(api, { url: scanUrl() })).json()) as { id: string };
    await cancelScan(api, id);
    await clock.advance(CREATE_TIMEOUT_MS);
    expect(lines.join('\n')).not.toContain('event=fly_create');
    expect(fly.lists).toHaveLength(0);
    answers[0]?.({ id: 'mlate' });
    await settle();
    expect(fly.destroyed).toEqual(['mlate']);
    expect(api.jobs.running).toBe(0);
  });

  it('a create still out at the cap: the create timeout fails the job first, and the late answer is destroyed', async () => {
    // The create timeout (30 s) is far shorter than any cap, so no job reaches its cap with
    // its create in flight: it fails as unable to start, and its cap timer is cancelled.
    const { api, fly, clock, lines } = setup();
    const answers = heldCreates(fly);
    const { id } = (await (await post(api, { url: scanUrl() })).json()) as { id: string };
    await clock.advance(OPEN_TIER.wallClockMs);
    expect(await status(api, id)).toEqual({ id, status: 'failed', message: START_FAILED });
    expect(lines.join('\n')).not.toContain('reason=timeout');
    answers[0]?.({ id: 'mlate' });
    await settle();
    expect(fly.destroyed).toEqual(['mlate']);
    expect(api.jobs.running).toBe(0);
  });

  it('a result that arrives while the job is starting ends it; the create answer is then destroyed', async () => {
    const { api, fly } = setup();
    const answers = heldCreates(fly);
    await postMany(api, 4);
    const first = fly.created[0];
    const id = first?.jobId ?? '';
    expect((await status(api, id)).status).toBe('starting');
    expect((await control(api, id, 'result', first?.token, doneResult())).status).toBe(204);
    expect(await status(api, id)).toEqual({ id, status: 'done' });
    expect(fly.created).toHaveLength(3);
    answers[0]?.({ id: 'mstarting' });
    await settle();
    expect(fly.destroyed).toEqual(['mstarting']);
    expect(fly.created).toHaveLength(4);
  });

  it('cancelling a queued job shifts the queue and starts no machine', async () => {
    const { api, fly } = setup();
    const ids = await postMany(api, 6);
    expect((await status(api, ids[4] ?? '')).queuePosition).toBe(2);
    await cancelScan(api, ids[3]);
    await settle();
    expect(await status(api, ids[3] ?? '')).toEqual({ id: ids[3], status: 'cancelled' });
    expect((await status(api, ids[4] ?? '')).queuePosition).toBe(1);
    expect((await status(api, ids[5] ?? '')).queuePosition).toBe(2);
    expect(fly.created).toHaveLength(3);
    expect(fly.destroyed).toEqual([]);
  });

  it('cancelling a running job promotes the first queued job', async () => {
    const { api, fly } = setup();
    const ids = await postMany(api, 5);
    await cancelScan(api, ids[1]);
    await settle();
    expect(fly.destroyed).toEqual([`m${(ids[1] ?? '').slice(0, 8)}`]);
    expect(fly.created.map((s) => s.jobId)).toEqual([ids[0], ids[1], ids[2], ids[3]]);
    expect((await status(api, ids[3] ?? '')).status).toBe('running');
    expect((await status(api, ids[4] ?? '')).queuePosition).toBe(1);
  });
});

describe('sweep deadline', () => {
  it('lets the next sweep run past a hung one, and a late settle does not clear a newer flag', async () => {
    const { api, fly, clock, lines } = setup();
    const lists: ((machines: ScanMachine[]) => void)[] = [];
    fly.fake.list = () => new Promise((done) => lists.push(done));
    api.start();
    await settle();
    expect(fly.lists).toHaveLength(1);
    await clock.advance(SWEEP_DEADLINE_MS);
    expect(lines).toContain('widedoor event=fly_sweep timed_out=1');
    await clock.advance(SWEEP_EVERY_MS - SWEEP_DEADLINE_MS);
    expect(fly.lists).toHaveLength(2);
    // The first sweep settles late, while the second is still going: no third may start.
    lists[0]?.([]);
    await settle();
    await api.jobs.sweep();
    expect(fly.lists).toHaveLength(2);
  });
});

const MULTIPART = 'multipart/form-data; boundary=x';

/** A request body of `text` sent in two halves, the second only once released; counts the chunks pulled. */
function heldText(text: string) {
  const bytes = new TextEncoder().encode(text);
  const halves = [bytes.slice(0, bytes.length >> 1), bytes.slice(bytes.length >> 1)];
  let pulled = 0;
  let release: () => void = () => undefined;
  const released = new Promise<void>((done) => (release = done));
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (pulled === 1) await released;
        const half = halves[pulled++];
        if (half === undefined) controller.close();
        else controller.enqueue(half);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled, release: () => release() };
}

const putResult = (api: Api, id: string, token: string, body: ReadableStream<Uint8Array>) =>
  api.controlApp.request(`/internal/jobs/${id}/result`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
    duplex: 'half',
  } as RequestInit);

describe('read deadlines', () => {
  it('gives an upload 2 minutes, a JSON request 10 s and a result 120 s', () => {
    expect(UPLOAD_DEADLINE_MS).toBe(120_000);
    expect(JSON_DEADLINE_MS).toBe(10_000);
    expect(RESULT_DEADLINE_MS).toBe(120_000);
  });

  it('cuts an upload that drips past its deadline with 408 and frees its upload place', async () => {
    const { api, lines } = setup({ uploadDeadlineMs: 50, maxUploadsInFlight: 1 });
    const drip = countedBody(2);
    const res = await postStream(api, drip.stream, MULTIPART);
    expect(res.status).toBe(408);
    expect(drip.pulled()).toBe(2);
    expect(lines).toContain(`widedoor event=refused reason=timeout status=408 ip=${logPrefix(IP)}`);
    // The one global place and this key's place are both free again.
    expect((await upload(api, PDF)).status).toBe(202);
  });

  it('cuts a JSON scan request that drips past its deadline with 408', async () => {
    const { api, fly } = setup({ jsonDeadlineMs: 50 });
    const drip = countedBody(2);
    const res = await postStream(api, drip.stream, 'application/json');
    expect(res.status).toBe(408);
    await settle();
    expect(fly.created).toHaveLength(0);
  });

  it('refuses a second upload from the same key while one is read, before any byte', async () => {
    const { api, lines } = setup();
    const first = countedBody(2);
    const pending = postStream(api, first.stream, MULTIPART);
    await settle();
    expect(first.pulled()).toBeGreaterThan(0);
    const second = countedBody();
    const res = await postStream(api, second.stream, MULTIPART);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe(BUSY);
    expect(second.pulled()).toBe(0);
    expect(lines).toContain(`widedoor event=refused reason=busy status=503 ip=${logPrefix(IP)}`);
    // Another network is not held up.
    const other = countedBody(2);
    const elsewhere = postStream(api, other.stream, MULTIPART, '203.0.113.9');
    await settle();
    expect(other.pulled()).toBeGreaterThan(0);
    first.release();
    other.release();
    expect((await pending).status).toBe(400);
    expect((await elsewhere).status).toBe(400);
    // Released on the refusal path too.
    expect((await upload(api, PDF)).status).toBe(202);
  });
  it('counts uploads per rate key: one IPv6 /64, and ::ffff:a.b.c.d with a.b.c.d', async () => {
    const { api } = setup();
    for (const [firstIp, secondIp] of [
      ['2001:db8:1:2::1', '2001:db8:1:2:ffff::9'],
      ['203.0.113.5', '::ffff:203.0.113.5'],
    ] as const) {
      const first = countedBody(2);
      const pending = postStream(api, first.stream, MULTIPART, firstIp);
      await settle();
      expect(first.pulled()).toBeGreaterThan(0);
      const second = countedBody();
      const res = await postStream(api, second.stream, MULTIPART, secondIp);
      expect(res.status, secondIp).toBe(503);
      expect(second.pulled()).toBe(0);
      first.release();
      expect((await pending).status).toBe(400);
    }
  });

  it('spends no rate token on a busy upload refusal', async () => {
    const { api } = setup();
    const held = countedBody(2);
    const pending = postStream(api, held.stream, MULTIPART);
    await settle();
    for (let i = 0; i < 5; i++)
      expect((await postStream(api, countedBody().stream, MULTIPART)).status).toBe(503);
    // The held upload spent 1 token of 10; the five refusals spent none. Bodies that fail
    // the schema spend a token each and take no job.
    for (let i = 0; i < 9; i++) expect((await post(api, { url: 'nope' })).status).toBe(400);
    expect((await post(api, { url: scanUrl() })).status).toBe(429);
    held.release();
    expect((await pending).status).toBe(400);
  });
});

describe('result path', () => {
  it('processes two jobs delivering at once one after the other', async () => {
    const { api, fly } = setup();
    const a = await startScan(api, fly);
    const b = await startScan(api, fly, scanUrl(), '198.51.100.8');
    const bodyA = heldText(JSON.stringify(doneResult()));
    const bodyB = heldText(JSON.stringify(doneResult()));
    bodyB.release();
    const first = putResult(api, a.id, a.token, bodyA.stream);
    await settle();
    expect(bodyA.pulled()).toBe(1);
    const second = putResult(api, b.id, b.token, bodyB.stream);
    await settle();
    // B waits at the gate, unread, while A is in transit.
    expect(bodyB.pulled()).toBe(0);
    expect((await status(api, b.id)).status).toBe('running');
    bodyA.release();
    expect((await first).status).toBe(204);
    expect((await second).status).toBe(204);
    expect(bodyB.pulled()).toBeGreaterThan(0);
    expect((await status(api, a.id)).status).toBe('done');
    expect((await status(api, b.id)).status).toBe('done');
  });

  it('answers a second PUT for the same job with 409, reading none of it', async () => {
    const { api, fly } = setup();
    const { id, token } = await startScan(api, fly);
    const body = heldText(JSON.stringify(doneResult()));
    const first = putResult(api, id, token, body.stream);
    await settle();
    const again = countedBody();
    const res = await putResult(api, id, token, again.stream);
    // The token holder learns to send it again later; anyone else still gets the empty 404.
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('');
    expect(again.pulled()).toBe(0);
    expect((await putResult(api, id, 'not-the-token', countedBody().stream)).status).toBe(404);
    body.release();
    expect((await first).status).toBe(204);
    expect((await status(api, id)).status).toBe('done');
  });

  it('fails jobs whose PUTs run out of time, at the gate or reading, as too slow', async () => {
    const { api, fly, lines } = setup({ resultDeadlineMs: 50 });
    const a = await startScan(api, fly);
    const b = await startScan(api, fly, scanUrl(), '198.51.100.8');
    // Both bodies drip, so B ends too slow whether its time runs out at the gate or while
    // reading after A leaves (the order of those timers is not fixed; Gate's own tests are).
    const first = putResult(api, a.id, a.token, countedBody(1).stream);
    await settle();
    const second = putResult(api, b.id, b.token, countedBody(1).stream);
    expect((await second).status).toBe(408);
    expect((await first).status).toBe(408);
    for (const job of [a, b]) {
      expect(await status(api, job.id)).toEqual({
        id: job.id,
        status: 'failed',
        message: TOO_SLOW,
      });
      expect(lines.join('\n')).toContain(
        `event=scan_failed job=${job.id} tier=open reason=too_slow`,
      );
    }
    // Both machines are destroyed and the gate is open again.
    expect(fly.destroyed).toHaveLength(2);
    const c = await startScan(api, fly, scanUrl(), '198.51.100.9');
    expect((await control(api, c.id, 'result', c.token, doneResult())).status).toBe(204);
  });
});

describe('DNS preflight cap', () => {
  it('answers a fifth concurrent preflight with 503 and frees the places once they finish', async () => {
    const answers: (() => void)[] = [];
    const { api, lines } = setup({
      resolver: () =>
        new PinnedResolver({
          lookup: () =>
            new Promise((done) => answers.push(() => done([{ address: PUBLIC_V4, family: 4 }]))),
        }),
    });
    const four = [1, 2, 3, 4].map(() =>
      post(api, { url: scanUrl() }, { 'fly-client-ip': freshIp() }),
    );
    await settle();
    expect(answers).toHaveLength(4);
    const fifth = await post(api, { url: scanUrl() }, { 'fly-client-ip': '198.51.100.9' });
    expect(fifth.status).toBe(503);
    expect(((await fifth.json()) as { error: string }).error).toBe(BUSY);
    expect(answers).toHaveLength(4);
    expect(lines).toContain(
      'widedoor event=refused reason=busy status=503 host=site.example.org ip=198.51.100.0',
    );
    for (const answer of answers) answer();
    for (const res of await Promise.all(four)) expect(res.status).toBe(202);
    const again = post(api, { url: scanUrl() }, { 'fly-client-ip': '198.51.100.9' });
    await settle();
    answers[4]?.();
    expect((await again).status).toBe(202);
  });
});

describe('log fields', () => {
  it('puts the client network on origin refusals and on scan_cancelled', async () => {
    const { api, fly, lines } = setup();
    const net = logPrefix(IP);
    expect((await post(api, { url: scanUrl() }, { origin: 'https://evil.example' })).status).toBe(
      403,
    );
    const { id } = await startScan(api, fly);
    const denied = await api.publicApp.request(`/api/scans/${id}`, {
      method: 'DELETE',
      headers: { 'fly-client-ip': IP },
    });
    expect(denied.status).toBe(403);
    expect(lines.filter((l) => l.includes('reason=origin'))).toEqual([
      `widedoor event=refused reason=origin status=403 ip=${net}`,
      `widedoor event=refused reason=origin status=403 ip=${net}`,
    ]);
    await api.publicApp.request(`/api/scans/${id}`, {
      method: 'DELETE',
      headers: { origin: ORIGIN, 'fly-client-ip': IP },
    });
    expect(lines).toContain(`widedoor event=scan_cancelled job=${id} tier=open ip=${net}`);
  });

  it('logs each report download with the job, the format and the client network only', async () => {
    const { api, fly, lines } = setup();
    const { id, token } = await startScan(api, fly);
    await control(api, id, 'result', token, doneResult());
    for (const kind of ['json', 'html']) {
      const res = await api.publicApp.request(`/api/scans/${id}/report.${kind}`, {
        headers: { 'fly-client-ip': IP },
      });
      expect(res.status).toBe(200);
    }
    expect(lines.filter((l) => l.includes('event=report_download'))).toEqual([
      `widedoor event=report_download job=${id} format=json ip=${logPrefix(IP)}`,
      `widedoor event=report_download job=${id} format=html ip=${logPrefix(IP)}`,
    ]);
  });

  it('names the error class on api_error and control_error, never its message', async () => {
    const { api, lines } = setup({
      resolveTier: () => Promise.reject(new TypeError('secret-api-message')),
    });
    expect((await post(api, { url: scanUrl() })).status).toBe(500);
    expect(lines).toContain('widedoor event=api_error status=500 err=TypeError');
    const other = setup();
    const { id, token } = await startScan(other.api, other.fly);
    other.api.jobs.input = () => {
      throw new RangeError('secret-control-message');
    };
    expect((await control(other.api, id, 'input', token)).status).toBe(500);
    expect(other.lines).toContain('widedoor event=control_error status=500 err=RangeError');
    expect([...lines, ...other.lines].join('\n')).not.toContain('secret-');
  });
});

describe('control host', () => {
  const env = (host: string): NodeJS.ProcessEnv => ({
    FLY_API_TOKEN: 'fo1_SECRET-token-value',
    WIDEDOOR_SCAN_IMAGE: `registry.fly.io/widedoor-scan@sha256:${'0'.repeat(64)}`,
    WIDEDOOR_PUBLIC_ORIGIN: ORIGIN,
    WIDEDOOR_CONTACT_URL: 'https://contact.example.net/widedoor',
    WIDEDOOR_CONTROL_HOST: host,
    WIDEDOOR_UI_DIST: DIST,
  });

  it('takes only loopback or an fdaa::/16 address, naming only the variable', async () => {
    for (const host of [
      '0.0.0.0',
      '::',
      '10.0.0.1',
      '127.0.0.2',
      'fd00::1',
      'fdab::1',
      'fdaa:0:1::2%eth0',
      '::1%1',
      'localhost',
    ]) {
      const lines: string[] = [];
      const code = await main({
        env: env(host),
        signal: AbortSignal.abort(),
        write: (l) => void lines.push(l),
      });
      expect(code, host).toBe(1);
      expect(lines).toEqual(['widedoor event=api_config_error name=WIDEDOOR_CONTROL_HOST']);
    }
  });

  it('lets an fdaa::/16 address through the config check', async () => {
    const lines: string[] = [];
    const fly = fakeFly();
    await main({
      env: env('fdaa:0:1::2'),
      signal: AbortSignal.abort(),
      write: (l) => void lines.push(l),
      publicHost: '127.0.0.1',
      publicPort: 0,
      controlPort: 0,
      createFly: () => fly.client,
    });
    // This machine has no such address, so the listener may fail; the config did not.
    expect(lines.join('\n')).not.toContain('api_config_error');
  });
});
