import { describe, expect, it } from 'vitest';
import { chromiumLaunchOptions } from '../src/context.ts';

/*
 * CWE-295 guard: the SSRF suite trusts its throwaway TLS key with a Chromium flag in one test.
 * The launch options the scanner itself uses must never carry certificate-error overrides.
 */
describe('chromiumLaunchOptions and TLS verification', () => {
  it.each([
    {},
    { unsafeNoSandbox: true },
    { proxy: { server: 'http://127.0.0.1:3128' } },
    { proxy: { server: 'http://[::1]:3128' }, unsafeNoSandbox: true },
  ])('turns off no certificate check: %j', (options) => {
    const launch: Record<string, unknown> & { args?: string[] } = chromiumLaunchOptions(options);
    expect(
      launch.args?.filter((arg) => arg.startsWith('--ignore-certificate-errors')) ?? [],
    ).toEqual([]);
    expect(launch).not.toHaveProperty('ignoreHTTPSErrors');
  });
});
