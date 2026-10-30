import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BLOCKED_V4, BLOCKED_V6 } from '@widedoor/web/egress';
import { RULES_NFT, main, nameservers } from '../src/hosted/firewall-bin.ts';
import { EGRESS_UID, TABLE, firewallRules, type FirewallInput } from '../src/hosted/firewall.ts';
import { EGRESS_PORT } from '../src/hosted/protocol.ts';

/*
 * The scan machine's firewall rules (ledger R13, R29, R33) as text: the exact nftables
 * ruleset for one input, the family split, the block list, the order the kernel checks
 * them in, the refusals; firewall-bin, which feeds them the control address and the
 * resolvers; and the entry script's copies of the port, uid and table. The rules
 * themselves run in the kernel in hosted-lockdown.image.test.ts; here `nft -c` parses
 * them when this machine has nft and root.
 */

const INPUT: FirewallInput = {
  controlAddresses: ['10.1.2.3', 'fdaa:0:1::2'],
  controlPort: 8080,
  resolvers: ['127.0.0.11', 'fdaa::3'],
  proxyPort: 18080,
};

const ND =
  'ip6 hoplimit 255 icmpv6 type { nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept';
const REJECT = 'reject with icmpx type port-unreachable';

const OUTPUT = [
  'ct state established,related accept',
  ND,
  'oifname "lo" meta skuid 10001 tcp dport 18080 accept',
  `oifname "lo" meta skuid 10001 ${REJECT}`,
  'meta skuid 10002 meta l4proto udp ct original ip daddr 127.0.0.11 ct original proto-dst 53 accept',
  'meta skuid 10002 meta l4proto tcp ct original ip daddr 127.0.0.11 ct original proto-dst 53 accept',
  'meta skuid 10002 meta l4proto udp ct original ip6 daddr fdaa::3 ct original proto-dst 53 accept',
  'meta skuid 10002 meta l4proto tcp ct original ip6 daddr fdaa::3 ct original proto-dst 53 accept',
  `oifname "lo" meta skuid 10002 ${REJECT}`,
  'oifname "lo" accept',
  'meta skuid 10002 ip daddr 0.0.0.0/8 drop',
  'meta skuid 10002 ip daddr 10.0.0.0/8 drop',
  'meta skuid 10002 ip daddr 100.64.0.0/10 drop',
  'meta skuid 10002 ip daddr 127.0.0.0/8 drop',
  'meta skuid 10002 ip daddr 169.254.0.0/16 drop',
  'meta skuid 10002 ip daddr 172.16.0.0/12 drop',
  'meta skuid 10002 ip daddr 192.0.0.0/24 drop',
  'meta skuid 10002 ip daddr 192.0.2.0/24 drop',
  'meta skuid 10002 ip daddr 192.88.99.0/24 drop',
  'meta skuid 10002 ip daddr 192.168.0.0/16 drop',
  'meta skuid 10002 ip daddr 198.18.0.0/15 drop',
  'meta skuid 10002 ip daddr 198.51.100.0/24 drop',
  'meta skuid 10002 ip daddr 203.0.113.0/24 drop',
  'meta skuid 10002 ip daddr 224.0.0.0/4 drop',
  'meta skuid 10002 ip daddr 240.0.0.0/4 drop',
  'meta skuid 10002 ip6 daddr ::/128 drop',
  'meta skuid 10002 ip6 daddr ::1/128 drop',
  'meta skuid 10002 ip6 daddr fe80::/10 drop',
  'meta skuid 10002 ip6 daddr fc00::/7 drop',
  'meta skuid 10002 ip6 daddr ff00::/8 drop',
  'meta skuid 10002 ip6 daddr 2001::/23 drop',
  'meta skuid 10002 ip6 daddr 2001:db8::/32 drop',
  'meta skuid 10002 ip6 daddr 2002::/16 drop',
  'meta skuid 10002 ip6 daddr 3fff::/20 drop',
  'meta skuid 10002 ip6 daddr 64:ff9b::/96 drop',
  'meta skuid 10002 ip6 daddr 64:ff9b:1::/48 drop',
  'meta skuid 10002 ip6 daddr ::/3 drop',
  'meta skuid 10002 ip6 daddr 4000::/2 drop',
  'meta skuid 10002 ip6 daddr 8000::/1 drop',
  'meta skuid 10002 ip daddr 10.1.2.3 drop',
  'meta skuid 10002 ip6 daddr fdaa:0:1::2 drop',
  'meta skuid 10002 tcp dport 80 accept',
  'meta skuid 10002 tcp dport 443 accept',
  'meta skuid 0 ip daddr 10.1.2.3 tcp dport 8080 accept',
  'meta skuid 0 ip6 daddr fdaa:0:1::2 tcp dport 8080 accept',
  'meta skuid 0 ip daddr 127.0.0.11 udp dport 53 accept',
  'meta skuid 0 ip daddr 127.0.0.11 tcp dport 53 accept',
  'meta skuid 0 ip6 daddr fdaa::3 udp dport 53 accept',
  'meta skuid 0 ip6 daddr fdaa::3 tcp dport 53 accept',
];

