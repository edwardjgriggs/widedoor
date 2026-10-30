/// <reference lib="dom" />
import { spawn, type ChildProcess } from 'node:child_process';
import { AxeBuilder } from '@axe-core/playwright';
import type { Browser, Locator, Page } from 'playwright';
import { expect } from 'vitest';
import { BIN, interrupt } from './helpers.ts';

/*
 * Driving widedoor ui in Chromium, for the browser and docker suites (one
 * copy for every ui test file): start the built bin's ui command, open its
 * link in a page that records dialogs, errors and CSP violations from the
 * first script on, check axe, change screens with the keyboard, and walk the
 * page with the Tab key.
 */

export interface UiChild {
  child: ChildProcess;
  url: string;
  port: number;
  stdout: () => string;
  stderr: () => string;
  closed: Promise<number | null>;
  /** The session token, once a page has traded the link's code for it. */
  token?: string;
}

/**
 * Starts `widedoor ui <args> --no-open` in cwd, serving the viewer build in
 * dist (never the shipped packages/ui/dist), and waits for the link it prints.
 */
export function startUi(args: readonly string[], cwd: string, dist: string): Promise<UiChild> {
  return new Promise((ready, fail) => {
    const child = spawn(process.execPath, [BIN, 'ui', ...args, '--no-open'], {
      cwd,
      env: { ...process.env, WIDEDOOR_UI_DIST: dist },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let text = '';
    let err = '';
    const closed = new Promise<number | null>((done) => child.once('close', (code) => done(code)));
    const timer = setTimeout(() => fail(new Error(`no link printed: ${text} ${err}`)), 30_000);
    child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.stdout?.on('data', (c: Buffer) => {
      text += c.toString('utf8');
      const m = /(http:\/\/127\.0\.0\.1:(\d+)\/\?code=[A-Za-z0-9_-]+)/.exec(text);
      if (m?.[1] && m[2]) {
        clearTimeout(timer);
        ready({
          child,
          url: m[1],
          port: Number(m[2]),
          stdout: () => text,
          stderr: () => err,
          closed,
        });
      }
    });
    child.once('error', fail);
    void closed.then((code) => fail(new Error(`ui exited early (${code}): ${text} ${err}`)));
  });
}

/** `widedoor ui --root <root>`, run in the root. */
export const startUiAt = (root: string, dist: string): Promise<UiChild> =>
  startUi(['--root', root], root, dist);

export async function stopUi(ui: UiChild): Promise<void> {
  if (ui.child.exitCode === null) interrupt(ui.child);
  expect(await ui.closed).toBe(0);
  expect(ui.stdout()).toContain('Widedoor UI stopped.');
}

export interface Watched {
  page: Page;
  dialogs: string[];
  errors: string[];
  violations: () => Promise<string[]>;
}

/** A page that records dialogs, console errors, page errors and CSP violations. */
export async function watchedPage(browser: Browser): Promise<Watched> {
  // AxeBuilder needs a context it can open a second page in; downloads are kept.
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  const dialogs: string[] = [];
  const errors: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  // Added through the DevTools protocol, so the page CSP does not block it.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __violations: string[] }).__violations = seen;
    document.addEventListener('securitypolicyviolation', (e) =>
      seen.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  return {
    page,
    dialogs,
    errors,
    violations: () =>
      page.evaluate(() => (window as unknown as { __violations: string[] }).__violations),
  };
}

export async function axeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
  );
}

/** Asserts axe finds nothing, naming the state in the failure. */
export async function expectAxeClean(page: Page, state: string): Promise<void> {
  expect(await axeViolations(page), state).toEqual([]);
}

/**
 * What makes the page scroll sideways (WCAG 1.4.10 reflow): [] when it does not, else the
 * elements that reach past its width. Inner regions that scroll on their own, and their
 * content, do not count.
 */
export const scrollsSideways = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    if (root.scrollWidth <= root.clientWidth) return [];
    const scrolls = (el: Element | null): boolean =>
      el !== null &&
      el !== document.body &&
      (['auto', 'scroll'].includes(getComputedStyle(el).overflowX) || scrolls(el.parentElement));
    return [...document.body.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > root.clientWidth + 1)
      .filter((el) => !scrolls(el.parentElement))
      .slice(0, 8)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className} ${el.textContent?.slice(0, 40)}`);
  });

/** A nav button. */
export const navButton = (page: Page, name: string): Locator =>
  page.getByRole('navigation', { name: 'Screens' }).getByRole('button', { name, exact: true });

/**
 * Opens a screen with the keyboard (focus its nav button, press Enter) and
 * checks focus moved to the page heading and the button is marked current.
 */
export async function showScreen(page: Page, name: string, heading: string): Promise<void> {
  const button = navButton(page, name);
  await button.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
  expect(await page.locator('h1').innerText()).toBe(heading);
  expect(await button.getAttribute('aria-current')).toBe('page');
}

/** The checklist item for a criterion (h4 text starts with it) under an asset's h3. */
export const checklistItem = (page: Page, asset: string, criterion: RegExp): Locator =>
  page
    .locator('section[aria-labelledby^="ck-group-"]', {
      has: page.getByRole('heading', { level: 3, name: asset, exact: true }),
    })
    .locator('li.item', { has: page.getByRole('heading', { level: 4, name: criterion }) });

export interface TabWalk {
  /** Focusable, visible controls the Tab key never reached. */
  unreached: string[];
  /** Controls that showed no outline when focused from the keyboard. */
  noOutline: string[];
  stops: number;
}

/**
 * Walks the page with the Tab key from where focus is until it comes back
 * round to a stop it already saw (passing through the browser's own UI at
 * the end), or max presses, and compares the stops with every visible
 * control: a radio group counts as one stop. Each stop must show a focus
 * outline.
 */
export async function tabWalk(page: Page, max = 1500): Promise<TabWalk> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-walk]')) el.removeAttribute('data-walk');
  });
  const seen: string[] = [];
  const noOutline: string[] = [];
  let outside = 0;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate((n) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return undefined;
      el.dataset.walk ??= String(n);
      const style = getComputedStyle(el);
      const outlined = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
      return {
        key: el.dataset.walk,
        outlined,
        what: `${el.tagName.toLowerCase()} ${(el.textContent ?? '').trim().slice(0, 60)}`,
      };
    }, i);
    // Focus left the page (the browser's UI); a few presses bring it back to the top.
    if (!stop) {
      if (++outside > 5) break;
      continue;
    }
    outside = 0;
    if (seen.includes(stop.key)) break;
    seen.push(stop.key);
    if (!stop.outlined) noOutline.push(stop.what);
  }
  const controls = await page.evaluate(() => {
    const visible = (el: Element) => (el as HTMLElement).offsetParent !== null;
    return [
      ...document.querySelectorAll(
        'button, input, select, textarea, summary, a[href], [tabindex="0"]',
      ),
    ]
      .filter((el) => visible(el) && !(el as HTMLInputElement).disabled)
      .map((el) => ({
        key: (el as HTMLElement).dataset.walk,
        radio: el instanceof HTMLInputElement && el.type === 'radio' ? el.name : undefined,
        what: `${el.tagName.toLowerCase()} ${el.id || (el.textContent ?? '').trim().slice(0, 60)}`,
      }));
  });
  const reachedGroups = new Set(
    controls.filter((c) => c.radio && c.key && seen.includes(c.key)).map((c) => c.radio),
  );
  const unreached = controls
    .filter((c) => !(c.key && seen.includes(c.key)))
    .filter((c) => !(c.radio && reachedGroups.has(c.radio)))
    .map((c) => c.what);
  return { unreached, noOutline, stops: seen.length };
}

/** Asserts every visible control is reached by Tab, with a visible outline, and focus does not stick. */
export async function expectKeyboardOperable(page: Page, state: string): Promise<void> {
  const walk = await tabWalk(page);
  expect(walk.unreached, `${state}: unreached`).toEqual([]);
  expect(walk.noOutline, `${state}: no focus outline`).toEqual([]);
  expect(walk.stops, state).toBeGreaterThan(1);
}
