import { PinnedResolver, formatProxyEvent, startEgressProxy } from '@widedoor/web/egress';
import { EGRESS_PORT } from './protocol.js';

/*
 * The scan machine's egress proxy process. The image's scan entry runs it as uid 10002,
 * the one user the kernel lets reach the internet (Task 8b); the scan child reaches the
 * internet only through it. It listens on EGRESS_PORT and prints `ready <port>` as its
 * first stdout line once it does, then one formatProxyEvent line per event. It never
 * runs as root: the agent holds the job token as root, and the proxy parses everything
 * a scanned page sends.
 */

/**
 * Set to 1 to let the proxy run as root (tests). The image never sets it: as root the
 * proxy would share the agent's uid.
 */
export const SAME_USER_ENV = 'WIDEDOOR_EGRESS_SAME_USER';

export { EGRESS_PORT };

export interface EgressBinOptions {
  env: NodeJS.ProcessEnv;
  /** Stops the proxy (SIGTERM or SIGINT); main then resolves with 0. */
  signal: AbortSignal;
  /** The process's uid (tests). Default process.getuid(), undefined on Windows. */
  getuid?: () => number | undefined;
  /** Where lines go. Default: stdout. */
  write?: (line: string) => void;
  /** Listen address (tests). Default: the proxy's, 127.0.0.1. */
  host?: string;
  /** Listen port (tests; 0 for any free port). Default EGRESS_PORT. */
  port?: number;
}

/** The real uid, or 0 when the effective uid is root; undefined where there are none (Windows). */
function processUid(): number | undefined {
  const uid = process.getuid?.();
  const euid = process.geteuid?.();
  if (uid === undefined || euid === undefined) return undefined;
  return euid === 0 ? 0 : uid;
}

/**
 * Runs the proxy until `signal` aborts. Resolves with the exit code: 0 once stopped,
 * 1 when it may not run as this user or could not start.
 */
export async function main(options: EgressBinOptions): Promise<number> {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const uid = (options.getuid ?? processUid)();
  // Only Windows (tests) has no uid; anywhere else an unknown uid may be root.
  const mayBeRoot = uid === 0 || (uid === undefined && process.platform !== 'win32');
  if (mayBeRoot && options.env[SAME_USER_ENV] !== '1') {
    write('widedoor event=egress_config_error name=uid');
    return 1;
  }

  let proxy;
  try {
    proxy = await startEgressProxy({
      resolver: new PinnedResolver(),
      ...(options.host !== undefined ? { host: options.host } : {}),
      port: options.port ?? EGRESS_PORT,
      onEvent: (event) => write(formatProxyEvent(event)),
    });
  } catch (error) {
    // Only a system error code (EADDRINUSE and the like), never the message.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    write(
      typeof code === 'string' && /^E[A-Z]+$/.test(code)
        ? `widedoor event=egress_start_failed code=${code}`
        : 'widedoor event=egress_start_failed',
    );
    return 1;
  }
  write(`ready ${proxy.port}`);

  const { signal } = options;
  await new Promise<void>((done) => {
    if (signal.aborted) done();
    else signal.addEventListener('abort', () => done(), { once: true });
  });
  await proxy.close();
  return 0;
}

// Only as a process entry point.
if (import.meta.main) {
  // A closed stdout (the reader died) ends the proxy: a proxy whose log nobody reads must
  // not keep serving a scan, so nothing listens on the port and the scan fails closed.
  process.stdout.on('error', () => process.exit(1));
  const stop = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT'] as const)
    process.once(name, () => {
      stop.abort();
      // Backstop from the signal on: a close that hangs must not keep the proxy up.
      setTimeout(() => process.exit(0), 2_000).unref();
    });
  const code = await main({ env: process.env, signal: stop.signal });
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2_000).unref();
}
