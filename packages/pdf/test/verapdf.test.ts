import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CONTAINER_LABEL,
  IN_CONTAINER_WARNING,
  NOT_ISOLATED_WARNING,
  TASKKILL,
  UNAVAILABLE_MESSAGE,
  VERAPDF_IMAGE,
  VERAPDF_IMAGE_REF,
  cpuSecondsFor,
  dockerCommand,
  dockerImagePresent,
  dockerRunArgs,
  dockerRunner,
  findOnPath,
  localVerapdfVersion,
  resolveRunner,
  runProcess,
  validateDockerOptions,
  type SpawnFn,
} from '../src/index.ts';
import { fakeSpawn } from './fixtures.ts';

const node = process.execPath;
const limits = { timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 };
/** An absolute Docker CLI path for runs whose spawn is faked. */
const DOCKER = join(tmpdir(), 'widedoor-fake-docker', 'docker');

describe('runProcess', () => {
  it('feeds stdin and collects stdout, stderr and the exit code', async () => {
    const r = await runProcess(
      node,
      ['-e', 'process.stdin.pipe(process.stdout); console.error("note"); process.exitCode = 3'],
      limits,
      { spawn: nodeSpawn, input: Buffer.from('%PDF-1.7 bytes') },
    );
    expect(r).toEqual({
      exitCode: 3,
      stdout: '%PDF-1.7 bytes',
      stderr: 'note\n',
      timedOut: false,
      truncated: false,
    });
  });

  it('kills a process that passes the deadline', async () => {
    const started = Date.now();
    const r = await runProcess(
      node,
      ['-e', 'setInterval(() => {}, 1000)'],
      { ...limits, timeoutMs: 300 },
      { spawn: nodeSpawn },
    );
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('stops reading and kills a process that passes the output cap', async () => {
    const r = await runProcess(
      node,
      ['-e', 'const b = "x".repeat(65536); setInterval(() => process.stdout.write(b), 1)'],
      { ...limits, maxOutputBytes: 100_000 },
      { spawn: nodeSpawn },
    );
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBe(100_000);
  });

  it('rejects when the command does not exist', async () => {
    await expect(
      runProcess('widedoor-no-such-command', [], limits, { spawn: nodeSpawn }),
    ).rejects.toThrow();
  });
});

describe('dockerRunArgs', () => {
  const args = dockerRunArgs('widedoor-verapdf-x', {}, 100);

  it('runs the pinned image by digest with no network, no mounts and no implicit pull', () => {
    expect(VERAPDF_IMAGE).toBe('verapdf/cli:v1.30.3');
    expect(VERAPDF_IMAGE_REF).toMatch(/^verapdf\/cli:v1\.30\.3@sha256:[0-9a-f]{64}$/);
    expect(args).toContain(VERAPDF_IMAGE_REF);
    const pair = (flag: string) => args[args.indexOf(flag) + 1];
    expect(pair('--network')).toBe('none');
    expect(pair('--pull')).toBe('never');
    expect(pair('--name')).toBe('widedoor-verapdf-x');
    expect(args.some((a) => /^(?:-v|--volume|--mount|--privileged)$/.test(a))).toBe(false);
    expect(args).toContain('--init');
    expect(pair('--label')).toBe(CONTAINER_LABEL);
    expect(pair('--ulimit')).toMatch(/^cpu=\d+$/);
  });

  it('is read-only, non-root, capability-free and capped', () => {
    const pair = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain('--read-only');
    expect(args).toContain('--rm');
    expect(pair('--tmpfs')).toMatch(/^\/tmp:rw,noexec,nosuid,size=/);
    expect(pair('--user')).toBe('100:101');
    expect(pair('--cap-drop')).toBe('ALL');
    expect(pair('--security-opt')).toBe('no-new-privileges');
    expect(pair('--memory')).toBe('1g');
    expect(pair('--memory-swap')).toBe('1g');
    expect(pair('--cpus')).toBe('2');
    expect(pair('--pids-limit')).toBe('256');
  });

  it('asks veraPDF for the PDF/UA-1 JSON report of stdin', () => {
    const tail = args.slice(args.indexOf(VERAPDF_IMAGE_REF) + 1);
    expect(tail).toEqual([
      '--flavour',
      'ua1',
      '--format',
      'json',
      '--success',
      '--maxfailuresdisplayed',
      '100',
    ]);
  });
});

describe('dockerRunner', () => {
  it('sends the PDF on stdin', async () => {
    const { spawn, calls } = fakeSpawn((c) => c.child.exit(1, '{"report":1}'));
    const r = await dockerRunner({ docker: DOCKER, spawn }).run(Buffer.from('%PDF'), {
      ...limits,
      maxFailuresDisplayed: 5,
    });
    expect(r.stdout).toBe('{"report":1}');
    expect(calls).toHaveLength(1);
    expect(Buffer.concat(calls[0]!.stdin).toString()).toBe('%PDF');
  });

  it('removes the container by name before killing the client on a timeout', async () => {
    const { spawn, calls } = fakeSpawn((c) => {
      if (c.args[0] === 'rm') c.child.exit(0);
      // docker run never answers.
    });
    const r = await dockerRunner({ docker: DOCKER, spawn }).run(Buffer.from('%PDF'), {
      ...limits,
      timeoutMs: 50,
      maxFailuresDisplayed: 1,
    });
    expect(r.timedOut).toBe(true);
    const name = calls[0]!.args[calls[0]!.args.indexOf('--name') + 1];
    expect(name).toMatch(/^widedoor-verapdf-[0-9a-f-]{36}$/);
    expect(calls[1]?.args).toEqual(['rm', '--force', name]);
    expect(calls[0]!.child.killedWith).toBe('SIGKILL');
  });

  it('uses a fresh container name for every run', async () => {
    const { spawn, calls } = fakeSpawn((c) => c.child.exit(0, '{}'));
    const runner = dockerRunner({ docker: DOCKER, spawn, namePrefix: 'test' });
    const run = { ...limits, maxFailuresDisplayed: 1 };
    await runner.run(Buffer.from('a'), run);
    await runner.run(Buffer.from('b'), run);
    const names = calls.map((c) => c.args[c.args.indexOf('--name') + 1]);
    expect(new Set(names).size).toBe(2);
    expect(names.every((n) => n?.startsWith('test-'))).toBe(true);
  });
});

describe('docker options', () => {
  it('refuse values that could change the flags around them', () => {
    const bad = [
      { tmpfsSize: '256m,exec,suid' },
      { image: '--privileged' },
      { image: 'verapdf/cli:v1.30.3 --privileged' },
      { memory: '1g --privileged' },
      { cpus: '2;' },
      { namePrefix: '-x' },
      { pidsLimit: 0 },
      // Zero and -1 read as "no limit" to Docker; tiny caps cannot start a JVM.
      { memory: '0g' },
      { memory: '0' },
      { memory: '32m' },
      { tmpfsSize: '0m' },
      { cpus: '0' },
      { cpus: '0.0' },
      { cpus: '-1' },
      { pidsLimit: -1 },
      { memory: 'unlimited' },
    ];
    for (const o of bad) expect(() => validateDockerOptions(o), JSON.stringify(o)).toThrow();
    expect(() =>
      validateDockerOptions({ memory: '2g', cpus: '1.5', tmpfsSize: '64m', namePrefix: 'ci-1' }),
    ).not.toThrow();
    expect(() => validateDockerOptions({ memory: '64m', cpus: '0.5' })).not.toThrow();
  });

  it('bound CPU time from the timeout and the CPU count', () => {
    expect(cpuSecondsFor(120_000, '2')).toBe(270);
    expect(cpuSecondsFor(1_000, '0.5')).toBe(31);
    const args = dockerRunArgs('n', {}, 1, 60_000);
    expect(args[args.indexOf('--ulimit') + 1]).toBe('cpu=150');
  });
});

describe('resolveRunner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'widedoor-verapdf-'));
  const exe = (name: string) => join(dir, process.platform === 'win32' ? `${name}.exe` : name);
  const cli = exe('verapdf');
  const docker = exe('docker');
  writeFileSync(cli, '');
  writeFileSync(docker, '');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const world = (o: { localVersion?: string; dockerImage: boolean }) =>
    fakeSpawn((c) => {
      if (c.args[0] === '--version') {
        if (o.localVersion) c.child.exit(0, `veraPDF ${o.localVersion}\nBuilt: 2026-10-07\n`);
        else c.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      } else if (c.args[0] === 'image') c.child.exit(o.dockerImage ? 0 : 1);
      else c.child.exit(0);
    });
  const opts = (spawn: SpawnFn, extra: object = {}) => ({
    local: { path: cli, spawn },
    docker: { docker, spawn },
    isolatedHost: false,
    ...extra,
  });

  it('uses the Docker image whenever it is present, even with a local CLI at the pinned version', async () => {
    const { spawn, calls } = world({ localVersion: '1.30.3', dockerImage: true });
    const r = await resolveRunner('auto', opts(spawn));
    expect(r.ok && r.runner.kind).toBe('docker');
    expect(r.ok && r.runner.description).toBe(VERAPDF_IMAGE_REF);
    expect(r.ok && r.runner.warnings).toEqual([]);
    expect(calls.some((c) => c.args[0] === '--version')).toBe(false);
  });

  it('falls back to a local CLI at the pinned version only without Docker, with a warning', async () => {
    const { spawn } = world({ localVersion: '1.30.3', dockerImage: false });
    const r = await resolveRunner('auto', opts(spawn));
    expect(r.ok && r.runner.kind).toBe('local');
    expect(r.ok && r.runner.warnings).toEqual([NOT_ISOLATED_WARNING]);
    expect(r.ok && r.runner.isolatedHost).toBe(false);
    // The warning names no host path.
    expect(r.ok && r.runner.description).toBe(basename(cli));
  });

  it('swaps in the in-container warning on an isolated host (Widedoor image)', async () => {
    const { spawn } = world({ localVersion: '1.30.3', dockerImage: false });
    const r = await resolveRunner('local', opts(spawn, { isolatedHost: true }));
    expect(r.ok && r.runner.kind).toBe('local');
    expect(r.ok && r.runner.warnings).toEqual([IN_CONTAINER_WARNING]);
    // The structural signal callers use (pdf.fetch), set by the same check as the warning.
    expect(r.ok && r.runner.isolatedHost).toBe(true);
  });

  it('skips a local CLI at another version', async () => {
    const { spawn } = world({ localVersion: '1.28.2', dockerImage: false });
    const r = await resolveRunner('auto', opts(spawn));
    expect(r.ok).toBe(false);
    expect(r.warnings.join()).toMatch(/1\.28\.2 .* was not used/);
  });

  it('names the image to pull when neither is available', async () => {
    const { spawn } = world({ dockerImage: false });
    const r = await resolveRunner('auto', opts(spawn));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toBe(UNAVAILABLE_MESSAGE);
    expect(UNAVAILABLE_MESSAGE).toContain('docker pull verapdf/cli:v1.30.3');
  });

  it('honours an explicit choice, and local carries the warning', async () => {
    const { spawn } = world({ localVersion: '1.30.3', dockerImage: true });
    const local = await resolveRunner('local', opts(spawn));
    expect(local.ok && local.runner.kind).toBe('local');
    expect(local.ok && local.runner.warnings).toEqual([NOT_ISOLATED_WARNING]);
    const { spawn: noImage } = world({ localVersion: '1.30.3', dockerImage: false });
    expect((await resolveRunner('docker', opts(noImage))).ok).toBe(false);
  });

  it('spawns only absolute commands', async () => {
    const { spawn, calls } = world({ localVersion: '1.30.3', dockerImage: false });
    const r = await resolveRunner('auto', opts(spawn));
    if (r.ok) await r.runner.run(Buffer.from('%PDF'), { ...limits, maxFailuresDisplayed: 1 });
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls)
      expect(isAbsolute(c.command.replace(/^"|"$/g, '')), c.command).toBe(true);
    expect(TASKKILL).toMatch(/[\\/]System32[\\/]taskkill\.exe$/i);
  });
});

