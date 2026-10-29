import { lookup as dnsLookup } from 'node:dns/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { isHttpUrl } from '../config.js';
import { firewallRules } from './firewall.js';
import { CONTROL_URL_ENV, EGRESS_PORT } from './protocol.js';

/*
 * Writes the scan machine's firewall rules (firewall.ts) for the scan entry, as root and
 * before any rule is loaded: it resolves the control URL's host once, reads the
 * nameservers of /etc/resolv.conf, and writes `rules.v4` and `rules.v6` (mode 0600) into
 * the root-only folder named by its one argument. The entry loads them with
 * iptables-restore and ip6tables-restore. Any failure exits 1 and writes nothing the
 * entry could load; the log says what was wrong, never the URL.
 */

export const RULES_V4 = 'rules.v4';
export const RULES_V6 = 'rules.v6';

export type LookupAll = (host: string) => Promise<string[]>;

export interface FirewallBinOptions {
  env: NodeJS.ProcessEnv;
  /** The folder the two files go into (absolute; the entry's root-only temp folder). */
  dir: string | undefined;
  /** Default /etc/resolv.conf. */
  resolvConf?: string;
  /** Every address of a host name. Default dns.lookup with all: true. */
  lookup?: LookupAll;
  /** Where log lines go. Default: stderr. */
  log?: (line: string) => void;
}

const defaultLookup: LookupAll = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/** The addresses of the `nameserver` lines of a resolv.conf, in order. */
export function nameservers(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*nameserver\s+(\S+)\s*$/.exec(line);
    if (match?.[1] !== undefined) out.push(match[1]);
  }
  return out;
}

/** Writes the rules. Resolves with the exit code: 0 once both files are written, 1 otherwise. */
export async function main(options: FirewallBinOptions): Promise<number> {
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const fail = (name: string) => {
    log(`widedoor event=firewall_config_error name=${name}`);
    return 1;
  };
  const { dir } = options;
  if (dir === undefined || !isAbsolute(dir)) return fail('dir');
  const controlUrl = options.env[CONTROL_URL_ENV] ?? '';
  if (!isHttpUrl(controlUrl)) return fail(CONTROL_URL_ENV);
  const url = new URL(controlUrl);
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const controlPort = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);

  let controlAddresses: string[];
  try {
    controlAddresses = isIP(host) !== 0 ? [host] : await (options.lookup ?? defaultLookup)(host);
  } catch {
    return fail('control_host');
  }
  let resolvers: string[];
  try {
    resolvers = nameservers(await readFile(options.resolvConf ?? '/etc/resolv.conf', 'utf8'));
  } catch {
    return fail('resolv_conf');
  }
  if (controlAddresses.length === 0) return fail('control_host');
  if (resolvers.length === 0) return fail('resolv_conf');

  let rules;
  try {
    rules = firewallRules({ controlAddresses, controlPort, resolvers, proxyPort: EGRESS_PORT });
  } catch {
    // An entry that is not an address (a nameserver with a zone, say).
    return fail('rules');
  }
  try {
    // wx: a file already there (planted, or from an earlier run) is never loaded in its place.
    await writeFile(join(dir, RULES_V4), rules.v4, { mode: 0o600, flag: 'wx' });
    await writeFile(join(dir, RULES_V6), rules.v6, { mode: 0o600, flag: 'wx' });
  } catch {
    return fail('write');
  }
  return 0;
}

// Only as a process entry point.
if (import.meta.main) {
  process.exitCode = await main({ env: process.env, dir: process.argv[2] });
}
