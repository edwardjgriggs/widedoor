import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BLOCKED_V4, BLOCKED_V6 } from '@widedoor/web/egress';
import { RULES_V4, RULES_V6, main, nameservers } from '../src/hosted/firewall-bin.ts';
import { EGRESS_UID, firewallRules, type FirewallInput } from '../src/hosted/firewall.ts';
import { EGRESS_PORT } from '../src/hosted/protocol.ts';

/*
 * The scan machine's firewall rules (ledger R13, R29, R33) as text: the exact files for
 * one input per family, the family split, the block list, the order the kernel checks
 * them in, the refusals; firewall-bin, which feeds them the control address and the
 * resolvers; and the entry script's copies of the port and uid. The rules themselves run
 * in the kernel in hosted-lockdown.image.test.ts.
 */

const INPUT: FirewallInput = {
  controlAddresses: ['10.1.2.3', 'fdaa:0:1::2'],
  controlPort: 8080,
  resolvers: ['127.0.0.11', 'fdaa::3'],
  proxyPort: 18080,
};

const HEAD = [
  '*filter',
  ':INPUT DROP [0:0]',
  ':FORWARD DROP [0:0]',
  ':OUTPUT DROP [0:0]',
  '-A INPUT -i lo -j ACCEPT',
  '-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
  '-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
];

const SCAN_LOOPBACK = [
  '-A OUTPUT -o lo -m owner --uid-owner 10001 -p tcp --dport 18080 -j ACCEPT',
  '-A OUTPUT -o lo -m owner --uid-owner 10001 -j REJECT',
];

const PROXY_LOOPBACK = [
  '-A OUTPUT -o lo -m owner --uid-owner 10002 -j REJECT',
  '-A OUTPUT -o lo -j ACCEPT',
];

const V4 = [
  ...HEAD,
  ...SCAN_LOOPBACK,
  '-A OUTPUT -m owner --uid-owner 10002 -p udp -m conntrack --ctorigdst 127.0.0.11 --ctorigdstport 53 -j ACCEPT',
  '-A OUTPUT -m owner --uid-owner 10002 -p tcp -m conntrack --ctorigdst 127.0.0.11 --ctorigdstport 53 -j ACCEPT',
  ...PROXY_LOOPBACK,
  '-A OUTPUT -m owner --uid-owner 10002 -d 0.0.0.0/8 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 10.0.0.0/8 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 100.64.0.0/10 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 127.0.0.0/8 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 169.254.0.0/16 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 172.16.0.0/12 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 192.0.0.0/24 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 192.0.2.0/24 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 192.88.99.0/24 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 192.168.0.0/16 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 198.18.0.0/15 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 198.51.100.0/24 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 203.0.113.0/24 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 224.0.0.0/4 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 240.0.0.0/4 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 10.1.2.3 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -p tcp --dport 80 -j ACCEPT',
  '-A OUTPUT -m owner --uid-owner 10002 -p tcp --dport 443 -j ACCEPT',
  '-A OUTPUT -m owner --uid-owner 0 -d 10.1.2.3 -p tcp --dport 8080 -j ACCEPT',
  '-A OUTPUT -m owner --uid-owner 0 -d 127.0.0.11 -p udp --dport 53 -j ACCEPT',
  '-A OUTPUT -m owner --uid-owner 0 -d 127.0.0.11 -p tcp --dport 53 -j ACCEPT',
  'COMMIT',
  '',
].join('\n');

