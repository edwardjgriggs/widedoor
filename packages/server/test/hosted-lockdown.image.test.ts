import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseJsonReport } from '@widedoor/report';
import { ROOT, reportValidator } from '../../cli/test/helpers.ts';
import { STOPPED, TIMED_OUT } from '../src/hosted/agent-bin.ts';
import { firewallRules } from '../src/hosted/firewall.ts';
import { API_HEAP_MB } from '../src/hosted/limits.ts';
import type { JobInput } from '../src/hosted/protocol.ts';

/*
 * The hosted scan machine's image, `docker build --target scan` (npm run test:image; needs
 * Docker, a Linux kernel and the base images of the Dockerfile). Nothing here reaches the
 * internet or opens a blocked range (ledger R28): scan targets sit on an internal Docker
 * network on 11.0.0.0/24 (public, outside BLOCKED_V4), and a fake control API sits on a
 * second internal network in 10.0.0.0/8, where the real one sits on Fly's private
 * network. Every container runs the image's own entry, firewall and proxy, unchanged.
 *
 * The probe machine runs the real entry with two stand-ins a test needs: a fake Fly
 * machine API socket at /.fly/api (made world-writable before the entry starts), and an
 * agent that only waits, so the firewall can be probed from each user for as long as the
 * tests need (the real agent is kept beside it as agent-bin.real.js and run by hand for
 * the timeout test). With WIDEDOOR_TEST_SCAN_IMAGE set, the suite tests that image as it
 * is and builds nothing.
 */

const PREBUILT = process.env.WIDEDOOR_TEST_SCAN_IMAGE;
const SCAN = PREBUILT ?? 'widedoor:scan-dev';
const HOSTED = 'widedoor:hosted-dev';
const CLI = 'widedoor:dev';
const BUILD_TIMEOUT = 1_200_000;
const TIMEOUT = 300_000;
const LABEL = 'io.widedoor.lockdown-test=1';
const SECCOMP = join(ROOT, 'docker', 'chromium-seccomp.json');
const HOSTED_DIR = '/app/packages/server/dist/hosted';
const id = randomUUID().slice(0, 8);
const publicNet = `widedoor-lockdown-public-${id}`;
const controlNet = `widedoor-lockdown-control-net-${id}`;
const site = `widedoor-lockdown-site-${id}`;
const control = `widedoor-lockdown-control-${id}`;
const probe = `widedoor-lockdown-probe-${id}`;
const PUBLIC_SUBNET = '11.0.0.0/24';
const SITE_IP = '11.0.0.10';
const CONTROL_SUBNET = '10.213.47.0/24';
const CONTROL_IP = '10.213.47.10';
const CONTROL_URL = `http://${control}:8080`;
const dns = `widedoor-lockdown-dns-${id}`;
const DNS_IP = '10.213.47.53';
const TOKEN = 'lockdown-test-token-0123456789';

const job = (n: number) => n.toString(16).padStart(32, '0');
const JOBS = {
  probe: job(1),
  scan: job(2),
  noCap: job(3),
  nonRoot: job(4),
  timeout: job(5),
  readerDeath: job(6),
};
const urlJob = (jobId: string, url: string): JobInput => ({
  jobId,
  tier: 'open',
  target: { kind: 'url', url },
  profile: '508+wcag21aa',
});
const INPUTS: Record<string, JobInput> = {
  [JOBS.scan]: urlJob(JOBS.scan, `http://${SITE_IP}/page.html`),
  [JOBS.noCap]: urlJob(JOBS.noCap, `http://${SITE_IP}/page.html`),
  [JOBS.nonRoot]: urlJob(JOBS.nonRoot, `http://${SITE_IP}/page.html`),
  [JOBS.timeout]: urlJob(JOBS.timeout, `http://${SITE_IP}/hang`),
  [JOBS.readerDeath]: urlJob(JOBS.readerDeath, `http://${SITE_IP}/hang`),
};

let tmp: string;

const docker = (args: readonly string[], timeout = TIMEOUT): SpawnSyncReturns<string> =>
  spawnSync('docker', args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });

