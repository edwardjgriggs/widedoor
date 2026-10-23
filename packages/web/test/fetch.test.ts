import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EgressRefusedError, createFetcher, type HopCheck } from '../src/index.ts';
import { serve, type TestServer } from './server.ts';

describe('createFetcher', () => {
  let site: TestServer;
  let other: TestServer;
  beforeAll(async () => {
    other = await serve(() => ({ '/x': { body: 'other' } }));
    site = await serve((o) => ({
      '/ok': { body: 'ok' },
      '/hop': { status: 302, body: '', headers: { location: '/ok' } },
      '/away': { status: 301, body: '', headers: { location: `${other.origin}/x` } },
      '/loop': { status: 302, body: '', headers: { location: `${o}/loop` } },
    }));
  });
  afterAll(async () => {
    await site.close();
    await other.close();
  });

  it('follows same-origin redirects hop by hop', async () => {
    const { response, url } = await createFetcher()(`${site.origin}/hop`);
    expect(await response.text()).toBe('ok');
    expect(url).toBe(`${site.origin}/ok`);
  });

  it('refuses a redirect to another origin before requesting it', async () => {
    await expect(createFetcher()(`${site.origin}/away`)).rejects.toThrow(EgressRefusedError);
    expect(other.hits).toEqual([]);
  });

  it('caps the number of redirects', async () => {
    await expect(createFetcher({ maxRedirects: 3 })(`${site.origin}/loop`)).rejects.toThrow(
      /more than 3 redirects/,
    );
  });

  it('runs the injected hop check on every hop, including the first', async () => {
    const seen: string[] = [];
    const checkHop: HopCheck = (hop) => {
      seen.push(hop.pathname);
    };
    await createFetcher({ checkHop })(`${site.origin}/away`);
    expect(seen).toEqual(['/away', '/x']);
    await expect(
      createFetcher({
        checkHop: () => {
          throw new EgressRefusedError('blocked by policy');
        },
      })(`${site.origin}/ok`),
    ).rejects.toThrow(/blocked by policy/);
  });

  it('uses the injected request function with redirect: manual', async () => {
    const calls: RequestInit[] = [];
    const fetcher = createFetcher({
      request: async (_url, init) => {
        calls.push(init);
        return new Response('stub');
      },
    });
    expect(await (await fetcher('http://example.test/')).response.text()).toBe('stub');
    expect(calls[0]?.redirect).toBe('manual');
  });

  it('refuses non-http schemes', async () => {
    await expect(createFetcher()('file:///etc/passwd')).rejects.toThrow(/refusing file:/);
  });
});