const ND = [
  '-A INPUT -p icmpv6 --icmpv6-type 133 -m hl --hl-eq 255 -j ACCEPT',
  '-A INPUT -p icmpv6 --icmpv6-type 134 -m hl --hl-eq 255 -j ACCEPT',
  '-A INPUT -p icmpv6 --icmpv6-type 135 -m hl --hl-eq 255 -j ACCEPT',
  '-A INPUT -p icmpv6 --icmpv6-type 136 -m hl --hl-eq 255 -j ACCEPT',
  '-A OUTPUT -p icmpv6 --icmpv6-type 133 -m hl --hl-eq 255 -j ACCEPT',
  '-A OUTPUT -p icmpv6 --icmpv6-type 134 -m hl --hl-eq 255 -j ACCEPT',
  '-A OUTPUT -p icmpv6 --icmpv6-type 135 -m hl --hl-eq 255 -j ACCEPT',
  '-A OUTPUT -p icmpv6 --icmpv6-type 136 -m hl --hl-eq 255 -j ACCEPT',
];

const V6 = [
  ...HEAD,
  ...ND,
  ...SCAN_LOOPBACK,
  '-A OUTPUT -m owner --uid-owner 10002 -p udp -m conntrack --ctorigdst fdaa::3 --ctorigdstport 53 -j ACCEPT',
  '-A OUTPUT -m owner --uid-owner 10002 -p tcp -m conntrack --ctorigdst fdaa::3 --ctorigdstport 53 -j ACCEPT',
  ...PROXY_LOOPBACK,
  '-A OUTPUT -m owner --uid-owner 10002 -d ::/128 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d ::1/128 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d fe80::/10 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d fc00::/7 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d ff00::/8 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 2001::/23 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 2001:db8::/32 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 2002::/16 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 3fff::/20 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 64:ff9b::/96 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 64:ff9b:1::/48 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d ::/3 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 4000::/2 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d 8000::/1 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -d fdaa:0:1::2 -j DROP',
  '-A OUTPUT -m owner --uid-owner 10002 -p tcp --dport 80 -j ACCEPT',
  '-A OUTPUT -m owner --uid-owner 10002 -p tcp --dport 443 -j ACCEPT',
  '-A OUTPUT -m owner --uid-owner 0 -d fdaa:0:1::2 -p tcp --dport 8080 -j ACCEPT',
  '-A OUTPUT -m owner --uid-owner 0 -d fdaa::3 -p udp --dport 53 -j ACCEPT',
  '-A OUTPUT -m owner --uid-owner 0 -d fdaa::3 -p tcp --dport 53 -j ACCEPT',
  'COMMIT',
  '',
].join('\n');

const lines = (text: string) => text.split('\n');
const indexOf = (text: string, pattern: RegExp) => lines(text).findIndex((l) => pattern.test(l));
const lastIndexOf = (text: string, pattern: RegExp) =>
  lines(text).findLastIndex((l) => pattern.test(l));

