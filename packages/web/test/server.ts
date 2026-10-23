import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Hit {
  path: string;
  headers: IncomingHttpHeaders;
}

export interface TestServer {
  origin: string;
  hits: Hit[];
  upgrades: number;
  close: () => Promise<void>;
}

export type Routes = Record<
  string,
  { body: string | Buffer; status?: number; type?: string; headers?: Record<string, string> }
>;

/** An HTTP server on 127.0.0.1 with fixed routes; every request is logged. */
export async function serve(routes: (origin: string) => Routes): Promise<TestServer> {
  let table: Routes = {};
  const state: TestServer = { origin: '', hits: [], upgrades: 0, close: async () => undefined };
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    state.hits.push({ path, headers: req.headers });
    const route = table[path];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res
      .writeHead(route.status ?? 200, {
        'content-type': route.type ?? 'text/html; charset=utf-8',
        ...route.headers,
      })
      .end(route.body);
  });
  server.on('upgrade', (_req, socket) => {
    state.upgrades++;
    socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  table = routes(state.origin);
  state.close = () =>
    new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
  return state;
}

export const page = (title: string, body: string, head = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><main>${body}</main></body></html>`;
