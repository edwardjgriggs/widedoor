import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROFILE_IDS, loadStandardsData } from '@widedoor/core';
import { DISCLAIMER, loadPlainData } from '@widedoor/report';
import { PAYLOAD, fixtureReport } from '../../report/test/fixture.ts';
import {
  SCANS_PER_HOUR as SERVER_SCANS_PER_HOUR,
  UPLOAD_DEADLINE_MS as SERVER_UPLOAD_DEADLINE_MS,
} from '../../server/src/hosted/api.ts';
import { RETENTION_MS as SERVER_RETENTION_MS } from '../../server/src/hosted/jobs.ts';
import { OPEN_TIER, VERIFIED_TIER } from '../../server/src/hosted/limits.ts';
import { MAX_TARGET_URL_LENGTH } from '../../server/src/hosted/protocol.ts';
import { VERIFY_VALID_MS as SERVER_VERIFY_VALID_MS } from '../../server/src/hosted/verify.ts';
import { DEFAULT_PROFILE as SERVER_DEFAULT_PROFILE } from '../../server/src/settings.ts';
import type { UiData } from '../src/data.ts';
import {
  HostedError,
  createVerification,
  fetchReport,
  startScan,
  type Created,
  type ScanJob,
} from '../src/hosted/api.ts';
import { followScan, runCheck } from '../src/hosted/flows.ts';
import { DEFAULT_PROFILE, HOSTED_PROFILES, HostedApp } from '../src/hosted/HostedApp.tsx';
import { HostedInitial, type HostedInitialState } from '../src/hosted/initial.ts';
import * as limits from '../src/hosted/limits.ts';
import {
  ERROR_WAIT_MAX_MS,
  SCAN_POLL_FAST_MS,
  SCAN_POLL_SLOW_MS,
  errorWait,
  VERIFY_POLL_FOR_MS,
  VERIFY_POLL_MS,
  type PollEnv,
} from '../src/hosted/poll.ts';
import { isSitePath } from '../src/hosted/SiteLink.tsx';
import {
  VERIFICATION_KEY,
  forgetVerification,
  loadVerification,
  saveVerification,
} from '../src/hosted/storage.ts';
import {
  LIMITS_TEXT,
  TOKEN_NOTE,
  UPLOAD_TIME_TEXT,
  VERIFIED_OPTION,
  VERIFY_TIMEOUT,
  coversUrl,
  pdfError,
  refusalText,
  urlError,
  urlTarget,
  waitText,
  type VerificationState,
} from '../src/hosted/text.ts';
import { PROFILES } from '../src/profiles.ts';

/*
 * The hosted page (Task 12) with a fake fetch, a fake clock and fake timers:
 * every state as static markup (empty, queued, running, done with the report
 * and the disclaimer, failed, busy and rate limited, field errors, a new
 * verification's three methods, verified and not verified with reasons), and
 * the behaviour behind them: client-side checks, the verified tier sent only
 * for its own host, session storage holding the verification and nothing
 * else, scan polling backing off from 2 s to 5 s and pausing while hidden,
 * verification checks at once or by polling. Also that the page's limits are
 * the server's, and that its entry never reaches a local-only screen.
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const isElement = (n: Node): n is Element => 'tagName' in n;
const attr = (e: Element, name: string) => e.attrs.find((a) => a.name === name)?.value;
const textOf = (n: Node): string =>
  n.nodeName === '#text' && 'value' in n
    ? n.value
    : 'childNodes' in n
      ? n.childNodes.map(textOf).join('')
      : '';
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function find(n: Node, test: (e: Element) => boolean): Element[] {
  const out: Element[] = [];
  const visit = (x: Node) => {
    if (isElement(x) && test(x)) out.push(x);
    if ('childNodes' in x) x.childNodes.forEach(visit);
  };
  visit(n);
  return out;
}

const doc = (markup: string) => parse(`<!doctype html><html><body>${markup}</body></html>`);
const roleText = (markup: string, role: string) =>
  find(doc(markup), (e) => attr(e, 'role') === role).map((e) => norm(textOf(e)));
const tagText = (markup: string, tag: string) =>
  find(doc(markup), (e) => e.tagName === tag).map((e) => norm(textOf(e)));

/** Every input and select has a label (for=id). */
function expectLabelled(markup: string) {
  const d = doc(markup);
  const labels = new Set(find(d, (e) => e.tagName === 'label').map((l) => attr(l, 'for')));
  const controls = find(d, (e) => ['input', 'select', 'textarea'].includes(e.tagName));
  expect(controls.length).toBeGreaterThan(0);
  for (const c of controls) expect(labels.has(attr(c, 'id')), attr(c, 'id')).toBe(true);
}

