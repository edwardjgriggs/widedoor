import { createSocket } from 'node:dgram';
import { chromium, type Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chromiumLaunchOptions, createHardenedContext, launchChromium } from '../src/context.ts';
import { createProxiedFetcher } from '../src/egress/guarded.ts';
import { fetchPdf, PdfFetchError } from '../src/fetch.ts';
import { withFetchedPdfs } from '../src/files.ts';
import { scanWeb, type WebScanResult } from '../src/scan.ts';
import { loadSitemap, SitemapError } from '../src/sitemap.ts';
import { withNetLog } from './netlog.ts';
import {
  hold,
  html,
  NO_LEAKS,
  probeScript,
  PUBLIC_V4,
  PUBLIC_V6,
  redirect,
  send,
  sendWith,
  SITE,
  startLab,
  type Lab,
} from './ssrf-fixtures.ts';

/*
 * The SSRF suite, the deploy gate of the hosted tier (npm run test:ssrf). It drives real
 * Chromium through scanWeb, and Node fetches through the proxied fetcher, with every host
 * name answered by a fake resolver and every dial sent to a local server. The "private"
 * server stands for the internal network: each test asserts it saw no request and no
 * connection. The browser tests run twice: once with the request guard and the proxy (the
 * hosted setup), once with the proxy alone, so the proxy is shown to hold without the guard.
 */

const TIMEOUT = 120_000;
const unsafeNoSandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1';

const NAMES = {
  [SITE]: [PUBLIC_V4],
  'rebind.example.org': (call: number) => (call === 0 ? [PUBLIC_V4] : ['10.0.0.1']),
  'v6.example.org': [PUBLIC_V6],
  'internal.example.org': ['10.0.0.1'],
  'meta.example.org': ['169.254.169.254'],
  'meta6.example.org': ['fd00:ec2::254'],
  'mapped.example.org': ['::ffff:7f00:1'],
  'nat64.example.org': ['64:ff9b::a00:1'],
  'sixtofour.example.org': ['2002:a00:1::'],
  'compat.example.org': ['::a00:1'],
  'scoped.example.org': ['fe80::1%eth0'],
  // One public answer first, one private second: refused as a whole.
  'mixed.example.org': [PUBLIC_V4, '10.0.0.1'],
};

let lab: Lab;

beforeEach(async () => {
  lab = await startLab({ names: NAMES });
  lab.routes.set('/hold', hold(lab));
}, TIMEOUT);

afterEach(async () => {
  await lab?.close();
});

const page = (path: string) => `http://${SITE}${path}`;
const pageOf = (r: WebScanResult) => r.pages[0];
/** The page scanned and its script reported back: what the test measured actually ran. */
const probed = () => lab.beacons.filter((b) => b.startsWith('/beacon?probed='));
const noLeaks = () => expect(lab.leaks()).toEqual(NO_LEAKS);
/**
 * Each target's host (as URL.hostname gives it) must have been refused on the target's own
 * route: an https target as a CONNECT, an http one as an absolute-form request, or by the
 * guard under the same scheme. Keyed on the route, an https twin proves the CONNECT refusal
 * itself instead of riding on its http sibling's refusal and the empty private side.
 */
const expectRefused = (targets: readonly string[]) => {
  const seen = new Set(lab.refusals().map((r) => `${r.route} ${r.host}`));
  for (const target of targets) {
    const url = new URL(target);
    const routes =
      url.protocol === 'https:' ? ['connect', 'guard:https'] : ['absolute', 'guard:http'];
    expect(
      routes.some((route) => seen.has(`${route} ${url.hostname}`)),
      target,
    ).toBe(true);
  }
};
/** img, script and iframe for each target, a held image, and the script that tries them all. */
const probeBody = (targets: readonly string[]) =>
  targets
    .map(
      (t) =>
        `<img src="${t}.png" alt="x"><script src="${t}.js"></script>` +
        `<iframe src="${t}.html" title="frame"></iframe>`,
    )
    .join('') +
  '<img src="/hold" alt="">' +
  probeScript(targets);

interface Vector {
  /** The private host this vector aims at (unique per vector). */
  host: string;
  markup: string;
  head?: string;
  /**
   * Whether this Chromium issues the request. When true a refusal for the host is required.
   * When false the vector is uncovered: headless Chromium fetches nothing for it, so the suite
   * cannot prove it is refused, and asserts instead that its host was never refused. A
   * Chromium that starts fetching it then fails here, and the vector needs a real check.
   */
  attempted: boolean;
}

