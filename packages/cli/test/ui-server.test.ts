import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SECURITY_HEADERS,
  CODE_HEADER,
  TOKEN_HEADER,
  UI_CSP,
  UiBuildError,
  hostAllowed,
  loadStaticFiles,
  startUiServer,
  tokenMatches,
  type UiServer,
} from '../src/ui-server.ts';

/*
 * The widedoor ui server over real loopback sockets: bind address, Host and
 * token checks, the security headers on every response, and static files
 * served only from the set read at start.
 */

const TOKEN = 'test-token_0123456789abcdefghijklmnopqrstuvwxyzABCD';
const CODE = 'test-code_0123456789abcdefghijklmnopqrstuvwxyzABCDE';
let dir: string;
let dist: string;
let server: UiServer;
let empty: UiServer;
let reuses = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'widedoor-ui-'));
  dist = join(dir, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>viewer</title>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1);');
  writeFileSync(join(dist, 'assets', 'app.css'), 'body{}');
  writeFileSync(join(dist, 'assets', 'notes.txt'), 'not a served type');
  writeFileSync(join(dist, '.hidden.js'), 'hidden');
  writeFileSync(join(dir, 'secret.js'), 'outside the folder');
  try {
    symlinkSync(join(dir, 'secret.js'), join(dist, 'assets', 'link.js'), 'file');
  } catch {
    // No symlink privilege (Windows without developer mode): the link case is then untested.
  }
  const files = loadStaticFiles(dist);
  server = await startUiServer({
    files,
    reportBody: '{"report":{}}',
    token: TOKEN,
    code: CODE,
    onCodeReuse: () => void reuses++,
  });
  empty = await startUiServer({ files });
});

afterAll(async () => {
  await server?.close();
  await empty?.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw request, so the test controls the Host header and the exact path. */
function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
  host = '127.0.0.1',
): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request(
      { host, port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.once('error', fail);
    req.end();
  });
}

const expectSecured = (r: Reply) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(r.headers[name]).toBe(value);
};

