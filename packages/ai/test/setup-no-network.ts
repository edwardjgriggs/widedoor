import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { afterAll, expect } from 'vitest';

/*
 * No network in the packages/ai unit tests (Global Constraints): any
 * connection to a non-loopback address throws NETWORK_OFF. Patched for each
 * packages/ai test file only: globalThis.fetch (the SDKs' transport),
 * http.request and https.request (and get), and net.Socket.prototype.connect,
 * which every TCP connection, Node's built-in fetch and the undici package
 * included, goes through. Blocked attempts are listed in
 * globalThis.__widedoorBlocked so a test can prove the guard, not the
 * network, stopped a call.
 */

export const NETWORK_OFF = 'network is off in unit tests';

declare global {
  var __widedoorBlocked: string[] | undefined;
}

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);
const isLoopback = (host: string | undefined) =>
  host === undefined ||
  host === '' ||
  LOOPBACK_HOSTS.has(host.toLowerCase()) ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
  /^::ffff:127\./i.test(host);

function block(target: string): never {
  (globalThis.__widedoorBlocked ??= []).push(target);
  throw new Error(`${NETWORK_OFF}: ${target}`);
}

/** The host a fetch input names. */
function fetchHost(input: unknown): string | undefined {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input instanceof Request
          ? input.url
          : String(input);
  try {
    return new URL(raw).hostname;
  } catch {
    return undefined;
  }
}

/** The host http.request and https.request will connect to. */
function requestHost(args: unknown[]): string | undefined {
  const [first, second] = args;
  if (typeof first === 'string' || first instanceof URL) return fetchHost(first);
  const opts = (first ?? second) as { hostname?: string; host?: string } | undefined;
  return opts?.hostname ?? opts?.host?.replace(/:\d+$/, '') ?? 'localhost';
}

/** The host net.Socket#connect is asked for: (options), (port, host) or (path) for IPC. */
function connectHost(args: unknown[]): string | undefined {
  const [first, second] = args;
  const options = Array.isArray(first) ? first[0] : first;
  if (typeof options === 'object' && options !== null) {
    const o = options as { host?: string; path?: string };
    if (o.path !== undefined) return undefined;
    return o.host ?? 'localhost';
  }
  if (typeof options === 'string' && !/^\d+$/.test(options)) return undefined;
  return typeof second === 'string' ? second : 'localhost';
}

const originals = {
  fetch: globalThis.fetch,
  httpRequest: http.request,
  httpGet: http.get,
  httpsRequest: https.request,
  httpsGet: https.get,
  connect: net.Socket.prototype.connect,
};

function install() {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const host = fetchHost(input);
    if (!isLoopback(host)) block(`fetch ${host}`);
    return originals.fetch(input, init);
  }) as typeof fetch;
  const guardRequest = <F extends (...args: never[]) => unknown>(original: F, name: string) =>
    ((...args: unknown[]) => {
      const host = requestHost(args);
      if (!isLoopback(host)) block(`${name} ${host}`);
      return (original as unknown as (...a: unknown[]) => unknown)(...args);
    }) as unknown as F;
  http.request = guardRequest(originals.httpRequest, 'http.request');
  http.get = guardRequest(originals.httpGet, 'http.get');
  https.request = guardRequest(originals.httpsRequest, 'https.request');
  https.get = guardRequest(originals.httpsGet, 'https.get');
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const host = connectHost(args);
    if (!isLoopback(host)) block(`connect ${host}`);
    return (originals.connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  syncBuiltinESMExports();
}

function uninstall() {
  globalThis.fetch = originals.fetch;
  http.request = originals.httpRequest;
  http.get = originals.httpGet;
  https.request = originals.httpsRequest;
  https.get = originals.httpsGet;
  net.Socket.prototype.connect = originals.connect;
  syncBuiltinESMExports();
}

// Installed at import, before the test file's own top level runs, so a client built there is
// covered too; removed after the file.
const inAiPackage = /[\\/]packages[\\/]ai[\\/]/.test(expect.getState().testPath ?? '');
if (inAiPackage) {
  install();
  afterAll(uninstall);
}
