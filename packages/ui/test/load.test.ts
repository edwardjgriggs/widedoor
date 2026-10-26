import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The code-for-token exchange in the page: only a 401 from /api/session
 * means the link was already used; any other refusal gets the generic text.
 * A 401 for the token later means the session has ended.
 */

const USED = /^This link was already used\./;
const REFUSED = /^The server refused the request\./;

function page(sessionAnswer: () => Promise<Response>) {
  const storage = new Map<string, string>();
  vi.stubGlobal('window', {
    location: { search: '?code=abc', pathname: '/' },
    history: { replaceState: vi.fn() },
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url === '/api/session'
        ? sessionAnswer()
        : Promise.resolve(new Response(null, { status: 204 })),
    ),
  );
}

/** A fresh copy of load.ts, whose token promise is per module. */
const load = async () => (await import('../src/load.ts')).fetchServedReport();

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('fetchServedReport', () => {
  it('says the link was already used only for a 401', async () => {
    page(async () => new Response('used', { status: 401 }));
    const r = await load();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(USED);
  });

  it.each([403, 404, 500, 502])('gives the generic refusal for a %i', async (status) => {
    page(async () => new Response('no', { status }));
    const r = await load();
    expect(!r.ok && r.message).toMatch(REFUSED);
    expect(!r.ok && r.message).not.toMatch(USED);
  });

  it('says the server is not running when the request fails', async () => {
    page(() => Promise.reject(new TypeError('fetch failed')));
    const r = await load();
    expect(!r.ok && r.message).toMatch(/server is not running/);
  });

  it('says so, with no unhandled rejection, when the session answer is not JSON', async () => {
    page(async () => new Response('<html>proxy</html>', { status: 200 }));
    const r = await load();
    expect(!r.ok && r.message).toBe(
      'The server sent an answer this page cannot read. Open the link widedoor ui printed in the terminal again.',
    );
  });

  it('says the session has ended when the token is refused', async () => {
    page(async () => Response.json({ token: 't0k' }));
    vi.mocked(fetch).mockImplementation(async (url) =>
      url === '/api/session'
        ? Response.json({ token: 't0k' })
        : new Response('Unauthorized', { status: 401 }),
    );
    const r = await load();
    expect(!r.ok && r.message).toBe("This page's session has ended. Run widedoor ui again.");
  });

  it('trades the code once and then asks for the served report with the token', async () => {
    page(async () => Response.json({ token: 't0k' }));
    const r = await load();
    expect(!r.ok && r.message).toMatch(/started without --report/);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.map((c) => c[0])).toEqual(['/api/session', '/api/report']);
    expect(calls[1]?.[1]?.headers).toEqual({ 'x-widedoor-token': 't0k' });
  });
});
