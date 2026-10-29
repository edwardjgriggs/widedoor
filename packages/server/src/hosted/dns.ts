import { Resolver } from 'node:dns/promises';
import type { ResolverOptions } from 'node:dns';
import type { LookupFn } from '@widedoor/web/egress';

/*
 * The hosted API's DNS lookup for its preflight. The egress resolver's default
 * lookup is getaddrinfo, which runs on libuv's thread pool (4 threads): a few
 * slow names would stall every file and crypto call of the API. This lookup
 * asks c-ares (node:dns Resolver) instead, which does its own network I/O on
 * the event loop, for A and AAAA in parallel. A name with neither answer gives
 * an empty list, which the resolver refuses as not resolving; any other DNS
 * failure is thrown, which it refuses the same way. Domain verification's TXT
 * lookup (Task 11) goes through c-ares the same way, with the same settings.
 */

/** c-ares settings: each query waits this long per try. */
export const DNS_RESOLVER_OPTIONS = { timeout: 2000, tries: 2 } as const;

/** The two Resolver methods the lookup uses (tests give a fake). */
export type AddressResolver = Pick<Resolver, 'resolve4' | 'resolve6'>;
/** The Resolver method the TXT lookup uses (tests give a fake). */
export type TxtResolver = Pick<Resolver, 'resolveTxt'>;
/** A name's TXT records, each as its chunks; empty when it has none. Throws when DNS failed. */
export type TxtLookup = (name: string) => Promise<string[][]>;

/** A query with no records of its type, or a name that does not exist: an empty answer. */
const NO_ANSWER = new Set(['ENODATA', 'ENOTFOUND']);

const answers = async <T>(query: Promise<T[]>): Promise<T[]> => {
  try {
    return await query;
  } catch (error) {
    if (NO_ANSWER.has((error as NodeJS.ErrnoException | undefined)?.code ?? '')) return [];
    throw error;
  }
};

/**
 * A LookupFn over one c-ares Resolver, made with DNS_RESOLVER_OPTIONS by createResolver
 * (tests give a fake): the A answers, then the AAAA answers.
 */
export function caresLookup(
  createResolver: (options: ResolverOptions) => AddressResolver = (options) =>
    new Resolver(options),
): LookupFn {
  const resolver = createResolver({ ...DNS_RESOLVER_OPTIONS });
  return async (host) => {
    const [v4, v6] = await Promise.all([
      answers(resolver.resolve4(host)),
      answers(resolver.resolve6(host)),
    ]);
    return [
      ...v4.map((address) => ({ address, family: 4 as const })),
      ...v6.map((address) => ({ address, family: 6 as const })),
    ];
  };
}

/**
 * A TxtLookup over one c-ares Resolver, made with DNS_RESOLVER_OPTIONS by createResolver
 * (tests give a fake). No records, or no such name, is an empty answer.
 */
export function caresTxtLookup(
  createResolver: (options: ResolverOptions) => TxtResolver = (options) => new Resolver(options),
): TxtLookup {
  const resolver = createResolver({ ...DNS_RESOLVER_OPTIONS });
  return (name) => answers(resolver.resolveTxt(name));
}
