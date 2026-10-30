import { isIP } from 'node:net';

/*
 * The hosted API's per-client rate limit (plan ruling 7, ledger R10): a sliding
 * one-hour window keyed by the client's network, IPv4 by /32 and IPv6 by /64,
 * so one host cannot dodge the limit by walking the addresses of its own /64.
 * A second, looser limiter keyed by IPv4 /24 and IPv6 /48 (wideKey) bounds a
 * client that holds a whole network; takeAll charges both or neither. An IPv4
 * address in IPv6 form (::ffff:a.b.c.d) is the same client as the plain IPv4
 * address. The number of keys held is capped; past it the key used least
 * recently is dropped.
 */

const HOUR_MS = 60 * 60_000;
/** Keys held at most; the least recently used goes first. */
export const MAX_RATE_KEYS = 100_000;

type Address = { family: 4; bytes: number[] } | { family: 6; groups: number[] };

/** The eight 16-bit groups of an IPv6 address, or undefined when it is not one (zone ids included). */
function v6Groups(ip: string): number[] | undefined {
  if (isIP(ip) !== 6 || ip.includes('%')) return undefined;
  let text = ip.toLowerCase();
  // A dotted IPv4 tail (::ffff:1.2.3.4) becomes its two hex groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  const [head = '', tail] = text.split('::');
  const front = parse(head);
  const back = tail === undefined ? [] : parse(tail);
  const groups = [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : undefined;
}

/** An IP address as IPv4 bytes or IPv6 groups, IPv4-mapped IPv6 as IPv4; undefined when not an IP. */
function parseAddress(ip: string): Address | undefined {
  if (isIP(ip) === 4) return { family: 4, bytes: ip.split('.').map(Number) };
  const groups = v6Groups(ip);
  if (groups === undefined) return undefined;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return { family: 4, bytes: [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff] };
  }
  return { family: 6, groups };
}

/** The network of ip: v4Bytes of an IPv4 address, v6Groups of an IPv6 one, as text. */
function network(ip: string, v4Bytes: number, v6Count: number): string | undefined {
  const address = parseAddress(ip);
  if (address === undefined) return undefined;
  if (address.family === 4)
    return [...address.bytes.slice(0, v4Bytes), ...Array<number>(4 - v4Bytes).fill(0)].join('.');
  return `${address.groups
    .slice(0, v6Count)
    .map((g) => g.toString(16))
    .join(':')}::`;
}

/** Whether ip is an IPv4 or IPv6 address (no zone id). */
export const isClientIp = (ip: string): boolean => parseAddress(ip) !== undefined;

/** The rate-limit key of an address: IPv4 /32 or IPv6 /64. Undefined when ip is not an IP. */
export const rateKey = (ip: string): string | undefined => network(ip, 4, 4);

/** How logs name a client: its IPv4 /24 or IPv6 /48 network address. Undefined when ip is not an IP. */
export const logPrefix = (ip: string): string | undefined => network(ip, 3, 3);

/** The looser rate-limit key of an address: IPv4 /24 or IPv6 /48. Undefined when ip is not an IP. */
export const wideKey = logPrefix;

export type RateVerdict = { ok: true } | { ok: false; retryAfterS: number };

export interface RateLimiterOptions {
  /** Requests one key may make in any hour. */
  perHour: number;
  /** An address's key. Default rateKey (IPv4 /32, IPv6 /64). */
  keyOf?: (ip: string) => string | undefined;
  /** Date.now outside tests. */
  now?: () => number;
}

export class RateLimiter {
  private readonly perHour: number;
  private readonly keyOf: (ip: string) => string | undefined;
  private readonly now: () => number;
  /** Times of the requests in the last hour, by key, least recently used first. */
  private readonly hits = new Map<string, number[]>();

  constructor(options: RateLimiterOptions) {
    if (!Number.isInteger(options.perHour) || options.perHour < 1)
      throw new RangeError('perHour must be a positive integer');
    this.perHour = options.perHour;
    this.keyOf = options.keyOf ?? rateKey;
    this.now = options.now ?? Date.now;
  }

  /** Whether one more request from ip would be taken now, without counting it. */
  check(ip: string): RateVerdict {
    const now = this.now();
    const recent = (this.hits.get(this.keyOf(ip) ?? ip) ?? []).filter((t) => t > now - HOUR_MS);
    if (recent.length < this.perHour) return { ok: true };
    const oldest = recent[0] ?? now;
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000)) };
  }

  /** Counts one request from ip, or says how long until it may come. A non-IP string is its own key. */
  take(ip: string): RateVerdict {
    const key = this.keyOf(ip) ?? ip;
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - HOUR_MS);
    // Moved to the end: the map's order is the order of last use.
    this.hits.delete(key);
    if (recent.length >= this.perHour) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    while (this.hits.size > MAX_RATE_KEYS) {
      const first = this.hits.keys().next();
      if (first.done) break;
      this.hits.delete(first.value);
    }
    return { ok: true };
  }

  /** Keys held (tests). */
  get size(): number {
    return this.hits.size;
  }
}

/**
 * Counts one request from ip in every limiter, or in none: when any would refuse it,
 * nothing is counted and the longest wait is given.
 */
export function takeAll(limiters: readonly RateLimiter[], ip: string): RateVerdict {
  let wait = 0;
  for (const limiter of limiters) {
    const verdict = limiter.check(ip);
    if (!verdict.ok) wait = Math.max(wait, verdict.retryAfterS);
  }
  if (wait > 0) return { ok: false, retryAfterS: wait };
  for (const limiter of limiters) limiter.take(ip);
  return { ok: true };
}
