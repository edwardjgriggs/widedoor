import { spawn as nodeSpawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { withoutProviderEnv } from '@widedoor/core';
import { CONTAINER_LABEL, TASKKILL, runProcess, type SpawnFn } from '@widedoor/pdf';

/*
 * Run lifecycle: every process the PDF scan starts goes through a tracker, so
 * an interrupt or a cancelled scan job can kill it, and every veraPDF
 * container is named after this host and process, so a later run can tell a
 * leftover of a dead run from a container a live run still uses. Chromium is
 * Playwright's: a cancelled scan closes the browser (performScan's signal),
 * and Playwright closes its browsers on SIGINT, SIGTERM and SIGHUP and kills
 * them when this process exits.
 */

const isWindows = process.platform === 'win32';

/** Starts child processes and remembers the live ones, so they can be killed on an interrupt. */
export class ProcessTracker {
  private readonly live = new Map<ChildProcess, { detached: boolean }>();
  private stopped = false;

  readonly spawn: SpawnFn = (command, args, options) => {
    if (this.stopped) throw new Error('the scan is stopping');
    const child = nodeSpawn(command, args, options);
    this.live.set(child, { detached: options.detached === true });
    const forget = () => void this.live.delete(child);
    child.once('exit', forget);
    child.once('error', forget);
    return child;
  };

  get size(): number {
    return this.live.size;
  }

  /** Refuses new processes and kills the live ones (with their process trees). Synchronous, so it can run in an exit handler. */
  stop(): void {
    this.stopped = true;
    for (const [child, { detached }] of this.live) {
      if (child.pid === undefined || child.exitCode !== null) continue;
      try {
        if (isWindows)
          spawnSync(TASKKILL, ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
            timeout: 10_000,
            env: withoutProviderEnv(process.env),
          });
        else if (detached) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
    this.live.clear();
  }
}

/** Short, stable tag for this host, so container names never carry the host name itself. */
export const hostTag = (name = hostname()): string =>
  createHash('sha256').update(name).digest('hex').slice(0, 8);

/** Container name prefix for one run: host tag and process id (the runner appends a random id). */
export const containerPrefix = (pid = process.pid, host = hostTag()): string =>
  `widedoor-verapdf-h${host}-p${pid}`;

const OWNED = /^widedoor-verapdf-h([0-9a-f]{8})-p(\d+)-/;

export interface ContainerRow {
  id: string;
  name: string;
  state: string;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Which labeled containers are leftovers: one named by this host for a
 * process that no longer runs, or any other that has exited or died. Any
 * other state (running, created, paused) may belong to a live scan on a
 * shared daemon, mid-start, and is left alone; its CPU-time limit ends it.
 */
export function staleContainers(
  rows: readonly ContainerRow[],
  host: string = hostTag(),
  alive: (pid: number) => boolean = isAlive,
): string[] {
  return rows
    .filter((row) => {
      const owned = OWNED.exec(row.name);
      if (owned && owned[1] === host) return !alive(Number(owned[2]));
      return row.state === 'exited' || row.state === 'dead';
    })
    .map((row) => row.id);
}

/** docker ps arguments for the labeled veraPDF containers, optionally only those whose name starts a run's prefix. */
export const listArgs = (prefix?: string): string[] => [
  'ps',
  '--all',
  '--no-trunc',
  '--filter',
  `label=${CONTAINER_LABEL}`,
  '--format',
  '{{.ID}}\t{{.Names}}\t{{.State}}',
  ...(prefix === undefined ? [] : ['--filter', `name=${prefix}-`]),
];

export function parseContainerRows(stdout: string): ContainerRow[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const [id, name, state] = line.trim().split('\t');
    return id && name && state ? [{ id, name, state }] : [];
  });
}

const LIMITS = { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 };

/** Removes leftover veraPDF containers of earlier runs. Returns how many; never throws. */
export async function sweepContainers(docker: string, spawn: SpawnFn): Promise<number> {
  try {
    const list = await runProcess(docker, listArgs(), LIMITS, { spawn });
    if (list.exitCode !== 0) return 0;
    const stale = staleContainers(parseContainerRows(list.stdout));
    if (stale.length === 0) return 0;
    const rm = await runProcess(docker, ['rm', '--force', ...stale], LIMITS, { spawn });
    return rm.exitCode === 0 ? stale.length : 0;
  } catch {
    return 0;
  }
}

/** Removes this run's own containers. Synchronous, for the interrupt and exit paths. */
export function removeOwnContainers(docker: string, prefix: string): void {
  // Provider keys stay in the CLI process, as for every other child (core's withoutProviderEnv).
  const sync = {
    encoding: 'utf8' as const,
    windowsHide: true,
    timeout: 15_000,
    env: withoutProviderEnv(process.env),
  };
  try {
    const list = spawnSync(docker, listArgs(prefix), sync);
    const own = parseContainerRows(list.stdout ?? '')
      .filter((row) => row.name.startsWith(`${prefix}-`))
      .map((row) => row.id);
    if (own.length > 0) spawnSync(docker, ['rm', '--force', ...own], sync);
  } catch {
    // Docker is gone; the containers' CPU-time limit ends them.
  }
}

/** The signals that stop a scan. SIGHUP fires on Windows too, when the console window closes. */
export const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Message a parent sends over an IPC channel to stop the scan as SIGINT would
 * (Windows has no catchable kill signal). A supported control for whatever
 * spawns the CLI with an ipc stdio slot: only that parent holds the channel,
 * and it could kill the process anyway. Only this exact string is acted on;
 * any later message types must be validated just as strictly.
 */
export const INTERRUPT_MESSAGE = 'widedoor:interrupt';

/**
 * Calls onStop once for the first stop signal (or IPC interrupt message) and
 * cleanup on process exit. Returns a function that removes the handlers.
 */
export function onStop(onSignal: (signal: string) => void, cleanup: () => void): () => void {
  const signal = (s: string) => onSignal(s);
  const message = (m: unknown) => {
    if (m === INTERRUPT_MESSAGE) onSignal('SIGINT');
  };
  for (const s of STOP_SIGNALS) process.on(s, signal);
  process.on('exit', cleanup);
  if (process.channel) process.on('message', message);
  return () => {
    for (const s of STOP_SIGNALS) process.off(s, signal);
    process.off('exit', cleanup);
    process.off('message', message);
    process.channel?.unref();
  };
}