describe('widedoor ui server', () => {
  it('listens on 127.0.0.1 only, on a random port, and links with a one-time code', () => {
    expect(server.address.address).toBe('127.0.0.1');
    expect(server.address.family).toBe('IPv4');
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/?code=${CODE}`);
    expect(empty.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(empty.code).not.toBe(empty.token);
    expect(empty.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(empty.token).not.toBe(server.token);
  });

  it('sends the CSP from the ruling', () => {
    expect(UI_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });

  it('serves the viewer with the security headers', async () => {
    for (const path of ['/', `/?code=${CODE}`, '/index.html']) {
      const r = await get(server.port, path);
      expect(r.status, path).toBe(200);
      expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(r.body).toContain('<title>viewer</title>');
      expectSecured(r);
    }
    const js = await get(server.port, '/assets/app.js');
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expectSecured(js);
  });

  it('accepts localhost as the Host name, in any case', async () => {
    const r = await get(server.port, '/', { host: `LocalHost:${server.port}` });
    expect(r.status).toBe(200);
  });

  it.each([
    ['another name', (p: number) => `evil.example:${p}`],
    ['a rebinding name on the right port', (p: number) => `attacker.localhost.evil:${p}`],
    ['the right name on another port', (p: number) => `127.0.0.1:${p + 1}`],
    ['no port', () => '127.0.0.1'],
    ['the IPv6 loopback', (p: number) => `[::1]:${p}`],
  ])('refuses a request whose Host is %s, with the headers', async (_, host) => {
    for (const path of ['/', '/api/report']) {
      const r = await get(server.port, path, { host: host(server.port), [TOKEN_HEADER]: TOKEN });
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('viewer');
      expectSecured(r);
    }
  });

  it('refuses a request with no Host header, with the headers', async () => {
    const r = await new Promise<Reply>((done, fail) => {
      const req = request(
        { host: '127.0.0.1', port: server.port, path: '/', setHost: false },
        (res) => {
          res.resume();
          res.on('end', () =>
            done({ status: res.statusCode ?? 0, headers: res.headers, body: '' }),
          );
        },
      );
      req.once('error', fail);
      req.end();
    });
    expect([400, 403]).toContain(r.status);
    expectSecured(r);
  });

  it('serves the report only with the token', async () => {
    const ok = await get(server.port, '/api/report', { [TOKEN_HEADER]: TOKEN });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(ok.body).toBe('{"report":{}}');
    expectSecured(ok);
    for (const headers of [
      {},
      { [TOKEN_HEADER]: '' },
      { [TOKEN_HEADER]: TOKEN.slice(1) },
      { [TOKEN_HEADER]: `${TOKEN}x` },
      { [TOKEN_HEADER]: empty.token },
      { authorization: `Bearer ${TOKEN}` },
    ]) {
      const r = await get(server.port, '/api/report', headers);
      expect(r.status, JSON.stringify(headers)).toBe(401);
      expect(r.body).not.toContain('report');
      expectSecured(r);
    }
    const query = await get(server.port, `/api/report?token=${TOKEN}`);
    expect(query.status).toBe(401);
  });

  it('trades the code for the token once, and only for the right code', async () => {
    for (const headers of [
      {},
      { [CODE_HEADER]: '' },
      { [CODE_HEADER]: CODE.slice(1) },
      { [CODE_HEADER]: TOKEN },
      { [CODE_HEADER]: empty.code },
      { [TOKEN_HEADER]: TOKEN },
    ]) {
      const r = await get(server.port, '/api/session', headers, 'POST');
      expect(r.status, JSON.stringify(headers)).toBe(401);
      expect(r.body).not.toContain(TOKEN);
      expectSecured(r);
    }
    // GET does not trade, and wrong codes did not use the code up.
    expect((await get(server.port, '/api/session', { [CODE_HEADER]: CODE })).status).toBe(401);
    const host = await get(
      server.port,
      '/api/session',
      { [CODE_HEADER]: CODE, host: `evil.example:${server.port}` },
      'POST',
    );
    expect(host.status).toBe(403);
    const first = await get(server.port, '/api/session', { [CODE_HEADER]: CODE }, 'POST');
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ token: TOKEN });
    expectSecured(first);
    expect(reuses).toBe(0);
    const second = await get(server.port, '/api/session', { [CODE_HEADER]: CODE }, 'POST');
    expect(second.status).toBe(401);
    // The right code a second time is reported (someone else may have used the link); a wrong one is not.
    expect(reuses).toBe(1);
    await get(server.port, '/api/session', { [CODE_HEADER]: 'wrong' }, 'POST');
    expect(reuses).toBe(1);
    expect(second.body).not.toContain(TOKEN);
  });

  it('answers 204 for the report when none was given', async () => {
    const r = await get(empty.port, '/api/report', { [TOKEN_HEADER]: empty.token });
    expect(r.status).toBe(204);
    expect(r.body).toBe('');
    expectSecured(r);
  });

  it.each([
    '/../secret.js',
    '/%2e%2e/secret.js',
    '/assets/%2e%2e/%2e%2e/secret.js',
    '/assets/..%2f..%2fsecret.js',
    '/assets/..%5c..%5csecret.js',
    '/..%5csecret.js',
    '/assets/',
    '/assets',
    '/assets/notes.txt',
    '/.hidden.js',
    '/assets/link.js',
    '/index.html/',
    '/INDEX.HTML',
    '/favicon.ico',
    '//127.0.0.1/index.html',
  ])('answers 404 with the headers for %s', async (path) => {
    const r = await get(server.port, path);
    expect(r.status).toBe(404);
    expect(r.body).toBe('Not found.');
    expectSecured(r);
  });

  it('serves nothing but GET and HEAD (and the session POST), with no CORS headers', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const r = await get(server.port, '/', { origin: 'https://evil.example' }, method);
      expect(r.status, method).toBe(404);
      expectSecured(r);
      expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
    }
    const preflight = await get(
      server.port,
      '/api/session',
      {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': CODE_HEADER,
      },
      'OPTIONS',
    );
    expect(preflight.status).not.toBe(200);
    expect(Object.keys(preflight.headers).filter((h) => h.startsWith('access-control-'))).toEqual(
      [],
    );
    const head = await get(server.port, '/', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });
});

describe('server helpers', () => {
  it('matches the Host exactly', () => {
    expect(hostAllowed('127.0.0.1:8080', 8080)).toBe(true);
    expect(hostAllowed('localhost:8080', 8080)).toBe(true);
    expect(hostAllowed(undefined, 8080)).toBe(false);
    expect(hostAllowed('127.0.0.1:8080 ', 8080)).toBe(false);
    expect(hostAllowed('127.0.0.1.nip.io:8080', 8080)).toBe(false);
    expect(hostAllowed('0.0.0.0:8080', 8080)).toBe(false);
  });

  it('compares tokens in full', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('ab', 'abc')).toBe(false);
    expect(tokenMatches(undefined, 'abc')).toBe(false);
  });

  it('refuses a folder with no built viewer', () => {
    expect(() => loadStaticFiles(join(dir, 'missing'))).toThrow(UiBuildError);
    expect(() => loadStaticFiles(join(dist, 'assets'))).toThrow(/no index.html/);
  });

  it('keeps only regular files of known types with plain names', () => {
    expect([...loadStaticFiles(dist).keys()].sort()).toEqual([
      '/assets/app.css',
      '/assets/app.js',
      '/index.html',
    ]);
  });
});