/** Text only: no script or handler, and links only to the site's own fixed paths. */
function expectTextOnly(markup: string) {
  const d = doc(markup);
  expect(find(d, (e) => ['script', 'iframe', 'img', 'form'].includes(e.tagName))).toEqual([]);
  expect(find(d, (e) => e.attrs.some((a) => a.name.startsWith('on')))).toEqual([]);
  for (const a of find(d, (e) => e.tagName === 'a')) {
    const href = attr(a, 'href') ?? '';
    expect(isSitePath(href) || /^https?:\/\//.test(href), href).toBe(true);
  }
}

const standards = loadStandardsData();
const data: UiData = {
  plain: loadPlainData(),
  wcagTitle: new Map(standards.wcag.criteria.map((c) => [c.id, c.title])),
  provisionTitle: new Map(standards.section508.provisions.map((p) => [p.id, p.title])),
  errata: new Map(standards.errata.criteria.map((c) => [c.id, c.citations])),
};

const ID = 'a'.repeat(32);
const VID = 'b'.repeat(32);
const TOKEN = 'c'.repeat(32);
const HOUR = 60 * 60_000;
const later = (ms: number) => new Date(Date.now() + ms).toISOString();

const render = (initial: HostedInitialState = {}) =>
  renderToStaticMarkup(
    <HostedInitial.Provider value={initial}>
      <HostedApp data={data} />
    </HostedInitial.Provider>,
  );

const job = (status: ScanJob['status'], extra: Partial<ScanJob> = {}): ScanJob => ({
  id: ID,
  status,
  ...extra,
});

const verified = (host = 'site.example.org', expiresIn = HOUR): VerificationState => ({
  id: VID,
  host,
  expiresAt: later(expiresIn),
  status: 'verified',
});

const created = (host = 'site.example.org'): Created => ({
  id: VID,
  host,
  token: TOKEN,
  expiresAt: later(24 * HOUR),
  methods: {
    dnsTxt: { name: `_widedoor-challenge.${host}`, value: `widedoor-verification=${TOKEN}` },
    metaTag: `<meta name="widedoor-verification" content="${TOKEN}">`,
    wellKnown: { url: `https://${host}/.well-known/widedoor.txt`, body: TOKEN },
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('limits', () => {
  it("are the server's own constants", () => {
    expect(limits.OPEN_MAX_PAGES).toBe(OPEN_TIER.maxPages);
    expect(limits.PDF_MAX_BYTES).toBe(OPEN_TIER.pdfMaxBytes);
    expect(limits.PDF_MAX_PAGES).toBe(OPEN_TIER.pdfMaxPages);
    expect(limits.VERIFIED_MAX_PAGES).toBe(VERIFIED_TIER.maxPages);
    expect(limits.SCANS_PER_HOUR).toBe(SERVER_SCANS_PER_HOUR);
    expect(limits.RETENTION_MS).toBe(SERVER_RETENTION_MS);
    expect(limits.UPLOAD_DEADLINE_MS).toBe(SERVER_UPLOAD_DEADLINE_MS);
    expect(limits.VERIFY_VALID_MS).toBe(SERVER_VERIFY_VALID_MS);
    expect(limits.MAX_URL_LENGTH).toBe(MAX_TARGET_URL_LENGTH);
  });

  it('are stated in words from those constants', () => {
    expect(LIMITS_TEXT).toBe(
      'Each scan covers one URL plus up to 5 pages linked from it on the same site, or one PDF up to 25 MB and 100 pages. You can run about 10 scans an hour from one network. Reports are deleted 1 hour after the scan ends.',
    );
    expect(UPLOAD_TIME_TEXT).toBe(
      'Uploads must finish within 2 minutes, so very large files need a reasonably fast connection.',
    );
    expect(VERIFIED_OPTION).toBe('Scan on the verified tier (up to 200 pages)');
    expect(TOKEN_NOTE).toMatch(/not a secret.*valid for 24 hours\.$/);
  });

  it("offers the local Scan screen's profiles, defaulting to the server's default", () => {
    expect(HOSTED_PROFILES).toEqual(PROFILES.filter((p) => p.id !== ''));
    expect(HOSTED_PROFILES.map((p) => p.id).sort()).toEqual([...PROFILE_IDS].sort());
    expect(DEFAULT_PROFILE).toBe(SERVER_DEFAULT_PROFILE);
  });

  it('puts waits in words', () => {
    expect(waitText(1)).toBe('1 second');
    expect(waitText(45)).toBe('45 seconds');
    expect(waitText(61)).toBe('2 minutes');
    expect(waitText(3539)).toBe('59 minutes');
    expect(waitText(3540)).toBe('1 hour');
    expect(waitText(3600)).toBe('1 hour');
    expect(waitText(3601)).toBe('2 hours');
  });
});

describe('the page, empty', () => {
  const markup = render();

  it('has the heading, the limits, a labelled form and the footer links', () => {
    expect(tagText(markup, 'h1')).toEqual(['Widedoor accessibility scanner']);
    expect(tagText(markup, 'h2')).toEqual(['Scan a page or a PDF', 'Scan more of a site you own']);
    expect(markup).toContain(LIMITS_TEXT);
    expectLabelled(markup);
    expectTextOnly(markup);
    const links = find(doc(markup), (e) => e.tagName === 'a').map((a) => attr(a, 'href'));
    expect(links).toEqual(['/about-scanner', '/THIRD-PARTY-LICENSES.txt']);
    const select = find(doc(markup), (e) => e.tagName === 'select')[0];
    const chosen = find(
      select as Element,
      (e) => e.tagName === 'option' && attr(e, 'selected') !== undefined,
    );
    expect(chosen.map((o) => attr(o, 'value'))).toEqual([DEFAULT_PROFILE]);
  });

  it('has one status region for the scan and one for verification, both empty', () => {
    expect(roleText(markup, 'status')).toEqual(['', '']);
    expect(roleText(markup, 'alert')).toEqual(['', '']);
  });

  it('keeps verification collapsed, with no verified-tier offer', () => {
    const details = find(doc(markup), (e) => e.tagName === 'details');
    expect(details).toHaveLength(1);
    expect(attr(details[0] as Element, 'open')).toBeUndefined();
    expect(markup).not.toContain(VERIFIED_OPTION);
  });

  it('shows the upload deadline in PDF mode', () => {
    const pdf = render({ form: { mode: 'pdf' } });
    expect(pdf).toContain(UPLOAD_TIME_TEXT);
    const file = find(doc(pdf), (e) => attr(e, 'type') === 'file');
    expect(file.map((f) => attr(f, 'accept'))).toEqual(['.pdf,application/pdf']);
    expectLabelled(pdf);
  });
});

describe('the page, following a scan', () => {
  it('says the queue position, with a Cancel button', () => {
    const markup = render({
      phase: { kind: 'following', job: job('queued', { queuePosition: 3 }) },
    });
    expect(tagText(markup, 'h2')[0]).toBe('Scan in progress');
    expect(roleText(markup, 'status')[0]).toBe('The scan is queued. It is number 3 in line.');
    expect(tagText(markup, 'button')).toContain('Cancel scan');
    expect(markup).not.toContain('Start scan');
  });

  it('says it is running, and cancelling once asked', () => {
    expect(
      roleText(render({ phase: { kind: 'following', job: job('running') } }), 'status')[0],
    ).toBe('The scan is running. This can take a few minutes.');
    expect(
      roleText(render({ phase: { kind: 'following', job: job('starting') } }), 'status')[0],
    ).toBe('The scanner is starting.');
    const cancelling = render({
      phase: { kind: 'following', job: job('running'), cancelling: true },
    });
    expect(roleText(cancelling, 'status')[0]).toBe('Cancelling the scan.');
  });
});

describe('the page, done', () => {
  const report = fixtureReport();
  const markup = render({
    phase: {
      kind: 'done',
      job: job('done'),
      report: { report, screenshots: new Map(), attachments: new Map(), source: 'file', name: '' },
    },
  });

  it('shows the report under the disclaimer, with both downloads as plain links', () => {
    expect(tagText(markup, 'h2')[0]).toBe('Your report');
    const d = doc(markup);
    const links = find(d, (e) => e.tagName === 'a').map((a) => attr(a, 'href'));
    expect(links.slice(0, 2)).toEqual([
      `/api/scans/${ID}/report.json`,
      `/api/scans/${ID}/report.html`,
    ]);
    // The disclaimer comes directly before the report's first section.
    const disclaimer = find(d, (e) => attr(e, 'class') === 'disclaimer')[0] as Element;
    expect(norm(textOf(disclaimer))).toBe(DISCLAIMER);
    const siblings = (disclaimer.parentNode as Element).childNodes.filter(isElement);
    const next = siblings[siblings.indexOf(disclaimer) + 1] as Element;
    expect(next.tagName).toBe('section');
    expect(attr(next, 'aria-labelledby')).toBe('manual');
    expect(roleText(markup, 'status')[0]).toBe('The scan finished. Its report is below.');
    expect(tagText(markup, 'button')).toContain('Start a new scan');
  });

  it('renders hostile report text as text only', () => {
    expectTextOnly(markup);
    expect(markup).not.toContain(PAYLOAD);
  });

  it('says so when the report could not be shown, keeping the downloads', () => {
    const failed = render({
      phase: { kind: 'done', job: job('done'), reportError: 'The report is not usable: x.' },
    });
    expect(roleText(failed, 'alert')[0]).toBe('The report is not usable: x.');
    expect(find(doc(failed), (e) => e.tagName === 'a')).toHaveLength(4);
  });
});

describe('the page, ended', () => {
  it("shows a failed scan's message from the server as text, and a way to start again", () => {
    const markup = render({
      phase: {
        kind: 'ended',
        job: job('failed', { message: `the scan ran out of time ${PAYLOAD}` }),
      },
    });
    expect(tagText(markup, 'h2')[0]).toBe('The scan did not finish');
    expect(roleText(markup, 'status')[0]).toBe('The scan failed.');
    expect(markup).toContain('The scan ran out of time');
    expect(tagText(markup, 'button')).toContain('Start a new scan');
    expectTextOnly(markup);
  });

  it('says a cancelled or expired scan', () => {
    expect(tagText(render({ phase: { kind: 'ended', job: job('cancelled') } }), 'h2')[0]).toBe(
      'Scan cancelled',
    );
    const expired = render({ phase: { kind: 'ended', job: job('expired') } });
    expect(norm(textOf(doc(expired)))).toContain(
      "Results are kept for 1 hour, and this scan's are gone.",
    );
  });
});

describe('refusals', () => {
  /** Answers every call with one response. */
  const answer = (res: () => Response) => {
    const fetch = vi.fn(async () => res());
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('show a busy 503 and a 429 with the wait in words', async () => {
    answer(() =>
      Response.json(
        { error: 'Too many scans from your network. Try again later.' },
        { status: 429, headers: { 'retry-after': '1500' } },
      ),
    );
    const limited = await startScan({ kind: 'url', url: 'https://site.example.org/' }, '508').catch(
      (e: unknown) => e,
    );
    expect(limited).toBeInstanceOf(HostedError);
    expect(refusalText(limited)).toBe(
      'Too many scans from your network. Try again later. You can try again in 25 minutes.',
    );
    answer(() =>
      Response.json({ error: 'The scanner is busy. Try again in a few minutes.' }, { status: 503 }),
    );
    const busy = await startScan({ kind: 'url', url: 'https://site.example.org/' }, '508').catch(
      (e: unknown) => e,
    );
    expect(refusalText(busy)).toBe('The scanner is busy. Try again in a few minutes.');
    const markup = render({ form: { alert: refusalText(limited) } });
    expect(roleText(markup, 'alert')[0]).toBe(
      'Too many scans from your network. Try again later. You can try again in 25 minutes.',
    );
  });

  it("give a 500 the page's fixed text, never the body", async () => {
    answer(() => new Response('stack trace here', { status: 500 }));
    const e = await startScan({ kind: 'url', url: 'https://site.example.org/' }, '508').catch(
      (x: unknown) => x,
    );
    expect(refusalText(e)).toBe('The scanner hit an error. Try again later.');
  });
});

describe('client-side checks', () => {
  it('refuse an empty, non-web or overlong URL', () => {
    expect(urlError('')).toBe('Enter the address of a web page.');
    expect(urlError('   ')).toBe('Enter the address of a web page.');
    expect(urlError('ftp://site.example.org/')).toMatch(/starts with https:\/\//);
    expect(urlError('site.example.org')).toMatch(/starts with https:\/\//);
    expect(urlError(`https://site.example.org/${'a'.repeat(2048)}`)).toBe(
      'The address is too long.',
    );
    expect(urlError(' https://site.example.org/a ')).toBeUndefined();
  });

  it('refuse no file, a non-PDF and a file over 25 MB', async () => {
    expect(await pdfError(undefined)).toBe('Choose a PDF file.');
    expect(await pdfError(new File(['hello'], 'a.pdf'))).toBe('The file is not a PDF.');
    const big = new File([new Uint8Array(limits.PDF_MAX_BYTES + 1)], 'big.pdf');
    expect(await pdfError(big)).toBe('The file is over the 25 MB limit.');
    expect(await pdfError(new File(['%PDF-1.7\n'], 'ok.pdf'))).toBeUndefined();
  });

  it('tie the error to its field', () => {
    const markup = render({ form: { url: 'ftp://x', fieldError: 'Enter a full address.' } });
    const input = find(doc(markup), (e) => attr(e, 'type') === 'url')[0] as Element;
    expect(attr(input, 'aria-invalid')).toBe('true');
    const ids = (attr(input, 'aria-describedby') ?? '').split(' ');
    const described = find(doc(markup), (e) => ids.includes(attr(e, 'id') ?? '')).map((e) =>
      norm(textOf(e)),
    );
    expect(described).toContain('Enter a full address.');
    const pdf = render({ form: { mode: 'pdf', fieldError: 'The file is not a PDF.' } });
    const file = find(doc(pdf), (e) => attr(e, 'type') === 'file')[0] as Element;
    expect(attr(file, 'aria-invalid')).toBe('true');
    expect(attr(file, 'aria-describedby')).toMatch(/ /);
  });
});

describe('the verified tier', () => {
  const now = Date.now();

  it('is sent only for a URL on exactly the verified host, when asked for', () => {
    const v = verified();
    expect(urlTarget('https://site.example.org/a', true, v, now)).toEqual({
      kind: 'url',
      url: 'https://site.example.org/a',
      verificationId: VID,
    });
    expect(urlTarget('https://SITE.example.org./', true, v, now)).toMatchObject({
      verificationId: VID,
    });
    for (const url of [
      'https://www.site.example.org/',
      'https://example.org/',
      'https://a.site.example.org/',
      'https://site.example.org.evil.example/',
    ])
      expect(urlTarget(url, true, v, now), url).toEqual({ kind: 'url', url });
    expect(urlTarget('https://site.example.org/', false, v, now)).not.toHaveProperty(
      'verificationId',
    );
    expect(coversUrl({ ...v, status: 'failed' }, 'https://site.example.org/', now)).toBe(false);
    expect(coversUrl(verified('site.example.org', -HOUR), 'https://site.example.org/', now)).toBe(
      false,
    );
  });

  it('sends verificationId in the scan request', async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_: string, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({ id: ID, status: 'queued' }, { status: 202 });
      }),
    );
    await startScan({ kind: 'url', url: 'https://site.example.org/', verificationId: VID }, '508');
    await startScan({ kind: 'url', url: 'https://other.example.org/' }, '508');
    const bodies = sent;
    expect(bodies).toEqual([
      { url: 'https://site.example.org/', profile: '508', verificationId: VID },
      { url: 'https://other.example.org/', profile: '508' },
    ]);
  });

  it('is offered in the form only for a URL on the verified host', () => {
    const on = render({ verification: verified(), form: { url: 'https://site.example.org/x' } });
    expect(on).toContain(VERIFIED_OPTION);
    expectLabelled(on);
    const off = render({ verification: verified(), form: { url: 'https://example.org/' } });
    expect(off).not.toContain(VERIFIED_OPTION);
    expect(off).toContain('Your verification covers site.example.org only');
    const expired = render({
      verification: verified('site.example.org', -HOUR),
      form: { url: 'https://site.example.org/' },
    });
    expect(expired).not.toContain(VERIFIED_OPTION);
  });
});

describe('verification', () => {
  it('shows the three methods exactly as the API gave them, each with a Copy button', async () => {
    const made = created();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(made, { status: 201 })),
    );
    expect(await createVerification('site.example.org')).toEqual(made);
    const markup = render({
      verification: { id: VID, host: made.host, expiresAt: made.expiresAt, status: 'pending' },
      created: made,
    });
    expect(tagText(markup, 'h4')).toEqual(['DNS TXT record', 'Meta tag', 'Well-known file']);
    expect(tagText(markup, 'code')).toEqual([
      made.methods.dnsTxt.name,
      made.methods.dnsTxt.value,
      made.methods.metaTag,
      made.methods.wellKnown.body,
    ]);
    expect(markup).toContain(made.methods.wellKnown.url);
    expect(tagText(markup, 'button').filter((b) => b.startsWith('Copy'))).toEqual([
      'Copy the record name',
      'Copy the record value',
      'Copy the meta tag',
      'Copy the token',
    ]);
    expect(markup.split(TOKEN_NOTE)).toHaveLength(2);
    expect(tagText(markup, 'button')).toContain('Check now');
    // The meta tag is text, never markup.
    expect(find(doc(markup), (e) => e.tagName === 'meta')).toEqual([]);
    expectTextOnly(markup);
  });

  it('shows a verified one, and a failed one with what each method found', () => {
    const ok = render({ verification: verified() });
    expect(ok).toContain('Verified.');
    expect(ok).toContain('can now cover up to 200 pages');
    expect(tagText(ok, 'button')).not.toContain('Check now');
    const failed = render({
      verification: {
        ...verified(),
        status: 'failed',
        tried: [
          { method: 'dns_txt', ok: false, reason: 'no TXT record found' },
          { method: 'well_known', ok: false, reason: 'the file did not match the token' },
          { method: 'meta_tag', ok: false, reason: `private address ${PAYLOAD}` },
        ],
      },
    });
    const items = tagText(failed, 'li').filter((l) => /^(DNS|Well|Meta)/.test(l));
    expect(items).toEqual([
      'DNS TXT record: no TXT record found.',
      'Well-known file: the file did not match the token.',
      expect.stringMatching(/^Meta tag: private address /),
    ]);
    expect(tagText(failed, 'button')).toContain('Check again');
    expectTextOnly(failed);
  });

  it('holds Check and Start scan while a Retry-After runs, as the scan form does', () => {
    const disabled = (markup: string, name: string) =>
      find(doc(markup), (e) => e.tagName === 'button' && norm(textOf(e)) === name).map((b) =>
        attr(b, 'aria-disabled'),
      );
    const waiting = render({
      verification: { ...verified(), status: 'failed' },
      verify: { retryAt: Date.now() + 60_000 },
      form: { retryAt: Date.now() + 60_000 },
    });
    expect(disabled(waiting, 'Check again')).toEqual(['true']);
    expect(disabled(waiting, 'Start scan')).toEqual(['true']);
    const free = render({ verification: { ...verified(), status: 'failed' } });
    expect(disabled(free, 'Check again')).toEqual(['false']);
    expect(disabled(free, 'Start scan')).toEqual(['false']);
  });

  it('says what to do when the check takes too long', () => {
    const markup = render({
      verification: { ...verified(), status: 'checking' },
      verify: { timedOut: true, status: VERIFY_TIMEOUT },
    });
    expect(roleText(markup, 'status')[1]).toBe(VERIFY_TIMEOUT);
    expect(tagText(markup, 'button')).toContain('Check again');
  });
});

/** A clock, timers and visibility that move only when told. */
function fakeEnv() {
  let t = 0;
  let hidden = false;
  const timers: { at: number; fire: () => void; live: boolean }[] = [];
  const listeners = new Set<() => void>();
  const env: PollEnv = {
    now: () => t,
    setTimer: (fire, ms) => {
      const timer = { at: t + ms, fire, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => void ((timer as { live: boolean }).live = false),
    hidden: () => hidden,
    onVisibility: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  /**
   * Lets the page's promises run until the requests made and the timers set stop changing
   * for three turns in a row (at most 100 turns).
   */
  const settle = async () => {
    const state = () =>
      `${(globalThis.fetch as { mock?: { calls: unknown[] } }).mock?.calls.length ?? 0} ${
        timers.filter((x) => x.live).length
      }`;
    let last = state();
    for (let i = 0, stable = 0; i < 100 && stable < 3; i++) {
      await new Promise((done) => setImmediate(done));
      const now = state();
      stable = now === last ? stable + 1 : 0;
      last = now;
    }
  };
  return {
    env,
    now: () => t,
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.live = false;
        t = due.at;
        due.fire();
        await settle();
      }
      t = end;
      await settle();
    },
    async show(visible: boolean) {
      hidden = !visible;
      for (const listener of [...listeners]) listener();
      await settle();
    },
    listeners,
  };
}

describe('scan polling', () => {
  /** A fetch that answers scan polls with the given statuses in turn, then the last one. */
  function polls(statuses: ScanJob['status'][]) {
    const at: number[] = [];
    let i = 0;
    return {
      at,
      install(clock: () => number) {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => {
            at.push(clock());
            const status = statuses[Math.min(i++, statuses.length - 1)] ?? 'running';
            return Response.json(job(status));
          }),
        );
      },
    };
  }

  it('polls every 2 s for the first minute, then every 5 s, and stops at the end', async () => {
    const f = fakeEnv();
    const p = polls([...Array<ScanJob['status']>(40).fill('running'), 'done']);
    p.install(f.now);
    const seen: string[] = [];
    followScan(ID, { view: (j) => seen.push(j.status), error: () => undefined }, f.env);
    await f.advance(60_000);
    expect(p.at).toHaveLength(60_000 / SCAN_POLL_FAST_MS);
    expect(p.at.slice(0, 3)).toEqual([2_000, 4_000, 6_000]);
    const before = p.at.length;
    await f.advance(20_000);
    expect(p.at.slice(before)).toEqual([65_000, 70_000, 75_000, 80_000]);
    expect(SCAN_POLL_SLOW_MS).toBe(5_000);
    await f.advance(5 * 60_000);
    expect(seen.at(-1)).toBe('done');
    const total = p.at.length;
    await f.advance(60_000);
    expect(p.at).toHaveLength(total);
    expect(f.listeners.size).toBe(0);
  });

  it('pauses while the tab is hidden and polls at once when it is shown', async () => {
    const f = fakeEnv();
    const p = polls(['running']);
    p.install(f.now);
    const stop = followScan(ID, { view: () => undefined, error: () => undefined }, f.env);
    await f.advance(2_000);
    expect(p.at).toEqual([2_000]);
    await f.show(false);
    await f.advance(30_000);
    expect(p.at).toEqual([2_000]);
    await f.show(true);
    expect(p.at).toEqual([2_000, 32_000]);
    await f.advance(2_000);
    expect(p.at).toEqual([2_000, 32_000, 34_000]);
    stop();
    await f.advance(10_000);
    expect(p.at).toHaveLength(3);
  });

  it('keeps polling through a failed poll, and stops for an unknown scan', async () => {
    const f = fakeEnv();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n++;
        if (n === 1) throw new TypeError('network down');
        return Response.json({ error: 'Not found: no such scan.' }, { status: 404 });
      }),
    );
    const errors: number[] = [];
    followScan(ID, { view: () => undefined, error: (e) => errors.push(e.status) }, f.env);
    await f.advance(10_000);
    expect(errors).toEqual([0, 404]);
    expect(n).toBe(2);
  });

  it('waits longer after failed polls in a row, at least the Retry-After, and resets on success', async () => {
    const f = fakeEnv();
    const at: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        at.push(f.now());
        if (at.length <= 4) throw new TypeError('network down');
        if (at.length === 5)
          return Response.json(
            { error: 'Too many requests.' },
            { status: 429, headers: { 'retry-after': '30' } },
          );
        return Response.json(job('running'));
      }),
    );
    followScan(ID, { view: () => undefined, error: () => undefined }, f.env);
    await f.advance(100_000);
    // 2 s, then doubling from 2 s; the 429 asks 30 s but the fifth failure in a row is
    // capped at 60 s; after a good answer the usual 5 s.
    expect(at).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 92_000, 97_000]);
    expect(errorWait(2_000, 1, 30)).toBe(30_000);
    expect(errorWait(5_000, 9)).toBe(ERROR_WAIT_MAX_MS);
    expect(errorWait(5_000, 1, 120)).toBe(120_000);
  });

  it('calls no handler for a poll that answers after it was stopped', async () => {
    const f = fakeEnv();
    let answer: (res: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((done) => (answer = done))),
    );
    const heard: string[] = [];
    const stop = followScan(
      ID,
      { view: (j) => heard.push(j.status), error: (e) => heard.push(String(e.status)) },
      f.env,
    );
    await f.advance(2_000);
    stop();
    answer(Response.json(job('done')));
    await f.advance(60_000);
    expect(heard).toEqual([]);
    expect(f.listeners.size).toBe(0);
  });
});