/** Markup and header vectors, each aimed at its own 10.3.0.x host. */
const MEDIUM: Record<string, Vector> = {
  object: {
    host: '10.3.0.1',
    markup: '<object data="http://10.3.0.1/o" type="text/html"></object>',
    attempted: true,
  },
  embed: {
    host: '10.3.0.2',
    markup: '<embed src="http://10.3.0.2/e" type="text/html">',
    attempted: true,
  },
  svgImage: {
    host: '10.3.0.3',
    markup:
      '<svg width="10" height="10"><image href="http://10.3.0.3/i.png" width="10" height="10"/></svg>',
    attempted: true,
  },
  imageSet: {
    host: '10.3.0.4',
    markup:
      '<div style=\'width:10px;height:10px;background-image:image-set(url("http://10.3.0.4/a.png") 1x)\'>x</div>',
    attempted: true,
  },
  poster: {
    host: '10.3.0.5',
    markup: '<video poster="http://10.3.0.5/p.png" width="10" height="10"></video>',
    attempted: true,
  },
  track: {
    host: '10.3.0.6',
    markup:
      // Without crossorigin, Chromium refuses a cross-origin track before fetching it.
      '<video crossorigin width="10" height="10"><track kind="subtitles" default src="http://10.3.0.6/t.vtt"></video>',
    attempted: true,
  },
  modulepreload: {
    host: '10.3.0.7',
    markup: '',
    head: '<link rel="modulepreload" href="http://10.3.0.7/m.js">',
    attempted: true,
  },
  icon: {
    host: '10.3.0.8',
    markup: '',
    head: '<link rel="icon" href="http://10.3.0.8/f.ico">',
    attempted: false,
  },
  manifest: {
    host: '10.3.0.9',
    markup: '',
    head: '<link rel="manifest" href="http://10.3.0.9/m.json">',
    attempted: false,
  },
  ping: {
    host: '10.3.0.10',
    markup: '<a id="pa" href="#x" ping="http://10.3.0.10/ping">x</a>',
    attempted: true,
  },
  linkHeader: { host: '10.3.0.11', markup: '', attempted: true },
  cspReport: { host: '10.3.0.12', markup: '', attempted: false },
  reportingEndpoint: { host: '10.3.0.13', markup: '', attempted: false },
  srcdoc: {
    host: '10.3.0.14',
    markup: '<iframe srcdoc=\'<img src="http://10.3.0.14/s.png">\' title="srcdoc"></iframe>',
    attempted: true,
  },
};

/**
 * The vectors headless Chromium does not fetch, so the suite cannot cover them. cspReport and
 * reportingEndpoint are also timing-bound: Chromium batches Reporting API deliveries and the
 * scan ends about 800 ms after load, so the silent check may never see them even once Chromium
 * does send them. The proxy and, in the image, the firewall still refuse all four.
 */
const UNCOVERED = ['icon', 'manifest', 'cspReport', 'reportingEndpoint'];

const dialled = () => lab.dials.map((d) => d.slice(0, d.lastIndexOf(':')));

