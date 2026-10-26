import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';

/** The veraPDF release Widedoor runs; verapdf-map.yaml is built from its rel/1.30 profiles. */
export const VERAPDF_VERSION = '1.30.3';
/** The pinned Docker image, by tag (what users pull). */
export const VERAPDF_IMAGE = `verapdf/cli:v${VERAPDF_VERSION}`;
/** The same image by digest (linux/amd64 manifest), so a re-pushed tag cannot change what runs. */
export const VERAPDF_IMAGE_REF = `${VERAPDF_IMAGE}@sha256:d565095c67a083e693aebf7d1a15784007370571053fc1aa5b502665b9a78f9c`;
/** The image's own non-root verapdf user (uid:gid). */
const IMAGE_USER = '100:101';

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The deadline passed and the process was killed. */
  timedOut: boolean;
  /** stdout passed maxOutputBytes; reading stopped and the process was killed. */
  truncated: boolean;
}

export interface RunLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface VerapdfRunOptions extends RunLimits {
  /** Failed checks listed per rule at most (veraPDF --maxfailuresdisplayed). */
  maxFailuresDisplayed: number;
}

export type RunnerKind = 'local' | 'docker' | 'custom';

/** Runs veraPDF on PDF bytes given on stdin and returns its raw output. */
export interface VerapdfRunner {
  kind: RunnerKind;
  /** For run metadata, for example the image reference or the CLI path. */
  description: string;
  /** Run-metadata warnings this runner always carries. */
  warnings: readonly string[];
  /**
   * True for the local CLI inside Widedoor's image (ISOLATED_HOST_ENV), where
   * veraPDF shares the scanner's container and network. Callers decide on this,
   * never on the warning text.
   */
  isolatedHost?: boolean;
  run(pdf: Uint8Array, options: VerapdfRunOptions): Promise<ProcessResult>;
}

const STDERR_MAX = 64 * 1024;
/** How long a killed process gets to report its exit before the run gives up on it. */
const KILL_WAIT_MS = 5_000;

export const verapdfArgs = (maxFailuresDisplayed: number) => [
  '--flavour',
  'ua1',
  '--format',
  'json',
  '--success',
  '--maxfailuresdisplayed',
  String(maxFailuresDisplayed),
];

interface RunProcessOptions {
  spawn: SpawnFn;
  spawnOptions?: SpawnOptions;
  input?: Uint8Array;
  /** Extra cleanup on timeout or overflow (for example `docker rm -f`). Runs before the kill. */
  onKill?: () => Promise<void> | void;
  /** Kills the process (tree). Default child.kill('SIGKILL'). */
  kill?: (child: ChildProcess) => void;
}

/**
 * Runs a process with a wall-clock deadline and a stdout cap. Past either,
 * onKill runs, the process is killed and reading stops. Rejects only when the
 * process cannot be started.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  limits: RunLimits,
  options: RunProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = options.spawn(command, args, {
        stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...options.spawnOptions,
      });
    } catch (e) {
      reject(e);
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let truncated = false;
    let killed = false;
    let done = false;
    let killTimer: NodeJS.Timeout | undefined;
    // The cleanup started by a kill (for example docker rm); the result waits for it.
    let cleanup: Promise<void> = Promise.resolve();

    const finish = (exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      const settle = () =>
        resolve({
          exitCode,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          timedOut,
          truncated,
        });
      void cleanup.then(settle, settle);
    };
    const stop = () => {
      if (killed) return;
      killed = true;
      child.stdout?.pause();
      cleanup = (async () => {
        try {
          await options.onKill?.();
        } catch {
          // The kill below still runs.
        }
        try {
          (options.kill ?? ((c) => c.kill('SIGKILL')))(child);
        } catch {
          // Already gone.
        }
      })();
      killTimer = setTimeout(() => finish(null), KILL_WAIT_MS);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      stop();
    }, limits.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (killed) return;
      const room = limits.maxOutputBytes - outBytes;
      if (chunk.length > room) {
        if (room > 0) out.push(chunk.subarray(0, room));
        outBytes = limits.maxOutputBytes;
        truncated = true;
        stop();
        return;
      }
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes >= STDERR_MAX) return;
      const part = chunk.subarray(0, STDERR_MAX - errBytes);
      err.push(part);
      errBytes += part.length;
    });
    child.once('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      reject(e);
    });
    child.once('close', (code) => finish(code));
    if (options.input && child.stdin) {
      // A process that exits before reading all of stdin closes the pipe; that is its answer.
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input);
    }
  });
}

export interface DockerRunnerOptions {
  /** Docker CLI: an absolute path, or a name looked up on PATH (never the current directory). Default "docker". */
  docker?: string;
  /** Image reference. Default VERAPDF_IMAGE_REF (the pinned tag and digest). */
  image?: string;
  /** Container memory cap (also the swap cap). Default "1g". */
  memory?: string;
  /** CPUs. Default "2". */
  cpus?: string;
  /** Process cap inside the container. Default 256. */
  pidsLimit?: number;
  /** Size of the writable /tmp. Default "256m". */
  tmpfsSize?: string;
  /** Container name prefix; each run appends a random id. Default "widedoor-verapdf". */
  namePrefix?: string;
  spawn?: SpawnFn;
  /** Environment whose PATH is searched for the Docker CLI. Default process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Label on every veraPDF container, so leftovers can be found with docker ps --filter label=... */