/** docker without blocking the event loop, for runs the test watches while they go. */
const dockerAsync = (args: readonly string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('docker', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** Runs `node -e script` in a container as a user and returns its trimmed stdout. */
const nodeAs = (container: string, user: string, script: string): string => {
  const r = docker(['exec', '--user', user, container, 'node', '-e', script], 60_000);
  if (r.status !== 0) throw new Error(`node as ${user} failed: ${r.stderr}`);
  return r.stdout.trim();
};

const shAs = (container: string, user: string, script: string) =>
  docker(['exec', '--user', user, container, 'sh', '-c', script], 60_000);

/** TCP connect within 2 s: `connected`, `timeout` (dropped) or the error code. */
const tcp = (target: { host: string; port: number } | { path: string }) =>
  [
    `const s = require('node:net').connect(${JSON.stringify(target)});`,
    "const t = setTimeout(() => { console.log('timeout'); process.exit(0); }, 2000);",
    "s.on('connect', () => { console.log('connected'); process.exit(0); });",
    "s.on('error', (e) => { console.log(e.code); process.exit(0); });",
  ].join('\n');

/** A DNS query for a name at one server: `ok <addresses>` or the error code. */
const dnsAt = (server: string, name: string) =>
  [
    "const r = new (require('node:dns').promises.Resolver)({ timeout: 1500, tries: 1 });",
    `r.setServers([${JSON.stringify(server)}]);`,
    `r.resolve4(${JSON.stringify(name)}).then((a) => console.log('ok ' + a.join(',')), (e) => console.log(e.code));`,
  ].join('\n');

/** The system resolver (getaddrinfo, /etc/resolv.conf): `ok <address>` or the error code. */
const lookup = (name: string) =>
  `require('node:dns').promises.lookup(${JSON.stringify(name)}).then((a) => console.log('ok ' + a.address), (e) => console.log(e.code));`;

/** One absolute-form GET through the egress proxy; prints the status line. */
const viaProxy = (url: string) =>
  [
    "const s = require('node:net').connect(18080, '127.0.0.1');",
    `const host = new URL(${JSON.stringify(url)}).host;`,
    `s.on('connect', () => s.write('GET ${url} HTTP/1.1\\r\\nHost: ' + host + '\\r\\nConnection: close\\r\\n\\r\\n'));`,
    "let text = ''; s.on('data', (d) => (text += d));",
    "s.on('close', () => console.log(text.split('\\r\\n')[0]));",
    "s.on('error', (e) => console.log(e.code));",
  ].join('\n');

/** The fake control API's log: one JSON line per request. */
const controlRequests = () =>
  docker(['logs', control])
    .stdout.split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as { method: string; path: string; auth: boolean });
const requestsFor = (jobId: string) => controlRequests().filter((r) => r.path.includes(jobId));
const resultFor = (jobId: string): Record<string, unknown> | undefined => {
  const r = docker(['exec', control, 'cat', `/tmp/results/${jobId}.json`]);
  return r.status === 0 ? (JSON.parse(r.stdout) as Record<string, unknown>) : undefined;
};

/** The scan target: a page, a page that never answers, and a listener off 80 and 443. */
const SITE_SERVER = [
  "const http = require('node:http');",
  'const page = \'<!doctype html><html lang="en"><head><title>Lockdown</title></head>\' +',
  '  \'<body><main><h1>Lockdown</h1><img src="pixel.png"><p>Text.</p></main></body></html>\';',
  'const handler = (req, res) => {',
  "  if (req.url === '/hang') return;",
  "  if (req.url === '/page.html') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);",
  "  if (req.url === '/') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('site');",
  '  res.writeHead(404).end();',
  '};',
  "http.createServer(handler).listen(80, '0.0.0.0', () =>",
  "  http.createServer(handler).listen(8080, '0.0.0.0', () => console.log('ready')));",
].join('\n');

/**
 * The fake control API on 8080 (input and result for the jobs in JOBS, with the token),
 * logging every request as a JSON line and keeping results in /tmp/results; and a decoy
 * on 80 that no scan machine user may reach.
 */
const CONTROL_SERVER = [
  "const http = require('node:http'), fs = require('node:fs');",
  'const jobs = JSON.parse(process.env.JOBS), auth = `Bearer ${process.env.TOKEN}`;',
  "fs.mkdirSync('/tmp/results', { recursive: true });",
  'const api = http.createServer((req, res) => {',
  '  const m = /^\\/internal\\/jobs\\/([0-9a-f]{32})\\/(input|result)$/.exec(req.url);',
  '  console.log(JSON.stringify({ method: req.method, path: req.url, auth: req.headers.authorization === auth }));',
  '  if (!m || req.headers.authorization !== auth) return void res.writeHead(404).end();',
  "  if (req.method === 'GET' && m[2] === 'input' && jobs[m[1]])",
  "    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(jobs[m[1]]));",
  "  if (req.method === 'PUT' && m[2] === 'result') {",
  '    const chunks = [];',
  "    req.on('data', (c) => chunks.push(c));",
  "    req.on('end', () => { fs.writeFileSync(`/tmp/results/${m[1]}.json`, Buffer.concat(chunks)); res.writeHead(204).end(); });",
  '    return;',
  '  }',
  '  res.writeHead(404).end();',
  '});',
  "api.listen(8080, '0.0.0.0', () =>",
  "  http.createServer((q, s) => s.end('control-80')).listen(80, '0.0.0.0', () => console.log('ready')));",
].join('\n');

/**
 * A DNS stub on the control network (in 10.0.0.0/8, a blocked range, like Fly's fdaa::3):
 * every A query gets the site's address, every other query an empty answer. It also
 * listens on TCP 8053, a port no machine user may reach.
 */
const DNS_SERVER = [
  "const dgram = require('node:dgram'), net = require('node:net');",
  "const s = dgram.createSocket('udp4');",
  "s.on('message', (q, from) => {",
  '  let i = 12;',
  '  while (q[i] !== 0) i += q[i] + 1;',
  '  i += 5;',
  '  const a = q.readUInt16BE(i - 4) === 1;',
  '  const head = Buffer.alloc(12);',
  '  q.copy(head, 0, 0, 2);',
  '  head.writeUInt16BE(0x8180, 2);',
  '  head.writeUInt16BE(1, 4);',
  '  head.writeUInt16BE(a ? 1 : 0, 6);',
  `  const answer = a ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ${SITE_IP.split('.').join(', ')}]) : Buffer.alloc(0);`,
  '  s.send(Buffer.concat([head, q.subarray(12, i), answer]), from.port, from.address);',
  '});',
  "s.bind(53, '0.0.0.0', () => net.createServer((c) => c.end('dns-8053')).listen(8053, '0.0.0.0', () => console.log('ready')));",
].join('\n');

/**
 * The probe machine's stand-in agent: it only waits. SIGTERM and SIGINT stop it (exit
 * 143 and 130, as a signal would); SIGUSR2 makes it finish on its own with exit code 7.
 */
const IDLE_AGENT = [
  "process.stderr.write('stand-in agent up\\n');",
  "for (const [name, code] of [['SIGTERM', 143], ['SIGINT', 130]])",
  '  process.on(name, () => { process.stderr.write(`stand-in agent stopped by ${name}\\n`); process.exit(code); });',
  "process.on('SIGUSR2', () => { process.stderr.write('stand-in agent done\\n'); process.exit(7); });",
  'setInterval(() => undefined, 1 << 30);',
].join('\n');

/**
 * The probe machine's start: keep the real agent beside the stand-in, put a world-writable
 * stand-in of Fly's machine API socket at /.fly/api, then run the image's entry.
 */
const PROBE_START = [
  'set -eu',
  `cp ${HOSTED_DIR}/agent-bin.js ${HOSTED_DIR}/agent-bin.real.js`,
  `cp /stand-in/agent.js ${HOSTED_DIR}/agent-bin.js`,
  'mkdir -m 0755 /.fly',
  "node -e \"require('node:net').createServer((s) => s.end('fly-api')).listen('/.fly/api')\" &",
  'until [ -S /.fly/api ]; do sleep 0.1; done',
  'chmod 0666 /.fly/api',
  'exec /app/docker/scan-entry.sh',
].join('\n');

/** Creates a scan machine on both networks; resolves its container name. */
function createMachine(name: string, extra: readonly string[], command: readonly string[] = []) {
  const created = docker([
    'create',
    '--name',
    name,
    '--label',
    LABEL,
    '--network',
    controlNet,
    ...extra,
    SCAN,
    ...command,
  ]);
  if (created.status !== 0) throw new Error(created.stderr);
  const connected = docker(['network', 'connect', publicNet, name]);
  if (connected.status !== 0) throw new Error(connected.stderr);
  return name;
}

/** What every scan machine gets: the job, Chromium's seccomp profile and an init. */
const machineEnv = (jobId: string, controlUrl = CONTROL_URL) => [
  '--init',
  '--security-opt',
  `seccomp=${SECCOMP}`,
  '--env',
  `WIDEDOOR_CONTROL_URL=${controlUrl}`,
  '--env',
  `WIDEDOOR_JOB_ID=${jobId}`,
  '--env',
  `WIDEDOOR_JOB_TOKEN=${TOKEN}`,
];

async function waitForLog(container: string, text: string, what: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    const logs = docker(['logs', container]);
    if ((logs.stdout + logs.stderr).includes(text)) return;
    await sleep(200);
  }
  const logs = docker(['logs', container]);
  throw new Error(`${what} did not start:\n${logs.stdout}${logs.stderr}`);
}