describe.each([
  { mode: 'request guard and proxy', guard: true },
  { mode: 'proxy alone', guard: false },
])('Chromium through the egress stack ($mode)', ({ guard }) => {
  const scan = (path: string) => scanWeb({ urls: [page(path)] }, lab.scanOptions(guard));
  const expectOnlyPublicDials = () =>
    expect(dialled().filter((a) => a !== PUBLIC_V4 && a !== PUBLIC_V6)).toEqual([]);

  /**
   * Serves a page that tries every target as img, script, iframe, fetch(), XHR and beacon,
   * scans it, and asserts: the page ran to its report, every target host was refused (by the
   * proxy or the guard), nothing reached the private side, and nothing was dialled but the
   * public site. The refused-host check is what makes a bypass visible: a connection that
   * skips the proxy never shows up as a refusal.
   */
  const probe = async (path: string, targets: readonly string[]) => {
    lab.routes.set(path, send(html(probeBody(targets))));
    const r = await scan(path);
    expect(pageOf(r)?.asset).toBeDefined();
    expect(probed()).toHaveLength(1);
    noLeaks();
    expectRefused(targets);
    expectOnlyPublicDials();
  };

  it(
    'private ranges: img, script, iframe, fetch() and XHR to 10/8, 192.168/16 and 172.16/12, over http and https, load nothing',
    async () => {
      await probe('/private', [
        'http://10.0.0.1/p',
        'http://192.168.1.1/p',
        'http://172.16.0.1/p',
        'https://10.0.0.1/p',
        'https://192.168.1.1/p',
        'https://172.16.0.1/p',
      ]);
    },
    TIMEOUT,
  );

  it(
    'reserved ranges: 0.0.0.0, CGNAT, the Alibaba metadata address, multicast and fe80::/10 are refused',
    async () => {
      await probe('/reserved', [
        'http://0.0.0.0/p',
        'http://100.64.0.1/p',
        'http://100.100.100.200/p',
        'http://224.0.0.1/p',
        'http://[fe80::1]/p',
        'https://100.64.0.1/p',
        'https://[fe80::1]/p',
      ]);
    },
    TIMEOUT,
  );

  /*
   * Playwright adds `<-loopback>` to the proxy bypass list itself, so this does not prove the
   * rule in context.ts; it proves that loopback, as a page and as subresources, is refused.
   */
  it(
    'loopback: 127.0.0.1 and localhost, as a page and as subresources, are refused',
    async () => {
      const port = lab.priv.port;
      // The port variants hit the port rule; the bare ones hit the address rule.
      const targets = [
        `http://127.0.0.1:${port}/p`,
        `http://localhost:${port}/p`,
        'http://127.0.0.1/p',
        'http://localhost/p',
        'http://[::1]/p',
      ];
      await probe('/loop', targets);
      // A scan of the private server itself must end in an error, never a scanned page.
      for (const target of targets) {
        const direct = await scanWeb({ urls: [target] }, lab.scanOptions(guard));
        expect(pageOf(direct)?.error).toBeDefined();
        expect(pageOf(direct)?.asset).toBeUndefined();
      }
      noLeaks();
    },
    TIMEOUT,
  );

  it(
    'alternate IPv4 forms of 127.0.0.1 (2130706433, 0x7f.1, 017700000001) are refused',
    async () => {
      const forms = ['http://2130706433/p', 'http://0x7f.1/p', 'http://017700000001/p'];
      await probe('/alt', forms);
      // Each form was a separate attempt on the same host.
      const all = [
        ...lab.events.flatMap((e) => (e.kind === 'refused' ? [e.host] : [])),
        ...lab.guardRefusals,
      ];
      expect(all.filter((h) => h === '127.0.0.1').length).toBeGreaterThanOrEqual(forms.length);
    },
    TIMEOUT,
  );

  it(
    'IPv6: [::1], [fdaa::3] and [::ffff:7f00:1] subresources are refused, also over https',
    async () => {
      await probe('/v6', [
        `http://[::1]:${lab.priv.port}/p`,
        'http://[::1]/p',
        'http://[fdaa::3]/p',
        'http://[::ffff:7f00:1]/p',
        'https://[::1]/p',
        'https://[fdaa::3]/p',
      ]);
    },
    TIMEOUT,
  );

  it(
    'metadata: 169.254.169.254 and [fd00:ec2::254] are refused, also through names that resolve to them',
    async () => {
      await probe('/meta', [
        'http://169.254.169.254/latest/meta-data/',
        'http://[fd00:ec2::254]/latest/meta-data/',
        'http://meta.example.org/latest/meta-data/',
        'http://meta6.example.org/latest/meta-data/',
        'http://mapped.example.org/p',
        'https://169.254.169.254/latest/meta-data/',
        'https://[fd00:ec2::254]/latest/meta-data/',
        'https://meta.example.org/latest/meta-data/',
      ]);
    },
    TIMEOUT,
  );

  it(
    'DNS answers: NAT64, 6to4, IPv4-compatible and scoped addresses, and a name with one blocked answer, are refused',
    async () => {
      await probe('/names', [
        'http://nat64.example.org/n-nat64',
        'http://sixtofour.example.org/n-6to4',
        'http://compat.example.org/n-compat',
        'http://scoped.example.org/n-scoped',
        'http://mixed.example.org/n-mixed',
        'https://nat64.example.org/n-nat64',
      ]);
      // A name is refused when any answer is blocked: the public first answer of mixed is never dialled.
      expect(lab.pub.requests.filter((u) => u.startsWith('/n-'))).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'DNS rebinding: rebind.example.org answers public, then private; the page and its later fetch("/secret") reach the public server',
    async () => {
      lab.routes.set(
        '/',
        send(
          html(
            '<img src="/hold" alt="">',
            `<script>
              setTimeout(async () => {
                const text = await (await fetch('/secret')).text();
                await fetch('/beacon?secret=' + encodeURIComponent(text));
              }, 400);
            </script>`,
          ),
        ),
      );
      lab.routes.set('/secret', send('public-secret', 'text/plain'));
      const r = await scanWeb({ urls: ['http://rebind.example.org/'] }, lab.scanOptions(guard));
      expect(pageOf(r)?.asset).toBeDefined();
      expect(lab.beacons).toContain('/beacon?secret=public-secret');
      // Resolved once and pinned: no second lookup, so no second answer to swap in.
      expect(lab.lookups.filter((h) => h === 'rebind.example.org')).toHaveLength(1);
      expect(await lab.resolver.resolve('rebind.example.org')).toBe(PUBLIC_V4);
      expect(lab.dials.every((d) => d.startsWith(`${PUBLIC_V4}:`))).toBe(true);
      noLeaks();
    },
    TIMEOUT,
  );

  it(
    'redirects: a page that 302s to a private address is not loaded, nor is a subresource that does',
    async () => {
      const port = lab.priv.port;
      lab.routes.set('/to-private', redirect('http://10.0.0.1/'));
      lab.routes.set('/to-loopback', redirect(`http://127.0.0.1:${port}/`));
      lab.routes.set('/to-name', redirect('http://internal.example.org/'));
      lab.routes.set('/to-meta', redirect('http://169.254.169.254/latest/meta-data/'));
      lab.routes.set('/img.png', redirect('http://10.0.0.1/x.png'));
      lab.routes.set('/s.js', redirect('http://192.168.1.1/s.js'));
      lab.routes.set('/f.html', redirect(`http://127.0.0.1:${port}/f`));
      lab.routes.set(
        '/sub',
        send(
          html(
            '<img src="/img.png" alt="x"><script src="/s.js"></script>' +
              '<iframe src="/f.html" title="f"></iframe><img src="/hold" alt="">' +
              probeScript(['/to-private', '/to-name', '/to-meta']),
          ),
        ),
      );
      for (const path of ['/to-private', '/to-loopback', '/to-name', '/to-meta']) {
        const r = await scan(path);
        expect(pageOf(r)?.asset, path).toBeUndefined();
        noLeaks();
      }
      const r = await scan('/sub');
      expect(pageOf(r)?.asset).toBeDefined();
      expect(probed()).toHaveLength(1);
      noLeaks();
      // The hops are followed inside Chromium, so the proxy is what refuses them.
      expectRefused([
        'http://10.0.0.1/',
        `http://127.0.0.1:${port}/`,
        'http://internal.example.org/',
        'http://169.254.169.254/',
        'http://192.168.1.1/',
      ]);
      expectOnlyPublicDials();
    },
    TIMEOUT,
  );

  it(
    'subresources: preconnect, dns-prefetch, a CSS @import and a font to a private host reach nothing and resolve no name',
    async () => {
      lab.routes.set('/import.css', send('@import url("http://10.0.0.1/a.css");', 'text/css'));
      lab.routes.set(
        '/hints',
        send(
          html(
            '<p>text</p>',
            '<link rel="preconnect" href="http://10.0.0.1">' +
              '<link rel="preconnect" href="https://internal.example.org">' +
              '<link rel="dns-prefetch" href="//internal.example.org">' +
              '<link rel="prefetch" href="http://192.168.1.1/next">' +
              '<link rel="preload" as="font" href="http://172.16.0.1/f.woff2" crossorigin>' +
              '<link rel="stylesheet" href="/import.css">' +
              '<style>@import url("http://192.168.1.1/b.css");' +
              '@font-face { font-family: F; src: url("http://10.0.0.1/f.woff2"); }' +
              'body { font-family: F; background: url("http://172.16.0.1/bg.png"); }</style>' +
              "<script>addEventListener('load', () => fetch('/beacon?hints=1'));</script>",
          ),
        ),
      );
      await withNetLog({ unsafeNoSandbox, proxy: { server: lab.proxy.url } }, async (logged) => {
        const context = await createHardenedContext(
          logged,
          guard ? { requestGuard: lab.requestGuard } : {},
        );
        const tab = await context.newPage();
        await tab.goto(page('/hints'));
        await Promise.race([lab.beaconed, new Promise((done) => setTimeout(done, 10_000))]);
        await context.close();
      });
      expect(lab.beacons).toContain('/beacon?hints=1');
      noLeaks();
      expectRefused(['http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/']);
      expectOnlyPublicDials();
    },
    TIMEOUT,
  );

  it(
    'ports: https://site.example.org:8443/ is refused',
    async () => {
      lab.routes.set(
        '/ports',
        send(
          html(
            `<img src="https://${SITE}:8443/x.png" alt="x"><img src="http://${SITE}:8080/x.png" alt="x">` +
              '<img src="/hold" alt="">' +
              probeScript([`https://${SITE}:8443/`, `http://${SITE}:8080/`]),
          ),
        ),
      );
      const r = await scan('/ports');
      expect(pageOf(r)?.asset).toBeDefined();
      expect(probed()).toHaveLength(1);
      const direct = await scanWeb({ urls: [`https://${SITE}:8443/`] }, lab.scanOptions(guard));
      expect(pageOf(direct)?.asset).toBeUndefined();
      expect(lab.dials.filter((d) => !/:80$/.test(d))).toEqual([]);
      noLeaks();
    },
    TIMEOUT,
  );

  describe('navigations and other browser-initiated requests', () => {
    /** Serves a page, scans it, and asserts that each target host was refused and nothing leaked. */
    const navigate = async (path: string, body: string, hosts: readonly string[]) => {
      lab.routes.set(path, send(html(body)));
      await scan(path);
      noLeaks();
      expectRefused(hosts);
      expectOnlyPublicDials();
    };

    it(
      '<meta http-equiv=refresh> and location= navigations to a private host are refused',
      async () => {
        await navigate(
          '/meta-refresh',
          '<meta http-equiv="refresh" content="0;url=http://10.2.0.1/">',
          ['http://10.2.0.1/'],
        );
        await navigate('/location', "<script>location.href = 'http://10.2.0.2/';</script>", [
          'http://10.2.0.2/',
        ]);
      },
      TIMEOUT,
    );

    it(
      'a form POST answered by 307 or 308 with a private Location is refused',
      async () => {
        lab.routes.set('/post307', redirect('http://10.2.0.3/', 307));
        lab.routes.set('/post308', redirect('http://10.2.0.4/', 308));
        for (const [n, ip] of [
          ['307', '10.2.0.3'],
          ['308', '10.2.0.4'],
        ] as const) {
          await navigate(
            `/form${n}`,
            `<form method="post" action="/post${n}"><input name="a" value="1"></form>` +
              '<script>document.forms[0].submit();</script>',
            [`http://${ip}/`],
          );
        }
      },
      TIMEOUT,
    );

    it(
      'window.open and target=_blank to a private host load nothing',
      async () => {
        // The hardened context aborts every popup request before the proxy sees it, so the
        // evidence is the page's own report and an empty private side.
        lab.routes.set(
          '/popups',
          send(
            html(
              '<a id="blank" href="http://10.2.0.5/b" target="_blank">open</a>' +
                '<a id="noopener" href="http://10.2.0.6/b" target="_blank" rel="noopener">open</a>' +
                '<img src="/hold" alt="">' +
                `<script>
                  window.open('http://10.2.0.7/w');
                  window.open('https://10.2.0.8/w', '_blank', 'noopener');
                  document.getElementById('blank').click();
                  document.getElementById('noopener').click();
                  setTimeout(() => fetch('/beacon?popups=1'), 800);
                </script>`,
            ),
          ),
        );
        const r = await scan('/popups');
        expect(pageOf(r)?.asset).toBeDefined();
        expect(lab.beacons).toContain('/beacon?popups=1');
        noLeaks();
        expectOnlyPublicDials();
      },
      TIMEOUT,
    );

    it(
      'dedicated, shared and service workers cannot fetch a private host',
      async () => {
        const probeInWorker = `Promise.allSettled([
          fetch('http://10.2.0.9/w'),
          new Promise((done, fail) => { try { importScripts('http://10.2.0.9/i.js'); done(); } catch (e) { fail(e); } }),
        ]).then((r) => r.every((x) => x.status === 'rejected') ? 'blocked' : 'REACHED')`;
        lab.routes.set(
          '/w.js',
          send(`${probeInWorker}.then((m) => postMessage(m));`, 'text/javascript'),
        );
        lab.routes.set(
          '/shared.js',
          send(
            `onconnect = (e) => ${probeInWorker}.then((m) => e.ports[0].postMessage(m));`,
            'text/javascript',
          ),
        );
        lab.routes.set(
          '/swreg.js',
          send('self.addEventListener("fetch", () => {});', 'text/javascript'),
        );
        lab.routes.set(
          '/workers',
          send(
            html(
              '<img src="/hold" alt="">' +
                `<script>
                  const timeout = (ms) => new Promise((done) => setTimeout(() => done('timeout'), ms));
                  const dedicated = new Promise((done) => {
                    try { const w = new Worker('/w.js'); w.onmessage = (e) => done(e.data); w.onerror = () => done('noworker'); }
                    catch { done('noworker'); }
                  });
                  const shared = new Promise((done) => {
                    try { const w = new SharedWorker('/shared.js'); w.port.onmessage = (e) => done(e.data); w.onerror = () => done('noworker'); }
                    catch { done('noworker'); }
                  });
                  const service = navigator.serviceWorker
                    ? navigator.serviceWorker.register('/swreg.js').then(() => 'registered', () => 'refused')
                    : Promise.resolve('unavailable');
                  Promise.all([dedicated, shared, service].map((p) => Promise.race([p, timeout(5000)])))
                    .then((r) => fetch('/beacon?workers=' + r.join(',')));
                </script>`,
            ),
          ),
        );
        const r = await scan('/workers');
        expect(pageOf(r)?.asset).toBeDefined();
        const report = lab.beacons.find((b) => b.startsWith('/beacon?workers='));
        expect(report).toBeDefined();
        // A worker either fetched nothing ("blocked") or did not start; none reached the host.
        expect(report).toMatch(
          /^\/beacon\?workers=(blocked|noworker),(blocked|noworker),(refused|unavailable)$/,
        );
        noLeaks();
        expectOnlyPublicDials();
      },
      TIMEOUT,
    );

    it(
      'WebSocket and EventSource to private hosts connect to nothing',
      async () => {
        lab.routes.set(
          '/sockets',
          send(
            html(
              '<img src="/hold" alt="">' +
                `<script>
                  const timeout = (ms) => new Promise((done) => setTimeout(() => done('timeout'), ms));
                  const ws = (url) => new Promise((done) => {
                    try { const s = new WebSocket(url); s.onopen = () => done('OPEN'); s.onclose = () => done('closed'); s.onerror = () => done('closed'); }
                    catch { done('closed'); }
                  });
                  const sse = (url) => new Promise((done) => {
                    const s = new EventSource(url); s.onopen = () => done('OPEN'); s.onerror = () => { s.close(); done('closed'); };
                  });
                  Promise.all([ws('ws://10.2.0.10/s'), ws('wss://10.2.0.11/s'), sse('http://10.2.0.12/e'), sse('https://10.2.0.13/e')]
                    .map((p) => Promise.race([p, timeout(5000)])))
                    .then((r) => fetch('/beacon?sockets=' + r.join(',')));
                </script>`,
            ),
          ),
        );
        const r = await scan('/sockets');
        expect(pageOf(r)?.asset).toBeDefined();
        expect(lab.beacons).toContain('/beacon?sockets=closed,closed,closed,closed');
        noLeaks();
        // WebSockets are closed by the hardened context; the EventSource requests are not.
        expectRefused(['http://10.2.0.12/', 'https://10.2.0.13/']);
        expectOnlyPublicDials();
      },
      TIMEOUT,
    );
  });

  it(
    'markup and headers that make the browser fetch (object, embed, SVG, image-set, poster, track, link rels, ping, Link header, CSP and Reporting endpoints, srcdoc) reach nothing',
    async () => {
      const hosts = Object.values(MEDIUM).map((m) => m.host);
      const markup = Object.values(MEDIUM)
        .map((m) => m.markup)
        .join('');
      lab.routes.set(
        '/medium',
        sendWith(
          html(
            markup +
              '<img src="/hold" alt="">' +
              `<script>
                document.getElementById('pa').click();
                setTimeout(() => fetch('/beacon?medium=1'), 800);
              </script>`,
            Object.values(MEDIUM)
              .map((m) => m.head ?? '')
              .join(''),
          ),
          {
            Link: '<http://10.3.0.11/l.css>; rel=preload; as=style',
            'Content-Security-Policy-Report-Only':
              "img-src 'none'; report-uri http://10.3.0.12/csp; report-to e",
            'Reporting-Endpoints': 'e="http://10.3.0.13/r"',
          },
        ),
      );
      const r = await scan('/medium');
      expect(pageOf(r)?.asset).toBeDefined();
      expect(lab.beacons).toContain('/beacon?medium=1');
      noLeaks();
      const seen = lab.refusedHosts();
      const missing = Object.entries(MEDIUM)
        .filter(([, m]) => m.attempted && !seen.has(m.host))
        .map(([name]) => name);
      // Each vector Chromium is known to issue shows up as a refusal.
      expect(missing).toEqual([]);
      expect(hosts.length).toBeGreaterThan(0);
      // The uncovered ones must stay silent: a refusal means Chromium now fetches the vector.
      const silent = Object.entries(MEDIUM).filter(([, m]) => !m.attempted);
      expect(silent.map(([name]) => name)).toEqual(UNCOVERED);
      expect(silent.filter(([, m]) => seen.has(m.host)).map(([name]) => name)).toEqual([]);
      expectOnlyPublicDials();
    },
    TIMEOUT,
  );
});

/*
 * The hardened context on its own. Each vector here aims at the public site, which the proxy
 * lets through, so only createHardenedContext can stop it: a request or a dial that reaches
 * the lab means the context layer is gone, whatever the proxy would do with a private target.
 */
describe('the hardened context, aimed at a target the proxy allows', () => {
  /** Runs use on a tab of a hardened context with the hosted proxy and guard, plus Chromium flags. */
  const withContext = async (args: readonly string[], use: (tab: Page) => Promise<void>) => {
    const launch = chromiumLaunchOptions({ unsafeNoSandbox, proxy: { server: lab.proxy.url } });
    const browser = await chromium.launch({ ...launch, args: [...(launch.args ?? []), ...args] });
    try {
      const context = await createHardenedContext(browser, { requestGuard: lab.requestGuard });
      await use(await context.newPage());
      await context.close();
    } finally {
      await browser.close();
    }
  };
  /** Waits for the page's report, at most 10 s, and fails if it never came. */
  const reported = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = await Promise.race([
      lab.beaconed.then(() => true),
      new Promise<false>((done) => (timer = setTimeout(() => done(false), 10_000))),
    ]);
    clearTimeout(timer);
    expect(seen, 'the page never reported').toBe(true);
  };
  /** Requests for paths under prefix that reached the public site, over http or TLS. */
  const reached = (prefix: string) =>
    [...lab.pub.requests, ...(lab.pubTls?.requests ?? [])].filter((u) => u.startsWith(prefix));

  it(
    'a service worker on the scanned origin is never registered',
    async () => {
      // Only this test starts the lab with its TLS site: in the rest of the suite a tunnel to
      // the public site on 443 meets the plain http server, as before.
      await lab.close();
      lab = await startLab({ names: NAMES, https: true });
      lab.routes.set(
        '/sw.js',
        send("self.addEventListener('install', () => fetch('/sw-reached'));", 'text/javascript'),
      );
      lab.routes.set(
        '/sw',
        send(
          html(
            '<p>sw</p>',
            `<script>
              (navigator.serviceWorker
                ? navigator.serviceWorker
                    .register('/sw.js')
                    .then((reg) => (reg ? 'registered' : 'blocked'), () => 'refused')
                : Promise.resolve('unavailable')
              ).then((r) => fetch('/beacon?sw=' + r));
            </script>`,
          ),
        ),
      );
      // Service workers need a secure context, so the page is the lab's TLS site on 443.
      await withContext([`--ignore-certificate-errors-spki-list=${lab.spki}`], async (tab) => {
        await tab.goto(`https://${SITE}/sw`);
        await reported();
      });
      // 'blocked' is the context's own answer: registration resolves without a registration.
      expect(lab.beacons).toContain('/beacon?sw=blocked');
      expect(reached('/sw')).toEqual(['/sw']);
      noLeaks();
    },
    TIMEOUT,
  );

  it(
    'a WebSocket to the scanned site is closed before it reaches the proxy',
    async () => {
      lab.routes.set(
        '/ws',
        send(
          html(
            '<p>ws</p>',
            `<script>
              const ws = (url) => new Promise((done) => {
                const s = new WebSocket(url);
                s.onopen = () => done('OPEN');
                s.onclose = () => done('closed');
              });
              Promise.all([ws('ws://${SITE}/ws-plain'), ws('wss://${SITE}/ws-tls')])
                .then((r) => fetch('/beacon?ws=' + r.join(',')));
            </script>`,
          ),
        ),
      );
      await withContext([], async (tab) => {
        await tab.goto(page('/ws'));
        await reported();
      });
      expect(lab.beacons).toContain('/beacon?ws=closed,closed');
      // A socket that left the context shows up as a CONNECT: refused for :80, dialled for :443.
      expect(reached('/ws-')).toEqual([]);
      expect(lab.refusals()).toEqual([]);
      expect(lab.dials.filter((d) => !d.endsWith(':80'))).toEqual([]);
      noLeaks();
    },
    TIMEOUT,
  );

  it(
    'window.open and target=_blank to the scanned site load nothing and are closed',
    async () => {
      lab.routes.set(
        '/popups',
        send(
          html(
            `<a id="blank" href="http://${SITE}/pop-blank" target="_blank">open</a>` +
              `<a id="noopener" href="http://${SITE}/pop-noopener" target="_blank" rel="noopener">open</a>` +
              `<script>
                window.open('/pop-w');
                window.open('/pop-w-noopener', '_blank', 'noopener');
                document.getElementById('blank').click();
                document.getElementById('noopener').click();
                fetch('/beacon?popups=1');
              </script>`,
          ),
        ),
      );
      const popups: Page[] = [];
      await withContext([], async (tab) => {
        tab.on('popup', (popup) => popups.push(popup));
        await tab.goto(page('/popups'));
        await reported();
        // Polls end as soon as they hold; the timeout only bounds a failing run.
        await expect.poll(() => popups.length, { timeout: 10_000 }).toBe(4);
        await expect
          .poll(() => popups.filter((p) => !p.isClosed()).length, { timeout: 10_000 })
          .toBe(0);
        expect(reached('/pop-')).toEqual([]);
      });
      // Again once the browser is gone, so a request still in flight at the poll is not missed.
      expect(reached('/pop-')).toEqual([]);
      noLeaks();
    },
    TIMEOUT,
  );
});