export const CONTAINER_LABEL = 'io.widedoor.verapdf=1';

// Sizes and CPU counts start with a non-zero digit: Docker reads 0 (and -1) as "no limit".
const DOCKER_OPTION_PATTERNS: Record<string, RegExp> = {
  memory: /^[1-9]\d{0,5}[kmg]$/,
  tmpfsSize: /^[1-9]\d{0,5}[kmg]$/,
  cpus: /^(?:[1-9]\d{0,2}(?:\.\d{1,2})?|0\.(?:0[1-9]|[1-9]\d?))$/,
  namePrefix: /^[a-z0-9][a-z0-9-]{0,47}$/,
  image: /^[a-z0-9][a-z0-9./:@_-]{0,255}$/,
};

/** Smallest container memory cap accepted: below it the JVM cannot start, which reads as a veraPDF failure. */
export const MIN_DOCKER_MEMORY_BYTES = 64 * 1024 * 1024;

const UNIT = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as const;
const sizeBytes = (size: string) =>
  Number(size.slice(0, -1)) * UNIT[size.slice(-1) as keyof typeof UNIT];

/**
 * Throws when a Docker option could change the flags around it or turn a cap
 * off: each must be a plain value, and limits must be real limits.
 */
export function validateDockerOptions(options: DockerRunnerOptions): void {
  for (const [key, pattern] of Object.entries(DOCKER_OPTION_PATTERNS)) {
    const value = options[key as keyof DockerRunnerOptions];
    if (value !== undefined && (typeof value !== 'string' || !pattern.test(value)))
      throw new Error(`invalid docker.${key}: ${JSON.stringify(value)}`);
  }
  if (options.memory !== undefined && sizeBytes(options.memory) < MIN_DOCKER_MEMORY_BYTES)
    throw new Error(`docker.memory must be at least 64m, got ${options.memory}`);
  const pids = options.pidsLimit;
  if (pids !== undefined && (!Number.isInteger(pids) || pids < 1))
    throw new Error(`invalid docker.pidsLimit: ${pids}`);
}

/** CPU seconds the JVM may use in all: every allowed CPU busy for the whole timeout, plus slack. */
export const cpuSecondsFor = (timeoutMs: number, cpus: string) =>
  Math.ceil((timeoutMs / 1000) * Math.max(1, Math.ceil(Number(cpus)))) + 30;

/**
 * The docker run arguments for one veraPDF run: no network, no mounts,
 * read-only, non-root, capped in memory, CPU, processes and CPU time.
 */
export function dockerRunArgs(
  name: string,
  options: DockerRunnerOptions,
  maxFailuresDisplayed: number,
  timeoutMs = 120_000,
): string[] {
  validateDockerOptions(options);
  const memory = options.memory ?? '1g';
  const cpus = options.cpus ?? '2';
  return [
    'run',
    '--rm',
    '--interactive',
    '--init',
    '--pull',
    'never',
    '--name',
    name,
    '--label',
    CONTAINER_LABEL,
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    `/tmp:rw,noexec,nosuid,size=${options.tmpfsSize ?? '256m'}`,
    '--user',
    IMAGE_USER,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    memory,
    '--memory-swap',
    memory,
    '--cpus',
    cpus,
    '--pids-limit',
    String(options.pidsLimit ?? 256),
    // Ends the run on its own even if this process dies and never removes the container.
    '--ulimit',
    `cpu=${cpuSecondsFor(timeoutMs, cpus)}`,
    '--env',
    'JAVA_OPTS=-XX:MaxRAMPercentage=75',
    options.image ?? VERAPDF_IMAGE_REF,
    ...verapdfArgs(maxFailuresDisplayed),
  ];
}

