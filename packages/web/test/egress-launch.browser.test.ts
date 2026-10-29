import { connect, type Socket } from 'node:net';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHardenedContext, launchChromium } from '../src/context.ts';
import { PinnedResolver } from '../src/egress/resolver.ts';
import { startEgressProxy, type EgressProxy } from '../src/egress/proxy.ts';
import { withNetLog } from './netlog.ts';
import { page, serve, type TestServer } from './server.ts';

/*
 * Chromium launched with the egress proxy: pages load through it, and the browser's own
 * DNS paths (dns-prefetch, preconnect) never reach the resolver. Local servers only.
 */

const TIMEOUT = 60_000;
const PUBLIC = '93.184.215.14';
const unsafeNoSandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1';

let site: TestServer;
let proxy: EgressProxy;
let browser: Browser;
const lookups: string[] = [];
const dials: string[] = [];

beforeAll(async () => {
  site = await serve(() => ({
    '/': {
      body: page(
        'Proxied',
        '<link rel="dns-prefetch" href="//leak.example.org">' +
          '<link rel="preconnect" href="https://leak2.example.org">',
        '<main><h1>Proxied</h1></main>',
      ),
    },
  }));
  const port = Number(new URL(site.origin).port);
  const resolver = new PinnedResolver({
    lookup: async (host) => {
      lookups.push(host);
      return host === 'site.example.org' ? [{ address: PUBLIC, family: 4 }] : [];
    },
  });
  proxy = await startEgressProxy({
    resolver,
    dial: (address, dialPort): Socket => {
      dials.push(`${address}:${dialPort}`);
      return connect(port, '127.0.0.1');
    },
  });
  browser = await launchChromium({ unsafeNoSandbox, proxy: { server: proxy.url } });
}, TIMEOUT);

afterAll(async () => {
  await browser?.close();
  await proxy?.close();
  await site?.close();
});

describe('Chromium launched with the egress proxy', () => {
  it(
    'loads a page through the proxy and its hint hosts never reach the proxy',
    async () => {
      const context = await createHardenedContext(browser);
      const tab = await context.newPage();
      await tab.goto('http://site.example.org/');
      expect(await tab.locator('h1').textContent()).toBe('Proxied');
      expect(dials).toContain(`${PUBLIC}:80`);
      // Hint hosts that would be looked up through the proxy's resolver. This does not watch
      // Chromium's own OS lookups: the net log test below does.
      await tab.waitForTimeout(1500);
      expect(lookups).not.toContain('leak.example.org');
      expect(lookups).not.toContain('leak2.example.org');
      await context.close();
    },
    TIMEOUT,
  );

  it(
    'resolves no host name inside Chromium (net log)',
    async () => {
      /*
       * This headless shell does not appear to issue dns-prefetch or preconnect hints under a
       * fixed proxy, so this guards against a future Chromium that does. With
       * `MAP * ~NOTFOUND` every host resolver job must end NOT_RESOLVED or not exist. The
       * backstop is Task 8's kernel rule: the scan user (uid 10001) has no DNS at all.
       */
      await withNetLog({ unsafeNoSandbox, proxy: { server: proxy.url } }, async (logged) => {
        const context = await createHardenedContext(logged);
        const tab = await context.newPage();
        await tab.goto('http://site.example.org/');
        await tab.waitForTimeout(1500);
      });
    },
    TIMEOUT,
  );

  it(
    'refuses loopback instead of bypassing the proxy',
    async () => {
      const context = await createHardenedContext(browser);
      const tab = await context.newPage();
      const before = site.hits.length;
      // The proxy answers 403 for a refused target; the page never reaches the server.
      const response = await tab.goto(site.origin + '/').catch((error: unknown) => error);
      if (response instanceof Error) expect(response.message).toContain('net::ERR_');
      else expect((response as { status(): number } | null)?.status()).toBe(403);
      expect(site.hits.length).toBe(before);
      await context.close();
    },
    TIMEOUT,
  );
});
