import robotsParser from 'robots-parser';
import { EgressRefusedError, readCapped, type EgressBlockReason, type Fetcher } from './fetch.js';

/*
 * robots.txt support for the hosted scanner (RFC 9309). The policy is built
 * from the fetcher it is given, so in hosted mode robots.txt is requested
 * through the egress guard like any other fetch. One request per origin, shared
 * by every page of that origin checked at the same time.
 *
 * The file is hostile input: the parser's matching is synchronous and costs about
 * (wildcards in a rule) times (path length) per rule, so the number of rules,
 * their length, their wildcards and the length of the URL checked are all bounded.
 */

/**
 * 'scan': go ahead. 'robots-disallowed': the rules (or an over-long URL) forbid the page.
 * 'robots-unreachable': robots.txt could not be read (or its applicable group is too big to
 * apply), so the whole origin is treated as disallowed. 'robots-unchecked': the URL is too long to check.
 */
export type PageVerdict = 'scan' | 'robots-disallowed' | 'robots-unreachable' | 'robots-unchecked';
/** Must not reject: scanWeb records a rejection as a scan error for that page. */
export type PagePolicy = (url: string) => Promise<PageVerdict>;

/** Largest robots.txt read, in bytes (RFC 9309 asks parsers to read at least 500 KiB). */
export const ROBOTS_MAX_BYTES = 500 * 1024;
/** Wall-clock limit for fetching one robots.txt, redirects and body included. */
export const ROBOTS_TIMEOUT_MS = 10_000;
/** Allow and Disallow rules of the applicable group; more makes the origin unreadable. */
export const ROBOTS_MAX_RULES = 250;
/** All rules of the applicable group together, in characters; more makes the origin unreadable. */
export const ROBOTS_MAX_RULE_CHARS = 8 * 1024;
/** Longest rule, in characters; a longer one makes the origin unreadable. */
export const ROBOTS_MAX_RULE_LENGTH = 2_048;
/** Most `*` in a rule; a rule with more makes the origin unreadable. */
export const ROBOTS_MAX_WILDCARDS = 64;
/** A URL whose path plus query is longer than this is not checked ('robots-unchecked'). */
export const ROBOTS_MAX_URL_LENGTH = 1_024;

export type RobotsCause =
  | 'http-5xx'
  | 'http-429'
  | 'http-other'
  | 'timeout'
  | 'network'
  | 'refused'
  | 'too-many-redirects'
  | 'too-large';

/** What was decided for one origin. Never carries a path or query. */
export interface RobotsDecision {
  origin: string;
  /** The status of the final robots.txt response, when there was one. */
  status?: number;
  /** Bytes of robots.txt read. */
  bytes: number;
  /** The file was cut at the byte cap, or its applicable group was over a limit. */
  truncated: boolean;
  /** Rules kept. */
  rules: number;
  verdict: 'rules' | 'allow-all' | 'disallow-all';
  cause?: RobotsCause;
  blockReason?: EgressBlockReason;
}

export interface RobotsPolicyOptions {
  /** Called once per origin, when its robots.txt has been dealt with. */
  onDecision?: (decision: RobotsDecision) => void;
}

/** The parser is CommonJS; its types describe a default export that Node's ESM interop does not produce. */
const parse = robotsParser as unknown as (
  url: string,
  contents: string,
) => { isAllowed(url: string, ua?: string): boolean | undefined };

type Rules = (url: string) => PageVerdict;

const allowAll: Rules = () => 'scan';
const disallowAll: Rules = () => 'robots-unreachable';

/** The product token of a user-agent line, as robots-parser reads it: lowercase, without a version. */
const productToken = (value: string): string => (value.split('/', 1)[0] ?? '').trim().toLowerCase();

interface Group {
  agents: string[];
  rules: { directive: 'allow' | 'disallow'; value: string }[];
}

/**
 * Reads the groups of a file (RFC 9309): consecutive User-agent lines share the
 * rules after them. Group boundaries follow robots-parser's, so what is picked
 * here is what it would have applied.
 */
function groupsOf(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | undefined;
  let inAgents = false;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const content = line.split('#', 1)[0] ?? '';
    const colon = content.indexOf(':');
    const directive = colon < 0 ? '' : content.slice(0, colon).trim().toLowerCase();
    if (directive === '') continue;
    const value = content.slice(colon + 1).trim();
    if (directive === 'user-agent') {
      if (!inAgents || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      if (value) current.agents.push(productToken(value));
      inAgents = true;
      continue;
    }
    inAgents = false;
    if ((directive === 'allow' || directive === 'disallow') && value && current)
      current.rules.push({ directive, value });
  }
  return groups;
}

/**
 * Cuts a file down to the rules that apply to `userAgent`: every group that names
 * it, else every group for `*`, else nothing (everything allowed). The limits are
 * checked on those rules only, and a rule over a limit makes the whole origin
 * unreadable: dropping it, or any other line, could move a group boundary or lose
 * the very rule that applies. The returned text holds only the applicable group.
 */