const isWindows = process.platform === 'win32';
const needsShell = (path: string) => isWindows && /\.(?:bat|cmd)$/i.test(path);

/**
 * Finds an executable on PATH. Only absolute PATH entries count, so neither
 * the current directory nor a relative entry such as "." can supply it. On
 * Windows a real .exe wins over a .cmd or .bat launcher.
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts = isWindows ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return undefined;
}

/** An absolute path as given, or a bare name looked up on PATH; anything else (a relative path) is refused. */
function resolveCommand(command: string, env?: NodeJS.ProcessEnv): string | undefined {
  if (isAbsolute(command)) return command;
  if (/[\\/]/.test(command)) return undefined;
  return findOnPath(command, env);
}

/** The Docker CLI as an absolute path, or undefined when it is not on PATH. */
export const dockerCommand = (options: DockerRunnerOptions = {}) =>
  resolveCommand(options.docker ?? 'docker', options.env);

/**
 * veraPDF in the pinned Docker image. The PDF goes in on stdin, so nothing on
 * the host is mounted. The image is never pulled implicitly (--pull never).
 * The client is not trusted to stop the container when it dies, so a timeout
 * or overflow removes the container by name first, and RLIMIT_CPU ends it on
 * its own if nothing does.
 */
export function dockerRunner(options: DockerRunnerOptions = {}): VerapdfRunner {
  validateDockerOptions(options);
  const docker = dockerCommand(options);
  const spawn = options.spawn ?? nodeSpawn;
  const image = options.image ?? VERAPDF_IMAGE_REF;
  return {
    kind: 'docker',
    description: image,
    warnings: [],
    run(pdf, run) {
      if (docker === undefined) return Promise.reject(new Error('the Docker CLI is not on PATH'));
      const name = `${options.namePrefix ?? 'widedoor-verapdf'}-${randomUUID()}`;
      const args = dockerRunArgs(name, options, run.maxFailuresDisplayed, run.timeoutMs);
      return runProcess(docker, args, run, {
        spawn,
        input: pdf,
        onKill: () =>
          runProcess(
            docker,
            ['rm', '--force', name],
            { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 },
            { spawn },
          ).then(
            () => undefined,
            () => undefined,
          ),
      });
    },
  };
}

/** Whether the Docker daemon answers and holds the image (it is never pulled here). */
export async function dockerImagePresent(options: DockerRunnerOptions = {}): Promise<boolean> {
  const docker = dockerCommand(options);
  if (docker === undefined) return false;
  try {
    const r = await runProcess(
      docker,
      ['image', 'inspect', '--format', '{{.Id}}', options.image ?? VERAPDF_IMAGE_REF],
      { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 },
      { spawn: options.spawn ?? nodeSpawn },
    );
    return r.exitCode === 0 && !r.timedOut;
  } catch {
    return false;
  }
}

/** taskkill from the Windows system directory, never from PATH or the current directory. */
export const TASKKILL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');

