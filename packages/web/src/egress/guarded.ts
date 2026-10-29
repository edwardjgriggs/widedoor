import { createRequire } from 'node:module';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { EgressRefusedError, createFetcher, type Fetcher, type HopCheck } from '../fetch.js';
import type { RequestGuard } from '../context.js';
import { checkTarget } from './policy.js';
import type { PinnedResolver } from './resolver.js';

/*
 * The hosted scanner's side of the egress policy. The proxy (proxy.ts) is the enforcement
 * point; these helpers refuse early, so a bad hop or request never reaches it, and route
 * Node fetches through it. Everything fails closed: any throw is a refusal.
 */

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

/** `Mozilla/5.0 (compatible; Widedoor/<version>; +<contactUrl>)` */
export function hostedUserAgent(contactUrl: string): string {
  return `Mozilla/5.0 (compatible; Widedoor/${version}; +${contactUrl})`;
}

/** Per-hop check for the fetcher: the target policy, then the pinned DNS answer for the host. */
export function guardedHop(resolver: PinnedResolver): HopCheck {
  return async (hop) => {
    checkTarget(hop);
    await resolver.resolve(hop.hostname);
  };
}

/**
 * Browser request guard: the target policy only. No DNS here; the proxy owns DNS, so a
 * page cannot use the route handler to probe names. Any throw blocks the request.
 */
export function guardedRequestGuard(): RequestGuard {
  return ({ url }) => {
    try {
      checkTarget(url);
      return true;
    } catch {
      return false;
    }
  };
}

export interface ProxiedFetcherOptions {
  /** The egress proxy, e.g. `http://127.0.0.1:<port>`. */
  proxyUrl: string;
  resolver: PinnedResolver;
  userAgent: string;
  maxRedirects?: number;
  /** Extra CA certificates to trust for the origin (tests). Verification stays on. */
  ca?: string | Buffer;
  /** Called for every hop the policy or the resolver refused, before the refusal is thrown. A throw from it is ignored. */
  onRefused?: (hop: URL, error: EgressRefusedError) => void;
  /** A caller's own rule for every hop, run after the egress check passed it; throw to refuse. */
  checkHop?: HopCheck;
}

/** A proxied fetcher, with a close hook for its connections to the proxy. */
export type ProxiedFetcher = Fetcher & {
  /** Closes the ProxyAgent and its connections; the fetcher must not be used after. */
  close(): Promise<void>;
};

/**
 * A fetcher whose every hop is checked (policy and DNS) before it is requested, and whose
 * requests all leave through the egress proxy. Uses undici's own fetch with a ProxyAgent,
 * because Node's bundled undici can differ from the userland one.
 */
export function createProxiedFetcher(options: ProxiedFetcherOptions): ProxiedFetcher {
  const dispatcher = new ProxyAgent({
    uri: options.proxyUrl,
    // Plain http goes absolute-form, where the proxy sets Host; it tunnels 443 only.
    proxyTunnel: false,
    ...(options.ca !== undefined ? { requestTls: { ca: options.ca } } : {}),
  });
  const check = guardedHop(options.resolver);
  const fetcher = createFetcher({
    checkHop: async (hop, start) => {
      try {
        await check(hop, start);
      } catch (e) {
        if (e instanceof EgressRefusedError)
          try {
            options.onRefused?.(hop, e);
          } catch {
            // Logging never changes what is refused.
          }
        throw e;
      }
      await options.checkHop?.(hop, start);
    },
    ...(options.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}),
    request: async (url, init) => {
      // createFetcher passes only redirect and signal, so the headers are ours alone.
      const response = await undiciFetch(url, {
        ...(init as Record<string, unknown>),
        headers: { 'user-agent': options.userAgent },
        dispatcher,
      });
      return response as unknown as Response;
    },
  });
  return Object.assign(fetcher, { close: () => dispatcher.close() });
}