describe('verification checks', () => {
  /** Answers the check POST with check, then each GET with the next view. */
  function api(check: Response, views: unknown[] = []) {
    const calls: string[] = [];
    let i = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init: RequestInit) => {
        calls.push(`${init.method ?? 'GET'} ${path}`);
        if (init.method === 'POST') return check;
        return Response.json(views[Math.min(i++, views.length - 1)]);
      }),
    );
    return calls;
  }
  const view = (status: string, tried?: unknown[]) => ({
    id: VID,
    host: 'site.example.org',
    status,
    expiresAt: later(HOUR),
    ...(tried ? { tried } : {}),
  });

  it('a 200 is verified at once, with no polling', async () => {
    const f = fakeEnv();
    const calls = api(Response.json({ status: 'verified' }));
    const statuses: string[] = [];
    await runCheck(
      VID,
      {
        status: (s) => statuses.push(s),
        view: () => undefined,
        timeout: () => undefined,
        error: () => undefined,
      },
      f.env,
    );
    await f.advance(VERIFY_POLL_FOR_MS);
    expect(statuses).toEqual(['verified']);
    expect(calls).toEqual([`POST /api/verifications/${VID}/check`]);
  });

  it('a 202 polls every 3 s until verified', async () => {
    const f = fakeEnv();
    const calls = api(Response.json({ status: 'checking' }, { status: 202 }), [
      view('checking'),
      view('verified', [{ method: 'well_known', ok: true }]),
    ]);
    const views: string[] = [];
    await runCheck(
      VID,
      {
        status: () => undefined,
        view: (v) => views.push(v.status),
        timeout: () => undefined,
        error: () => undefined,
      },
      f.env,
    );
    await f.advance(VERIFY_POLL_MS * 5);
    expect(views).toEqual(['checking', 'verified']);
    expect(calls).toHaveLength(3);
  });

  it('a 202 then not verified gives the reasons', async () => {
    const f = fakeEnv();
    const tried = [
      { method: 'dns_txt', ok: false, reason: 'no TXT record found' },
      { method: 'well_known', ok: false, reason: 'the site could not be reached' },
      { method: 'meta_tag', ok: false, reason: 'the page has no matching meta tag' },
    ];
    api(Response.json({ status: 'checking' }, { status: 202 }), [view('failed', tried)]);
    let last: unknown;
    await runCheck(
      VID,
      {
        status: () => undefined,
        view: (v) => (last = v),
        timeout: () => undefined,
        error: () => undefined,
      },
      f.env,
    );
    await f.advance(VERIFY_POLL_MS);
    expect(last).toMatchObject({ status: 'failed', tried });
  });

  it('gives up after 3 minutes of checking, and waits while hidden', async () => {
    const f = fakeEnv();
    const calls = api(Response.json({ status: 'checking' }, { status: 202 }), [view('checking')]);
    let timedOut = 0;
    await runCheck(
      VID,
      {
        status: () => undefined,
        view: () => undefined,
        timeout: () => void timedOut++,
        error: () => undefined,
      },
      f.env,
    );
    await f.show(false);
    await f.advance(VERIFY_POLL_FOR_MS + 10_000);
    expect(calls).toHaveLength(1);
    expect(timedOut).toBe(0);
    // Shown again past the limit: one last look, then the timeout.
    await f.show(true);
    expect(calls).toHaveLength(2);
    expect(timedOut).toBe(1);
  });

  it('throws the check refusal with its wait', async () => {
    api(
      Response.json(
        { error: 'That verification was just checked. Try again shortly.' },
        { status: 429, headers: { 'retry-after': '42' } },
      ),
    );
    const e = await runCheck(
      VID,
      {
        status: () => undefined,
        view: () => undefined,
        timeout: () => undefined,
        error: () => undefined,
      },
      fakeEnv().env,
    ).catch((x: unknown) => x);
    expect(refusalText(e)).toBe(
      'That verification was just checked. Try again shortly. You can try again in 42 seconds.',
    );
  });
});

