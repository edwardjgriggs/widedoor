import { isIP } from 'node:net';
import { BLOCKED_V4, BLOCKED_V6 } from '@widedoor/web/egress';

/*
 * The scan machine's kernel firewall (ledger R13, R29, R33). The scan entry loads these rules
 * with iptables-restore and ip6tables-restore, whole and at once, before anything else
 * starts: every chain drops by default; the scan user (uid 10001) reaches only the egress
 * proxy's port on loopback; the egress proxy's user (uid 10002) reaches DNS at the
 * resolvers and ports 80 and 443 on public addresses other than the control address,
 * and nothing else on loopback; root reaches the control address and DNS, and loopback.
 * The scan user has no rule off loopback, so its only way out is the proxy.
 */

/** The unprivileged user and group the scan runs as in the scan machine. */
export const SCAN_UID = 10001;
/** The egress proxy's user and group in the scan machine. */
export const EGRESS_UID = 10002;

export interface FirewallInput {
  /** The control API's addresses, already resolved; IPv4 and IPv6 may mix. */
  controlAddresses: readonly string[];
  controlPort: number;
  /** The nameserver addresses of /etc/resolv.conf; IPv4 and IPv6 may mix. */
  resolvers: readonly string[];
  /** The egress proxy's loopback port. */
  proxyPort: number;
}

export interface FirewallRules {
  /** iptables-restore input for the filter table. */
  v4: string;
  /** ip6tables-restore input for the filter table. */
  v6: string;
}

/** ICMPv6 router solicitation and advertisement, neighbor solicitation and advertisement. */
const ND_TYPES = [133, 134, 135, 136];
export const NEIGHBOR_DISCOVERY: readonly string[] = ['INPUT', 'OUTPUT'].flatMap((chain) =>
  ND_TYPES.map((type) => `-A ${chain} -p icmpv6 --icmpv6-type ${type} -m hl --hl-eq 255 -j ACCEPT`),
);

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

/** One family's rules, in the order the kernel checks them. */
function familyRules(
  family: 4 | 6,
  control: readonly string[],
  controlPort: number,
  resolvers: readonly string[],
  proxyPort: number,
): string {
  const mine = (addresses: readonly string[]) => addresses.filter((a) => isIP(a) === family);
  const blocked = family === 4 ? BLOCKED_V4 : BLOCKED_V6;
  const scan = `-m owner --uid-owner ${SCAN_UID}`;
  const egress = `-m owner --uid-owner ${EGRESS_UID}`;
  const root = '-m owner --uid-owner 0';
  const dns = (owner: string) =>
    mine(resolvers).flatMap((address) => [
      `-A OUTPUT ${owner} -d ${address} -p udp --dport 53 -j ACCEPT`,
      `-A OUTPUT ${owner} -d ${address} -p tcp --dport 53 -j ACCEPT`,
    ]);
  // Matched on the address and port the packet was sent to, before any NAT: Docker's
  // resolver on 127.0.0.11 is rewritten to another loopback port before this table.
  const sentToDns = (owner: string) =>
    mine(resolvers).flatMap((address) =>
      ['udp', 'tcp'].map(
        (protocol) =>
          `-A OUTPUT ${owner} -p ${protocol} -m conntrack --ctorigdst ${address} --ctorigdstport 53 -j ACCEPT`,
      ),
    );
  return [
    '*filter',
    ':INPUT DROP [0:0]',
    ':FORWARD DROP [0:0]',
    ':OUTPUT DROP [0:0]',
    '-A INPUT -i lo -j ACCEPT',
    '-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    '-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    // IPv6 only (ledger R33): neighbor and router discovery, on-link only (hop limit 255).
    // The kernel sends these with no socket owner and conntrack never marks them
    // established; without them no IPv6 next hop resolves (Fly's private network).
    ...(family === 6 ? NEIGHBOR_DISCOVERY : []),
    // Loopback: the scan user reaches the proxy and nothing else (not Docker's DNS on
    // 127.0.0.11, not any other local listener).
    `-A OUTPUT -o lo ${scan} -p tcp --dport ${proxyPort} -j ACCEPT`,
    `-A OUTPUT -o lo ${scan} -j REJECT`,
    // The proxy: DNS at the resolvers first (they may sit on loopback, or in a blocked
    // range as Fly's fdaa::3 does), then nothing else on loopback; root is free there.
    ...sentToDns(egress),
    `-A OUTPUT -o lo ${egress} -j REJECT`,
    '-A OUTPUT -o lo -j ACCEPT',
    // Then nothing in a blocked range and nothing at the control API (even at a public
    // address), then the web.
    ...blocked.map((range) => `-A OUTPUT ${egress} -d ${range} -j DROP`),
    ...mine(control).map((address) => `-A OUTPUT ${egress} -d ${address} -j DROP`),
    `-A OUTPUT ${egress} -p tcp --dport 80 -j ACCEPT`,
    `-A OUTPUT ${egress} -p tcp --dport 443 -j ACCEPT`,
    // Root (the agent): the control API and DNS only.
    ...mine(control).map(
      (address) => `-A OUTPUT ${root} -d ${address} -p tcp --dport ${controlPort} -j ACCEPT`,
    ),
    ...dns(root),
    'COMMIT',
    '',
  ].join('\n');
}

/**
 * The scan machine's iptables-restore and ip6tables-restore inputs for the filter table.
 * Each family gets only its own addresses. Throws on an empty control or resolver list,
 * a port outside 1..65535, or anything isIP does not take as an address, so no rule is
 * ever built from an unchecked string.
 */
export function firewallRules(input: FirewallInput): FirewallRules {
  const control = checkAddresses('controlAddresses', input.controlAddresses);
  const resolvers = checkAddresses('resolvers', input.resolvers);
  const controlPort = checkPort('controlPort', input.controlPort);
  const proxyPort = checkPort('proxyPort', input.proxyPort);
  return {
    v4: familyRules(4, control, controlPort, resolvers, proxyPort),
    v6: familyRules(6, control, controlPort, resolvers, proxyPort),
  };
}
