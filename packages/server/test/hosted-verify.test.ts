import { afterEach, describe, expect, it } from 'vitest';
import { PinnedResolver } from '@widedoor/web/egress';
import {
  BAD_HOST,
  MACHINE_CHECK_RATE,
  MAX_VERIFY_RESULT_BYTES,
  SELF_SCAN,
  createHostedApi,
  type HostedApi,
  type HostedApiOptions,
} from '../src/hosted/api.ts';
import { caresTxtLookup, type TxtResolver } from '../src/hosted/dns.ts';
import { BUSY, BUSY_NETWORK, UNREADABLE } from '../src/hosted/jobs.ts';
import {
  VERIFY_COOLDOWN_MS,
  VERIFY_DAILY_CAP,
  VERIFY_WALL_CLOCK_MS,
} from '../src/hosted/limits.ts';
import { JobInputSchema } from '../src/hosted/protocol.ts';
import { logPrefix } from '../src/hosted/rate-limit.ts';
import {
  CHECK_UNFINISHED,
  DNS_FAILED,
  EXPIRED,
  MAX_VERIFICATIONS,
  NOT_FOUND,
  NOT_VERIFIED,
  NO_TXT,
  OTHER_HOST,
  TXT_MISMATCH,
  VERIFY_RECORD_MS,
  VERIFY_VALID_MS,
  Verifications,
} from '../src/hosted/verify.ts';
import { FakeClock, fakeFly, settle } from './hosted-api-fixtures.ts';

/*
 * Domain verification on the API (Task 11) with a fake Fly client, a fake TXT
 * lookup and a fake clock: creating one and the methods it names, the host
 * rules, DNS TXT on the API, the verify job for the HTTP methods and the
 * results it may send, expiry, the tier a scan takes, the rate limits, and
 * what never leaves: the token after creation, in any answer or log line.
 */

const ORIGIN = 'https://widedoor.example.net';
const IMAGE = 'registry.fly.io/widedoor-scan:deployment-01';
const CONTROL = 'http://[fdaa:0:1::2]:8081';
const PUBLIC_V4 = '93.184.215.14';
const HOST = 'site.example.org';
const IP = '198.51.100.7';
const NAMES: Record<string, string[]> = {
  [HOST]: [PUBLIC_V4],
  'example.org': [PUBLIC_V4],
  'www.example.org': [PUBLIC_V4],
  'a.example.org': [PUBLIC_V4],
};

let opened: HostedApi[] = [];
afterEach(() => {
  for (const api of opened) api.stop();
  opened = [];
});

/** A TXT lookup whose answer the test sets: records, a DNS error code, or a hold. */
function fakeTxt() {
  const state = {
    asked: [] as string[],
    records: [] as string[][],
    error: undefined as string | undefined,
    held: [] as (() => void)[],
    hold: false,
  };
  const resolveTxt = (name: string): Promise<string[][]> => {
    state.asked.push(name);
    const answer = () =>
      state.error === undefined
        ? Promise.resolve(state.records)
        : Promise.reject(
            Object.assign(new Error(`query failed ${state.error}`), { code: state.error }),
          );
    if (!state.hold) return answer();
    return new Promise((done, fail) => state.held.push(() => void answer().then(done, fail)));
  };
  // The real lookup over a fake c-ares Resolver, so its reading of DNS errors is used.
  const lookup = caresTxtLookup(() => ({ resolveTxt: resolveTxt as TxtResolver['resolveTxt'] }));
  return { state, lookup };
}

function setup(extra: Partial<HostedApiOptions> = {}) {
  const clock = new FakeClock();
  const fly = fakeFly();
  const txt = fakeTxt();
  const lines: string[] = [];
  const api = createHostedApi({
    fly: fly.client,
    image: IMAGE,
    controlUrl: CONTROL,
    publicOrigin: ORIGIN,
    resolver: () =>
      new PinnedResolver({
        lookup: (host) =>
          Promise.resolve((NAMES[host] ?? []).map((address) => ({ address, family: 4 as const }))),
      }),
    txtLookup: txt.lookup,
    trustMissingClientIp: true,
    now: clock.now,
    schedule: clock.schedule,
    log: (line) => void lines.push(line),
    ...extra,
  });
  opened.push(api);
  return { api, clock, fly, txt, lines };
}

type Setup = ReturnType<typeof setup>;
type Api = Setup['api'];

interface Created {
  id: string;
  host: string;
  token: string;
  expiresAt: string;
  methods: unknown;
}

const postJson = (api: Api, path: string, body: unknown, headers: Record<string, string> = {}) =>
  api.publicApp.request(path, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'fly-client-ip': IP,
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const create = (api: Api, host: unknown = HOST, headers: Record<string, string> = {}) =>
  postJson(api, '/api/verifications', { host }, headers);

async function created(api: Api, host = HOST): Promise<Created> {
  const res = await create(api, host);
  expect(res.status).toBe(201);
  return (await res.json()) as Created;
}

const check = (api: Api, id: string, headers: Record<string, string> = {}) =>
  api.publicApp.request(`/api/verifications/${id}/check`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'fly-client-ip': IP, ...headers },
  });