describe('storage', () => {
  let session: Map<string, string>;
  const touched: string[] = [];
  beforeEach(() => {
    session = new Map();
    touched.length = 0;
    const refuse = (name: string) => () => {
      touched.push(name);
      throw new Error(`${name} must not be used`);
    };
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (k: string) => session.get(k) ?? null,
        setItem: (k: string, v: string) => void session.set(k, v),
        removeItem: (k: string) => void session.delete(k),
      },
      localStorage: { getItem: refuse('localStorage'), setItem: refuse('localStorage') },
    });
  });

  it('keeps the verification id, host and expiry, never the token, and nothing else', () => {
    const made = created();
    saveVerification(made);
    expect([...session.keys()]).toEqual([VERIFICATION_KEY]);
    expect(JSON.parse(session.get(VERIFICATION_KEY) ?? '')).toEqual({
      id: VID,
      host: made.host,
      expiresAt: made.expiresAt,
    });
    expect(session.get(VERIFICATION_KEY)).not.toContain(TOKEN);
    expect(loadVerification()).toEqual({ id: VID, host: made.host, expiresAt: made.expiresAt });
    forgetVerification();
    expect(session.size).toBe(0);
    expect(touched).toEqual([]);
  });

  it('ignores a stored value that is not a verification', () => {
    session.set(
      VERIFICATION_KEY,
      JSON.stringify({ id: VID, host: 'x', expiresAt: 'soon', token: TOKEN }),
    );
    expect(loadVerification()).toBeUndefined();
    session.set(VERIFICATION_KEY, '{not json');
    expect(loadVerification()).toBeUndefined();
  });

  it('is the only storage any hosted module touches', () => {
    const dir = fileURLToPath(new URL('../src/hosted/', import.meta.url));
    for (const file of readdirSync(dir)) {
      // Code only: the comments may name what is not used.
      const text = readFileSync(join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(text, file).not.toMatch(/localStorage|document\.cookie|indexedDB|caches\./);
      if (file !== 'storage.ts') expect(text, file).not.toMatch(/sessionStorage/);
    }
  });
});

