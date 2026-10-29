import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, get as httpGet, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { FindingSchema, findingId, getProfile, type Asset } from '@widedoor/core';
import { buildScanReport, serializeJson } from '@widedoor/report';
import { PinnedResolver } from '@widedoor/web/egress';
import { createHostedApi, type HostedApi } from '../src/hosted/api.ts';
import { runAgent } from '../src/hosted/agent-bin.ts';
import { downloadDeadlineFor } from '../src/hosted/limits.ts';
import { FakeClock, fakeFly } from './hosted-api-fixtures.ts';

/*
 * The seam between the agent and the API: the real runAgent (with a stub scan child that
 * prints a result) against the real control app, over HTTP on 127.0.0.1. A scan job ends
 * done with a downloadable report; a verify job leaves its verification verified. Only
 * the Fly client and the child are stand-ins. And a report download through a real
 * @hono/node-server listener, to a client that stops reading.
 */

const ORIGIN = 'https://widedoor.example.net';
const IP = '198.51.100.7';
const HOST = 'site.example.org';
const tmp = mkdtempSync(join(tmpdir(), 'widedoor-seam-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PAGE: Asset = {
  kind: 'web',
  uri: `https://${HOST}/`,
  contentHash: `sha256:${'a'.repeat(64)}`,
};

function report(snippet?: string) {
  const location = { selector: 'img#hero' };
  return buildScanReport({
    profile: getProfile('wcag21aa'),
    startedAt: '2026-10-28T12:00:00.000Z',
    finishedAt: '2026-10-28T12:01:00.000Z',
    toolVersion: '0.0.0',
    scope: { web: { urls: [PAGE.uri], truncated: false } },
    web: {
      engine: { name: 'axe-core', version: '4.14.0' },
      assets: [PAGE],
      findings: [
        FindingSchema.parse({
          schemaVersion: 1,
          id: findingId(PAGE.uri, location, 'axe-core', 'image-alt'),
          asset: PAGE,
          location,
          source: { engine: 'axe-core', engineVersion: '4.14.0', ruleId: 'image-alt' },
          criteria: { wcag: ['1.1.1'] },
          outcome: 'fail',
          impact: 'critical',
          ...(snippet !== undefined ? { evidence: { snippet } } : {}),
        }),
      ],
      errors: [],
      skipped: [],
      warnings: [],
      truncated: false,
      pages: [{ asset: PAGE, title: 'Home' }],
    },
  });
}

let servers: Server[] = [];
let apis: HostedApi[] = [];
afterEach(async () => {
  for (const api of apis) api.stop();
  apis = [];
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  );
  servers = [];
});

/** The real API, its control app listening on 127.0.0.1 like the 6PN listener. */
async function start() {
  // Set once the API exists (right after), which needs the listener's port first.
  const holder: { api?: HostedApi } = {};
  const server = createServer(
    getRequestListener(
      (req) => holder.api?.controlApp.fetch(req) ?? new Response(null, { status: 404 }),
      {
        overrideGlobalObjects: false,
      },
    ),
  );
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  const fly = fakeFly();
  const api = createHostedApi({
    fly: fly.client,
    image: `registry.fly.io/widedoor-scan@sha256:${'0'.repeat(64)}`,
    controlUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    publicOrigin: ORIGIN,
    contactUrl: 'https://contact.example.net/widedoor',
    resolver: () =>
      new PinnedResolver({
        lookup: () => Promise.resolve([{ address: '93.184.215.14', family: 4 as const }]),
      }),
    // No TXT record: a check goes to a verify job.
    txtLookup: () => Promise.resolve([]),
  });
  apis.push(api);
  holder.api = api;
  return { api, fly };
}