describe('Node fetches through the proxied fetcher', () => {
  const fetcher = () =>
    createProxiedFetcher({
      proxyUrl: lab.proxy.url,
      resolver: lab.resolver,
      userAgent: 'Widedoor-ssrf-test',
    });

  it(
    'a sitemap that redirects to a private host fails with a SitemapError naming the refusal',
    async () => {
      for (const [path, location] of [
        ['/sitemap-ip.xml', 'http://10.0.0.1/sitemap.xml'],
        ['/sitemap-name.xml', 'http://internal.example.org/sitemap.xml'],
        ['/sitemap-meta.xml', 'http://169.254.169.254/sitemap.xml'],
      ] as const) {
        lab.routes.set(path, redirect(location));
        const error = await loadSitemap(`http://${SITE}${path}`, undefined, fetcher()).catch(
          (e: unknown) => e,
        );
        expect(error, path).toBeInstanceOf(SitemapError);
        expect((error as Error).message, path).toMatch(/refus/i);
      }
      noLeaks();
    },
    TIMEOUT,
  );

  it(
    'a sitemap that redirects to a private host is a sitemap-failed error in scanWeb',
    async () => {
      lab.routes.set('/sitemap.xml', redirect('http://10.0.0.1/sitemap.xml'));
      const r = await scanWeb(
        { sitemap: `http://${SITE}/sitemap.xml` },
        { ...lab.scanOptions(true), fetcher: fetcher() },
      );
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]?.code).toBe('sitemap-failed');
      expect(r.errors[0]?.message).toMatch(/refus/i);
      noLeaks();
    },
    TIMEOUT,
  );

  it(
    'a PDF URL that redirects to a private host fails with pdf-fetch-refused',
    async () => {
      const targets = [
        'http://10.0.0.1/a.pdf',
        'http://internal.example.org/a.pdf',
        'http://169.254.169.254/a.pdf',
        'http://[fd00:ec2::254]/a.pdf',
        `http://127.0.0.1:${lab.priv.port}/a.pdf`,
        `http://${SITE}:8443/a.pdf`,
      ];
      const urls: string[] = [];
      targets.forEach((location, i) => {
        lab.routes.set(`/r${i}.pdf`, redirect(location));
        urls.push(`http://${SITE}/r${i}.pdf`);
      });
      const { failed } = await withFetchedPdfs(urls, { fetcher: fetcher() }, async (sources) => {
        for (const source of sources) expect(await source.load()).toBeUndefined();
      });
      expect(failed.map((f) => f.code)).toEqual(targets.map(() => 'pdf-fetch-refused'));
      const direct = await fetchPdf(fetcher(), urls[0] as string, async () => undefined).catch(
        (e: unknown) => e,
      );
      expect(direct).toBeInstanceOf(PdfFetchError);
      expect((direct as PdfFetchError).code).toBe('pdf-fetch-refused');
      noLeaks();
    },
    TIMEOUT,
  );

  it('the first URL itself is refused when it names a private host', async () => {
    for (const url of ['http://10.0.0.1/a.pdf', 'http://internal.example.org/a.pdf']) {
      const error = await fetchPdf(fetcher(), url, async () => undefined).catch((e: unknown) => e);
      expect((error as PdfFetchError).code, url).toBe('pdf-fetch-refused');
    }
    noLeaks();
  });
});