beforeAll(async () => {
  const version = docker(['version', '--format', '{{.Server.Version}}'], 60_000);
  if (version.status !== 0) throw new Error(`Docker is not running: ${version.stderr}`);
  if (PREBUILT === undefined) {
    for (const [tag, target] of [
      [SCAN, 'scan'],
      [HOSTED, 'hosted'],
      [CLI, undefined],
    ] as const) {
      const built = docker(
        ['build', ...(target ? ['--target', target] : []), '--tag', tag, ROOT],
        BUILD_TIMEOUT,
      );
      if (built.status !== 0) throw new Error(`docker build failed:\n${built.stderr.slice(-4000)}`);
    }
  } else if (docker(['image', 'inspect', SCAN]).status !== 0) {
    throw new Error(`WIDEDOOR_TEST_SCAN_IMAGE ${SCAN} is not present locally`);
  }
  tmp = mkdtempSync(join(tmpdir(), 'widedoor-lockdown-'));
  writeFileSync(join(tmp, 'agent.js'), IDLE_AGENT);
  writeFileSync(join(tmp, 'resolv.conf'), `nameserver ${DNS_IP}\n`);

  for (const [name, subnet] of [
    [publicNet, PUBLIC_SUBNET],
    [controlNet, CONTROL_SUBNET],
  ] as const) {
    const net = docker([
      'network',
      'create',
      '--internal',
      '--subnet',
      subnet,
      '--label',
      LABEL,
      name,
    ]);
    if (net.status !== 0) throw new Error(net.stderr);
  }
  for (const [name, net, ip, script, env] of [
    [site, publicNet, SITE_IP, SITE_SERVER, []],
    [dns, controlNet, DNS_IP, DNS_SERVER, []],
    [
      control,
      controlNet,
      CONTROL_IP,
      CONTROL_SERVER,
      ['--env', `JOBS=${JSON.stringify(INPUTS)}`, '--env', `TOKEN=${TOKEN}`],
    ],
  ] as const) {
    const started = docker([
      'run',
      '--detach',
      '--init',
      '--label',
      LABEL,
      '--name',
      name,
      '--network',
      net,
      '--ip',
      ip,
      ...env,
      '--entrypoint',
      'node',
      SCAN,
      '-e',
      script,
    ]);
    if (started.status !== 0) throw new Error(started.stderr);
    await waitForLog(name, 'ready', name);
  }
}, BUILD_TIMEOUT);