const publicPost = (api: HostedApi, path: string, body?: unknown) =>
  api.publicApp.request(path, {
    method: 'POST',
    headers: { origin: ORIGIN, 'fly-client-ip': IP, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

/** A scan child that reads its job and prints `result` as its one stdout line. */
function stubChild(result: unknown): string[] {
  const file = join(mkdtempSync(join(tmp, 'child-')), 'result.json');
  writeFileSync(file, `${JSON.stringify(result)}\n`);
  return [
    process.execPath,
    '-e',
    `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(require('fs').readFileSync(${JSON.stringify(file)})));`,
  ];
}

/** Runs the real agent for the machine the API last created. */
async function agentFor(fly: ReturnType<typeof fakeFly>, child: string[]) {
  const spec = fly.created.at(-1);
  if (spec === undefined) throw new Error('no machine was created');
  const lines: string[] = [];
  const code = await runAgent({
    env: {
      PATH: process.env.PATH,
      WIDEDOOR_CONTROL_URL: spec.controlUrl,
      WIDEDOOR_JOB_ID: spec.jobId,
      WIDEDOOR_JOB_TOKEN: spec.token,
      // Never used: the stub child makes no request.
      WIDEDOOR_PROXY_URL: 'http://127.0.0.1:9',
      WIDEDOOR_CONTACT_URL: spec.contactUrl,
      WIDEDOOR_AGENT_SAME_USER: '1',
    },
    child,
    uid: 1000,
    log: (line) => void lines.push(line),
  });
  return { code, lines, spec };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
};

describe('agent and API', () => {
  it('a scan job ends done, with both reports downloadable', async () => {
    const { api, fly } = await start();
    const res = await publicPost(api, '/api/scans', { url: `https://${HOST}/` });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    await settle();
    const sent = report();
    const { code, lines, spec } = await agentFor(
      fly,
      stubChild({ status: 'done', reportJson: serializeJson(sent) }),
    );
    expect(code, lines.join('\n')).toBe(0);
    expect(spec.jobId).toBe(id);
    expect(lines).toContain(`widedoor event=agent_result job=${id} status=done`);
    const view = await api.publicApp.request(`/api/scans/${id}`);
    expect(await view.json()).toEqual({ id, status: 'done' });
    const json = await api.publicApp.request(`/api/scans/${id}/report.json`);
    expect(json.status).toBe(200);
    expect(await json.text()).toBe(serializeJson(sent));
    const html = await api.publicApp.request(`/api/scans/${id}/report.html`);
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('<title>Accessibility report</title>');
    // The token is spent: the agent's job is over.
    expect(fly.destroyed).toEqual([`m${id.slice(0, 8)}`]);
  });

  it('a verify job leaves its verification verified', async () => {
    const { api, fly } = await start();
    const created = await publicPost(api, '/api/verifications', { host: HOST });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const check = await publicPost(api, `/api/verifications/${id}/check`);
    expect(check.status).toBe(202);
    await settle();
    const { code, lines } = await agentFor(
      fly,
      stubChild({ status: 'verified', tried: [{ method: 'well_known', ok: true }] }),
    );
    expect(code, lines.join('\n')).toBe(0);
    const view = await api.publicApp.request(`/api/verifications/${id}`);
    expect(((await view.json()) as { status: string }).status).toBe('verified');
  });
});

describe('a report download through a real server', () => {
  it('holds its place while the client stalls, then ends it and its socket at the deadline', async () => {
    const clock = new FakeClock();
    const fly = fakeFly();
    const api = createHostedApi({
      fly: fly.client,
      image: `registry.fly.io/widedoor-scan@sha256:${'0'.repeat(64)}`,
      controlUrl: 'http://127.0.0.1:8081',
      publicOrigin: ORIGIN,
      contactUrl: 'https://contact.example.net/widedoor',
      resolveTier: () => Promise.resolve('verified'),
      now: clock.now,
      schedule: clock.schedule,
    });
    apis.push(api);
    // As api-bin.ts serves it: the node bindings go on to the app.
    const server = createServer(
      getRequestListener((req, env) => api.publicApp.fetch(req, env), {
        overrideGlobalObjects: false,
      }),
    );
    // The server's side of the connection: destroyed is what frees it, whatever the client does.
    let socketClosed = false;
    server.on('connection', (socket) => socket.on('close', () => (socketClosed = true)));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    servers.push(server);
    const taken = api.jobs.submit({
      tier: 'verified',
      profile: '508+wcag21aa',
      target: { kind: 'url', url: `https://${HOST}/`, host: HOST },
    });
    if (!taken.ok) throw new Error('job refused');
    await settle();
    const token = fly.created[0]?.token ?? '';
    // 20 MiB: more than Linux socket buffers can absorb, so the server really stalls.
    const json = serializeJson(report('x'.repeat(20 * 1024 * 1024)));
    const put = await api.controlApp.request(`/internal/jobs/${taken.view.id}/result`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done', reportJson: json }),
    });
    expect(put.status).toBe(204);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      // A client that takes the headers and then reads nothing.
      const port = (server.address() as AddressInfo).port;
      let received = 0;
      const response = await new Promise<import('node:http').IncomingMessage>((done, fail) => {
        const req = httpGet(
          {
            host: '127.0.0.1',
            port,
            path: `/api/scans/${taken.view.id}/report.json`,
            headers: { 'fly-client-ip': IP },
          },
          done,
        );
        req.on('error', () => undefined);
        req.once('error', fail);
      });
      expect(response.statusCode).toBe(200);
      response.pause();
      response.on('data', (chunk: Buffer) => (received += chunk.length));
      response.on('error', () => undefined);
      response.on('aborted', () => undefined);
      // The server writes until the socket's buffers fill, then waits: the place stays held.
      await new Promise((wait) => setTimeout(wait, 300));
      expect(api.inFlightDownloads()).toBe(1);
      expect(socketClosed).toBe(false);
      const deadline = downloadDeadlineFor(Buffer.byteLength(json));
      expect(deadline).toBe(91_000);
      await clock.advance(deadline - 1);
      expect(api.inFlightDownloads()).toBe(1);
      await clock.advance(1);
      // At the deadline: the place is free and the server's socket is destroyed, mid-body.
      expect(api.inFlightDownloads()).toBe(0);
      for (let i = 0; i < 100 && !socketClosed; i++)
        await new Promise((wait) => setTimeout(wait, 20));
      expect(socketClosed).toBe(true);
      expect(received).toBeLessThan(Buffer.byteLength(json));
      // node-server took the early end as a premature close: no console.error.
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      consoleInfo.mockRestore();
    }
  });
});