const read = async (api: Api, id: string) => {
  const res = await api.publicApp.request(`/api/verifications/${id}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const scan = (api: Api, url: string, verificationId?: string) =>
  postJson(api, '/api/scans', { url, ...(verificationId !== undefined ? { verificationId } : {}) });

const control = (api: Api, id: string, route: 'input' | 'result', token: string, body?: unknown) =>
  api.controlApp.request(`/internal/jobs/${id}/${route}`, {
    method: route === 'result' ? 'PUT' : 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const VERIFIED_BY_FILE = { status: 'verified', tried: [{ method: 'well_known', ok: true }] };
const NOT_VERIFIED_RESULT = {
  status: 'not_verified',
  tried: [
    { method: 'well_known', ok: false, reason: 'the site answered 404' },
    { method: 'meta_tag', ok: false, reason: 'the page has no matching meta tag' },
  ],
};

/** A verification checked by its verify job, which sends `result`. */
async function checkedByJob(s: Setup, result: unknown, host = HOST) {
  const v = await created(s.api, host);
  expect((await check(s.api, v.id)).status).toBe(202);
  await settle();
  const spec = s.fly.created.at(-1);
  const put = await control(s.api, spec?.jobId ?? '', 'result', spec?.token ?? '', result);
  await settle();
  return { v, spec, put };
}

/** A verification made verified by DNS TXT. */
async function verifiedByDns(s: Setup, host = HOST) {
  const v = await created(s.api, host);
  s.txt.state.records = [[`widedoor-verification=${v.token}`]];
  expect((await check(s.api, v.id)).status).toBe(200);
  s.txt.state.records = [];
  return v;
}

describe('POST /api/verifications', () => {
  it('gives an id, the host, a token, the expiry and the three methods exactly', async () => {
    const { api, clock, lines } = setup();
    const v = await created(api);
    expect(v.id).toMatch(/^[0-9a-f]{32}$/);
    expect(v.token).toMatch(/^[0-9a-f]{32}$/);
    expect(v.token).not.toBe(v.id);
    expect(v).toEqual({
      id: v.id,
      host: HOST,
      token: v.token,
      expiresAt: new Date(clock.t + 24 * 60 * 60_000).toISOString(),
      methods: {
        dnsTxt: { name: `_widedoor-challenge.${HOST}`, value: `widedoor-verification=${v.token}` },
        metaTag: `<meta name="widedoor-verification" content="${v.token}">`,
        wellKnown: { url: `https://${HOST}/.well-known/widedoor.txt`, body: v.token },
      },
    });
    expect(lines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^widedoor event=verify_created host=${HOST} ip=${logPrefix(IP)} vref=[0-9a-f]{12}$`,
        ),
      ),
    );
  });

  it.each([
    ['a port', 'site.example.org:443'],
    ['a path', 'site.example.org/admin'],
    ['a scheme', 'https://site.example.org'],
    ['user info', 'user@site.example.org'],
    ['an IPv4 literal', PUBLIC_V4],
    ['an IPv6 literal', '[2606:2800:220:1::1]'],
    ['a numeric form the URL parser reads as IPv4', '0x7f.1'],
    ['an empty host', ''],
    ['a space', 'site example.org'],
  ])('refuses a host with %s (400) and creates nothing', async (_, host) => {
    const { api, lines } = setup();
    const res = await create(api, host);
    expect(res.status).toBe(400);
    if (host !== '') expect(((await res.json()) as { error: string }).error).toBe(BAD_HOST);
    expect(api.verifications.size).toBe(0);
    // The host as given is never logged.
    if (host !== '') expect(lines.join('\n')).not.toContain(host);
  });

  it('refuses a host the egress policy refuses', async () => {
    const { api } = setup();
    for (const host of ['localhost', 'printer.local', 'intranet', 'metadata.internal']) {
      const res = await create(api, host);
      expect(res.status).toBe(400);
    }
    expect(api.verifications.size).toBe(0);
  });

  it("refuses Widedoor's own host and any .fly.dev host", async () => {
    const { api } = setup();
    for (const host of ['widedoor.example.net', 'WIDEDOOR.example.net.', 'widedoor.fly.dev']) {
      const res = await create(api, host);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(SELF_SCAN);
    }
  });

  it('normalizes case, one trailing dot and an IDN', async () => {
    const { api } = setup();
    expect((await created(api, 'Site.Example.ORG.')).host).toBe(HOST);
    expect((await created(api, 'bücher.example.org')).host).toBe('xn--bcher-kva.example.org');
    expect((await create(api, 'site.example.org..')).status).toBe(400);
  });

  it('takes JSON { host } only', async () => {
    const { api } = setup();
    expect((await postJson(api, '/api/verifications', { host: HOST, extra: 1 })).status).toBe(400);
    expect((await postJson(api, '/api/verifications', { host: 7 })).status).toBe(400);
  });

  it('needs the public Origin (403) and a Fly-Client-IP in production (400)', async () => {
    const { api } = setup();
    expect((await create(api, HOST, { origin: 'https://evil.example.com' })).status).toBe(403);
    const prod = setup({ trustMissingClientIp: false });
    const res = await prod.api.publicApp.request('/api/verifications', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ host: HOST }),
    });
    expect(res.status).toBe(400);
    expect(api.verifications.size + prod.api.verifications.size).toBe(0);
  });
});

describe('GET /api/verifications/:id', () => {
  it('gives the state and never the token; 404 for an unknown id', async () => {
    const { api } = setup();
    const v = await created(api);
    const { status, body } = await read(api, v.id);
    expect(status).toBe(200);
    expect(body).toEqual({ id: v.id, host: HOST, status: 'pending', expiresAt: v.expiresAt });
    expect((await read(api, 'f'.repeat(32))).status).toBe(404);
    expect((await read(api, 'not-an-id')).status).toBe(404);
  });

  it('reads expired (410) 24 hours after issue, and forgets it a day later', async () => {
    const { api, clock } = setup();
    const v = await created(api);
    await clock.advance(VERIFY_VALID_MS - 1);
    expect((await read(api, v.id)).body.status).toBe('pending');
    await clock.advance(1);
    expect(await read(api, v.id)).toMatchObject({ status: 410, body: { status: 'expired' } });
    expect((await check(api, v.id)).status).toBe(410);
    await clock.advance(VERIFY_RECORD_MS);
    expect((await read(api, v.id)).status).toBe(404);
  });
});

describe('POST /api/verifications/:id/check: DNS TXT on the API', () => {
  it('verifies by DNS TXT alone with no machine started', async () => {
    const s = setup();
    const v = await created(s.api);
    s.txt.state.records = [['v=spf1 -all'], [`widedoor-verification=${v.token}`]];
    const res = await check(s.api, v.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'verified' });
    expect(s.txt.state.asked).toEqual([`_widedoor-challenge.${HOST}`]);
    await settle();
    expect(s.fly.created).toHaveLength(0);
    expect((await read(s.api, v.id)).body).toMatchObject({
      status: 'verified',
      tried: [{ method: 'dns_txt', ok: true }],
    });
    expect(s.lines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^widedoor event=verify_checked method=dns_txt ok=true host=${HOST} ip=${logPrefix(IP)} vref=[0-9a-f]{12}$`,
        ),
      ),
    );
  });

  it('joins the chunks of a split TXT record', async () => {
    const s = setup();
    const v = await created(s.api);
    s.txt.state.records = [['widedoor-verification=', v.token.slice(0, 10), v.token.slice(10)]];
    expect((await check(s.api, v.id)).status).toBe(200);
  });

  it('reads no record, a wrong token and a DNS failure each in its own words', async () => {
    for (const [records, error, reason] of [
      [[], undefined, NO_TXT],
      [[['widedoor-verification=' + 'f'.repeat(32)]], undefined, TXT_MISMATCH],
      [[], 'ENOTFOUND', NO_TXT],
      [[], 'ESERVFAIL', DNS_FAILED],
      [[], 'ETIMEOUT', DNS_FAILED],
    ] as const) {
      const s = setup();
      const v = await created(s.api);
      s.txt.state.records = records.map((r) => [...r]);
      s.txt.state.error = error;
      expect((await check(s.api, v.id)).status).toBe(202);
      expect((await read(s.api, v.id)).body).toMatchObject({
        status: 'checking',
        tried: [{ method: 'dns_txt', ok: false, reason }],
      });
    }
  });

  it('answers a verified verification at once, without a lookup or a job', async () => {
    const s = setup();
    const v = await verifiedByDns(s);
    const asked = s.txt.state.asked.length;
    const res = await check(s.api, v.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'verified' });
    expect(s.txt.state.asked).toHaveLength(asked);
    expect(s.fly.created).toHaveLength(0);
  });

  it('answers 404 for an unknown id and 403 without the Origin', async () => {
    const s = setup();
    expect((await check(s.api, 'f'.repeat(32))).status).toBe(404);
    const v = await created(s.api);
    expect((await check(s.api, v.id, { origin: 'https://evil.example.com' })).status).toBe(403);
    expect(s.txt.state.asked).toEqual([]);
  });

  it('caps TXT lookups at 4 at once: the 5th check gets 503 and spends no rate token', async () => {
    const s = setup();
    s.txt.state.hold = true;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await created(s.api)).id);
    const pending = ids.slice(0, 4).map((id) => check(s.api, id));
    await settle();
    expect(s.txt.state.asked).toHaveLength(4);
    const busy = await check(s.api, ids[4] ?? '');
    expect(busy.status).toBe(503);
    expect(((await busy.json()) as { error: string }).error).toBe(BUSY);
    expect((await read(s.api, ids[4] ?? '')).body.status).toBe('pending');
    s.txt.state.held.splice(0).forEach((go) => go());
    await Promise.all(pending);
    // 5 creates and 4 checks so far: 21 more requests fit in the hour, the 22nd does not.
    s.txt.state.hold = false;
    for (let i = 0; i < 21; i++) expect((await create(s.api)).status).toBe(201);
    expect((await create(s.api)).status).toBe(429);
  });
});

