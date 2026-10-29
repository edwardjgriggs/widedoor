import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { expect } from 'vitest';
import { chromiumLaunchOptions, type LaunchOptions } from '../src/context.ts';

/*
 * Chromium's own host resolver, watched through its net log. With the egress proxy and
 * `--host-resolver-rules=MAP * ~NOTFOUND`, every host resolver job must end NOT_RESOLVED or
 * not exist: a job that reached a real resolver, or got an answer, is a name Chromium looked
 * up outside the proxy. The backstop is Task 8's kernel rule: the scan user has no DNS.
 */

interface NetLog {
  constants: {
    logEventTypes: Record<string, number>;
    logEventPhase: Record<string, number>;
  };
  events: { type: number; phase: number; params?: Record<string, unknown> }[];
}

/**
 * Asserts that no host resolver job in the log reached a resolver or got an answer, and that
 * at least one job carried a host: with none, a renamed field or event would leave nothing to
 * check and the detector would pass on any log.
 */
export function expectNoHostResolution(log: NetLog): void {
  const nameOf = new Map<number, string>();
  for (const [name, id] of Object.entries(log.constants.logEventTypes))
    if (name.includes('HOST_RESOLVER')) nameOf.set(id, name);
  const end = log.constants.logEventPhase.PHASE_END;
  expect(log.events.length).toBeGreaterThan(0);
  let hosts = 0;
  for (const event of log.events.filter((e) => nameOf.has(e.type))) {
    const name = nameOf.get(event.type) ?? '';
    // The host rules rewrite every name to ~notfound before the job is logged, so a job for a
    // real name means the rules are missing (the `<-loopback>` bypass check resolves each name).
    const host = event.params?.host;
    if (typeof host === 'string') {
      hosts += 1;
      const bare = host
        .replace(/^[a-z]+:\/\//i, '')
        .replace(/:\d+$/, '')
        .replace(/^\[|\]$/g, '');
      expect(bare === '~notfound' || isIP(bare) !== 0, `Chromium looked up ${bare}`).toBe(true);
    }
    // A job that reached a real resolver, or got an answer, shows up as one of these.
    expect(name).not.toMatch(/DNS_TASK|PROC_TASK|ATTEMPT|CACHE_HIT|EXTRACTION_RESULTS/);
    if (event.phase === end && event.params && 'net_error' in event.params)
      expect(event.params.net_error).toBe(-105); // ERR_NAME_NOT_RESOLVED
  }
  expect(hosts, 'no host resolver event carried a host').toBeGreaterThan(0);
}

/**
 * Launches Chromium with the net log on, calls use, closes the browser and checks the log
 * for host resolution.
 */
export async function withNetLog(
  options: LaunchOptions,
  use: (browser: Browser) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'widedoor-netlog-'));
  const logFile = join(dir, 'net.json');
  try {
    const launch = chromiumLaunchOptions(options);
    const logged = await chromium.launch({
      ...launch,
      args: [
        ...(launch.args ?? []),
        `--log-net-log=${logFile}`,
        '--net-log-capture-mode=Everything',
      ],
    });
    try {
      await use(logged);
    } finally {
      await logged.close();
    }
    expectNoHostResolution(JSON.parse(readFileSync(logFile, 'utf8')) as NetLog);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