describe('firewallRules', () => {
  it('writes the exact iptables-restore and ip6tables-restore files', () => {
    expect(EGRESS_UID).toBe(10002);
    const rules = firewallRules(INPUT);
    expect(rules.v4).toBe(V4);
    expect(rules.v6).toBe(V6);
  });

  it('gives each family only its own addresses, and a family with none gets no rule for them', () => {
    const rules = firewallRules({
      ...INPUT,
      controlAddresses: ['fdaa:0:1::2'],
      resolvers: ['192.0.2.53'],
    });
    expect(rules.v4).toContain('--ctorigdst 192.0.2.53 --ctorigdstport 53');
    expect(rules.v4).toContain('-d 192.0.2.53 -p udp --dport 53');
    expect(rules.v4).not.toContain('fdaa');
    expect(rules.v4).not.toMatch(/--uid-owner 0 -d \S+ -p tcp --dport 8080/);
    expect(rules.v6).toContain(
      '-A OUTPUT -m owner --uid-owner 0 -d fdaa:0:1::2 -p tcp --dport 8080 -j ACCEPT',
    );
    expect(rules.v6).not.toContain('192.0.2.53');
    expect(rules.v6).not.toMatch(/dport 53|ctorigdstport 53/);
  });

  it('accepts on-link neighbor discovery in IPv6 only, before any uid rule (R33)', () => {
    const rules = firewallRules(INPUT);
    const v6 = lines(rules.v6);
    expect(v6.filter((l) => l.includes('icmpv6'))).toEqual(ND);
    expect(
      v6.filter((l) => l.includes('icmpv6')).every((l) => l.includes(' -m hl --hl-eq 255 ')),
    ).toBe(true);
    // Right after the ESTABLISHED,RELATED rules, before the first uid rule.
    const established = lastIndexOf(rules.v6, /ESTABLISHED,RELATED/);
    expect(v6.slice(established + 1, established + 1 + ND.length)).toEqual(ND);
    expect(indexOf(rules.v6, /--uid-owner/)).toBeGreaterThan(established + ND.length);
    expect(rules.v4).not.toMatch(/icmp|--hl-eq/);
  });

  it('drops every blocked range once per family, then the control addresses, for the proxy user only', () => {
    const rules = firewallRules(INPUT);
    for (const [text, blocked, control] of [
      [rules.v4, BLOCKED_V4, '10.1.2.3'],
      [rules.v6, BLOCKED_V6, 'fdaa:0:1::2'],
    ] as const) {
      const drops = lines(text).filter((l) => l.endsWith(' -j DROP'));
      expect(drops).toEqual(
        [...blocked, control].map((r) => `-A OUTPUT -m owner --uid-owner 10002 -d ${r} -j DROP`),
      );
    }
  });

  it('drops the proxy user to a control address that is public, before 80 and 443', () => {
    const text = firewallRules({ ...INPUT, controlAddresses: ['93.184.215.14'] }).v4;
    const drop = indexOf(
      text,
      /^-A OUTPUT -m owner --uid-owner 10002 -d 93\.184\.215\.14 -j DROP$/,
    );
    const web = indexOf(text, /--uid-owner 10002 -p tcp --dport 80 -j ACCEPT$/);
    expect(drop).toBeGreaterThan(0);
    expect(web).toBe(drop + 1);
  });

  it('keeps the order: policies, scan loopback, proxy DNS, proxy loopback, drops, 80 and 443, root', () => {
    for (const text of Object.values(firewallRules(INPUT))) {
      expect(lines(text).slice(0, 4)).toEqual(HEAD.slice(0, 4));
      // The scan user's two loopback rules first.
      const proxyPort = indexOf(text, /--uid-owner 10001 -p tcp --dport 18080 -j ACCEPT$/);
      const scanReject = indexOf(text, /-o lo -m owner --uid-owner 10001 -j REJECT$/);
      expect(proxyPort).toBeGreaterThan(0);
      expect(scanReject).toBe(proxyPort + 1);
      // The proxy's DNS (matched before NAT, so a loopback resolver such as Docker's
      // 127.0.0.11 counts) before its loopback REJECT, which comes before the loopback
      // accept for everyone else; and before the block drops (Fly's resolver is in
      // fc00::/7). Then the drops, then 80 and 443.
      const firstDns = indexOf(text, /--uid-owner 10002 .*--ctorigdstport 53 -j ACCEPT$/);
      const dns = lastIndexOf(text, /--uid-owner 10002 .*--ctorigdstport 53 -j ACCEPT$/);
      const proxyReject = indexOf(text, /^-A OUTPUT -o lo -m owner --uid-owner 10002 -j REJECT$/);
      const loopback = indexOf(text, /^-A OUTPUT -o lo -j ACCEPT$/);
      const firstDrop = indexOf(text, /--uid-owner 10002 -d \S+ -j DROP$/);
      const lastDrop = lastIndexOf(text, /--uid-owner 10002 -d \S+ -j DROP$/);
      const web = indexOf(text, /--uid-owner 10002 -p tcp --dport 80 -j ACCEPT$/);
      expect(firstDns).toBe(scanReject + 1);
      expect(proxyReject).toBe(dns + 1);
      expect(loopback).toBe(proxyReject + 1);
      expect(firstDrop).toBe(loopback + 1);
      expect(web).toBe(lastDrop + 1);
      expect(lines(text)[web + 1]).toBe(
        '-A OUTPUT -m owner --uid-owner 10002 -p tcp --dport 443 -j ACCEPT',
      );
      // Root last; the scan user has no rule off loopback.
      expect(indexOf(text, /--uid-owner 0 /)).toBe(web + 2);
      expect(lines(text).filter((l) => l.includes('--uid-owner 10001'))).toHaveLength(2);
      expect(
        lines(text).filter((l) => l.includes('--uid-owner 10001') && !l.includes('-o lo')),
      ).toEqual([]);
      expect(lines(text).slice(-2)).toEqual(['COMMIT', '']);
    }
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
      [{ controlAddresses: ['10.0.0.1 -j ACCEPT'] }, /not an IP address/],
      [{ controlAddresses: ['10.0.0.0/8'] }, /not an IP address/],
      [{ resolvers: ['fe80::1%eth0'] }, /not an IP address/],
      [{ resolvers: ['127.0.0.11\n-A OUTPUT -j ACCEPT'] }, /not an IP address/],
      [{ resolvers: [''] }, /not an IP address/],
    ];
    for (const [change, message] of bad)
      expect(() => firewallRules({ ...INPUT, ...change }), JSON.stringify(change)).toThrow(message);
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

  it('resolves the control host once and writes both files, root only', async () => {
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
    expect(readFileSync(join(out, RULES_V4), 'utf8')).toBe(V4);
    expect(readFileSync(join(out, RULES_V6), 'utf8')).toBe(V6);
    if (process.platform !== 'win32')
      for (const name of [RULES_V4, RULES_V6])
        expect(statSync(join(out, name)).mode & 0o777).toBe(0o600);
  });

  it('takes an address as it is, and the scheme default port', async () => {
    const { code, dir: out } = await run('https://[fdaa:0:1::2]/', undefined, async () => {
      throw new Error('no lookup for an address');
    });
    expect(code).toBe(0);
    expect(readFileSync(join(out, RULES_V6), 'utf8')).toContain(
      '-A OUTPUT -m owner --uid-owner 0 -d fdaa:0:1::2 -p tcp --dport 443 -j ACCEPT',
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
      expect(() => statSync(join(out, RULES_V4))).toThrow();
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('never overwrites a rules file already in the folder', async () => {
    dir = mkdtempSync(join(tmpdir(), 'widedoor-firewall-'));
    writeFileSync(join(dir, 'resolv.conf'), 'nameserver 127.0.0.11\n');
    writeFileSync(join(dir, RULES_V4), '*filter\nCOMMIT\n');
    const log: string[] = [];
    const code = await main({
      env: { WIDEDOOR_CONTROL_URL: 'http://10.1.2.3:8080/' },
      dir,
      resolvConf: join(dir, 'resolv.conf'),
      log: (line) => log.push(line),
    });
    expect(code).toBe(1);
    expect(log).toEqual(['widedoor event=firewall_config_error name=write']);
    expect(readFileSync(join(dir, RULES_V4), 'utf8')).toBe('*filter\nCOMMIT\n');
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
  it('names the same proxy port and proxy uid as the TypeScript', () => {
    const entry = readFileSync(
      fileURLToPath(new URL('../../../docker/scan-entry.sh', import.meta.url)),
      'utf8',
    );
    expect(entry).toMatch(new RegExp(`^PROXY_PORT=${EGRESS_PORT}$`, 'm'));
    expect(entry).toMatch(new RegExp(`^EGRESS_UID=${EGRESS_UID}$`, 'm'));
    // Each is set once, so no later line overrides it.
    expect(entry.match(/^PROXY_PORT=/gm)).toHaveLength(1);
    expect(entry.match(/^EGRESS_UID=/gm)).toHaveLength(1);
  });
});