describe('the verify job', () => {
  it('starts exactly one job on no TXT match, and a second check starts nothing', async () => {
    const s = setup();
    const v = await created(s.api);
    const first = await check(s.api, v.id);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: 'checking' });
    await settle();
    expect(s.fly.created).toHaveLength(1);
    const again = await check(s.api, v.id);
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ status: 'checking' });
    await settle();
    expect(s.fly.created).toHaveLength(1);
    expect(s.txt.state.asked).toHaveLength(1);
    // The scan's image and size; the input carries the host and the token, nothing else.
    const spec = s.fly.created[0];
    expect(spec).toMatchObject({ image: IMAGE, controlUrl: CONTROL, tier: 'open' });
    const input = await (
      await control(s.api, spec?.jobId ?? '', 'input', spec?.token ?? '')
    ).json();
    expect(JobInputSchema.parse(input).target).toEqual({
      kind: 'verify',
      host: HOST,
      token: v.token,
    });
  });

  it('marks the verification verified when the job verifies it, and destroys the machine', async () => {
    const s = setup();
    const { v, spec, put } = await checkedByJob(s, VERIFIED_BY_FILE);
    expect(put.status).toBe(204);
    expect((await read(s.api, v.id)).body).toMatchObject({
      status: 'verified',
      tried: [
        { method: 'dns_txt', ok: false, reason: NO_TXT },
        { method: 'well_known', ok: true },
      ],
    });
    expect(s.fly.destroyed).toEqual([`m${spec?.jobId.slice(0, 8)}`]);
    expect(s.lines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^widedoor event=verify_checked method=well_known ok=true host=${HOST} ip=${logPrefix(IP)} vref=[0-9a-f]{12}$`,
        ),
      ),
    );
    expect(
      s.lines.some((l) => l.startsWith(`widedoor event=verify_job_done job=${spec?.jobId}`)),
    ).toBe(true);
    expect(s.lines.some((l) => l.startsWith('widedoor event=scan_'))).toBe(false);
  });

  it('stores every method tried when the job does not verify it', async () => {
    const s = setup();
    const { v } = await checkedByJob(s, NOT_VERIFIED_RESULT);
    expect((await read(s.api, v.id)).body).toMatchObject({
      status: 'failed',
      tried: [{ method: 'dns_txt', ok: false, reason: NO_TXT }, ...NOT_VERIFIED_RESULT.tried],
    });
    // Another check may follow once the cooldown has passed, and starts a new job.
    await s.clock.advance(VERIFY_COOLDOWN_MS);
    expect((await check(s.api, v.id)).status).toBe(202);
    await settle();
    expect(s.fly.created).toHaveLength(2);
  });

  it('fails a verify job that sends a scan result, and a scan job that sends a verification', async () => {
    const s = setup();
    const report = { status: 'done', reportJson: '{}' };
    const { v, put } = await checkedByJob(s, report);
    expect(put.status).toBe(400);
    expect((await read(s.api, v.id)).body).toMatchObject({
      status: 'failed',
      tried: [
        { method: 'dns_txt' },
        { method: 'well_known', ok: false, reason: CHECK_UNFINISHED },
        { method: 'meta_tag', ok: false, reason: CHECK_UNFINISHED },
      ],
    });
    expect(
      s.lines.some(
        (l) => l.includes('event=verify_job_failed') && l.includes('reason=unreadable_result'),
      ),
    ).toBe(true);

    const res = await scan(s.api, `https://${HOST}/`);
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    await settle();
    const spec = s.fly.created.find((c) => c.jobId === id);
    expect((await control(s.api, id, 'result', spec?.token ?? '', VERIFIED_BY_FILE)).status).toBe(
      400,
    );
    const job = (await (await s.api.publicApp.request(`/api/scans/${id}`)).json()) as {
      status: string;
      message: string;
    };
    expect(job).toMatchObject({ status: 'failed', message: UNREADABLE });
  });

  it('takes a failed result as a check that did not finish', async () => {
    const s = setup();
    const { v, put } = await checkedByJob(s, {
      status: 'failed',
      error: 'the scan ran out of time',
    });
    expect(put.status).toBe(204);
    expect((await read(s.api, v.id)).body).toMatchObject({
      status: 'failed',
      tried: [
        { method: 'dns_txt', ok: false, reason: NO_TXT },
        { method: 'well_known', ok: false, reason: CHECK_UNFINISHED },
        { method: 'meta_tag', ok: false, reason: CHECK_UNFINISHED },
      ],
    });
  });

  it("reads at most 64 KiB of a verify job's result (413), and fails the check", async () => {
    const s = setup();
    const big = { status: 'failed', error: 'x'.repeat(MAX_VERIFY_RESULT_BYTES) };
    const { v, put } = await checkedByJob(s, big);
    expect(put.status).toBe(413);
    expect((await read(s.api, v.id)).body.status).toBe('failed');
    expect(
      s.lines.some((l) => l.includes('event=verify_job_failed') && l.includes('reason=too_large')),
    ).toBe(true);
  });

  it('fails a job past its 2-minute cap, and the verification with it', async () => {
    const s = setup();
    const v = await created(s.api);
    await check(s.api, v.id);
    await settle();
    await s.clock.advance(VERIFY_WALL_CLOCK_MS - 1);
    expect((await read(s.api, v.id)).body.status).toBe('checking');
    await s.clock.advance(1);
    expect((await read(s.api, v.id)).body).toMatchObject({
      status: 'failed',
      tried: [{ method: 'dns_txt' }, { reason: CHECK_UNFINISHED }, { reason: CHECK_UNFINISHED }],
    });
    expect(s.fly.destroyed).toHaveLength(1);
    expect(
      s.lines.some((l) => l.includes('event=verify_job_failed') && l.includes('reason=timeout')),
    ).toBe(true);
  });

  it('with the queue full, a matching TXT record still verifies and a miss gets 503', async () => {
    const s = setup();
    for (let i = 0; i < 23; i++) {
      const res = await postJson(
        s.api,
        '/api/scans',
        { url: `https://${HOST}/` },
        { 'fly-client-ip': `10.${i + 10}.0.7` },
      );
      expect(res.status).toBe(202);
    }
    const miss = await created(s.api);
    const busy = await check(s.api, miss.id);
    expect(busy.status).toBe(503);
    expect(((await busy.json()) as { error: string }).error).toBe(BUSY);
    expect(s.txt.state.asked).toHaveLength(1);
    expect((await read(s.api, miss.id)).body).toEqual({
      id: miss.id,
      host: HOST,
      status: 'pending',
      expiresAt: miss.expiresAt,
    });
    await verifiedByDns(s);
    expect(s.fly.created).toHaveLength(3);
  });

  it('charges a check that would start a machine to the scan buckets; DNS checks are free of them', async () => {
    const s = setup();
    // Bodies that fail the schema spend a scan token each and take no job.
    for (let i = 0; i < 10; i++) expect((await scan(s.api, 'nope')).status).toBe(400);
    await settle();
    const machines = s.fly.created.length;
    const v = await created(s.api);
    const res = await check(s.api, v.id);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await res.json()) as { error: string }).error).toBe(MACHINE_CHECK_RATE);
    expect(s.txt.state.asked).toHaveLength(1);
    expect((await read(s.api, v.id)).body.status).toBe('pending');
    // A match needs no machine, so the scan buckets do not come into it.
    await verifiedByDns(s);
    await settle();
    expect(s.fly.created).toHaveLength(machines);
  });

  it('a missed check refused as busy spends no scan token', async () => {
    const s = setup();
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      const res = await postJson(
        s.api,
        '/api/scans',
        { url: `https://${HOST}/` },
        { 'fly-client-ip': `10.${i + 10}.0.7` },
      );
      ids.push(((await res.json()) as { id: string }).id);
    }
    const v = await created(s.api);
    for (let i = 0; i < 3; i++) expect((await check(s.api, v.id)).status).toBe(503);
    // The pool frees up: the client still has all 10 of its scan tokens.
    for (const id of ids) s.api.jobs.cancel(id);
    for (let i = 0; i < 10; i++) {
      const res = await scan(s.api, `https://${HOST}/`);
      expect(res.status).toBe(202);
      s.api.jobs.cancel(((await res.json()) as { id: string }).id);
    }
    expect((await scan(s.api, `https://${HOST}/`)).status).toBe(429);
  });

  it('and the other way: a machine check spends a scan token', async () => {
    const s = setup();
    const v = await created(s.api);
    expect((await check(s.api, v.id)).status).toBe(202);
    for (let i = 0; i < 9; i++) expect((await scan(s.api, 'nope')).status).toBe(400);
    const res = await scan(s.api, `https://${HOST}/`);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Too many scans/);
  });

  it('a check that needs a machine obeys the per-network live job cap, spending no scan token', async () => {
    const s = setup();
    // One scan running and one queued: the network holds all it may.
    const ids: string[] = [];
    for (const path of ['/', '/a']) {
      const res = await scan(s.api, `https://${HOST}${path}`);
      expect(res.status).toBe(202);
      ids.push(((await res.json()) as { id: string }).id);
    }
    const v = await created(s.api);
    const res = await check(s.api, v.id);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(((await res.json()) as { error: string }).error).toBe(BUSY_NETWORK);
    expect(s.lines).toContain(
      `widedoor event=refused reason=busy_network status=429 host=${HOST} ip=${logPrefix(IP)}`,
    );
    expect((await read(s.api, v.id)).body.status).toBe('pending');
    // Both scans end: now the check starts a machine.
    for (const id of ids) s.api.jobs.cancel(id);
    await settle();
    expect((await check(s.api, v.id)).status).toBe(202);
    // Two scans and this check spent 3 tokens; the refused check spent none.
    for (let i = 0; i < 7; i++) expect((await scan(s.api, 'nope')).status).toBe(400);
    expect((await scan(s.api, `https://${HOST}/`)).status).toBe(429);
  });

  it(`takes at most ${VERIFY_DAILY_CAP} verify jobs a UTC day; DNS checks and scans go on`, async () => {
    const s = setup();
    for (let i = 0; i < VERIFY_DAILY_CAP; i++) {
      const ip = { 'fly-client-ip': `10.${i}.0.1` };
      const res = await create(s.api, HOST, ip);
      const { id } = (await res.json()) as Created;
      expect((await check(s.api, id, ip)).status).toBe(202);
      await settle();
      // Ended at once, so the machine and queue caps never come into it.
      s.api.jobs.cancel(s.fly.created.at(-1)?.jobId ?? '');
    }
    const ip = { 'fly-client-ip': '10.200.0.1' };
    const { id } = (await (await create(s.api, HOST, ip)).json()) as Created;
    const over = await check(s.api, id, ip);
    expect(over.status).toBe(503);
    expect((await read(s.api, id)).body.status).toBe('pending');
    expect(s.fly.created).toHaveLength(VERIFY_DAILY_CAP);
    await verifiedByDns(s);
    expect((await scan(s.api, `https://${HOST}/`)).status).toBe(202);
    // The fake clock starts at noon UTC: past midnight is the next day, with the record still good.
    await s.clock.advance(12 * 60 * 60_000);
    expect((await check(s.api, id, ip)).status).toBe(202);
  });

  it('a failed check may start another machine only after 60 s; DNS still runs', async () => {
    const s = setup();
    const { v } = await checkedByJob(s, NOT_VERIFIED_RESULT);
    await s.clock.advance(20_000);
    const asked = s.txt.state.asked.length;
    const res = await check(s.api, v.id);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('40');
    expect(s.txt.state.asked).toHaveLength(asked + 1);
    expect((await read(s.api, v.id)).body).toMatchObject({
      status: 'failed',
      tried: [{ method: 'dns_txt' }, ...NOT_VERIFIED_RESULT.tried],
    });
    expect(s.fly.created).toHaveLength(1);
    // A TXT record published meanwhile still verifies inside the cooldown.
    s.txt.state.records = [[`widedoor-verification=${v.token}`]];
    expect((await check(s.api, v.id)).status).toBe(200);
  });

  it('a check whose job submit throws leaves the verification as it was', async () => {
    const s = setup();
    const v = await created(s.api);
    s.api.jobs.submit = () => {
      throw new RangeError('submit broke');
    };
    expect((await check(s.api, v.id)).status).toBe(500);
    expect((await read(s.api, v.id)).body.status).toBe('pending');
  });

  it('a verification that expires while its check runs reads expired, and never grants the tier', async () => {
    const s = setup();
    const v = await created(s.api);
    await s.clock.advance(VERIFY_VALID_MS - 60_000);
    expect((await check(s.api, v.id)).status).toBe(202);
    await settle();
    await s.clock.advance(60_000);
    const spec = s.fly.created[0];
    await control(s.api, spec?.jobId ?? '', 'result', spec?.token ?? '', VERIFIED_BY_FILE);
    expect((await read(s.api, v.id)).status).toBe(410);
    const res = await scan(s.api, `https://${HOST}/`, v.id);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(EXPIRED);
  });

  it('a job cancelled while it runs leaves the verification failed, not checking', async () => {
    const s = setup();
    const v = await created(s.api);
    await check(s.api, v.id);
    await settle();
    const jobId = s.fly.created[0]?.jobId ?? '';
    s.api.jobs.cancel(jobId);
    expect((await read(s.api, v.id)).body.status).toBe('failed');
  });

  it('a verified verification stays verified: a later check changes nothing', async () => {
    const s = setup();
    const { v } = await checkedByJob(s, VERIFIED_BY_FILE);
    expect((await check(s.api, v.id)).status).toBe(200);
    expect((await read(s.api, v.id)).body.status).toBe('verified');
    expect(s.fly.created).toHaveLength(1);
  });
});

