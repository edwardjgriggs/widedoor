import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECKLIST_STATUSES, MANUAL_OUTCOMES, PROFILE_IDS } from '@widedoor/core';
import { FORMATS, reportName } from '@widedoor/server';
import { EXPORTS } from '../src/ExportView.tsx';
import { PROFILES } from '../src/ScanView.tsx';

/*
 * api.ts, the one module that calls fetch: the token on every call, JSON and
 * raw bodies, status codes as typed errors (401 ends the session and stops
 * every later call), answers checked before use, and the download through a
 * temporary link and an object URL. Also that the lists the browser bundle
 * keeps of its own (it cannot import the Node entries) match the server's.
 */

const TOKEN = 't0k';
const JOB = { id: 'a'.repeat(32), status: 'running', progress: { done: 0, known: 2 } };

type Answer = (url: string, init: RequestInit) => Promise<Response>;

/** A page with a stored token, whose fetch gives answer. */
function page(answer: Answer) {
  vi.stubGlobal('window', {
    location: { search: '', pathname: '/' },
    history: { replaceState: vi.fn() },
    sessionStorage: { getItem: () => TOKEN, setItem: vi.fn() },
  });
  const fetch = vi.fn(answer);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const api = () => import('../src/api.ts');

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('calls', () => {
  it('carry the token, and a JSON body as application/json', async () => {
    const fetch = page(async () => Response.json(JOB, { status: 202 }));
    const { startScan, getScan, cancelScan } = await api();
    expect(await startScan({ urls: ['https://site.example/'], profile: '508' })).toEqual(JOB);
    await getScan(JOB.id);
    await cancelScan(JOB.id);
    const [post, get, del] = fetch.mock.calls;
    expect(post?.[0]).toBe('/api/scans');
    expect(post?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'x-widedoor-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ urls: ['https://site.example/'], profile: '508' }),
      credentials: 'omit',
      cache: 'no-store',
    });
    expect(get?.[0]).toBe(`/api/scans/${JOB.id}`);
    expect(get?.[1]).toMatchObject({ method: 'GET', headers: { 'x-widedoor-token': TOKEN } });
    expect(get?.[1]?.body).toBeUndefined();
    expect(del?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('send an upload as its own bytes, with its type and a name', async () => {
    const fetch = page(async () => Response.json({ id: 'b'.repeat(32) }, { status: 201 }));
    const { upload } = await api();
    const file = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });
    expect(await upload('pdf', file, 'a.pdf')).toBe('b'.repeat(32));
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/uploads?kind=pdf&name=a.pdf');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'x-widedoor-token': TOKEN, 'content-type': 'application/pdf' },
      body: file,
    });
    await upload('image', new Blob([new Uint8Array([1])]));
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/uploads?kind=image');
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      'content-type': 'application/octet-stream',
    });
  });

  it("keep a 4xx message as text, and give a 500 the server's fixed text", async () => {
    let answer = new Response('a scan is already running; wait for it or cancel it', {
      status: 409,
    });
    page(async () => answer);
    const { ApiError, startScan, failure } = await api();
    const busy = await startScan({}).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(ApiError);
    expect(busy).toMatchObject({
      status: 409,
      message: 'a scan is already running; wait for it or cancel it',
    });
    expect(failure('The scan could not start', busy)).toBe(
      'The scan could not start: a scan is already running; wait for it or cancel it.',
    );
    answer = new Response('<b>stack</b> at C:\\secret', { status: 500 });
    const crashed = await startScan({}).catch((e: unknown) => e);
    expect(crashed).toMatchObject({
      status: 500,
      message: 'Server error. The widedoor ui terminal shows the cause.',
    });
  });

  it('say the server is not running when no answer comes, and refuse an answer of the wrong shape', async () => {
    let fail = true;
    page(async () => {
      if (fail) throw new TypeError('fetch failed');
      return Response.json({ id: 'not-an-id', status: 'running' });
    });
    const { getScan } = await api();
    await expect(getScan(JOB.id)).rejects.toMatchObject({
      status: 0,
      message: 'The widedoor ui server is not running.',
    });
    fail = false;
    await expect(getScan(JOB.id)).rejects.toMatchObject({
      status: 0,
      message: 'The server sent an answer this page cannot read.',
    });
  });

  it('end the session on a 401: the listeners hear it once and no later call is sent', async () => {
    const fetch = page(async () => new Response('Unauthorized', { status: 401 }));
    const { getChecklist, getAcrState, onSessionEnded, sessionEnded, failure, SESSION_ENDED } =
      await api();
    const heard = vi.fn();
    onSessionEnded(heard);
    const e = await getChecklist().catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 401, message: SESSION_ENDED });
    expect(SESSION_ENDED).toBe("This page's session has ended. Run widedoor ui again.");
    expect(failure('The checklist could not be loaded', e)).toBe(SESSION_ENDED);
    expect(sessionEnded()).toBe(true);
    await expect(getAcrState()).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('failure', () => {
  it("keeps the page's own errors apart from the server's", async () => {
    page(async () => new Response(null, { status: 204 }));
    const { failure, ApiError, SERVER_ERROR } = await api();
    expect(failure('The checklist could not be loaded', new TypeError('x is undefined'))).toBe(
      'The checklist could not be loaded: this page hit an error it did not expect. Reload it and try again.',
    );
    expect(failure('The scan could not start', new ApiError(500, SERVER_ERROR))).toBe(
      'The scan could not start: Server error. The widedoor ui terminal shows the cause.',
    );
  });

  it('marks a call the page cancelled as aborted, not as a server that is not running', async () => {
    page(
      (_, init) =>
        new Promise((_done, fail) => {
          const stop = () => fail(new DOMException('aborted', 'AbortError'));
          if (init.signal?.aborted) stop();
          init.signal?.addEventListener('abort', stop);
        }),
    );
    const { upload, isAborted } = await api();
    const stop = new AbortController();
    const pending = upload('pdf', new Blob(['%PDF']), 'a.pdf', stop.signal).catch(
      (e: unknown) => e,
    );
    stop.abort();
    const e = await pending;
    expect(isAborted(e)).toBe(true);
    expect(e).toMatchObject({ status: 0 });
  });
});

