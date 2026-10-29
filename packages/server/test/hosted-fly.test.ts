import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  FlyError,
  createFlyClient,
  sweepScanMachines,
  type ScanMachine,
  type ScanMachineSpec,
} from '../src/hosted/fly.js';

const API_TOKEN = 'fo1_apitoken-SECRET-0123456789';
const JOB_TOKEN = 'jobtoken-SECRET-abcdefghij';
const JOB_ID = 'a'.repeat(32);

const spec: ScanMachineSpec = {
  jobId: JOB_ID,
  token: JOB_TOKEN,
  image: 'registry.fly.io/widedoor-scan:deployment-01',
  controlUrl: 'http://widedoor-api.internal:8081',
  contactUrl: 'https://widedoor.example.net/contact',
  tier: 'open',
};

interface Seen {
  method: string;
  path: string;
  query: string;
  auth: string | undefined;
  body: unknown;
}

/** A fake Machines API: a Hono app called through options.fetch, recording every request. */
function fake(
  handler: (c: import('hono').Context) => Response | Promise<Response>,
  apiToken = API_TOKEN,
) {
  const seen: Seen[] = [];
  const app = new Hono();
  app.all('*', async (c) => {
    const text = await c.req.text();
    seen.push({
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      query: new URL(c.req.url).search,
      auth: c.req.header('authorization'),
      body: text === '' ? undefined : JSON.parse(text),
    });
    return await handler(c);
  });
  const redirects: (string | undefined)[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    redirects.push(init?.redirect);
    return app.fetch(new Request(input, init));
  };
  const client = createFlyClient({
    app: 'widedoor-scan',
    apiToken,
    baseUrl: 'http://localhost/v1',
    fetch: fetchFn,
  });
  return { seen, client, redirects };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createScanMachine', () => {
  it('sends exactly the machine config, with the bearer header, to the right path', async () => {
    const { seen, client } = fake(() => json({ id: 'm1234abcd' }));
    await expect(client.createScanMachine(spec)).resolves.toEqual({ id: 'm1234abcd' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.path).toBe('/v1/apps/widedoor-scan/machines');
    expect(seen[0]?.auth).toBe(`Bearer ${API_TOKEN}`);
    expect(seen[0]?.body).toStrictEqual({
      config: {
        image: spec.image,
        guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 },
        auto_destroy: true,
        restart: { policy: 'no' },
        init: { entrypoint: ['/app/docker/scan-entry.sh'] },
        env: {
          WIDEDOOR_CONTROL_URL: spec.controlUrl,
          WIDEDOOR_CONTACT_URL: spec.contactUrl,
          WIDEDOOR_JOB_ID: JOB_ID,
          WIDEDOOR_JOB_TOKEN: JOB_TOKEN,
        },
        metadata: { widedoor_role: 'scan', widedoor_job: JOB_ID, widedoor_tier: 'open' },
      },
    });
    expect(Object.keys((seen[0]?.body as { config: object }).config)).not.toContain('services');
  });

  it.each([
    ['job id', { jobId: 'nope' }],
    ['control URL', { controlUrl: 'ftp://x.internal' }],
    ['control URL with a user name', { controlUrl: 'http://u@x.internal' }],
    ['control URL with a password', { controlUrl: 'http://u:p@x.internal' }],
    ['control URL with a query', { controlUrl: 'http://x.internal/?a=1' }],
    ['control URL with an empty query', { controlUrl: 'http://x.internal/?' }],
    ['control URL with a fragment', { controlUrl: 'http://x.internal/#a' }],
    ['contact URL over http', { contactUrl: 'http://widedoor.example.net/contact' }],
    ['contact URL that is not a URL', { contactUrl: 'contact' }],
    ['contact URL with a user name', { contactUrl: 'https://u@widedoor.example.net/' }],
    ['contact URL with a space', { contactUrl: 'https://widedoor.example.net/a b' }],
    ['mailto contact', { contactUrl: 'mailto:abuse@widedoor.example.net' }],
    ['tier', { tier: 'admin' as unknown as ScanMachineSpec['tier'] }],
    ['empty image', { image: '' }],
    ['image with whitespace', { image: 'a b' }],
    ['empty token', { token: '' }],
    ['token with a space', { token: 'a b' }],
    ['token over 512 characters', { token: 'x'.repeat(513) }],
  ])('refuses a bad %s before any request', async (_name, patch) => {
    const { seen, client } = fake(() => json({ id: 'm1' }));
    const error = await client.createScanMachine({ ...spec, ...patch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlyError);
    expect((error as FlyError).status).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it("creates the machine in the region it is given (the API's own), and only a region code", async () => {
    const { seen, client } = fake(() => json({ id: 'm1' }));
    await client.createScanMachine({ ...spec, region: 'iad' });
    expect((seen[0]?.body as { region?: string }).region).toBe('iad');
    for (const region of ['IAD', 'ia', 'iad1', 'iad ', '']) {
      const error = await client
        .createScanMachine({ ...spec, region })
        .catch((e: unknown) => e as FlyError);
      expect(error, region).toMatchObject({ status: 0, message: 'Fly machine spec: bad region' });
    }
    expect(seen).toHaveLength(1);
  });

  it('refuses a bad app name at the factory', () => {
    for (const app of ['', 'Upper', 'a/b', 'a'.repeat(64), '-a', 'a-']) {
      expect(() => createFlyClient({ app, apiToken: API_TOKEN })).toThrow(FlyError);
    }
    expect(() => createFlyClient({ app: 'a', apiToken: API_TOKEN })).not.toThrow();
    expect(() => createFlyClient({ app: 'a-b', apiToken: API_TOKEN })).not.toThrow();
  });

  it('accepts https, and http only for _api.internal and loopback hosts', () => {
    const ok = [
      undefined,
      'https://api.machines.dev/v1',
      'http://_api.internal:4280',
      'http://127.0.0.1:8080/v1',
      'http://[::1]:8080/v1',
      'http://localhost:8080/v1',
    ];
    for (const baseUrl of ok) {
      expect(() =>
        createFlyClient({ app: 'a', apiToken: API_TOKEN, ...(baseUrl ? { baseUrl } : {}) }),
      ).not.toThrow();
    }
    const bad = [
      'http://api.machines.dev/v1',
      'http://evil.example',
      'http://localhost.evil.example',
      'ftp://api.machines.dev',
      'https://u:p@api.machines.dev',
      'not a url',
    ];
    for (const baseUrl of bad) {
      const error = (() => {
        try {
          createFlyClient({ app: 'a', apiToken: API_TOKEN, baseUrl });
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(FlyError);
      expect((error as FlyError).status).toBe(0);
    }
  });

  it('fails when the answer holds no machine id', async () => {
    const { client } = fake(() => json({ nope: true }));
    await expect(client.createScanMachine(spec)).rejects.toMatchObject({ status: 200 });
  });
});

describe('destroy', () => {
  it('uses force=true and encodes the path', async () => {
    const { seen, client } = fake(() => json({ ok: true }));
    await client.destroy('m1234abcd');
    expect(seen[0]?.method).toBe('DELETE');
    expect(seen[0]?.path).toBe('/v1/apps/widedoor-scan/machines/m1234abcd');
    expect(seen[0]?.query).toBe('?force=true');
  });

  it('treats 404 as success and says so', async () => {
    const { client } = fake(() => json({ error: 'not found' }, 404));
    await expect(client.destroy('m1234abcd')).resolves.toEqual({ status: 404 });
  });

  it('reports any 2xx as 200', async () => {
    for (const code of [200, 202]) {
      const { client } = fake(() => json({ ok: true }, code));
      await expect(client.destroy('m1234abcd')).resolves.toEqual({ status: 200 });
    }
  });

  it('surfaces other failures', async () => {
    const { client } = fake(() => json({ error: 'boom' }, 500));
    await expect(client.destroy('m1234abcd')).rejects.toMatchObject({ status: 500 });
  });

  it('refuses a bad machine id before any request', async () => {
    const { seen, client } = fake(() => json({}));
    for (const id of ['', '../x', 'a b', 'x'.repeat(65), 'm1?force=false']) {
      await expect(client.destroy(id)).rejects.toMatchObject({ status: 0 });
    }
    expect(seen).toHaveLength(0);
  });
});

describe('listScanMachines', () => {
  it('filters by role, maps fields and drops non-scan and malformed entries', async () => {
    const meta = (role: string, job: string) => ({
      metadata: { widedoor_role: role, widedoor_job: job },
    });
    const { seen, client } = fake(() =>
      json([
        {
          id: 'm1',
          state: 'started',
          created_at: '2026-10-27T10:00:00Z',
          config: meta('scan', 'j1'),
        },
        {
          id: 'm2',
          state: 'started',
          created_at: '2026-10-27T10:00:00Z',
          config: meta('api', 'j2'),
        },
        { id: 'm3', state: 'started', config: meta('scan', 'j3') },
        {
          id: '../x',
          state: 'started',
          created_at: '2026-10-27T10:00:00Z',
          config: meta('scan', 'j7'),
        },
        { state: 'started', created_at: '2026-10-27T10:00:00Z', config: meta('scan', 'j4') },
        { id: 'm5', state: 'started', created_at: '2026-10-27T10:00:00Z' },
        'junk',
        null,
        {
          id: 'm6',
          state: 'stopped',
          created_at: '2026-10-27T11:00:00Z',
          config: meta('scan', 'j6'),
        },
      ]),
    );
    await expect(client.listScanMachines()).resolves.toEqual([
      { id: 'm1', createdAt: '2026-10-27T10:00:00Z', jobId: 'j1', state: 'started' },
      { id: 'm6', createdAt: '2026-10-27T11:00:00Z', jobId: 'j6', state: 'stopped' },
    ]);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.path).toBe('/v1/apps/widedoor-scan/machines');
    expect(seen[0]?.query).toBe('?metadata.widedoor_role=scan');
  });

  it('counts the machines without widedoor_role from the unfiltered list', async () => {
    const { seen, client } = fake(() =>
      json([
        { id: 'm1', config: { metadata: { widedoor_role: 'scan' } } },
        { id: 'm2', config: { metadata: { widedoor_role: 'other' } } },
        { id: 'm3', config: {} },
        { id: 'm4' },
        'junk',
      ]),
    );
    await expect(client.countForeignMachines()).resolves.toBe(4);
    expect(seen[0]).toMatchObject({
      method: 'GET',
      path: '/v1/apps/widedoor-scan/machines',
      query: '',
    });
    const bad = fake(() => json({ not: 'a list' }));
    await expect(bad.client.countForeignMachines()).rejects.toMatchObject({ status: 200 });
  });

  it('throws with the response status when the body is not an array', async () => {
    const { client } = fake(() => json({ machines: [] }));
    await expect(client.listScanMachines()).rejects.toMatchObject({ status: 200 });
  });
});

describe('errors', () => {
  it.each([429, 503])('surfaces %i as a FlyError with that status', async (status) => {
    const { client } = fake(() => json({ error: 'slow down' }, status));
    const error = await client.listScanMachines().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlyError);
    expect((error as FlyError).status).toBe(status);
    expect((error as FlyError).message).toBe(`Fly API ${status}: slow down`);
  });

  it('redacts both tokens from an error body that echoes them', async () => {
    const { client } = fake(() =>
      json({ error: `bad config ${JOB_TOKEN} for ${API_TOKEN} and again ${JOB_TOKEN}` }, 422),
    );
    const error = (await client.createScanMachine(spec).catch((e: unknown) => e)) as FlyError;
    expect(error.status).toBe(422);
    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain(JOB_TOKEN);
    expect(error.message).not.toContain(API_TOKEN);
    expect(error.stack).not.toContain(JOB_TOKEN);
    expect(error.cause).toBeUndefined();
  });

  describe('a FlyV1 deploy token', () => {
    const PART1 = `fm2_${'a'.repeat(300)}`;
    const PART2 = `fm2_${'b'.repeat(300)}`;
    const FLY_V1 = `FlyV1 ${PART1},${PART2}`;

    it('is sent whole as the bearer token', async () => {
      const { client, seen } = fake(() => json([]), FLY_V1);
      await client.listScanMachines();
      expect(seen[0]?.auth).toBe(`Bearer ${FLY_V1}`);
    });

    it.each([
      ['the whole token', FLY_V1],
      ['the part after FlyV1', `${PART1},${PART2}`],
      ['the first part', PART1],
      ['the second part', PART2],
    ])('is redacted when an error echoes %s', async (_name, echoed) => {
      const { client } = fake(() => json({ error: `token ${echoed} refused` }, 401), FLY_V1);
      const error = (await client.listScanMachines().catch((e: unknown) => e)) as FlyError;
      expect(error.status).toBe(401);
      expect(error.message).toContain('[REDACTED]');
      expect(error.message).not.toContain('fm2_');
      expect(error.message).not.toContain('aaaa');
      expect(error.message).not.toContain('bbbb');
    });
  });

  describe('a token with characters that escape', () => {
    const JOB = 'ab"c\\d%e<>&x-job';
    const API = 'fo1"api\\z%q<>&y-api';
    const goEscape = (value: string) =>
      JSON.stringify(value)
        .slice(1, -1)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
    const forms = (value: string) => [
      value,
      JSON.stringify(value).slice(1, -1),
      goEscape(value),
      encodeURIComponent(value),
    ];
    const bodies: [string, () => Response][] = [
      [
        'a JSON body without error',
        () => json({ config: { env: { WIDEDOOR_JOB_TOKEN: JOB, key: API } } }, 422),
      ],
      ['a JSON body with error', () => json({ error: `bad ${JOB} and ${API}` }, 422)],
      [
        'a Go-escaped JSON body',
        () =>
          new Response(`{"error":"bad ${goEscape(JOB)} and ${goEscape(API)}"}`, { status: 422 }),
      ],
      [
        'a JSON body whose error holds percent-encoded forms',
        () => json({ error: `bad ${encodeURIComponent(JOB)} and ${encodeURIComponent(API)}` }, 422),
      ],
      [
        'a non-JSON body',
        () =>
          new Response(`bad ${JOB} ${encodeURIComponent(JOB)} and ${API} ${goEscape(API)}`, {
            status: 422,
          }),
      ],
    ];
    it.each(bodies)('is redacted from %s', async (_name, respond) => {
      const { client } = fake(respond, API);
      const error = (await client
        .createScanMachine({ ...spec, token: JOB })
        .catch((e: unknown) => e)) as FlyError;
      expect(error.status).toBe(422);
      for (const form of [...forms(JOB), ...forms(API)]) {
        expect(error.message).not.toContain(form);
        expect(error.stack).not.toContain(form);
      }
    });
  });

  it('redacts a non-JSON body, escapes it and cuts it to exactly 300 characters', async () => {
    const { client } = fake(
      () =>
        new Response(`<b>${JOB_TOKEN}</b>${API_TOKEN}\u0007${'x'.repeat(1000)}`, { status: 502 }),
    );
    const error = (await client.createScanMachine(spec).catch((e: unknown) => e)) as FlyError;
    expect(error.message).not.toContain(JOB_TOKEN);
    expect(error.message).not.toContain(API_TOKEN);
    expect(error.message).not.toContain('\u0007');
    expect(error.message).toContain('[REDACTED]');
    expect(error.message.startsWith('Fly API 502: ')).toBe(true);
    expect(Array.from(error.message).length).toBe('Fly API 502: '.length + 300);
  });

  it('never follows a redirect: every call sends redirect manual', async () => {
    const { client, redirects } = fake((c) =>
      c.req.method === 'POST' ? json({ id: 'm1' }) : json([]),
    );
    await client.createScanMachine(spec);
    await client.listScanMachines();
    await client.destroy('m1');
    expect(redirects).toEqual(['manual', 'manual', 'manual']);
  });

  it('turns a 302 into a FlyError after exactly one request', async () => {
    const { seen, client } = fake(
      () => new Response(null, { status: 302, headers: { location: 'http://evil.example/x' } }),
    );
    const error = (await client.listScanMachines().catch((e: unknown) => e)) as FlyError;
    expect(error).toBeInstanceOf(FlyError);
    expect(error.status).toBe(302);
    expect(seen).toHaveLength(1);
  });

  it('gives a fixed message on a network failure, never the underlying text', async () => {
    const client = createFlyClient({
      app: 'widedoor-scan',
      apiToken: API_TOKEN,
      fetch: () => Promise.reject(new Error(`connect failed with ${API_TOKEN}`)),
    });
    const error = (await client.listScanMachines().catch((e: unknown) => e)) as FlyError;
    expect(error.status).toBe(0);
    expect(error.message).toBe('Fly API unreachable');
    expect(error.cause).toBeUndefined();
  });

  it('times out against a server that never answers', async () => {
    const client = createFlyClient({
      app: 'widedoor-scan',
      apiToken: API_TOKEN,
      timeoutMs: 50,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const error = (await client.listScanMachines().catch((e: unknown) => e)) as FlyError;
    expect(error).toBeInstanceOf(FlyError);
    expect(error.status).toBe(0);
    expect(error.message).toBe('Fly API timed out');
  });

  it('times out even when the injected fetch ignores the signal', async () => {
    const client = createFlyClient({
      app: 'widedoor-scan',
      apiToken: API_TOKEN,
      timeoutMs: 50,
      fetch: () => new Promise<Response>(() => undefined),
    });
    const error = (await client.listScanMachines().catch((e: unknown) => e)) as FlyError;
    expect(error).toBeInstanceOf(FlyError);
    expect(error.status).toBe(0);
    expect(error.message).toBe('Fly API timed out');
  });

  it('times out on a body that never finishes and ignores the signal', async () => {
    const client = createFlyClient({
      app: 'widedoor-scan',
      apiToken: API_TOKEN,
      timeoutMs: 50,
      fetch: () => Promise.resolve(new Response(new ReadableStream({ start: () => undefined }))),
    });
    const error = (await client.listScanMachines().catch((e: unknown) => e)) as FlyError;
    expect(error.message).toBe('Fly API timed out');
  });

  it('caps an error body at 1 MiB with a fixed message', async () => {
    const { client } = fake(() => new Response('x'.repeat(1024 * 1024 + 1), { status: 502 }));
    const error = (await client.listScanMachines().catch((e: unknown) => e)) as FlyError;
    expect(error.status).toBe(502);
    expect(error.message).toBe('Fly API 502: response too large');
  });

  it('caps a list body at 1 MiB and reads a body of exactly 1 MiB', async () => {
    const big = fake(() => new Response('['.padEnd(1024 * 1024 + 1, ' ')));
    await expect(big.client.listScanMachines()).rejects.toMatchObject({ status: 200 });
    const edge = fake(() => new Response('[]'.padEnd(1024 * 1024, ' ')));
    await expect(edge.client.listScanMachines()).resolves.toEqual([]);
  });

  it('times out when the headers arrive but the body never finishes', async () => {
    const client = createFlyClient({
      app: 'widedoor-scan',
      apiToken: API_TOKEN,
      timeoutMs: 50,
      fetch: (_input, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener('abort', () => controller.error(new Error('x')));
              },
            }),
            { status: 200 },
          ),
        ),
    });
    const error = (await client.listScanMachines().catch((e: unknown) => e)) as FlyError;
    expect(error).toBeInstanceOf(FlyError);
    expect(error.status).toBe(0);
    expect(error.message).toBe('Fly API timed out');
  });
});

describe('sweepScanMachines', () => {
  const NOW = Date.parse('2026-10-27T12:00:00Z');
  const HOUR = 3_600_000;

  it('destroys only older machines, skips a bad date, survives a failed destroy and counts', async () => {
    const listed = [
      { id: 'old1', createdAt: '2026-10-27T08:00:00Z', jobId: 'j', state: 'started' },
      { id: 'young', createdAt: '2026-10-27T11:30:00Z', jobId: 'j', state: 'started' },
      { id: 'baddate', createdAt: 'not a date', jobId: 'j', state: 'started' },
      { id: 'fails', createdAt: '2026-10-27T07:00:00Z', jobId: 'j', state: 'started' },
      { id: 'old2', createdAt: '2026-10-27T06:00:00Z', jobId: 'j', state: 'stopped' },
    ];
    const destroyed: string[] = [];
    const client = {
      createScanMachine: () => Promise.reject(new Error('unused')),
      listScanMachines: () => Promise.resolve(listed),
      destroy: (id: string) => {
        if (id === 'fails') return Promise.reject(new FlyError(500, 'Fly API 500: boom'));
        destroyed.push(id);
        return Promise.resolve({ status: 200 as const });
      },
    };
    await expect(sweepScanMachines(client, NOW, 2 * HOUR)).resolves.toBe(2);
    expect(destroyed).toEqual(['old1', 'old2']);
  });

  it('reports each failed destroy once, and ignores a throwing callback', async () => {
    const listed = ['a1', 'b2', 'c3'].map((id) => ({
      id,
      createdAt: '2026-10-27T01:00:00Z',
      jobId: 'j',
      state: 's',
    }));
    const client = {
      createScanMachine: () => Promise.reject(new Error('unused')),
      listScanMachines: () => Promise.resolve(listed),
      destroy: (id: string) =>
        id === 'a1'
          ? Promise.resolve({ status: 200 as const })
          : Promise.reject(new FlyError(503, 'Fly API 503: x')),
    };
    const failures: [string, number][] = [];
    const count = await sweepScanMachines(client, NOW, HOUR, (id, error) => {
      failures.push([id, error.status]);
      throw new Error('callback failed');
    });
    expect(count).toBe(1);
    expect(failures).toEqual([
      ['b2', 503],
      ['c3', 503],
    ]);
  });

  it('in an all sweep destroys every machine of any age or date, but those it keeps', async () => {
    const listed: ScanMachine[] = [
      { id: 'mnew', createdAt: new Date(NOW).toISOString(), jobId: 'a', state: 'started' },
      { id: 'mbad', createdAt: 'not a date', jobId: 'b', state: 'started' },
      { id: 'mkeep', createdAt: new Date(NOW).toISOString(), jobId: 'mine', state: 'started' },
    ];
    const destroyed: string[] = [];
    const client = {
      listScanMachines: () => Promise.resolve(listed),
      destroy: (id: string) => {
        destroyed.push(id);
        return Promise.resolve({ status: 200 as const });
      },
    };
    await expect(
      sweepScanMachines(client, NOW, HOUR, undefined, {
        all: true,
        keep: (machine) => machine.jobId === 'mine',
      }),
    ).resolves.toBe(2);
    expect(destroyed).toEqual(['mnew', 'mbad']);
  });

  it('destroys at most 50 machines per call', async () => {
    const listed = Array.from({ length: 60 }, (_v, i) => ({
      id: `m${i}`,
      createdAt: '2026-10-27T01:00:00Z',
      jobId: 'j',
      state: 's',
    }));
    const destroyed: string[] = [];
    const client = {
      createScanMachine: () => Promise.reject(new Error('unused')),
      listScanMachines: () => Promise.resolve(listed),
      destroy: (id: string) => {
        destroyed.push(id);
        return Promise.resolve({ status: 200 as const });
      },
    };
    await expect(sweepScanMachines(client, NOW, HOUR)).resolves.toBe(50);
    expect(destroyed).toHaveLength(50);
    expect(destroyed[49]).toBe('m49');
  });

  it('propagates a list failure', async () => {
    const client = {
      createScanMachine: () => Promise.reject(new Error('unused')),
      listScanMachines: () => Promise.reject(new FlyError(503, 'Fly API 503: x')),
      destroy: () => Promise.resolve({ status: 200 as const }),
    };
    await expect(sweepScanMachines(client, NOW, HOUR)).rejects.toMatchObject({ status: 503 });
  });

  it.each([
    ['now is NaN', Number.NaN, HOUR],
    ['now is Infinity', Number.POSITIVE_INFINITY, HOUR],
    ['maxAgeMs is NaN', NOW, Number.NaN],
    ['maxAgeMs is Infinity', NOW, Number.POSITIVE_INFINITY],
    ['maxAgeMs is zero', NOW, 0],
    ['maxAgeMs is negative', NOW, -1],
  ])('destroys nothing when %s', async (_name, now, maxAge) => {
    const client = {
      createScanMachine: () => Promise.reject(new Error('unused')),
      listScanMachines: () =>
        Promise.resolve([{ id: 'old', createdAt: '2000-01-01T00:00:00Z', jobId: 'j', state: 's' }]),
      destroy: () => Promise.reject(new Error('must not be called')),
    };
    await expect(sweepScanMachines(client, now, maxAge)).resolves.toBe(0);
  });

  it('skips loose date formats', async () => {
    const dates = [
      '1',
      '2026',
      '2026-10-27',
      '2026-10-27T01:00:00',
      'Oct 27 2026',
      '',
      '2026-10-27T01:00:00.5+00:00',
    ];
    const destroyed: string[] = [];
    const client = {
      createScanMachine: () => Promise.reject(new Error('unused')),
      listScanMachines: () =>
        Promise.resolve(
          dates.map((createdAt, i) => ({ id: `m${i}`, createdAt, jobId: 'j', state: 's' })),
        ),
      destroy: (id: string) => {
        destroyed.push(id);
        return Promise.resolve({ status: 200 as const });
      },
    };
    await expect(sweepScanMachines(client, NOW, HOUR)).resolves.toBe(1);
    expect(destroyed).toEqual(['m6']);
  });

  it('does not destroy a machine exactly at the age limit', async () => {
    const client = {
      createScanMachine: () => Promise.reject(new Error('unused')),
      listScanMachines: () =>
        Promise.resolve([
          { id: 'edge', createdAt: '2026-10-27T10:00:00Z', jobId: 'j', state: 's' },
        ]),
      destroy: () => Promise.reject(new Error('must not be called')),
    };
    await expect(sweepScanMachines(client, NOW, 2 * HOUR)).resolves.toBe(0);
  });
});