describe('no direct UDP leaves the browser', () => {
  it(
    'WebRTC with STUN and TURN servers, and other UDP a page can trigger, send no datagram',
    async () => {
      // Positive control: the listener sees a datagram sent to it.
      const control = createSocket('udp4');
      await new Promise<void>((done) => control.send('x', lab.udp.port, '127.0.0.1', () => done()));
      control.close();
      await new Promise((done) => setTimeout(done, 200));
      expect(lab.udp.datagrams).toBe(1);
      lab.udp.datagrams = 0;

      const browser = await launchChromium({ unsafeNoSandbox, proxy: { server: lab.proxy.url } });
      try {
        const context = await createHardenedContext(browser);
        const tab = await context.newPage();
        lab.routes.set('/', send(html('<p>udp</p>')));
        await tab.goto(page('/'));
        const port = lab.udp.port;
        const outcome = await tab.evaluate(async (udpPort) => {
          const seen: string[] = [];
          const servers: RTCIceServer[] = [
            { urls: `stun:127.0.0.1:${udpPort}` },
            { urls: `turn:127.0.0.1:${udpPort}?transport=udp`, username: 'u', credential: 'p' },
            { urls: `turn:127.0.0.1:${udpPort}?transport=tcp`, username: 'u', credential: 'p' },
            { urls: `stun:stun.example.org:${udpPort}` },
          ];
          const peers = [
            new RTCPeerConnection({ iceServers: servers }),
            new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' }),
          ];
          await Promise.all(
            peers.map(async (peer) => {
              peer.createDataChannel('x');
              peer.addEventListener('icecandidate', (e) => {
                if (e.candidate) seen.push(e.candidate.type ?? 'unknown');
              });
              await peer.setLocalDescription(await peer.createOffer());
              await new Promise<void>((done) => {
                const timer = setTimeout(done, 4000);
                peer.addEventListener('icegatheringstatechange', () => {
                  if (peer.iceGatheringState === 'complete') {
                    clearTimeout(timer);
                    done();
                  }
                });
              });
            }),
          );
          // Other UDP paths: WebTransport and a WebSocket-over-QUIC style probe need a secure
          // context or a server; try them anyway and ignore the outcome.
          const extra: Promise<unknown>[] = [];
          const wt = (
            globalThis as { WebTransport?: new (url: string) => { ready: Promise<void> } }
          ).WebTransport;
          if (wt) extra.push(new wt(`https://127.0.0.1:${udpPort}/`).ready.catch(() => undefined));
          await Promise.race([
            Promise.allSettled(extra),
            new Promise((done) => setTimeout(done, 2000)),
          ]);
          peers.forEach((peer) => peer.close());
          return seen;
        }, port);
        // No candidate may be a host or server-reflexive one, and nothing reached the listener.
        expect(outcome.filter((t) => t === 'srflx' || t === 'host')).toEqual([]);
        await new Promise((done) => setTimeout(done, 500));
        expect(lab.udp.datagrams).toBe(0);
        noLeaks();
        await context.close();
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );
});
