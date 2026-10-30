import { isIP } from 'node:net';
import { BLOCKED_V4, BLOCKED_V6 } from '@widedoor/web/egress';

/*
 * The scan machine's kernel firewall (ledger R13, R29, R33), as one native nftables ruleset.
 * The scan entry loads it with `nft -f`, in one transaction, before anything else starts:
 * every chain drops by default; the scan user (uid 10001) reaches only the egress proxy's
 * port on loopback; the egress proxy's user (uid 10002) reaches DNS at the resolvers and
 * ports 80 and 443 on public addresses other than the control address, and nothing else on
 * loopback; root reaches the control address and DNS, and loopback. The scan user has no
 * rule off loopback, so its only way out is the proxy.
 *
 * Native nft expressions only (`meta skuid`, `ct original`): Fly's kernel has no xt owner
 * match, so iptables' `-m owner` cannot load there (seen 2026-10-29). One inet table holds
 * both families. Each rule that names an address names its family (`ip`, `ip6`), so an IPv4
 * packet meets exactly the IPv4 rules, in the order iptables-restore had them, and the same
 * for IPv6.
 *
 * The file replaces only its own table: it creates it (so the delete never fails), deletes
 * it and builds it again, all in the one transaction. Every other table stays, so NAT that
 * the machine needs (Docker's resolver on 127.0.0.11 is a DNAT rule) keeps working; no other
 * table can undo a drop here, since a packet must pass every base chain on its hook.
 */

/** The unprivileged user and group the scan runs as in the scan machine. */
export const SCAN_UID = 10001;
/** The egress proxy's user and group in the scan machine. */
export const EGRESS_UID = 10002;
/** The nftables table the ruleset owns (family inet). */
export const TABLE = 'widedoor';

export interface FirewallInput {
  /** The control API's addresses, already resolved; IPv4 and IPv6 may mix. */
  controlAddresses: readonly string[];
  controlPort: number;
  /** The nameserver addresses of /etc/resolv.conf; IPv4 and IPv6 may mix. */
  resolvers: readonly string[];
  /** The egress proxy's loopback port. */
  proxyPort: number;
}

/**
 * IPv6 only (ledger R33): router solicitation and advertisement, neighbor solicitation and
 * advertisement (ICMPv6 types 133 to 136), on-link only (hop limit 255).
 */
export const NEIGHBOR_DISCOVERY =
  'ip6 hoplimit 255 icmpv6 type { nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept';

/** Answers like iptables' REJECT: port unreachable, as ICMP or ICMPv6 by the family. */
const REJECT = 'reject with icmpx type port-unreachable';

const checkPort = (name: string, port: number): number => {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`firewall: ${name} must be a port from 1 to 65535`);
  return port;
};

/**
 * The addresses, each checked by isIP and made only of hex digits, colons and dots (isIP
 * also takes a zone such as `fe80::1%eth0`); throws on an empty list or any other entry.
 */
const checkAddresses = (name: string, addresses: readonly string[]): string[] => {
  if (addresses.length === 0) throw new Error(`firewall: ${name} is empty`);
  for (const address of addresses)
    if (typeof address !== 'string' || isIP(address) === 0 || !/^[0-9A-Fa-f:.]+$/.test(address))
      throw new Error(`firewall: ${name} holds something that is not an IP address`);
  return [...addresses];
};

/** The nft address keyword of an address or range: `ip` or `ip6`. */
const family = (address: string): 'ip' | 'ip6' =>
  isIP(address.replace(/\/\d+$/, '')) === 6 ? 'ip6' : 'ip';

/** The addresses, IPv4 first, each family in the given order. */
const byFamily = (addresses: readonly string[]): string[] => [
  ...addresses.filter((a) => isIP(a) === 4),
  ...addresses.filter((a) => isIP(a) === 6),
];

const chain = (name: string, rules: readonly string[]): string[] => [
  `\tchain ${name} {`,
  `\t\ttype filter hook ${name} priority filter; policy drop;`,
  ...rules.map((rule) => `\t\t${rule}`),
  '\t}',
];

/**
 * The scan machine's nftables ruleset, for `nft -f`. Throws on an empty control or resolver
 * list, a port outside 1..65535, or anything isIP does not take as an address, so no rule is
 * ever built from an unchecked string.
 */
export function firewallRules(input: FirewallInput): string {
  const control = byFamily(checkAddresses('controlAddresses', input.controlAddresses));
  const resolvers = byFamily(checkAddresses('resolvers', input.resolvers));
  const controlPort = checkPort('controlPort', input.controlPort);
  const proxyPort = checkPort('proxyPort', input.proxyPort);
  const scan = `meta skuid ${SCAN_UID}`;
  const egress = `meta skuid ${EGRESS_UID}`;
  const root = 'meta skuid 0';
  const dns = (owner: string) =>
    resolvers.flatMap((address) =>
      ['udp', 'tcp'].map(
        (protocol) => `${owner} ${family(address)} daddr ${address} ${protocol} dport 53 accept`,
      ),
    );
  // Matched on the address and port the packet was sent to, before any NAT: Docker's
  // resolver on 127.0.0.11 is rewritten to another loopback port before this chain.
  const sentToDns = (owner: string) =>
    resolvers.flatMap((address) =>
      ['udp', 'tcp'].map(
        (protocol) =>
          `${owner} meta l4proto ${protocol} ct original ${family(address)} daddr ${address} ct original proto-dst 53 accept`,
      ),
    );
  return [
    `table inet ${TABLE}`,
    `delete table inet ${TABLE}`,
    `table inet ${TABLE} {`,
    ...chain('input', [
      'iifname "lo" accept',
      'ct state established,related accept',
      // IPv6 only (R33). The kernel sends these with no socket owner and conntrack never
      // marks them established; without them no IPv6 next hop resolves (Fly's private
      // network).
      NEIGHBOR_DISCOVERY,
    ]),
    ...chain('forward', []),
    ...chain('output', [
      'ct state established,related accept',
      NEIGHBOR_DISCOVERY,
      // Loopback: the scan user reaches the proxy and nothing else (not Docker's DNS on
      // 127.0.0.11, not any other local listener).
      `oifname "lo" ${scan} tcp dport ${proxyPort} accept`,
      `oifname "lo" ${scan} ${REJECT}`,
      // The proxy: DNS at the resolvers first (they may sit on loopback, or in a blocked
      // range as Fly's fdaa::3 does), then nothing else on loopback; root is free there.
      ...sentToDns(egress),
      `oifname "lo" ${egress} ${REJECT}`,
      'oifname "lo" accept',
      // Then nothing in a blocked range and nothing at the control API (even at a public
      // address), then the web.
      ...[...BLOCKED_V4, ...BLOCKED_V6, ...control].map(
        (range) => `${egress} ${family(range)} daddr ${range} drop`,
      ),
      `${egress} tcp dport 80 accept`,
      `${egress} tcp dport 443 accept`,
      // Root (the agent): the control API and DNS only.
      ...control.map(
        (address) => `${root} ${family(address)} daddr ${address} tcp dport ${controlPort} accept`,
      ),
      ...dns(root),
    ]),
    '}',
    '',
  ].join('\n');
}