const RULESET = [
  'table inet widedoor',
  'delete table inet widedoor',
  'table inet widedoor {',
  '\tchain input {',
  '\t\ttype filter hook input priority filter; policy drop;',
  '\t\tiifname "lo" accept',
  '\t\tct state established,related accept',
  `\t\t${ND}`,
  '\t}',
  '\tchain forward {',
  '\t\ttype filter hook forward priority filter; policy drop;',
  '\t}',
  '\tchain output {',
  '\t\ttype filter hook output priority filter; policy drop;',
  ...OUTPUT.map((rule) => `\t\t${rule}`),
  '\t}',
  '}',
  '',
].join('\n');

/** One base chain's rules, without its type line, trimmed. */
const chainRules = (text: string, name: string): string[] => {
  const all = text.split('\n');
  const start = all.indexOf(`\tchain ${name} {`);
  const end = all.indexOf('\t}', start);
  expect(start, name).toBeGreaterThan(0);
  return all.slice(start + 2, end).map((l) => l.trim());
};
/** The rules an IPv4 (or IPv6) packet can meet: every rule but those of the other family. */
const forFamily = (rules: readonly string[], family: 4 | 6) =>
  rules.filter((r) => (family === 4 ? !/\bip6\b|icmpv6/.test(r) : !/\bip\b/.test(r)));
const indexOf = (rules: readonly string[], pattern: RegExp) =>
  rules.findIndex((l) => pattern.test(l));
const lastIndexOf = (rules: readonly string[], pattern: RegExp) =>
  rules.findLastIndex((l) => pattern.test(l));

/** nft can check a ruleset only with root (it talks to the kernel) and outside Windows. */
const nftCheck =
  process.platform !== 'win32' &&
  process.getuid?.() === 0 &&
  spawnSync('nft', ['--version'], { encoding: 'utf8' }).status === 0;