describe('download', () => {
  it('fetches the export with the token and saves it as an octet stream through a temporary link, revoked on the next task', async () => {
    const fetch = page(async () => new Response('report body', { status: 200 }));
    const events: string[] = [];
    const link = {
      href: '',
      download: '',
      click: vi.fn(() => events.push(`click ${link.href} ${link.download}`)),
    };
    vi.stubGlobal('document', { createElement: vi.fn(() => link) });
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      events.push(`create ${(blob as Blob).size} ${(blob as Blob).type}`);
      return 'blob:http://127.0.0.1/x';
    });
    const revoke = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation((url) => void events.push(`revoke ${url}`));
    const { download } = await api();
    try {
      await download('vpat-html', 'report.vpat.html');
      // Not yet revoked: the click has to start the download first.
      expect(events.some((e) => e.startsWith('revoke'))).toBe(false);
      await new Promise((done) => setTimeout(done, 5));
    } finally {
      create.mockRestore();
      revoke.mockRestore();
    }
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/export/vpat-html');
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ 'x-widedoor-token': TOKEN });
    expect(events).toEqual([
      'create 11 application/octet-stream',
      'click blob:http://127.0.0.1/x report.vpat.html',
      'revoke blob:http://127.0.0.1/x',
    ]);
  });

  it('shows the 422 message and saves nothing', async () => {
    page(
      async () =>
        new Response('the openacr format needs acr.product.name in widedoor.config.yaml', {
          status: 422,
        }),
    );
    const createElement = vi.fn();
    vi.stubGlobal('document', { createElement });
    const { download } = await api();
    await expect(download('openacr', 'report.openacr.yaml')).rejects.toMatchObject({
      status: 422,
      message: 'the openacr format needs acr.product.name in widedoor.config.yaml',
    });
    expect(createElement).not.toHaveBeenCalled();
  });
});

describe('lists the browser bundle keeps of its own', () => {
  it('match core and the server', async () => {
    const { ITEM_STATUSES, OUTCOMES } = await api();
    expect([...ITEM_STATUSES]).toEqual([...CHECKLIST_STATUSES]);
    expect([...OUTCOMES]).toEqual([...MANUAL_OUTCOMES]);
    // '' leaves the profile to the config.
    expect(PROFILES[0]?.id).toBe('');
    expect(
      PROFILES.map((p) => p.id)
        .filter((id) => id !== '')
        .sort(),
    ).toEqual([...PROFILE_IDS].sort());
    expect(EXPORTS.map((x) => [x.format, x.file])).toEqual(FORMATS.map((f) => [f, reportName(f)]));
  });
});
