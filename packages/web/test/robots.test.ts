import { describe, expect, it } from 'vitest';
import {
  EgressRefusedError,
  ROBOTS_MAX_BYTES,
  ROBOTS_MAX_RULE_CHARS,
  ROBOTS_MAX_RULES,
  ROBOTS_MAX_URL_LENGTH,
  ROBOTS_MAX_WILDCARDS,
  createFetcher,
  robotsPolicy,
  type Fetcher,
  type RobotsDecision,
} from '../src/index.ts';

const ORIGIN = 'https://example.test';

/** A fetcher that answers every request with the given response and records the URLs. */
function fakeFetcher(answer: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    return { response: await answer(), url };
  };
  return { fetcher, calls };
}

const text =
  (body: string, status = 200) =>
  () =>
    new Response(body, { status });

describe('robotsPolicy', () => {
  it('skips a path the Widedoor group disallows and allows the rest', async () => {
    const { fetcher } = fakeFetcher(text('User-agent: Widedoor\nDisallow: /private\n'));
    const policy = robotsPolicy(fetcher, 'Widedoor');
    expect(await policy(`${ORIGIN}/private/x`)).toBe('robots-disallowed');
    expect(await policy(`${ORIGIN}/`)).toBe('scan');
    expect(await policy(`${ORIGIN}/public`)).toBe('scan');
  });

  it('applies the * group when there is no Widedoor group, and prefers the Widedoor group', async () => {
    const star = fakeFetcher(text('User-agent: *\nDisallow: /hidden\n'));
    expect(await robotsPolicy(star.fetcher, 'Widedoor')(`${ORIGIN}/hidden/a`)).toBe(
      'robots-disallowed',
    );
    const own = fakeFetcher(
      text('User-agent: *\nDisallow: /\n\nUser-agent: Widedoor\nDisallow: /only-this\n'),
    );
    const policy = robotsPolicy(own.fetcher, 'Widedoor');
    expect(await policy(`${ORIGIN}/page`)).toBe('scan');
    expect(await policy(`${ORIGIN}/only-this`)).toBe('robots-disallowed');
  });

  it('allows everything on a 4xx', async () => {
    for (const status of [404, 403, 410]) {
      const { fetcher } = fakeFetcher(text('User-agent: *\nDisallow: /\n', status));
      expect(await robotsPolicy(fetcher, 'Widedoor')(`${ORIGIN}/a`)).toBe('scan');
    }
  });

  it('disallows everything on a 5xx', async () => {
    const { fetcher } = fakeFetcher(text('', 503));
    const policy = robotsPolicy(fetcher, 'Widedoor');
    expect(await policy(`${ORIGIN}/`)).toBe('robots-unreachable');
    expect(await policy(`${ORIGIN}/a`)).toBe('robots-unreachable');
  });

  it('disallows everything when the fetch is refused or fails', async () => {
    for (const error of [new EgressRefusedError('blocked'), new TypeError('fetch failed')]) {
      const fetcher: Fetcher = () => Promise.reject(error);
      expect(await robotsPolicy(fetcher, 'Widedoor')(`${ORIGIN}/a`)).toBe('robots-unreachable');
    }
  });

  it('reads only the first 500 KiB and drops a cut-off last line', async () => {
    const head = 'User-agent: Widedoor\nDisallow: /early\n';
    const filler = `${'#'.repeat(ROBOTS_MAX_BYTES - head.length - 8)}\n`;
    const body = `${head}${filler}Disallow: /late\n`;
    expect(body.length).toBeGreaterThan(ROBOTS_MAX_BYTES);
    const policy = robotsPolicy(fakeFetcher(text(body)).fetcher, 'Widedoor');
    expect(await policy(`${ORIGIN}/early`)).toBe('robots-disallowed');
    expect(await policy(`${ORIGIN}/late`)).toBe('scan');

    // A rule the cap cuts in half must not survive as a shorter, broader rule.
    const cut = `${head}${'#'.repeat(ROBOTS_MAX_BYTES - head.length - 4)}\nDisallow: /cut/off/here\n`;
    const second = robotsPolicy(fakeFetcher(text(cut)).fetcher, 'Widedoor');
    expect(await second(`${ORIGIN}/cut/off/here`)).toBe('scan');
    expect(await second(`${ORIGIN}/early`)).toBe('robots-disallowed');
  });

  it('fetches robots.txt once per origin, even for concurrent checks', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => (release = done));
    const { fetcher, calls } = fakeFetcher(async () => {
      await gate;
      return new Response('User-agent: *\nDisallow: /no\n');
    });
    const policy = robotsPolicy(fetcher, 'Widedoor');
    const pending = [
      policy(`${ORIGIN}/a`),
      policy(`${ORIGIN}/no`),
      policy(`${ORIGIN}/b`),
      policy('https://other.test/no'),
    ];
    release();
    expect(await Promise.all(pending)).toEqual([
      'scan',
      'robots-disallowed',
      'scan',
      'robots-disallowed',
    ]);
    await policy(`${ORIGIN}/c`);
    expect(calls.sort()).toEqual([`${ORIGIN}/robots.txt`, 'https://other.test/robots.txt']);
  });

  it('does not apply robots.txt to non-http URLs', async () => {
    const { fetcher, calls } = fakeFetcher(text('User-agent: *\nDisallow: /\n'));
    expect(await robotsPolicy(fetcher, 'Widedoor')('file:///tmp/a.html')).toBe('scan');
    expect(calls).toEqual([]);
  });
  it('treats a cut file with CR-only line endings like any other, and a single over-long line as unreachable', async () => {
    const head = 'User-agent: Widedoor\rDisallow: /early\r';
    const cr = `${head}${'#'.repeat(ROBOTS_MAX_BYTES)}\rDisallow: /\r`;
    const policy = robotsPolicy(fakeFetcher(text(cr)).fetcher, 'Widedoor');
    expect(await policy(`${ORIGIN}/early`)).toBe('robots-disallowed');
    expect(await policy(`${ORIGIN}/other`)).toBe('scan');

    const events: RobotsDecision[] = [];
    const oneLine = `User-agent: *${' '.repeat(ROBOTS_MAX_BYTES)}\nDisallow: /x\n`;
    const single = robotsPolicy(fakeFetcher(text(oneLine)).fetcher, 'Widedoor', {
      onDecision: (d) => events.push(d),
    });
    expect(await single(`${ORIGIN}/anything`)).toBe('robots-unreachable');
    expect(events[0]).toMatchObject({
      verdict: 'disallow-all',
      cause: 'too-large',
      truncated: true,
    });
  });

  it('treats a 429 as unreachable, and reports each cause once per origin without any path', async () => {
    const cases: [() => Response | Promise<Response>, Partial<RobotsDecision>][] = [
      [text('', 429), { status: 429, verdict: 'disallow-all', cause: 'http-429' }],
      [text('', 503), { status: 503, verdict: 'disallow-all', cause: 'http-5xx' }],
      [text('', 404), { status: 404, verdict: 'allow-all' }],
      [
        text('User-agent: *\nDisallow: /private\n'),
        { status: 200, verdict: 'rules', rules: 1, truncated: false },
      ],
    ];
    for (const [answer, expected] of cases) {
      const events: RobotsDecision[] = [];
      const policy = robotsPolicy(fakeFetcher(answer).fetcher, 'Widedoor', {
        onDecision: (d) => events.push(d),
      });
      await Promise.all([policy(`${ORIGIN}/private/a?token=1`), policy(`${ORIGIN}/b`)]);
      await policy(`${ORIGIN}/c`);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ origin: ORIGIN, ...expected });
      expect(JSON.stringify(events[0])).not.toMatch(/private|token/);
    }
    const tooMany = robotsPolicy(fakeFetcher(text('', 429)).fetcher, 'Widedoor');
    expect(await tooMany(`${ORIGIN}/`)).toBe('robots-unreachable');
  });

  it('names why a fetch failed: timeout, network, refused (with its block reason)', async () => {
    const failures: [unknown, Partial<RobotsDecision>][] = [
      [new DOMException('timed out', 'TimeoutError'), { cause: 'timeout' }],
      [new TypeError('fetch failed'), { cause: 'network' }],
      [
        new EgressRefusedError('no', 'policy', 'private'),
        { cause: 'refused', blockReason: 'private' },
      ],
      [new EgressRefusedError('loop', 'redirect-limit'), { cause: 'too-many-redirects' }],
    ];
    for (const [error, expected] of failures) {
      const events: RobotsDecision[] = [];
      const policy = robotsPolicy(() => Promise.reject(error), 'Widedoor', {
        onDecision: (d) => events.push(d),
      });
      expect(await policy(`${ORIGIN}/a`)).toBe('robots-unreachable');
      expect(events[0]).toMatchObject({ verdict: 'disallow-all', ...expected });
    }
  });

  it('does not judge a URL over the length cap, and does not fetch robots.txt for it', async () => {
    const { fetcher, calls } = fakeFetcher(text('User-agent: *\nDisallow: /x\n'));
    const policy = robotsPolicy(fetcher, 'Widedoor');
    expect(await policy(`${ORIGIN}/${'a'.repeat(ROBOTS_MAX_URL_LENGTH)}`)).toBe('robots-unchecked');
    expect(await policy(`${ORIGIN}/?q=${'a'.repeat(ROBOTS_MAX_URL_LENGTH)}`)).toBe(
      'robots-unchecked',
    );
    expect(calls).toEqual([]);
  });

  describe('limits cannot change which rules apply', () => {
    const events: RobotsDecision[] = [];
    const policyFor = (body: string) => {
      events.length = 0;
      return robotsPolicy(fakeFetcher(text(body)).fetcher, 'Widedoor', {
        onDecision: (d) => events.push(d),
      });
    };

    it('does not let 1,000 rules for another bot push out the Widedoor group', async () => {
      const others = Array.from({ length: 1_000 }, (_, i) => `Disallow: /o${i}/`);
      const body = ['User-agent: other', ...others, '', 'User-agent: Widedoor', 'Disallow: /', ''];
      const policy = policyFor(body.join('\n'));
      expect(await policy(`${ORIGIN}/page`)).toBe('robots-disallowed');
      expect(events[0]).toMatchObject({ verdict: 'rules', rules: 1 });
    });

    it('disallows the origin when the applicable group has an over-long rule, instead of merging groups', async () => {
      const body = `User-agent: Widedoor\nDisallow: /${'a'.repeat(2_100)}\nUser-agent: other\nAllow: /\n`;
      const policy = policyFor(body);
      expect(await policy(`${ORIGIN}/page`)).toBe('robots-unreachable');
      expect(events[0]).toMatchObject({ verdict: 'disallow-all', cause: 'too-large' });
    });

    it('disallows the origin when the applicable group is over a limit', async () => {
      const bodies = [
        `User-agent: *\n${Array.from({ length: ROBOTS_MAX_RULES + 1 }, (_, i) => `Disallow: /r${i}/`).join('\n')}\n`,
        `User-agent: *\nDisallow: /${'*b'.repeat(ROBOTS_MAX_WILDCARDS + 1)}\n`,
        `User-agent: *\n${Array.from({ length: 12 }, (_, i) => `Disallow: /${i}${'a'.repeat(1_500)}`).join('\n')}\n`,
      ];
      for (const body of bodies) {
        const policy = policyFor(body);
        expect(await policy(`${ORIGIN}/page`)).toBe('robots-unreachable');
        expect(events[0]).toMatchObject({ cause: 'too-large' });
      }
    });

    it('applies a * only file, and prefers the Widedoor group over it', async () => {
      const star = policyFor('User-agent: *\nDisallow: /star\n');
      expect(await star(`${ORIGIN}/star`)).toBe('robots-disallowed');
      expect(await star(`${ORIGIN}/other`)).toBe('scan');
      const own = policyFor(
        'User-agent: *\nDisallow: /star\n\nUser-agent: widedoor/1.0\nDisallow: /own\n',
      );
      expect(await own(`${ORIGIN}/star`)).toBe('scan');
      expect(await own(`${ORIGIN}/own`)).toBe('robots-disallowed');
    });

    it('merges the rules of separate groups that name Widedoor', async () => {
      const policy = policyFor(
        'User-agent: Widedoor\nDisallow: /one\n\nUser-agent: other\nDisallow: /nope\n\nUser-agent: WIDEDOOR\nDisallow: /two\n',
      );
      expect(await policy(`${ORIGIN}/one`)).toBe('robots-disallowed');
      expect(await policy(`${ORIGIN}/two`)).toBe('robots-disallowed');
      expect(await policy(`${ORIGIN}/nope`)).toBe('scan');
      expect(events[0]).toMatchObject({ rules: 2 });
    });
  });

  it('turns 1,000 rules of 64 characters into disallow-all, and keeps 125 of them', async () => {
    const rules = (n: number) =>
      `User-agent: *\n${Array.from({ length: n }, (_, i) => `Disallow: /*${String(i).padStart(4, '0')}${'a'.repeat(57)}z`).join('\n')}\n`;
    const events: RobotsDecision[] = [];
    const big = robotsPolicy(fakeFetcher(text(rules(1_000))).fetcher, 'Widedoor', {
      onDecision: (d) => events.push(d),
    });
    expect(await big(`${ORIGIN}/page`)).toBe('robots-unreachable');
    expect(events[0]).toMatchObject({ verdict: 'disallow-all', cause: 'too-large' });
    const within = robotsPolicy(fakeFetcher(text(rules(125))).fetcher, 'Widedoor', {
      onDecision: (d) => events.push(d),
    });
    expect(await within(`${ORIGIN}/page`)).toBe('scan');
    expect(events[1]).toMatchObject({ verdict: 'rules', rules: 125 });
  });

  it('keeps every single check under 50 ms for the worst files the limits allow', async () => {
    const path = `/${'a'.repeat(ROBOTS_MAX_URL_LENGTH - 1)}`;
    const fill = (rule: string) => {
      const n = Math.min(ROBOTS_MAX_RULES, Math.floor(ROBOTS_MAX_RULE_CHARS / rule.length));
      return `User-agent: *\n${`Disallow: ${rule}\n`.repeat(n)}`;
    };
    const cases: Record<string, string> = {
      'many short rules': fill(`/*a${'a'.repeat(60)}z`),
      '64-star rules': fill(`/${'*a'.repeat(ROBOTS_MAX_WILDCARDS)}z`),
      'long rules': fill(`/*${'a'.repeat(2_000)}z`),
      'reviewer file': fill('/*a*a*a*a*a*a*a*z'),
    };
    for (const [name, body] of Object.entries(cases)) {
      const policy = robotsPolicy(fakeFetcher(text(body)).fetcher, 'Widedoor');
      await policy(`${ORIGIN}/warm`);
      const times: number[] = [];
      for (let i = 0; i < 9; i++) {
        const started = performance.now();
        expect(await policy(`${ORIGIN}${path}`), name).toBe('scan');
        times.push(performance.now() - started);
      }
      // The fastest of the runs: a loaded CI host slows single runs, not the work itself.
      expect(Math.min(...times), name).toBeLessThan(50);
    }
  });

  describe('with a fetcher that follows cross-origin redirects', () => {
    const redirecting = (hops: (url: string) => string | undefined) =>
      createFetcher({
        checkHop: () => undefined,
        request: async (url) => {
          const next = hops(url);
          return next
            ? new Response(null, { status: 301, headers: { location: next } })
            : new Response('User-agent: *\nDisallow: /private\n');
        },
      });

    it('applies the rules of a robots.txt that http redirects to https to the http origin', async () => {
      const fetcher = redirecting((url) =>
        url === 'http://x.test/robots.txt' ? 'https://x.test/robots.txt' : undefined,
      );
      const policy = robotsPolicy(fetcher, 'Widedoor');
      expect(await policy('http://x.test/private/a')).toBe('robots-disallowed');
      expect(await policy('http://x.test/public')).toBe('scan');
    });

    it('disallows the origin after more than 5 hops', async () => {
      let n = 0;
      const events: RobotsDecision[] = [];
      const fetcher = redirecting(() => `https://x.test/hop${n++}`);
      const policy = robotsPolicy(fetcher, 'Widedoor', { onDecision: (d) => events.push(d) });
      expect(await policy('https://x.test/public')).toBe('robots-unreachable');
      expect(events[0]).toMatchObject({ cause: 'too-many-redirects' });
      expect(n).toBe(6);
    });
  });
});