function applicableRules(
  text: string,
  userAgent: string,
): { text: string; rules: number } | 'too-large' {
  const groups = groupsOf(text);
  const named = groups.filter((g) => g.agents.includes(userAgent.toLowerCase()));
  const picked = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));
  const rules = picked.flatMap((g) => g.rules);
  let chars = 0;
  for (const rule of rules) {
    chars += rule.value.length;
    if (
      rule.value.length > ROBOTS_MAX_RULE_LENGTH ||
      rule.value.split('*').length - 1 > ROBOTS_MAX_WILDCARDS
    )
      return 'too-large';
  }
  if (rules.length > ROBOTS_MAX_RULES || chars > ROBOTS_MAX_RULE_CHARS) return 'too-large';
  const lines = rules.map((r) => `${r.directive}: ${r.value}`);
  return { text: ['User-agent: *', ...lines].join('\n'), rules: rules.length };
}

function causeOf(e: unknown): { cause: RobotsCause; blockReason?: EgressBlockReason } {
  if (e instanceof EgressRefusedError) {
    if (e.reason === 'redirect-limit') return { cause: 'too-many-redirects' };
    return {
      cause: 'refused',
      ...(e.blockReason !== undefined ? { blockReason: e.blockReason } : {}),
    };
  }
  const name = (e as Error | undefined)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return { cause: 'timeout' };
  return { cause: 'network' };
}

async function loadRules(
  fetcher: Fetcher,
  origin: string,
  userAgent: string,
  onDecision: ((decision: RobotsDecision) => void) | undefined,
): Promise<Rules> {
  const robotsUrl = `${origin}/robots.txt`;
  const decide = (rules: Rules, decision: Omit<RobotsDecision, 'origin'>): Rules => {
    try {
      onDecision?.({ origin, ...decision });
    } catch {
      // A broken observer never changes what is scanned.
    }
    return rules;
  };
  let status: number | undefined;
  try {
    // The fetcher follows redirects within its own rules (at most 5 by default).
    const { response } = await fetcher(robotsUrl, {
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
    });
    const code = response.status;
    status = code;
    const unread = (cause: RobotsCause) =>
      decide(disallowAll, {
        status: code,
        bytes: 0,
        truncated: false,
        rules: 0,
        verdict: 'disallow-all',
        cause,
      });
    // 4xx: no robots.txt, everything is allowed; except 429, which is as good as unreachable.
    if (code === 429) {
      await response.body?.cancel().catch(() => undefined);
      return unread('http-429');
    }
    if (code >= 400 && code < 500) {
      await response.body?.cancel().catch(() => undefined);
      return decide(allowAll, {
        status: code,
        bytes: 0,
        truncated: false,
        rules: 0,
        verdict: 'allow-all',
      });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return unread(code >= 500 ? 'http-5xx' : 'http-other');
    }
    const { bytes, over } = await readCapped(response, ROBOTS_MAX_BYTES);
    let text = new TextDecoder('utf-8').decode(bytes);
    if (over) {
      // A cut-off last line could read as a shorter, broader rule: drop it. With no line
      // break at all nothing can be trusted, so the origin is treated as unreachable.
      const cut = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
      if (cut < 0)
        return decide(disallowAll, {
          status: code,
          bytes: bytes.length,
          truncated: true,
          rules: 0,
          verdict: 'disallow-all',
          cause: 'too-large',
        });
      text = text.slice(0, cut + 1);
    }
    const applicable = applicableRules(text, userAgent);
    if (applicable === 'too-large')
      return decide(disallowAll, {
        status: code,
        bytes: bytes.length,
        truncated: true,
        rules: 0,
        verdict: 'disallow-all',
        cause: 'too-large',
      });
    const robots = parse(robotsUrl, applicable.text);
    // undefined means the parser could not place the URL on this host: do not guess.
    return decide(
      (url) => (robots.isAllowed(url, userAgent) === true ? 'scan' : 'robots-disallowed'),
      {
        status: code,
        bytes: bytes.length,
        truncated: over,
        rules: applicable.rules,
        verdict: 'rules',
      },
    );
  } catch (e) {
    // A refused hop, a network error or a timeout: unreachable means complete disallow.
    return decide(disallowAll, {
      ...(status !== undefined ? { status } : {}),
      bytes: 0,
      truncated: false,
      rules: 0,
      verdict: 'disallow-all',
      ...causeOf(e),
    });
  }
}

/**
 * A page policy that skips what the site's robots.txt disallows for
 * `userAgent`. The robots.txt of an origin is fetched once (cap 500 KiB, 10 s):
 * a 4xx other than 429 allows everything; a 429, a 5xx, a refused fetch or a
 * network failure makes every page of that origin 'robots-unreachable'.
 *
 * The fetcher must let robots.txt redirect to another origin (http to https,
 * apex to www; RFC 9309 section 2.3.1.2) while still enforcing egress on every
 * hop. A fetcher that refuses cross-origin hops makes such sites unreachable.
 * The rules are parsed against the original origin's robots.txt URL.
 */
export function robotsPolicy(
  fetcher: Fetcher,
  userAgent: 'Widedoor',
  options: RobotsPolicyOptions = {},
): PagePolicy {
  const byOrigin = new Map<string, Promise<Rules>>();
  return async (url) => {
    const parsed = new URL(url);
    // robots.txt is an HTTP convention; it says nothing about other schemes.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'scan';
    // Matching costs path length; a URL this long is not worth the time, and is not judged.
    if (parsed.pathname.length + parsed.search.length > ROBOTS_MAX_URL_LENGTH)
      return 'robots-unchecked';
    let rules = byOrigin.get(parsed.origin);
    if (!rules) {
      rules = loadRules(fetcher, parsed.origin, userAgent, options.onDecision);
      byOrigin.set(parsed.origin, rules);
    }
    return (await rules)(url);
  };
}