afterAll(() => {
  const left = docker(['ps', '--all', '--quiet', '--filter', `label=${LABEL}`]).stdout.split(/\s+/);
  const ids = left.filter(Boolean);
  if (ids.length) docker(['rm', '--force', ...ids]);
  docker(['network', 'rm', publicNet]);
  docker(['network', 'rm', controlNet]);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('the scan image', () => {
  it('runs its entry as root, carries the tools and users it needs, and no test switch', () => {
    // Proves the R8 target: root, the scan entry, no CMD, the libuv pool, and that neither
    // test switch is in the image's environment.
    const config = JSON.parse(
      docker(['image', 'inspect', '--format', '{{json .Config}}', SCAN]).stdout,
    ) as { User?: string; Env: string[]; Entrypoint: string[]; Cmd?: string[] | null };
    // Docker leaves User out when the image sets none: root.
    expect(config.User ?? '').toBe('');
    expect(config.Entrypoint).toEqual(['/app/docker/scan-entry.sh']);
    expect(config.Cmd ?? null).toBeNull();
    expect(config.Env).toContain('UV_THREADPOOL_SIZE=32');
    expect(config.Env.filter((e) => e.includes('SAME_USER'))).toEqual([]);

    const sh = (script: string) =>
      docker(['run', '--rm', '--label', LABEL, '--entrypoint', 'sh', SCAN, '-c', script]);
    // setpriv, pkill (the reaper) and nft at their absolute paths; no iptables (Fly's
    // kernel has no xt owner match, so the firewall is native nftables).
    const tools = sh(
      'for t in /usr/bin/setpriv /usr/bin/pkill /usr/bin/pgrep /usr/sbin/nft; do test -x $t && echo $t; done',
    );
    expect(tools.stdout.trim().split('\n')).toEqual([
      '/usr/bin/setpriv',
      '/usr/bin/pkill',
      '/usr/bin/pgrep',
      '/usr/sbin/nft',
    ]);
    // nft is root's alone (the entry runs as root).
    expect(sh('stat -c "%F %U:%G %a" /usr/sbin/nft').stdout.trim()).toBe(
      'regular file root:root 700',
    );
    expect(
      sh(
        'dpkg -s iptables >/dev/null 2>&1 && echo present; command -v iptables iptables-restore ip6tables-restore; echo end',
      ).stdout.trim(),
    ).toBe('end');
    // The proxy's user: 10002, its own group, no home, no shell.
    expect(sh('getent passwd egress; getent group egress').stdout.trim().split('\n')).toEqual([
      'egress:x:10002:10002::/nonexistent:/usr/sbin/nologin',
      'egress:x:10002:',
    ]);
    expect(sh('test -e /nonexistent || echo none').stdout.trim()).toBe('none');
    // apt ran after the base image's strip; the scan target strips again.
    expect(sh('find / -xdev -perm /6000 -type f; echo end').stdout.trim()).toBe('end');
    // The entry never sets either test switch (it only unsets them).
    const entry = sh('cat /app/docker/scan-entry.sh').stdout;
    expect(entry).toMatch(/^unset WIDEDOOR_AGENT_SAME_USER WIDEDOOR_EGRESS_SAME_USER$/m);
    expect(entry).not.toMatch(/SAME_USER=/);
  });

  it("loads a ruleset with IPv6 control and resolver addresses with the image's nft, twice", () => {
    // The probe network is IPv4 only, so its ruleset names no IPv6 address. This one does
    // (Fly's shape: the control API and the resolver on the 6PN), and loading it again
    // replaces the table in one transaction instead of failing on the one already there.
    writeFileSync(
      join(tmp, 'rules.nft'),
      firewallRules({
        controlAddresses: ['10.1.2.3', 'fdaa:0:1::2'],
        controlPort: 8080,
        resolvers: ['127.0.0.11', 'fdaa::3'],
        proxyPort: 18080,
      }),
    );
    const r = docker([
      'run',
      '--rm',
      '--label',
      LABEL,
      '--network',
      'none',
      '--cap-add',
      'NET_ADMIN',
      '--volume',
      `${tmp}:/stand-in:ro`,
      '--entrypoint',
      'sh',
      SCAN,
      '-c',
      'nft -c -f /stand-in/rules.nft && nft -f /stand-in/rules.nft && nft -f /stand-in/rules.nft && nft list ruleset',
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.match(/^table /gm)).toEqual(['table ']);
    expect(r.stdout.match(/policy drop;/g)).toHaveLength(3);
    expect(r.stdout).toContain(
      'meta skuid 10002 meta l4proto 17 ct original ip6 daddr fdaa::3 ct original proto-dst 53 accept',
    );
    expect(r.stdout).toContain('meta skuid 0 ip6 daddr fdaa:0:1::2 tcp dport 8080 accept');
  });

  it('leaves nftables, iptables and procps out of the CLI and hosted images', () => {
    // Proves R8's split: only the scan target gets the firewall tools and pkill.
    for (const image of [CLI, HOSTED]) {
      const r = docker([
        'run',
        '--rm',
        '--label',
        LABEL,
        '--entrypoint',
        'sh',
        image,
        '-c',
        'for p in nftables iptables procps; do dpkg -s $p >/dev/null 2>&1 && echo $p; done; command -v nft iptables-restore pkill; echo end',
      ]);
      expect(r.stdout.trim(), image).toBe('end');
    }
    const hosted = JSON.parse(
      docker(['image', 'inspect', '--format', '{{json .Config}}', HOSTED]).stdout,
    ) as { User: string; Entrypoint: string[] };
    expect(hosted.User).toBe('10001:10001');
    expect(hosted.Entrypoint).toEqual(['node', `${HOSTED_DIR}/api-bin.js`]);
  });

  it(
    'the hosted image boots and serves /healthz and the hosted page with its CSP',
    async () => {
      // The API as Fly would start it, but with no network at all: the Machines API is
      // unreachable, so the startup sweep fails and nothing else is touched.
      const name = `widedoor-lockdown-hosted-${id}`;
      const token = 'lockdown-hosted-SECRET-0123456789';
      const started = docker([
        'run',
        '--detach',
        '--label',
        LABEL,
        '--name',
        name,
        '--network',
        'none',
        '--env',
        `FLY_API_TOKEN=${token}`,
        '--env',
        `WIDEDOOR_SCAN_IMAGE=registry.fly.io/widedoor-scan@sha256:${'0'.repeat(64)}`,
        '--env',
        'WIDEDOOR_PUBLIC_ORIGIN=https://widedoor.example.net',
        '--env',
        'WIDEDOOR_CONTACT_URL=https://contact.example.net/widedoor',
        '--env',
        'WIDEDOOR_CONTROL_HOST=127.0.0.1',
        // fly.toml's heap flag (API_HEAP_MB).
        '--env',
        `NODE_OPTIONS=--max-old-space-size=${API_HEAP_MB}`,
        HOSTED,
      ]);
      expect(started.status, started.stderr).toBe(0);
      await waitForLog(name, 'widedoor event=api_ready', 'the hosted API');
      const seen = JSON.parse(
        nodeAs(
          name,
          '10001',
          [
            '(async () => {',
            "  const health = await fetch('http://127.0.0.1:8080/healthz');",
            "  const page = await fetch('http://127.0.0.1:8080/');",
            '  const text = await page.text();',
            '  console.log(JSON.stringify({',
            '    health: health.status, ok: await health.text(),',
            "    page: page.status, csp: page.headers.get('content-security-policy'),",
            "    hosted: text.includes('<!doctype html>') && text.includes('/assets/'),",
            '  }));',
            '})();',
          ].join('\n'),
        ),
      ) as { health: number; ok: string; page: number; csp: string | null; hosted: boolean };
      expect(seen).toMatchObject({ health: 200, ok: 'ok', page: 200, hosted: true });
      expect(seen.csp).toMatch(/default-src 'none'/);
      // The sweep's list fails with no network; it is logged, never the token.
      await waitForLog(name, 'widedoor event=fly_sweep', 'the startup sweep');
      const logs = docker(['logs', name]);
      const text = logs.stdout + logs.stderr;
      expect(text).toContain('widedoor event=fly_sweep status=0 reason=list_failed');
      expect(text).not.toContain('api_config_error');
      expect(text).not.toContain(token);
      docker(['rm', '--force', name]);
    },
    TIMEOUT,
  );

  it(
    'the entry refuses to run as anyone but root, and so does the agent',
    () => {
      // Proves the entry's first step and the agent's uid gate in the image itself.
      const entry = docker([
        'run',
        '--rm',
        '--label',
        LABEL,
        '--user',
        '10001:10001',
        '--network',
        controlNet,
        ...machineEnv(JOBS.nonRoot),
        SCAN,
      ]);
      expect(entry.status).not.toBe(0);
      expect(entry.stderr).toContain('widedoor event=entry_failed step=uid');
      expect(requestsFor(JOBS.nonRoot)).toEqual([]);

      const agent = docker([
        'run',
        '--rm',
        '--label',
        LABEL,
        '--user',
        '10001:10001',
        '--network',
        controlNet,
        ...machineEnv(JOBS.nonRoot),
        '--env',
        'WIDEDOOR_PROXY_URL=http://127.0.0.1:18080',
        '--entrypoint',
        'node',
        SCAN,
        `${HOSTED_DIR}/agent-bin.js`,
      ]);
      expect(agent.status).toBe(1);
      expect(agent.stderr).toContain(
        `widedoor event=agent_config_error job=${JOBS.nonRoot} name=uid`,
      );
      // The API hears why; the input is never fetched.
      expect(
        requestsFor(JOBS.nonRoot).map((r) => `${r.method} ${r.path.split('/').pop()}`),
      ).toEqual(['PUT result']);
      expect(resultFor(JOBS.nonRoot)).toEqual({
        status: 'failed',
        error: 'the scan machine is misconfigured',
      });
    },
    TIMEOUT,
  );

  it(
    'without NET_ADMIN the entry exits non-zero and the agent never runs',
    () => {
      // Proves the firewall fails closed: nft cannot load the ruleset, so nothing starts
      // and the API never hears from the machine.
      const name = createMachine(`${probe}-nocap`, machineEnv(JOBS.noCap));
      const r = docker(['start', '--attach', name]);
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toContain('widedoor event=entry_failed step=nftables');
      expect(r.stdout + r.stderr).not.toContain('agent_');
      expect(requestsFor(JOBS.noCap)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'scans a page on 11.0.0.0/24 through the proxy and sends a valid result',
    () => {
      // Proves the whole machine: entry, firewall, proxy as 10002, agent as root, scan child
      // as 10001 with Chromium's sandbox, the reaper, and the result the API receives.
      const name = createMachine(`${probe}-scan`, [
        '--cap-add',
        'NET_ADMIN',
        ...machineEnv(JOBS.scan),
      ]);
      const r = docker(['start', '--attach', name]);
      const log = r.stdout + r.stderr;
      expect(r.status, log).toBe(0);
      expect(log).toContain(`widedoor event=agent_result job=${JOBS.scan} status=done`);
      expect(log).toMatch(
        new RegExp(`widedoor event=agent_reaped job=${JOBS.scan} found=(yes|no) passes=[1-3]`),
      );
      // The token never reaches the log.
      expect(log).not.toContain(TOKEN);
      const sent = resultFor(JOBS.scan) as { status: string; reportJson: string };
      expect(sent.status).toBe('done');
      const validate = reportValidator();
      expect(validate(JSON.parse(sent.reportJson)), JSON.stringify(validate.errors)).toBe(true);
      const report = parseJsonReport(sent.reportJson);
      expect(report.errors).toEqual([]);
      expect(report.assets.map((a) => a.uri)).toEqual([`http://${SITE_IP}/page.html`]);
      expect(report.findings.some((f) => f.outcome === 'fail')).toBe(true);
      // The JSON report only (R37).
      expect(Object.keys(sent).sort()).toEqual(['reportJson', 'status']);
      expect(requestsFor(JOBS.scan).every((q) => q.auth)).toBe(true);
    },
    TIMEOUT,
  );
});

/** Starts a probe machine (PROBE_START) and waits for its stand-in agent. */
async function startProbe(
  name: string,
  options: { controlUrl?: string; extra?: readonly string[] } = {},
): Promise<void> {
  createMachine(
    name,
    [
      '--cap-add',
      'NET_ADMIN',
      ...machineEnv(JOBS.probe, options.controlUrl),
      ...(options.extra ?? []),
      // Both test switches, to prove the entry unsets them.
      '--env',
      'WIDEDOOR_AGENT_SAME_USER=1',
      '--env',
      'WIDEDOOR_EGRESS_SAME_USER=1',
      '--volume',
      `${tmp}:/stand-in:ro`,
      '--entrypoint',
      'sh',
    ],
    ['-c', PROBE_START],
  );
  const started = docker(['start', name]);
  if (started.status !== 0) throw new Error(started.stderr);
  await waitForLog(name, 'stand-in agent up', name);
}

/** Sends the proxy `count` requests for a private address as the scan user (all refused). */
function refuseMany(name: string, count: number): void {
  nodeAs(
    name,
    '10001',
    [
      "const net = require('node:net');",
      'const one = () => new Promise((done) => {',
      "  const s = net.connect(18080, '127.0.0.1', () => s.write('GET http://10.0.0.2/ HTTP/1.1\\r\\nHost: 10.0.0.2\\r\\n\\r\\n'));",
      "  s.on('data', () => s.destroy()); s.on('close', done); s.on('error', done);",
      '});',
      `(async () => { for (let i = 0; i < ${count}; i++) await one(); })();`,
    ].join('\n'),
  );
}

/** Waits for a machine to exit; resolves with its exit code and its log (stderr). */
async function exited(name: string): Promise<{ code: number; log: string }> {
  let state = '';
  for (let i = 0; i < 100 && state !== 'exited'; i++) {
    await sleep(200);
    state = docker(['inspect', '--format', '{{.State.Status}}', name]).stdout.trim();
  }
  expect(state, name).toBe('exited');
  const code = Number(docker(['inspect', '--format', '{{.State.ExitCode}}', name]).stdout.trim());
  return { code, log: docker(['logs', name]).stderr };
}

const lineAt = (log: string, pattern: RegExp) => log.split('\n').findIndex((l) => pattern.test(l));

describe('a locked scan machine', () => {
  beforeAll(() => startProbe(probe), TIMEOUT);

  it('loads the firewall whole: every chain drops by default, in both families', () => {
    // Proves nft -f ran: the inet table (both families) is the generated ruleset, rule for
    // rule, with policy drop on every chain. The probe's inputs: the control API's address,
    // Docker's resolver from resolv.conf, the control and proxy ports.
    const r = shAs(probe, '0', 'nft list ruleset');
    expect(r.status, r.stderr).toBe(0);
    // Root ran it (the entry and this probe); the machine's other users cannot run it at all.
    for (const user of ['10001', '10002'])
      expect(shAs(probe, user, '/usr/sbin/nft list ruleset').status, user).toBe(126);
    const listed = r.stdout.split('\n');
    const start = listed.indexOf('table inet widedoor {');
    expect(start, r.stdout).toBeGreaterThanOrEqual(0);
    const table = listed
      .slice(start, listed.indexOf('}', start) + 1)
      .map((l) => l.trim())
      .filter(Boolean);
    // nft lists protocols by number, the default reject bare and a /128 as the address.
    const generated = firewallRules({
      controlAddresses: [CONTROL_IP],
      controlPort: 8080,
      resolvers: ['127.0.0.11'],
      proxyPort: 18080,
    })
      .split('\n')
      .slice(2)
      .map((l) =>
        l
          .trim()
          .replace('meta l4proto udp', 'meta l4proto 17')
          .replace('meta l4proto tcp', 'meta l4proto 6')
          .replace(' reject with icmpx type port-unreachable', ' reject')
          .replace(/ daddr (\S+)\/128 /, ' daddr $1 '),
      )
      .filter(Boolean);
    expect(table).toEqual(generated);
    expect(table.filter((l) => l.endsWith('policy drop;'))).toHaveLength(3);
    // R33: the kernel takes the neighbor discovery rules (IPv6 only, 4 types, input and
    // output). This network is IPv4, so it shows the rules load, not that IPv6 works on Fly.
    const discovery = table.filter((l) => l.includes('icmpv6'));
    expect(discovery).toHaveLength(2);
    for (const rule of discovery) expect(rule).toMatch(/^ip6 hoplimit 255 icmpv6 type \{ /);
  });

  it('the scan user reaches nothing but the proxy', () => {
    // Proves uid 10001 has no way out but the proxy: no direct TCP to a public target or
    // to the control API, no DNS (Docker's 127.0.0.11 or through resolv.conf), and the
    // proxy itself works for it.
    expect(nodeAs(probe, '10001', tcp({ host: SITE_IP, port: 80 }))).toBe('timeout');
    expect(nodeAs(probe, '10001', tcp({ host: CONTROL_IP, port: 8080 }))).toBe('timeout');
    expect(nodeAs(probe, '10001', tcp({ host: '127.0.0.11', port: 53 }))).toBe('ECONNREFUSED');
    expect(nodeAs(probe, '10001', dnsAt('127.0.0.11', site))).toMatch(/^E[A-Z]+$/);
    expect(nodeAs(probe, '10001', lookup(site))).toMatch(/^E[A-Z_]+$/);
    // The same DNS listener is open to the proxy's user: the refusal is the firewall's.
    expect(nodeAs(probe, '10002', tcp({ host: '127.0.0.11', port: 53 }))).toBe('connected');
    expect(nodeAs(probe, '10001', viaProxy(`http://${SITE_IP}/`))).toBe('HTTP/1.1 200 OK');
  });

  it('no machine user but root reaches a loopback listener other than the proxy and DNS', () => {
    // Proves the loopback REJECTs for uid 10001 (IPv6 ::1 too, and the machine's own
    // address, which the kernel routes over loopback) and for uid 10002 (even the proxy's
    // own port). Root listeners on [::1]:18081 and <own address>:18082 show the refusals
    // are the firewall's: root connects to both.
    const own = docker([
      'inspect',
      '--format',
      `{{(index .NetworkSettings.Networks "${controlNet}").IPAddress}}`,
      probe,
    ]).stdout.trim();
    expect(own).toMatch(/^10\.213\.47\.\d+$/);
    const listen = docker([
      'exec',
      '--detach',
      '--user',
      '0',
      probe,
      'node',
      '-e',
      // A probe hangs up at once; the listener ignores the reset so it stays up.
      `const net = require('node:net'); const serve = (c) => { c.on('error', () => undefined); c.end('x'); }; net.createServer(serve).listen(18081, '::1'); net.createServer(serve).listen(18082, '${own}');`,
    ]);
    expect(listen.status, listen.stderr).toBe(0);
    let up = '';
    for (let i = 0; i < 50 && up !== 'connected'; i++)
      up = nodeAs(probe, '0', tcp({ host: own, port: 18082 }));
    expect(up).toBe('connected');
    expect(nodeAs(probe, '0', tcp({ host: '::1', port: 18081 }))).toBe('connected');
    for (const user of ['10001', '10002']) {
      expect(nodeAs(probe, user, tcp({ host: '::1', port: 18081 })), user).toBe('ECONNREFUSED');
      expect(nodeAs(probe, user, tcp({ host: own, port: 18082 })), user).toBe('ECONNREFUSED');
    }
    expect(nodeAs(probe, '10002', tcp({ host: '127.0.0.1', port: 18080 }))).toBe('ECONNREFUSED');
  });

  it('the proxy user reaches the web on 80 and DNS, never a blocked range or the control API', () => {
    // Proves uid 10002's rules: DNS at the resolver, port 80 on 11.0.0.0/24, and the block
    // drops before the 80 accept (the control API's decoy on port 80 sits in 10.0.0.0/8).
    expect(nodeAs(probe, '10002', tcp({ host: SITE_IP, port: 80 }))).toBe('connected');
    expect(nodeAs(probe, '10002', dnsAt('127.0.0.11', site))).toBe(`ok ${SITE_IP}`);
    expect(nodeAs(probe, '10002', tcp({ host: SITE_IP, port: 8080 }))).toBe('timeout');
    expect(nodeAs(probe, '10002', tcp({ host: CONTROL_IP, port: 80 }))).toBe('timeout');
    expect(nodeAs(probe, '10002', tcp({ host: CONTROL_IP, port: 8080 }))).toBe('timeout');
  });

  it('root reaches only the control API and DNS', () => {
    // Proves uid 0's rules: the control port on the control address, DNS, nothing else.
    expect(nodeAs(probe, '0', tcp({ host: CONTROL_IP, port: 8080 }))).toBe('connected');
    expect(nodeAs(probe, '0', lookup(control))).toBe(`ok ${CONTROL_IP}`);
    expect(nodeAs(probe, '0', tcp({ host: CONTROL_IP, port: 80 }))).toBe('timeout');
    expect(nodeAs(probe, '0', tcp({ host: SITE_IP, port: 80 }))).toBe('timeout');
  });

  it('the proxy refuses the metadata address and private ranges, and its log is tagged', () => {
    // Proves the policy holds in the image (403), and that the reader forwards the proxy's
    // lines with the job id and source=egress.
    expect(nodeAs(probe, '10001', viaProxy('http://169.254.169.254/'))).toBe(
      'HTTP/1.1 403 Forbidden',
    );
    expect(nodeAs(probe, '10001', viaProxy('http://10.0.0.1/'))).toBe('HTTP/1.1 403 Forbidden');
    const logs = docker(['logs', probe]);
    expect(logs.stderr).toContain(
      `widedoor event=egress_refused job=${JOBS.probe} source=egress host=169.254.169.254 reason=metadata method=GET via=absolute`,
    );
    expect(logs.stderr).toContain(
      `widedoor event=egress_refused job=${JOBS.probe} source=egress host=10.0.0.1 reason=private method=GET via=absolute`,
    );
  });

  it("locks Fly's machine API socket to root", () => {
    // Proves step 2: the stand-in socket was world-writable before the entry; after it, the
    // folder is 0700 and the socket 0600, both root's, so the scan user cannot reach it.
    expect(shAs(probe, '0', 'stat -c %u:%a /.fly /.fly/api').stdout.trim().split('\n')).toEqual([
      '0:700',
      '0:600',
    ]);
    expect(nodeAs(probe, '10001', tcp({ path: '/.fly/api' }))).toBe('EACCES');
    expect(nodeAs(probe, '0', tcp({ path: '/.fly/api' }))).toBe('connected');
  });

  it('keeps the token and the test switches away from the proxy and its reader', () => {
    // Proves R30: egress-bin and the reader start with an empty environment but for the
    // listed names; the agent has its job, the proxy URL (R4) and neither test switch.
    const environ = (user: string, pattern: string) => {
      const r = shAs(
        probe,
        user,
        `tr '\\0' '\\n' < /proc/$(pgrep -o -u ${user} -f '${pattern}')/environ`,
      );
      expect(r.status, r.stderr).toBe(0);
      return r.stdout.trim().split('\n').sort();
    };
    expect(environ('10002', 'node .*egress-bin[.]js')).toEqual([
      'NODE_ENV=production',
      expect.stringMatching(/^PATH=/),
      'UV_THREADPOOL_SIZE=32',
    ]);
    expect(environ('0', 'node .*egress-reader-bin[.]js')).toEqual([
      expect.stringMatching(/^PATH=/),
      `WIDEDOOR_JOB_ID=${JOBS.probe}`,
    ]);
    const agent = environ('0', 'node .*hosted/agent-bin[.]js');
    expect(agent).toContain(`WIDEDOOR_JOB_TOKEN=${TOKEN}`);
    expect(agent).toContain('WIDEDOOR_PROXY_URL=http://127.0.0.1:18080');
    expect(agent.filter((e) => e.includes('SAME_USER'))).toEqual([]);
    // The proxy holds no capability and cannot gain one.
    const status = shAs(
      probe,
      '10002',
      'grep -E "^(Uid|Gid|Groups|CapEff|CapBnd|NoNewPrivs)" /proc/$(pgrep -o -u 10002 -f "node .*egress-bin[.]js")/status',
    );
    expect(
      status.stdout
        .trim()
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').trim()),
    ).toEqual([
      'Uid: 10002 10002 10002 10002',
      'Gid: 10002 10002 10002 10002',
      'Groups:',
      'CapEff: 0000000000000000',
      'CapBnd: 0000000000000000',
      'NoNewPrivs: 1',
    ]);
  });

  it(
    "kills the scan child's process group on timeout and leaves no scan user process",
    async () => {
      // Proves the Task 7 carries on Linux: the child (setpriv to 10001) is stopped at its
      // time limit with its process group, the reaper's pkill runs until none is left, and
      // pgrep -U 10001 is empty once the result is sent. The page never answers, so the
      // scan runs into the limit. A scan user process in a session of its own that ignores
      // SIGTERM stands in for one that escaped the group (Chromium's helpers are detached).
      const escaped = docker([
        'exec',
        '--detach',
        '--user',
        '10001:10001',
        probe,
        'setsid',
        'sh',
        '-c',
        "trap '' TERM; exec sleep 600",
      ]);
      expect(escaped.status, escaped.stderr).toBe(0);
      const script = [
        `const { runAgent } = await import('${HOSTED_DIR}/agent-bin.real.js');`,
        'process.exitCode = await runAgent({',
        '  env: {',
        '    PATH: process.env.PATH,',
        "    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',",
        `    WIDEDOOR_CONTROL_URL: '${CONTROL_URL}',`,
        `    WIDEDOOR_JOB_ID: '${JOBS.timeout}',`,
        `    WIDEDOOR_JOB_TOKEN: '${TOKEN}',`,
        "    WIDEDOOR_PROXY_URL: 'http://127.0.0.1:18080',",
        '  },',
        '  capMs: 60_000,',
        '  marginMs: 45_000,',
        '});',
      ].join('\n');
      const run = dockerAsync([
        'exec',
        '--user',
        '0',
        probe,
        'node',
        '--input-type=module',
        '-e',
        script,
      ]);
      // While the scan hangs, the scan user runs the child and Chromium.
      let during = '';
      for (let i = 0; i < 60 && !/chrom/i.test(during); i++) {
        await sleep(250);
        during = shAs(probe, '0', 'pgrep -a -U 10001 || true').stdout;
      }
      expect(during).toMatch(/agent-child\.js/);
      expect(during).toMatch(/chrom/i);
      expect(during).toMatch(/sleep 600/);

      const done = await run;
      expect(done.status, done.stderr).toBe(0);
      expect(done.stderr).toContain(`widedoor event=agent_timeout job=${JOBS.timeout}`);
      // passes=2 when the second pkill finds nothing; 3 when it still matched the first
      // pass's victims as zombies that tini had not collected yet (pkill matches zombies).
      expect(done.stderr).toMatch(
        new RegExp(`widedoor event=agent_reaped job=${JOBS.timeout} found=yes passes=[23]`),
      );
      expect(resultFor(JOBS.timeout)).toEqual({ status: 'failed', error: TIMED_OUT });
      const left = shAs(probe, '0', 'pgrep -a -U 10001');
      expect(left.status, left.stdout).toBe(1);
      expect(left.stdout).toBe('');
    },
    TIMEOUT,
  );
});

describe('the end of a scan (ledger R32)', () => {
  it(
    "stops the agent when the proxy dies, after reporting each event's dropped lines",
    async () => {
      // Proves the reader's carries and R32's loss path, on a machine of its own: the
      // reader drains the proxy's output (more than 200 refusals), forwards 200 per event
      // name and counts the rest; when the proxy dies, it tells the entry, which stops the
      // agent (SIGTERM), has the reader report the count and exits non-zero.
      const name = `${probe}-death`;
      await startProbe(name);
      refuseMany(name, 210);
      const killed = shAs(name, '0', 'pkill -KILL -u 10002');
      expect(killed.status, killed.stderr).toBe(0);
      const { code, log } = await exited(name);
      expect(code).not.toBe(0);
      const refused = log.split('\n').filter((l) => l.startsWith('widedoor event=egress_refused '));
      expect(refused).toHaveLength(200);
      const lost = lineAt(log, new RegExp(`^widedoor event=egress_exited job=${JOBS.probe}$`));
      const stopped = lineAt(log, /^stand-in agent stopped by SIGTERM$/);
      const dropped = lineAt(
        log,
        new RegExp(
          `^widedoor event=egress_lines_dropped job=${JOBS.probe} name=egress_refused count=\\d+$`,
        ),
      );
      expect(lost).toBeGreaterThan(0);
      expect(stopped).toBeGreaterThan(lost);
      expect(dropped).toBeGreaterThan(0);
      const count = Number(/count=(\d+)$/.exec(log.split('\n')[dropped] ?? '')?.[1]);
      expect(count).toBeGreaterThanOrEqual(210 - 200);
    },
    TIMEOUT,
  );

  it(
    'stops the scan when the reader dies, and the API hears the agent stopped it',
    async () => {
      // Proves the Important fix of review round 2 (CWE-778), with the real agent: the
      // reader is killed mid-scan; its wrapper tells the entry (SIGUSR1), which stops the
      // agent (SIGTERM) and exits non-zero. The agent's stop path still reaches the API
      // (root's control channel does not go through the proxy or the reader), so the API
      // gets the agent's failed result, `the scan was stopped`, not silence.
      const name = createMachine(`${probe}-reader`, [
        '--cap-add',
        'NET_ADMIN',
        ...machineEnv(JOBS.readerDeath),
      ]);
      const started = docker(['start', name]);
      expect(started.status, started.stderr).toBe(0);
      let scanning = '';
      for (let i = 0; i < 120 && !/agent-child/.test(scanning); i++) {
        await sleep(250);
        scanning = shAs(name, '0', 'pgrep -a -U 10001 || true').stdout;
      }
      expect(scanning).toMatch(/agent-child/);
      const killed = shAs(name, '0', "pkill -KILL -f 'node .*egress-reader-bin[.]js'");
      expect(killed.status, killed.stderr).toBe(0);
      const { code, log } = await exited(name);
      expect(code, log).toBe(1);
      expect(log).toContain(`widedoor event=agent_stopped job=${JOBS.readerDeath}`);
      expect(log).toContain(`widedoor event=agent_result job=${JOBS.readerDeath} status=failed`);
      expect(resultFor(JOBS.readerDeath)).toEqual({ status: 'failed', error: STOPPED });
    },
    TIMEOUT,
  );

  it(
    'resolves through a resolver in a blocked range for the proxy user only',
    async () => {
      // Proves in the kernel that the proxy user's DNS accept comes before the blocked-range
      // drops: with resolv.conf naming a stub in 10.0.0.0/8, uid 10002 resolves through it
      // while the rest of that address stays dropped, and uid 10001 cannot query it at all.
      const name = `${probe}-dns`;
      await startProbe(name, {
        controlUrl: `http://${CONTROL_IP}:8080`,
        extra: ['--volume', `${join(tmp, 'resolv.conf')}:/etc/resolv.conf:ro`],
      });
      expect(shAs(name, '0', 'grep nameserver /etc/resolv.conf').stdout.trim()).toBe(
        `nameserver ${DNS_IP}`,
      );
      expect(nodeAs(name, '10002', dnsAt(DNS_IP, 'site.example.test'))).toBe(`ok ${SITE_IP}`);
      expect(nodeAs(name, '10002', lookup('site.example.test'))).toBe(`ok ${SITE_IP}`);
      expect(nodeAs(name, '10002', tcp({ host: DNS_IP, port: 8053 }))).toBe('timeout');
      expect(nodeAs(name, '10001', dnsAt(DNS_IP, 'site.example.test'))).toMatch(/^E[A-Z]+$/);
      expect(nodeAs(name, '0', tcp({ host: DNS_IP, port: 8053 }))).toBe('timeout');
    },
    TIMEOUT,
  );

  it(
    "reports the dropped lines after the agent ends on its own, and exits with the agent's code",
    async () => {
      // Proves the normal end: the agent exits by itself (code 7), then the reader reports
      // each event's dropped lines, then the entry stops the proxy and exits 7.
      const name = `${probe}-end`;
      await startProbe(name);
      refuseMany(name, 205);
      const done = shAs(name, '0', "kill -USR2 $(pgrep -o -f 'node .*hosted/agent-bin[.]js')");
      expect(done.status, done.stderr).toBe(0);
      const { code, log } = await exited(name);
      expect(code).toBe(7);
      const finished = lineAt(log, /^stand-in agent done$/);
      const dropped = lineAt(
        log,
        new RegExp(
          `^widedoor event=egress_lines_dropped job=${JOBS.probe} name=egress_refused count=5$`,
        ),
      );
      expect(finished).toBeGreaterThan(0);
      expect(dropped, log).toBeGreaterThan(finished);
      expect(log).not.toContain('egress_exited');
      expect(log).not.toContain('entry_failed');
    },
    TIMEOUT,
  );

  it(
    'passes SIGTERM and SIGINT on to the agent and exits with its code',
    async () => {
      // Proves the traps: a machine stop (SIGTERM, through the init) and SIGINT reach the
      // agent, and the entry ends with the agent's status.
      for (const [signal, code] of [
        ['TERM', 143],
        ['INT', 130],
      ] as const) {
        const name = `${probe}-${signal.toLowerCase()}`;
        await startProbe(name);
        const sent = docker(['kill', '--signal', signal, name]);
        expect(sent.status, sent.stderr).toBe(0);
        const end = await exited(name);
        expect(end.code, end.log).toBe(code);
        expect(end.log).toContain(`stand-in agent stopped by SIG${signal}`);
        expect(end.log).not.toContain('egress_exited');
      }
    },
    TIMEOUT,
  );
});