describe('the tier of a scan with a verificationId', () => {
  it('runs the verified tier for a verified id of the same host', async () => {
    const s = setup();
    const v = await verifiedByDns(s);
    const res = await scan(s.api, `https://${HOST}/page?q=1`, v.id);
    expect(res.status).toBe(202);
    await settle();
    expect(s.fly.created[0]?.tier).toBe('verified');
    // No verificationId: the open tier as before (from another network, so it starts now).
    expect(
      (
        await postJson(
          s.api,
          '/api/scans',
          { url: `https://${HOST}/` },
          { 'fly-client-ip': '10.9.9.9' },
        )
      ).status,
    ).toBe(202);
    await settle();
    expect(s.fly.created[1]?.tier).toBe('open');
  });

  it('refuses an unknown, unverified, expired or other-host id with its own message', async () => {
    const s = setup();
    const refusal = async (url: string, id: string) => {
      const res = await scan(s.api, url, id);
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: string }).error;
    };
    expect(await refusal(`https://${HOST}/`, 'f'.repeat(32))).toBe(NOT_FOUND);
    const pending = await created(s.api);
    expect(await refusal(`https://${HOST}/`, pending.id)).toBe(NOT_VERIFIED);
    const www = await verifiedByDns(s, 'www.example.org');
    expect(await refusal('https://example.org/', www.id)).toBe(OTHER_HOST);
    expect(await refusal('https://a.example.org/', www.id)).toBe(OTHER_HOST);
    expect((await scan(s.api, 'https://www.example.org/', www.id)).status).toBe(202);
    await s.clock.advance(VERIFY_VALID_MS);
    expect(await refusal('https://www.example.org/', www.id)).toBe(EXPIRED);
    await settle();
    expect(s.fly.created.map((c) => c.tier)).toEqual(['verified']);
  });
});