function killTree(child: ChildProcess, spawn: SpawnFn) {
  if (child.pid === undefined) return;
  if (isWindows) {
    spawn(TASKKILL, ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    process.kill(-child.pid, 'SIGKILL');
  }
}

export interface LocalRunnerOptions {
  /** veraPDF CLI: an absolute path, or a name looked up on PATH. Default "verapdf". */
  path?: string;
  spawn?: SpawnFn;
  /** Environment whose PATH is searched for the CLI. Default process.env. */
  env?: NodeJS.ProcessEnv;
}

function localSpawnOptions(path: string): SpawnOptions {
  // The JVM gets a heap cap; nothing else bounds a local run's memory.
  const env = { ...process.env, JAVA_OPTS: '-Xmx1g' };
  // A .bat launcher only runs through cmd.exe. Every argument is a constant
  // (the PDF goes in on stdin) and the path is quoted, so nothing is injected.
  if (needsShell(path)) return { shell: true, env };
  return isWindows ? { env } : { detached: true, env };
}

function localCommand(path: string): string {
  if (!needsShell(path)) return path;
  if (/["%^&|<>!]/.test(path)) throw new Error('unsupported characters in the veraPDF path');
  return `"${path}"`;
}

/** The version a local veraPDF CLI reports, or undefined when it does not run. */
export async function localVerapdfVersion(
  options: LocalRunnerOptions = {},
): Promise<{ path: string; version: string } | undefined> {
  const path = resolveCommand(options.path ?? 'verapdf', options.env);
  if (path === undefined) return undefined;
  const spawn = options.spawn ?? nodeSpawn;
  try {
    const r = await runProcess(
      localCommand(path),
      ['--version'],
      { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 },
      { spawn, spawnOptions: localSpawnOptions(path), kill: (c) => killTree(c, spawn) },
    );
    const version = /veraPDF\s+(\d+\.\d+\.\d+)/i.exec(`${r.stdout}\n${r.stderr}`)?.[1];
    return version ? { path, version } : undefined;
  } catch {
    return undefined;
  }
}

/** Set to 1 by Widedoor's own image (Task 1.7), where the scanner container is the only boundary around veraPDF. */
export const ISOLATED_HOST_ENV = 'WIDEDOOR_ISOLATED_HOST';

export const NOT_ISOLATED_WARNING =
  'veraPDF ran from the local CLI without the Docker sandbox: no network, filesystem or memory isolation.';

/** The in-container warning inside Widedoor's image: veraPDF has no container of its own there either. */
export const IN_CONTAINER_WARNING =
  "veraPDF ran inside the Widedoor container without a sandbox of its own: it shares the container's network and mounts. Run PDF scans with --network none and read-only input mounts.";

/**
 * A veraPDF CLI installed on this machine. It has no container around it, so
 * it runs with the user's network and filesystem access; unless the host is
 * itself Widedoor's container, the run records that as a warning; inside the
 * container it records IN_CONTAINER_WARNING instead.
 */
export function localRunner(
  path: string,
  options: LocalRunnerOptions & { isolatedHost?: boolean } = {},
): VerapdfRunner {
  const spawn = options.spawn ?? nodeSpawn;
  return {
    kind: 'local',
    description: basename(path),
    warnings: [options.isolatedHost ? IN_CONTAINER_WARNING : NOT_ISOLATED_WARNING],
    isolatedHost: options.isolatedHost === true,
    run(pdf, run) {
      return runProcess(localCommand(path), verapdfArgs(run.maxFailuresDisplayed), run, {
        spawn,
        spawnOptions: localSpawnOptions(path),
        input: pdf,
        kill: (c) => killTree(c, spawn),
      });
    },
  };
}

export type RunnerChoice = 'auto' | 'local' | 'docker' | VerapdfRunner;

export interface ResolveRunnerOptions {
  local?: LocalRunnerOptions;
  docker?: DockerRunnerOptions;
  /**
   * The scanner itself runs in an isolated container (Widedoor's image), so a
   * local veraPDF carries IN_CONTAINER_WARNING instead of NOT_ISOLATED_WARNING.
   * Default: true when WIDEDOOR_ISOLATED_HOST=1.
   */
  isolatedHost?: boolean;
}

export type ResolvedRunner =
  | { ok: true; runner: VerapdfRunner; warnings: string[] }
  | { ok: false; message: string; warnings: string[] };

export const UNAVAILABLE_MESSAGE =
  `veraPDF ${VERAPDF_VERSION} is not available. Start Docker and run ` +
  `"docker pull ${VERAPDF_IMAGE}" (sandboxed, preferred), or install veraPDF ${VERAPDF_VERSION} on PATH.`;

/**
 * Picks the veraPDF runner. "auto" uses the pinned Docker image whenever
 * Docker holds it, and falls back to a local CLI that reports exactly
 * VERAPDF_VERSION only when it does not (with the not-isolated warning).
 * With neither, the result names the image to pull.
 */
export async function resolveRunner(
  choice: RunnerChoice = 'auto',
  options: ResolveRunnerOptions = {},
): Promise<ResolvedRunner> {
  if (typeof choice === 'object') return { ok: true, runner: choice, warnings: [] };
  if (options.docker) validateDockerOptions(options.docker);
  const warnings: string[] = [];
  if (choice !== 'local' && (await dockerImagePresent(options.docker)))
    return { ok: true, runner: dockerRunner(options.docker), warnings };
  if (choice === 'docker') return { ok: false, message: UNAVAILABLE_MESSAGE, warnings };
  const local = await localVerapdfVersion(options.local);
  const isolatedHost = options.isolatedHost ?? process.env[ISOLATED_HOST_ENV] === '1';
  if (local?.version === VERAPDF_VERSION)
    return {
      ok: true,
      runner: localRunner(local.path, { ...options.local, isolatedHost }),
      warnings,
    };
  if (local)
    warnings.push(
      `local veraPDF ${local.version} (${basename(local.path)}) was not used: Widedoor needs ${VERAPDF_VERSION}.`,
    );
  return { ok: false, message: UNAVAILABLE_MESSAGE, warnings };
}