describe('firewallRules', () => {
  it('writes the exact nftables ruleset', () => {
    expect(EGRESS_UID).toBe(10002);
    expect(TABLE).toBe('widedoor');
    expect(firewallRules(INPUT)).toBe(RULESET);
  });

  it('replaces only its own table, in one file, with a drop policy on every chain', () => {
    const text = firewallRules(INPUT);
    // Created first so the delete never fails on a fresh machine; nft -f runs all three as
    // one transaction. No flush ruleset: other tables (Docker's resolver NAT) stay.
    expect(text.split('\n').slice(0, 3)).toEqual([
      'table inet widedoor',
      'delete table inet widedoor',
      'table inet widedoor {',
    ]);
    expect(text).not.toMatch(/flush|policy accept/);
    expect(text.match(/policy drop;/g)).toHaveLength(3);
    for (const hook of ['input', 'forward', 'output'])
      expect(text).toContain(`type filter hook ${hook} priority filter; policy drop;`);
    expect(chainRules(text, 'forward')).toEqual([]);
    // Native nft only: no xt owner or conntrack match (Fly's kernel lacks xt owner).
    expect(text).not.toMatch(/-m owner|--uid-owner|-m conntrack|-j |\*filter|COMMIT/);
  });

  it('gives each family only its own addresses, and a family with none gets no rule for them', () => {
    const text = firewallRules({
      ...INPUT,
      controlAddresses: ['fdaa:0:1::2'],
      resolvers: ['192.0.2.53'],
    });
    const output = chainRules(text, 'output');
    expect(output).toContain(
      'meta skuid 10002 meta l4proto udp ct original ip daddr 192.0.2.53 ct original proto-dst 53 accept',
    );
    expect(output).toContain('meta skuid 0 ip daddr 192.0.2.53 udp dport 53 accept');
    expect(output).toContain('meta skuid 0 ip6 daddr fdaa:0:1::2 tcp dport 8080 accept');
    expect(output.filter((r) => /dport 8080/.test(r))).toHaveLength(1);
    expect(output.filter((r) => /\bip6\b.*(dport 53|proto-dst 53)/.test(r))).toEqual([]);
    expect(output.filter((r) => /\bip daddr \S+ (tcp dport 8080 accept|drop)$/.test(r))).toEqual(
      BLOCKED_V4.map((range) => `meta skuid 10002 ip daddr ${range} drop`),
    );
  });

  it('meets each family with the rules iptables-restore had for it, in the same order', () => {
    // The old v4 and v6 OUTPUT chains, in their order, as nft rules: any rule naming the
    // other family can never match, so an IPv4 packet meets exactly these.
    const output = chainRules(firewallRules(INPUT), 'output');
    const shared = (rules: readonly string[]) => [
      'ct state established,related accept',
      ...rules,
      'oifname "lo" meta skuid 10001 tcp dport 18080 accept',
      `oifname "lo" meta skuid 10001 ${REJECT}`,
    ];
    expect(forFamily(output, 4)).toEqual([
      ...shared([]),
      'meta skuid 10002 meta l4proto udp ct original ip daddr 127.0.0.11 ct original proto-dst 53 accept',
      'meta skuid 10002 meta l4proto tcp ct original ip daddr 127.0.0.11 ct original proto-dst 53 accept',
      `oifname "lo" meta skuid 10002 ${REJECT}`,
      'oifname "lo" accept',
      ...[...BLOCKED_V4, '10.1.2.3'].map((r) => `meta skuid 10002 ip daddr ${r} drop`),
      'meta skuid 10002 tcp dport 80 accept',
      'meta skuid 10002 tcp dport 443 accept',
      'meta skuid 0 ip daddr 10.1.2.3 tcp dport 8080 accept',
      'meta skuid 0 ip daddr 127.0.0.11 udp dport 53 accept',
      'meta skuid 0 ip daddr 127.0.0.11 tcp dport 53 accept',
    ]);
    expect(forFamily(output, 6)).toEqual([
      ...shared([ND]),
      'meta skuid 10002 meta l4proto udp ct original ip6 daddr fdaa::3 ct original proto-dst 53 accept',
      'meta skuid 10002 meta l4proto tcp ct original ip6 daddr fdaa::3 ct original proto-dst 53 accept',
      `oifname "lo" meta skuid 10002 ${REJECT}`,
      'oifname "lo" accept',
      ...[...BLOCKED_V6, 'fdaa:0:1::2'].map((r) => `meta skuid 10002 ip6 daddr ${r} drop`),
      'meta skuid 10002 tcp dport 80 accept',
      'meta skuid 10002 tcp dport 443 accept',
      'meta skuid 0 ip6 daddr fdaa:0:1::2 tcp dport 8080 accept',
      'meta skuid 0 ip6 daddr fdaa::3 udp dport 53 accept',
      'meta skuid 0 ip6 daddr fdaa::3 tcp dport 53 accept',
    ]);
    const input = chainRules(firewallRules(INPUT), 'input');
    expect(forFamily(input, 4)).toEqual([
      'iifname "lo" accept',
      'ct state established,related accept',
    ]);
    expect(forFamily(input, 6)).toEqual([
      'iifname "lo" accept',
      'ct state established,related accept',
      ND,
    ]);
  });

  it('accepts on-link neighbor discovery in IPv6 only, before any uid rule (R33)', () => {
    const text = firewallRules(INPUT);
    for (const name of ['input', 'output']) {
      const rules = chainRules(text, name);
      expect(rules.filter((r) => r.includes('icmpv6'))).toEqual([ND]);
      // Right after the established and related rule, before the first uid rule.
      const established = indexOf(rules, /^ct state established,related accept$/);
      expect(rules[established + 1], name).toBe(ND);
      const firstUid = indexOf(rules, /meta skuid/);
      if (firstUid !== -1) expect(firstUid).toBeGreaterThan(established + 1);
    }
    // The hop limit match makes the rule IPv6 only; the four types are 133 to 136.
    expect(ND).toMatch(/^ip6 hoplimit 255 icmpv6 type \{ /);
  });

  it('drops every blocked range once per family, then the control addresses, for the proxy user only', () => {
    const drops = chainRules(firewallRules(INPUT), 'output').filter((r) => r.endsWith(' drop'));
    expect(drops).toEqual([
      ...BLOCKED_V4.map((r) => `meta skuid 10002 ip daddr ${r} drop`),
      ...BLOCKED_V6.map((r) => `meta skuid 10002 ip6 daddr ${r} drop`),
      'meta skuid 10002 ip daddr 10.1.2.3 drop',
      'meta skuid 10002 ip6 daddr fdaa:0:1::2 drop',
    ]);
  });

  it('drops the proxy user to a control address that is public, before 80 and 443', () => {
    const rules = chainRules(
      firewallRules({ ...INPUT, controlAddresses: ['93.184.215.14'] }),
      'output',
    );
    const drop = indexOf(rules, /^meta skuid 10002 ip daddr 93\.184\.215\.14 drop$/);
    const web = indexOf(rules, /^meta skuid 10002 tcp dport 80 accept$/);
    expect(drop).toBeGreaterThan(0);
    expect(web).toBe(drop + 1);
  });

  it('keeps the order: scan loopback, proxy DNS, proxy loopback, drops, 80 and 443, root', () => {
    const rules = chainRules(firewallRules(INPUT), 'output');
    // The scan user's two loopback rules first.
    const proxyPort = indexOf(rules, /^oifname "lo" meta skuid 10001 tcp dport 18080 accept$/);
    const scanReject = indexOf(rules, /^oifname "lo" meta skuid 10001 reject /);
    expect(proxyPort).toBeGreaterThan(0);
    expect(scanReject).toBe(proxyPort + 1);
    // The proxy's DNS (matched before NAT, so a loopback resolver such as Docker's
    // 127.0.0.11 counts) before its loopback reject, which comes before the loopback
    // accept for everyone else; and before the block drops (Fly's resolver is in
    // fc00::/7). Then the drops, then 80 and 443.
    const firstDns = indexOf(rules, /^meta skuid 10002 .*ct original proto-dst 53 accept$/);
    const dns = lastIndexOf(rules, /^meta skuid 10002 .*ct original proto-dst 53 accept$/);
    const proxyReject = indexOf(rules, /^oifname "lo" meta skuid 10002 reject /);
    const loopback = indexOf(rules, /^oifname "lo" accept$/);
    const firstDrop = indexOf(rules, /^meta skuid 10002 ip6? daddr \S+ drop$/);
    const lastDrop = lastIndexOf(rules, /^meta skuid 10002 ip6? daddr \S+ drop$/);
    const web = indexOf(rules, /^meta skuid 10002 tcp dport 80 accept$/);
    expect(firstDns).toBe(scanReject + 1);
    expect(proxyReject).toBe(dns + 1);
    expect(loopback).toBe(proxyReject + 1);
    expect(firstDrop).toBe(loopback + 1);
    expect(web).toBe(lastDrop + 1);
    expect(rules[web + 1]).toBe('meta skuid 10002 tcp dport 443 accept');
    // Root last; the scan user has no rule off loopback.
    expect(indexOf(rules, /^meta skuid 0 /)).toBe(web + 2);
    expect(rules.slice(web + 2).every((r) => r.startsWith('meta skuid 0 '))).toBe(true);
    expect(rules.filter((r) => r.includes('skuid 10001'))).toHaveLength(2);
    expect(
      rules.filter((r) => r.includes('skuid 10001') && !r.startsWith('oifname "lo" ')),
    ).toEqual([]);
  });

  it('refuses empty lists, ports out of range and anything that is not an address', () => {
    const bad: [Partial<FirewallInput>, RegExp][] = [
      [{ controlAddresses: [] }, /controlAddresses is empty/],
      [{ resolvers: [] }, /resolvers is empty/],
      [{ controlPort: 0 }, /controlPort/],
      [{ controlPort: 65536 }, /controlPort/],
      [{ controlPort: 80.5 }, /controlPort/],
      [{ proxyPort: 0 }, /proxyPort/],
      [{ proxyPort: Number.NaN }, /proxyPort/],
      [{ controlAddresses: ['control.internal'] }, /not an IP address/],
      [{ controlAddresses: ['10.0.0.1 accept'] }, /not an IP address/],
      [{ controlAddresses: ['10.0.0.0/8'] }, /not an IP address/],
      [{ resolvers: ['fe80::1%eth0'] }, /not an IP address/],
      [{ resolvers: ['127.0.0.11\n}\ntable inet x {'] }, /not an IP address/],
      [{ resolvers: [''] }, /not an IP address/],
    ];
    for (const [change, message] of bad)
      expect(() => firewallRules({ ...INPUT, ...change }), JSON.stringify(change)).toThrow(message);
  });

  it.skipIf(!nftCheck)('parses with nft -c -f', () => {
    const dir = mkdtempSync(join(tmpdir(), 'widedoor-nft-'));
    try {
      const file = join(dir, RULES_NFT);
      writeFileSync(file, firewallRules(INPUT));
      const r = spawnSync('nft', ['-c', '-f', file], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('firewall-bin', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** A temp folder with a resolv.conf, and main run against it. */
  const run = async (
    controlUrl: string | undefined,
    resolv = 'nameserver 127.0.0.11\noptions ndots:0\n',
    lookup = async (host: string) => (host === 'control.internal' ? ['10.1.2.3'] : []),
  ) => {
    dir = mkdtempSync(join(tmpdir(), 'widedoor-firewall-'));
    const resolvConf = join(dir, 'resolv.conf');
    writeFileSync(resolvConf, resolv);
    const log: string[] = [];
    const code = await main({
      env: controlUrl === undefined ? {} : { WIDEDOOR_CONTROL_URL: controlUrl },
      dir,
      resolvConf,
      lookup,
      log: (line) => log.push(line),
    });
    return { code, log, dir };
  };

  it('reads the nameserver lines of a resolv.conf', () => {
    expect(
      nameservers(
        '# comment\nnameserver 127.0.0.11\r\nsearch x\n  nameserver   fdaa::3  \nnameserver\n',
      ),
    ).toEqual(['127.0.0.11', 'fdaa::3']);
  });

  it('resolves the control host once and writes the ruleset, root only', async () => {
    const lookups: string[] = [];
    const {
      code,
      log,
      dir: out,
    } = await run(
      'http://control.internal:8080/',
      'nameserver 127.0.0.11\nnameserver fdaa::3\n',
      async (host) => {
        lookups.push(host);
        return ['10.1.2.3', 'fdaa:0:1::2'];
      },
    );
    expect(code).toBe(0);
    expect(log).toEqual([]);
    expect(lookups).toEqual(['control.internal']);
    expect(readFileSync(join(out, RULES_NFT), 'utf8')).toBe(RULESET);
    if (process.platform !== 'win32')
      expect(statSync(join(out, RULES_NFT)).mode & 0o777).toBe(0o600);
  });

  it('takes an address as it is, and the scheme default port', async () => {
    const { code, dir: out } = await run('https://[fdaa:0:1::2]/', undefined, async () => {
      throw new Error('no lookup for an address');
    });
    expect(code).toBe(0);
    expect(readFileSync(join(out, RULES_NFT), 'utf8')).toContain(
      '\t\tmeta skuid 0 ip6 daddr fdaa:0:1::2 tcp dport 443 accept\n',
    );
  });

  it('fails closed and names the problem, never the URL', async () => {
    const cases: [string | undefined, string | undefined, string][] = [
      [undefined, undefined, 'WIDEDOOR_CONTROL_URL'],
      ['ftp://control.internal/', undefined, 'WIDEDOOR_CONTROL_URL'],
      ['http://nowhere.internal:8080/', undefined, 'control_host'],
      ['http://control.internal:8080/', '# no nameserver\n', 'resolv_conf'],
      ['http://control.internal:8080/', 'nameserver fe80::1%eth0\n', 'rules'],
    ];
    for (const [url, resolv, name] of cases) {
      const { code, log, dir: out } = await run(url, resolv);
      expect(code, name).toBe(1);
      expect(log).toEqual([`widedoor event=firewall_config_error name=${name}`]);
      expect(() => statSync(join(out, RULES_NFT))).toThrow();
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('never overwrites a rules file already in the folder', async () => {
    dir = mkdtempSync(join(tmpdir(), 'widedoor-firewall-'));
    writeFileSync(join(dir, 'resolv.conf'), 'nameserver 127.0.0.11\n');
    writeFileSync(join(dir, RULES_NFT), 'flush ruleset\n');
    const log: string[] = [];
    const code = await main({
      env: { WIDEDOOR_CONTROL_URL: 'http://10.1.2.3:8080/' },
      dir,
      resolvConf: join(dir, 'resolv.conf'),
      log: (line) => log.push(line),
    });
    expect(code).toBe(1);
    expect(log).toEqual(['widedoor event=firewall_config_error name=write']);
    expect(readFileSync(join(dir, RULES_NFT), 'utf8')).toBe('flush ruleset\n');
  });

  it('needs an absolute folder', async () => {
    const log: string[] = [];
    expect(await main({ env: {}, dir: undefined, log: (l) => log.push(l) })).toBe(1);
    expect(await main({ env: {}, dir: 'relative', log: (l) => log.push(l) })).toBe(1);
    expect(log).toEqual([
      'widedoor event=firewall_config_error name=dir',
      'widedoor event=firewall_config_error name=dir',
    ]);
  });
});

describe('docker/scan-entry.sh', () => {
  const entry = () =>
    readFileSync(fileURLToPath(new URL('../../../docker/scan-entry.sh', import.meta.url)), 'utf8');

  it('names the same proxy port and proxy uid as the TypeScript', () => {
    const text = entry();
    expect(text).toMatch(new RegExp(`^PROXY_PORT=${EGRESS_PORT}$`, 'm'));
    expect(text).toMatch(new RegExp(`^EGRESS_UID=${EGRESS_UID}$`, 'm'));
    // Each is set once, so no later line overrides it.
    expect(text.match(/^PROXY_PORT=/gm)).toHaveLength(1);
    expect(text.match(/^EGRESS_UID=/gm)).toHaveLength(1);
  });

  it('loads the ruleset whole with nft and checks the table and its drop policies, failing closed', () => {
    const text = entry();
    expect(text).toMatch(/^\/usr\/sbin\/nft -f "\$dir\/rules\.nft" \|\| fail nftables$/m);
    expect(text).toContain(`$(/usr/sbin/nft list table inet ${TABLE}) || fail nftables_verify`);
    expect(text).toMatch(/^for hook in input forward output; do$/m);
    expect(text).toContain('*"type filter hook $hook priority filter; policy drop;"*) ;;');
    expect(text).toContain('*) fail nftables_verify ;;');
    expect(text).not.toMatch(/iptables|rules\.v[46]/);
  });

  /**
   * The entry's own verify loop, cut from the script, run by sh against a canned listing:
   * prints `ok`, or `fail <step>` from a stand-in fail().
   */
  const verify = (listed: string) => {
    const loop = /^for hook in input forward output; do\n[\s\S]*?^done$/m.exec(entry())?.[0];
    expect(loop).toBeDefined();
    const script = `fail() { echo "fail $1"; exit 1; }\nlisted=$LISTED\n${loop ?? ''}\necho ok\n`;
    return spawnSync('sh', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, LISTED: listed },
    }).stdout.trim();
  };
  const hasSh = spawnSync('sh', ['-c', 'true']).status === 0;

  it.skipIf(!hasSh)(
    "passes nft's listing of the table and fails nftables_verify when a drop policy is missing",
    () => {
      // nft 1.0.6's own listing of the table (the scan image's nft), most rules left out.
      const listed = [
        'table inet widedoor {',
        '\tchain input {',
        '\t\ttype filter hook input priority filter; policy drop;',
        '\t\tiifname "lo" accept',
        '\t}',
        '',
        '\tchain forward {',
        '\t\ttype filter hook forward priority filter; policy drop;',
        '\t}',
        '',
        '\tchain output {',
        '\t\ttype filter hook output priority filter; policy drop;',
        '\t\tct state established,related accept',
        '\t}',
        '}',
      ].join('\n');
      expect(verify(listed)).toBe('ok');
      for (const hook of ['input', 'forward', 'output']) {
        const line = `type filter hook ${hook} priority filter; policy drop;`;
        for (const broken of [
          listed.replace(line, `type filter hook ${hook} priority filter; policy accept;`),
          listed.replace(line, ''),
        ])
          expect(verify(broken), hook).toBe('fail nftables_verify');
      }
      expect(verify('')).toBe('fail nftables_verify');
    },
  );
});