describe('rate limits', () => {
  it('gives the 31st verification request in an hour from one network 429', async () => {
    const s = setup();
    const v = await created(s.api);
    for (let i = 0; i < 28; i++) expect((await create(s.api)).status).toBe(201);
    expect((await check(s.api, v.id)).status).toBe(202);
    const res = await create(s.api);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBe(3600);
    expect((await check(s.api, v.id, { 'fly-client-ip': '2001:db8:1:2::1' })).status).toBe(202);
    // Scans have their own bucket.
    expect((await scan(s.api, `https://${HOST}/`)).status).toBe(202);
  });

  it('caps verification requests per IPv4 /24 and IPv6 /48 at 90 an hour', async () => {
    const s = setup();
    for (let i = 0; i < 90; i++)
      expect((await create(s.api, HOST, { 'fly-client-ip': `203.0.113.${i + 1}` })).status).toBe(
        201,
      );
    expect((await create(s.api, HOST, { 'fly-client-ip': '203.0.113.200' })).status).toBe(429);
    expect((await create(s.api, HOST, { 'fly-client-ip': '203.0.114.1' })).status).toBe(201);
    for (let i = 0; i < 90; i++)
      await create(s.api, HOST, { 'fly-client-ip': `2001:db8:5:${i.toString(16)}::1` });
    expect((await create(s.api, HOST, { 'fly-client-ip': '2001:db8:5:ffff::1' })).status).toBe(429);
    expect((await create(s.api, HOST, { 'fly-client-ip': '2001:db8:6::1' })).status).toBe(201);
  });

  it('caps scans per IPv4 /24 and IPv6 /48 at 30 an hour, on top of the /32 and /64 cap', async () => {
    const s = setup();
    const url = `https://${HOST}/`;
    const post = (ip: string) =>
      s.api.publicApp.request('/api/scans', {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', 'fly-client-ip': ip },
        body: JSON.stringify({ url }),
      });
    // Cancelled at once, so the machine and queue caps never come into it.
    const scanned = async (ip: string) => {
      const res = await post(ip);
      if (res.status === 202) {
        const { id } = (await res.json()) as { id: string };
        s.api.jobs.cancel(id);
      }
      return res.status;
    };
    for (let i = 0; i < 30; i++) expect(await scanned(`192.0.2.${i + 1}`)).toBe(202);
    expect(await scanned('192.0.2.250')).toBe(429);
    expect(await scanned('192.0.3.1')).toBe(202);
    for (let i = 0; i < 30; i++) expect(await scanned(`2001:db8:7:${i.toString(16)}::1`)).toBe(202);
    expect(await scanned('2001:db8:7:ffff::1')).toBe(429);
    await s.clock.advance(60 * 60_000 + 1);
    expect(await scanned('192.0.2.250')).toBe(202);
  });
});

