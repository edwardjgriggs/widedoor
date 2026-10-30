import { isIP } from 'node:net';
import { EgressRefusedError, type EgressBlockReason } from '../fetch.js';

/*
 * Address and host policy for the hosted scanner. Every egress component (pinned
 * resolver, egress proxy, Chromium route guard, Node fetch hop check) calls this
 * to decide whether a connection may leave the scanner. It fails closed: an address
 * that is not provably public is blocked, and IPv6 is allow-listed to 2000::/3.
 * Refusal messages name the host and the reason, never the path or query.
 */

export type BlockReason =
  | 'private'
  | 'loopback'
  | 'link-local'
  | 'cgnat'
  | 'multicast'
  | 'metadata'
  | 'reserved'
  | 'unspecified';

export type AddressVerdict = { ok: true } | { ok: false; reason: BlockReason };

type Range = readonly [cidr: string, reason: BlockReason];

const V4_RANGES: readonly Range[] = [
  ['0.0.0.0/8', 'unspecified'],
  ['10.0.0.0/8', 'private'],
  ['100.64.0.0/10', 'cgnat'],
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link-local'],
  ['172.16.0.0/12', 'private'],
  ['192.0.0.0/24', 'reserved'],
  ['192.0.2.0/24', 'reserved'],
  ['192.88.99.0/24', 'reserved'],
  ['192.168.0.0/16', 'private'],
  ['198.18.0.0/15', 'reserved'],
  ['198.51.100.0/24', 'reserved'],
  ['203.0.113.0/24', 'reserved'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'reserved'],
];

/*
 * IPv6 is allow-listed to 2000::/3, so the first three entries are its complement.
 * More specific entries come first: the first match wins.
 */
const V6_RANGES: readonly Range[] = [
  ['::/128', 'unspecified'],
  ['::1/128', 'loopback'],
  ['fe80::/10', 'link-local'],
  ['fc00::/7', 'private'],
  ['ff00::/8', 'multicast'],
  ['2001::/23', 'reserved'],
  ['2001:db8::/32', 'reserved'],
  ['2002::/16', 'reserved'],
  ['3fff::/20', 'reserved'],
  ['64:ff9b::/96', 'reserved'],
  ['64:ff9b:1::/48', 'reserved'],
  ['::/3', 'reserved'],
  ['4000::/2', 'reserved'],
  ['8000::/1', 'reserved'],
];

/** Cloud metadata endpoints, matched exactly before the range tables. */
const METADATA_V4 = new Set(['169.254.169.254', '100.100.100.200']);
const METADATA_V6 = new Set(['fd00:ec2::254']);

export const BLOCKED_V4: readonly string[] = V4_RANGES.map(([cidr]) => cidr);
export const BLOCKED_V6: readonly string[] = V6_RANGES.map(([cidr]) => cidr);

function parseV4(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

/** Expands any valid IPv6 text (including a dotted IPv4 tail) to a 128-bit integer. */
function parseV6(ip: string): bigint {
  let text = ip.toLowerCase();
  const tail = text.lastIndexOf(':');
  if (text.slice(tail + 1).includes('.')) {
    const v4 = parseV4(text.slice(tail + 1));
    text = `${text.slice(0, tail + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const fill = rest === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].reduce(
    (acc, group) => (acc << 16n) | BigInt(parseInt(group, 16)),
    0n,
  );
}

function v6InRange(value: bigint, cidr: string): boolean {
  const [base = '', len = '0'] = cidr.split('/');
  const shift = 128n - BigInt(len);
  return value >> shift === parseV6(base) >> shift;
}

function v4InRange(value: number, cidr: string): boolean {
  const [base = '', len = '0'] = cidr.split('/');
  const size = 2 ** (32 - Number(len));
  return Math.floor(value / size) === Math.floor(parseV4(base) / size);
}

function classifyV4(ip: string): AddressVerdict {
  if (METADATA_V4.has(ip)) return { ok: false, reason: 'metadata' };
  const value = parseV4(ip);
  for (const [cidr, reason] of V4_RANGES) if (v4InRange(value, cidr)) return { ok: false, reason };
  return { ok: true };
}

/** Classifies a literal IP address. Throws TypeError when `ip` is not an IP address. */
export function classifyAddress(ip: string): AddressVerdict {
  const family = isIP(ip);
  if (family === 0 || ip.includes('%')) throw new TypeError('not an IP address');
  if (family === 4) return classifyV4(ip);
  const value = parseV6(ip);
  // ::ffff:0:0/96 is an IPv4 address in IPv6 clothing: judge the embedded IPv4 address.
  if (value >> 32n === 0xffffn) {
    const v4 = Number(value & 0xffffffffn);
    return classifyV4([24, 16, 8, 0].map((shift) => Math.floor(v4 / 2 ** shift) % 256).join('.'));
  }
  if ([...METADATA_V6].some((metadata) => parseV6(metadata) === value))
    return { ok: false, reason: 'metadata' };
  for (const [cidr, reason] of V6_RANGES) if (v6InRange(value, cidr)) return { ok: false, reason };
  return { ok: true };
}

const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.flycast',
  '.home.arpa',
  '.onion',
  '.test',
  '.invalid',
  '.example',
];

/**
 * Throws EgressRefusedError unless `name` is a plausible public host name. Takes a host as
 * `URL.hostname` gives it; IP literals are not judged here (see classifyAddress).
 */
export function checkHostName(name: string): void {
  const bare = name.replace(/^\[|\]$/g, '').toLowerCase();
  const host = bare.replace(/\.$/, '');
  const refuse = (why: string): never => {
    throw new EgressRefusedError(`refusing ${bare}: ${why}`, 'policy', 'host-name');
  };
  if (host === '') refuse('empty host');
  // Only one trailing dot is stripped above, so `localhost..` or `a..com` lands here.
  if (host.split('.').some((label) => label === '')) refuse('empty label in host name');
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix)))
    refuse('reserved host name');
  if (!host.includes('.')) refuse('single-label host');
}

/** Throws EgressRefusedError unless the URL is a public http(s) target on port 80 or 443. */
export function checkTarget(url: URL): void {
  const bare = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const host = bare.replace(/\.$/, '');
  const refuse = (why: string, blockReason: EgressBlockReason): never => {
    throw new EgressRefusedError(
      `refusing ${bare}: ${why}`,
      blockReason === 'scheme' ? 'scheme' : 'policy',
      blockReason,
    );
  };

  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    refuse(`scheme ${url.protocol}`, 'scheme');
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  if (port !== '80' && port !== '443') refuse(`port ${port} is not allowed`, 'port');
  if (url.username !== '' || url.password !== '') refuse('credentials in the URL', 'credentials');

  if (isIP(host) !== 0) {
    const verdict = classifyAddress(host);
    if (!verdict.ok) refuse(`address is ${verdict.reason}`, verdict.reason);
    return;
  }
  checkHostName(bare);
}
