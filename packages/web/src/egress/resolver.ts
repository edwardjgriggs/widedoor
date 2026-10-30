import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { EgressRefusedError, type EgressBlockReason } from '../fetch.js';
import { checkHostName, classifyAddress } from './policy.js';

/*
 * Resolves each host name once per instance and pins the answer. The pinned address
 * is what gets checked against the egress policy and then reused for the rest of the
 * scan, so a second DNS answer can never swap in an internal address (DNS rebinding).
 * A refusal is pinned too. Anything unexpected is a refusal of the whole host. IP
 * literals are checked on every call and never pinned, so only names fill the map,
 * and maxHosts caps those.
 */

export type LookupFn = (host: string) => Promise<{ address: string; family: 4 | 6 }[]>;

export interface PinnedResolverOptions {
  lookup?: LookupFn;
  /** Longest wait for one lookup. Default 5000. */
  timeoutMs?: number;
  /** Distinct host names one instance will look up; later new names are refused. Default 2000. */
  maxHosts?: number;
}

const defaultLookup: LookupFn = async (host) => {
  const answers = await dnsLookup(host, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

export class PinnedResolver {
  private readonly lookup: LookupFn;
  private readonly timeoutMs: number;
  private readonly maxHosts: number;
  private readonly pins = new Map<string, Promise<string>>();

  constructor(options: PinnedResolverOptions = {}) {
    this.lookup = options.lookup ?? defaultLookup;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxHosts = options.maxHosts ?? 2000;
    // NaN would compare false and switch the cap off.
    if (!Number.isInteger(this.maxHosts) || this.maxHosts < 1)
      throw new RangeError('maxHosts must be a positive integer');
  }

  /** Takes a host as `URL.hostname` gives it (IPv6 in brackets, one optional trailing dot). */
  resolve(host: string): Promise<string> {
    const bare = host
      .replace(/^\[|\]$/g, '')
      .toLowerCase()
      .replace(/\.$/, '');
    if (isIP(bare) !== 0) return this.pinHost(bare);
    let pin = this.pins.get(bare);
    if (pin === undefined) {
      // Not pinned: the refusal must not grow the map it caps.
      if (this.pins.size >= this.maxHosts)
        return Promise.reject(
          new EgressRefusedError('too many distinct hosts in one scan', 'policy', 'host-limit'),
        );
      pin = this.pinHost(bare);
      this.pins.set(bare, pin);
    }
    return pin;
  }

  private async pinHost(host: string): Promise<string> {
    const refuse = (why: string, blockReason: EgressBlockReason = 'unresolved'): never => {
      throw new EgressRefusedError(`refusing ${host}: ${why}`, 'policy', blockReason);
    };
    const check = (address: string): void => {
      let verdict;
      try {
        verdict = classifyAddress(address);
      } catch {
        return refuse('unusable address in the DNS answer');
      }
      if (!verdict.ok) refuse(`address is ${verdict.reason}`, verdict.reason);
    };

    if (isIP(host) !== 0) {
      try {
        check(host);
      } catch (error) {
        if (error instanceof EgressRefusedError) throw error;
        return refuse('unusable address');
      }
      return host;
    }

    // Reserved names never reach DNS: the answer text would let a page probe internal names.
    checkHostName(host);

    let answers: Awaited<ReturnType<LookupFn>>;
    let timer: NodeJS.Timeout | undefined;
    try {
      answers = await Promise.race([
        this.lookup(host),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), this.timeoutMs);
        }),
      ]);
    } catch {
      return refuse('did not resolve');
    } finally {
      clearTimeout(timer);
    }
    const first = answers[0];
    if (first === undefined) return refuse('did not resolve');
    for (const { address } of answers) check(address);
    return first.address;
  }
}