describe('what never leaves', () => {
  it('the token appears in no log line and in no GET answer', async () => {
    const s = setup();
    const a = await created(s.api);
    await check(s.api, a.id);
    await settle();
    const spec = s.fly.created[0];
    await control(s.api, spec?.jobId ?? '', 'result', spec?.token ?? '', NOT_VERIFIED_RESULT);
    const b = await verifiedByDns(s, 'www.example.org');
    const bodies = [
      JSON.stringify((await read(s.api, a.id)).body),
      JSON.stringify((await read(s.api, b.id)).body),
      JSON.stringify(await (await check(s.api, b.id)).json()),
    ];
    for (const token of [a.token, b.token]) {
      expect(s.lines.join('\n')).not.toContain(token);
      for (const body of bodies) expect(body).not.toContain(token);
    }
    // Nor does the verification id: it is what grants the verified tier.
    expect(s.lines.join('\n')).not.toContain(a.id);
    expect(s.lines.join('\n')).not.toContain(b.id);
  });

  it("ties a verification's log lines together by a vref that is not its id", async () => {
    const s = setup();
    const v = await created(s.api);
    await check(s.api, v.id);
    await settle();
    const spec = s.fly.created[0];
    await control(s.api, spec?.jobId ?? '', 'result', spec?.token ?? '', VERIFIED_BY_FILE);
    expect((await scan(s.api, `https://${HOST}/`, v.id)).status).toBe(202);
    const created_ = s.lines.find((l) => l.startsWith('widedoor event=verify_created'));
    const ref = /vref=([0-9a-f]{12})$/.exec(created_ ?? '')?.[1] ?? 'none';
    expect(v.id).not.toContain(ref);
    for (const event of [
      'verify_checked method=dns_txt',
      'verify_job_queued',
      'verify_job_started',
      'verify_job_done',
      'verify_checked method=well_known',
    ])
      expect(
        s.lines.some((l) => l.startsWith(`widedoor event=${event}`) && l.includes(`vref=${ref}`)),
      ).toBe(true);
    const queued = s.lines.filter((l) => l.startsWith('widedoor event=scan_queued'));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toContain('tier=verified');
    expect(queued[0]).toContain(`vref=${ref}`);
    // An open-tier scan carries none.
    await scan(s.api, `https://${HOST}/`);
    expect(s.lines.filter((l) => l.startsWith('widedoor event=scan_queued'))[1]).not.toContain(
      'vref=',
    );
  });

  it('about-scanner says verification skips robots.txt and that tokens are not secrets', async () => {
    const { api } = setup();
    const page = await (await api.publicApp.request('/about-scanner')).text();
    expect(page).toContain('without consulting robots.txt');
    expect(page).toContain('Verification tokens are not secrets');
  });
});