describe('the report', () => {
  it('comes from report.json through load.ts, never report.html', async () => {
    const report = fixtureReport();
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(report), { headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetch);
    const result = await fetchReport(ID);
    expect(result.ok).toBe(true);
    expect(fetch.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      `/api/scans/${ID}/report.json`,
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"not":"a report"}')),
    );
    const bad = await fetchReport(ID);
    expect(bad).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^The report is not usable: /),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'The report is gone: results are kept for 1 hour.' },
          { status: 410 },
        ),
      ),
    );
    expect(await fetchReport(ID)).toEqual({
      ok: false,
      message: 'The report is gone: results are kept for 1 hour.',
    });
  });
});

describe('the hosted entry', () => {
  /** Every module main.tsx reaches through relative imports. */
  function reached(): Set<string> {
    const src = fileURLToPath(new URL('../src/', import.meta.url));
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/^import\s+(?!type\b)[^'"]*['"](\.[^'"]+)['"]/gm)) {
        const spec = (m[1] ?? '').replace(/\.js$/, '');
        const base = resolve(dirname(file), spec);
        const next = ['.ts', '.tsx', '.css', '']
          .map((x) => `${base}${x}`)
          .find((p) => {
            try {
              readFileSync(p);
              return true;
            } catch {
              return false;
            }
          });
        if (next && /\.tsx?$/.test(next)) visit(next);
      }
    };
    visit(join(src, 'hosted', 'main.tsx'));
    return new Set([...seen].map((f) => f.slice(src.length).replace(/\\/g, '/')));
  }

  it('reaches no local-only screen', () => {
    const files = reached();
    expect(files).toContain('ReportView.tsx');
    expect(files).toContain('load.ts');
    for (const screen of [
      'App.tsx',
      'ScanView.tsx',
      'ChecklistView.tsx',
      'ExportView.tsx',
      'ReviewForm.tsx',
    ])
      expect(files, screen).not.toContain(screen);
  });

  it('is the second entry of the Vite build, with its own page', () => {
    const config = readFileSync(
      fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      'utf8',
    );
    expect(config).toMatch(/hosted: fileURLToPath\(new URL\('\.\/hosted\.html'/);
    const html = readFileSync(fileURLToPath(new URL('../hosted.html', import.meta.url)), 'utf8');
    expect(html).toContain('<script type="module" src="/src/hosted/main.tsx"></script>');
    expect(html).not.toMatch(/\sstyle=|<style|\son[a-z]+=/i);
  });
});