describe('findOnPath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'widedoor-path-'));
  const planted = mkdtempSync(join(tmpdir(), 'widedoor-planted-'));
  const win = process.platform === 'win32';
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(planted, { recursive: true, force: true });
  });

  it('finds an executable in an absolute PATH entry', () => {
    const cli = join(dir, win ? 'verapdf.exe' : 'verapdf');
    writeFileSync(cli, '');
    expect(findOnPath('verapdf', { PATH: dir })).toBe(cli);
    expect(findOnPath('verapdf', { PATH: join(dir, 'missing') })).toBeUndefined();
  });

  it('prefers a .exe over a .bat launcher on Windows', () => {
    if (!win) return;
    writeFileSync(join(dir, 'tool.bat'), '');
    writeFileSync(join(dir, 'tool.exe'), '');
    expect(findOnPath('tool', { PATH: dir })).toBe(join(dir, 'tool.exe'));
  });

  it('never uses a docker or verapdf planted in the current directory', async () => {
    for (const f of ['docker.exe', 'docker', 'verapdf.bat', 'verapdf'])
      writeFileSync(join(planted, f), '');
    const cwd = process.cwd();
    process.chdir(planted);
    try {
      // Neither the cwd nor relative PATH entries count.
      const env = { PATH: ['.', 'bin', join('..', basename(planted))].join(delimiter) };
      expect(findOnPath('docker', env)).toBeUndefined();
      expect(findOnPath('verapdf', env)).toBeUndefined();
      expect(dockerCommand({ env })).toBeUndefined();
      expect(dockerCommand({ docker: './docker.exe', env })).toBeUndefined();
      const { spawn, calls } = fakeSpawn((c) => c.child.exit(0, 'veraPDF 1.30.3'));
      expect(await dockerImagePresent({ env, spawn })).toBe(false);
      expect(await localVerapdfVersion({ env, spawn })).toBeUndefined();
      expect(await localVerapdfVersion({ path: 'verapdf.bat', env, spawn })).toBeUndefined();
      expect(calls).toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });
});