describe('Verifications', () => {
  /** A verification made verified by its DNS outcome. */
  const verify = (verifications: Verifications, id: string) => {
    verifications.begin(id, undefined);
    verifications.dnsChecked(id, { method: 'dns_txt', ok: true });
  };

  it('drops the oldest record that is not verified first', () => {
    const clock = new FakeClock();
    const verifications = new Verifications({ now: clock.now, max: 3 });
    const [a = '', b = '', c = ''] = [1, 2, 3].map(() => verifications.create(HOST).id);
    verify(verifications, a);
    const d = verifications.create(HOST).id;
    expect(verifications.view(a)?.status).toBe('verified');
    expect(verifications.view(b)).toBeUndefined();
    expect(verifications.view(c)?.status).toBe('pending');
    expect(verifications.view(d)?.status).toBe('pending');
  });

  it('drops a verified record only when every record is verified', () => {
    const clock = new FakeClock();
    const verifications = new Verifications({ now: clock.now, max: 2 });
    const [a = '', b = ''] = [1, 2].map(() => verifications.create(HOST).id);
    verify(verifications, a);
    verify(verifications, b);
    const c = verifications.create(HOST).id;
    expect(verifications.view(a)).toBeUndefined();
    expect(verifications.view(b)?.status).toBe('verified');
    expect(verifications.view(c)?.status).toBe('pending');
  });

  it('ignores the end of a job whose verification the cap dropped', () => {
    const clock = new FakeClock();
    const verifications = new Verifications({ now: clock.now, max: 2 });
    const a = verifications.create(HOST).id;
    verifications.begin(a, undefined);
    verifications.awaitJob(a, 'job-a');
    verifications.create(HOST);
    verifications.create(HOST);
    expect(verifications.view(a)).toBeUndefined();
    expect(
      verifications.jobEnded('job-a', {
        status: 'verified',
        tried: [{ method: 'well_known', ok: true }],
      }),
    ).toBeUndefined();
    expect(verifications.size).toBe(2);
  });

  it('holds at most its cap, dropping the oldest', () => {
    const clock = new FakeClock();
    const verifications = new Verifications({ now: clock.now, max: 3 });
    const ids = [1, 2, 3, 4].map(() => verifications.create(HOST).id);
    expect(verifications.size).toBe(3);
    expect(verifications.view(ids[0] ?? '')).toBeUndefined();
    expect(verifications.view(ids[3] ?? '')?.status).toBe('pending');
    expect(MAX_VERIFICATIONS).toBe(10_000);
  });
});
