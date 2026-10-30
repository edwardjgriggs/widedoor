import { createRequire } from 'node:module';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { EgressRefusedError, createFetcher, type Fetcher, type HopCheck } from '../fetch.js';
import type { RequestGuard } from '../context.js';
import { checkTarget } from './policy.js';
import { PROXY_REFUSED_STATUS } from './proxy.js';
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

/**
 * Per-hop check for the fetcher: the target policy, then, given a resolver, the pinned DNS
 * answer for the host. Without one there is no DNS here; the proxy resolves and refuses.
 */
export function guardedHop(resolver?: PinnedResolver): HopCheck {
  return async (hop) => {
    checkTarget(hop);
    await resolver?.resolve(hop.hostname);
  };
}

/** undici's error when the proxy answers a CONNECT with its refusal (a 403). */
const TUNNEL_REFUSED = /^Proxy response \(403\) !== 200 when HTTP Tunneling$/;

/**
 * Whether a response or a fetch error is the egress proxy refusing the hop: a 403 with its
 * Proxy-Status for plain http, and a 403 to the CONNECT (which undici reports only as an
 * error) for https.
 */
function proxyRefused(outcome: { response: Response } | { error: unknown }): boolean {
  if ('response' in outcome)
    return (
      outcome.response.status === 403 &&
      outcome.response.headers.get('proxy-status') === PROXY_REFUSED_STATUS
    );
  // fetch's TypeError wraps a DOMException that wraps undici's RequestAbortedError.
  let cause = outcome.error;
  for (let depth = 0; depth < 4 && cause !== null && typeof cause === 'object'; depth++) {
    if (cause instanceof Error && TUNNEL_REFUSED.test(cause.message)) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
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
  /**
   * Checks each hop's name before the proxy is asked, for a caller whose resolver the
   * proxy shares (in-process tests). Leave it out where the proxy is another process: the
   * scan child cannot reach DNS at all (firewall.ts), and the proxy's own pin is the one
   * that binds.
   */
  resolver?: PinnedResolver;
  userAgent: string;
  maxRedirects?: number;
  /** Extra CA certificates to trust for the origin (tests). Verification stays on. */
  ca?: string | Buffer;
  /**
   * Called for every hop the policy, the resolver or the proxy refused, before the refusal
   * is thrown. A throw from it is ignored.
   */
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
 * A fetcher whose every hop is checked (policy, and DNS given a resolver) before it is
 * requested, and whose requests all leave through the egress proxy. A hop the proxy
 * refuses is an EgressRefusedError ('proxy', no block reason: the proxy never says why),
 * never a response. Uses undici's own fetch with a ProxyAgent, because Node's bundled
 * undici can differ from the userland one.
 */
export function createProxiedFetcher(options: ProxiedFetcherOptions): ProxiedFetcher {
  const dispatcher = new ProxyAgent({
    uri: options.proxyUrl,
    // Plain http goes absolute-form, where the proxy sets Host; it tunnels 443 only.
    proxyTunnel: false,
    ...(options.ca !== undefined ? { requestTls: { ca: options.ca } } : {}),
  });
  const check = guardedHop(options.resolver);
  const refused = (hop: URL, e: EgressRefusedError): EgressRefusedError => {
    try {
      options.onRefused?.(hop, e);
    } catch {
      // Logging never changes what is refused.
    }
    return e;
  };
  const byProxy = (url: string) => {
    const hop = new URL(url);
    return refused(
      hop,
      new EgressRefusedError(`the egress proxy refused ${hop.hostname}`, 'proxy'),
    );
  };
  const fetcher = createFetcher({
    checkHop: async (hop, start) => {
      try {
        await check(hop, start);
      } catch (e) {
        throw e instanceof EgressRefusedError ? refused(hop, e) : e;
      }
      await options.checkHop?.(hop, start);
    },
    ...(options.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}),
    request: async (url, init) => {
      let response;
      try {
        // createFetcher passes only redirect and signal, so the headers are ours alone.
        response = (await undiciFetch(url, {
          ...(init as Record<string, unknown>),
          headers: { 'user-agent': options.userAgent },
          dispatcher,
        })) as unknown as Response;
      } catch (error) {
        throw proxyRefused({ error }) ? byProxy(url) : error;
      }
      if (proxyRefused({ response })) {
        await response.body?.cancel().catch(() => undefined);
        throw byProxy(url);
      }
      return response;
    },
  });
  return Object.assign(fetcher, { close: () => dispatcher.close() });
}
