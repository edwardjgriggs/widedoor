import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PinnedResolver } from '@widedoor/web/egress';
import { runHostedScan, type HostedScanOptions } from '../src/hosted/agent.ts';
import type { JobInput, ScanResult } from '../src/hosted/protocol.ts';
import { PUBLIC_V4, SITE, startLab, type Lab } from '../../web/test/ssrf-fixtures.ts';

/*
 * Shared by the hosted agent tests: the SSRF lab of the web package (a fake
 * resolver, a "public" site and a "private" server behind an in-process egress
 * proxy), a runner for runHostedScan against it, and a fake control API.
 */

export {
  NO_LEAKS,
  PUBLIC_V4,
  SITE,
  html,
  redirect,
  send,
  type Lab,
} from '../../web/test/ssrf-fixtures.ts';

export const JOB_ID = '0123456789abcdef0123456789abcdef';
export const TOKEN = 'test-token-0123456789';
export const START = `http://${SITE}/`;
export const unsafeNoSandbox = process.env.WIDEDOOR_TEST_UNSAFE_NO_SANDBOX === '1';

/** The lab with the site's name pinned to its public address. */
export const hostedLab = (): Promise<Lab> => startLab({ names: { [SITE]: [PUBLIC_V4] } });

export const urlJob = (url = START, tier: JobInput['tier'] = 'open'): JobInput => ({
  jobId: JOB_ID,
  tier,
  target: { kind: 'url', url },
  profile: '508+wcag21aa',
});

export const pdfJob = (fileName = 'report.pdf'): JobInput => ({
  jobId: JOB_ID,
  tier: 'open',
  target: { kind: 'pdf', fileName },
  profile: '508+wcag21aa',
});

/** runHostedScan through the lab's proxy and resolver, with its log lines kept. */
export async function scanInLab(
  lab: Lab,
  input: JobInput,
  extra: Partial<HostedScanOptions> = {},
): Promise<{ result: ScanResult; log: string[] }> {
  const log: string[] = [];
  const result = await runHostedScan({
    input,
    proxyUrl: lab.proxy.url,
    // The web source's class; typecheck reads @widedoor/web's built declaration of the same class.
    resolver: lab.resolver as unknown as PinnedResolver,
    contactUrl: 'https://example.org/contact',
    signal: AbortSignal.timeout(110_000),
    log: (line) => void log.push(line),
    unsafeNoSandbox,
    ...extra,
  });
  return { result, log };
}

export interface ControlRequest {
  method: string;
  path: string;
  authorization: string | undefined;
}

export interface FakeControl {
  url: string;
  requests: ControlRequest[];
  /** Bodies of PUT result, parsed. */
  results: unknown[];
  close(): Promise<void>;
}

export interface ControlOptions {
  /** The input answer: an object is sent as JSON, a string as it is. */
  input: unknown;
  /** The upload answer. */
  pdf?: Uint8Array;
  /** Status for GET input (default 200); a 3xx sends `location`; 'hang' never answers. */
  inputStatus?: number | 'hang';
  location?: string;
  /** Status for PUT result (default 204); 'hang' never answers. */
  resultStatus?: number | 'hang';
  /** Statuses for the first PUTs of a result, in order; then resultStatus. */
  resultStatuses?: number[];
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

/** The API's private listener as the agent sees it: input, pdf and result for JOB_ID. */
export async function startControl(options: ControlOptions): Promise<FakeControl> {
  const requests: ControlRequest[] = [];
  const results: unknown[] = [];
  const base = `/internal/jobs/${JOB_ID}`;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = req.url ?? '';
      requests.push({ method: req.method ?? '', path, authorization: req.headers.authorization });
      if (req.method === 'GET' && path === `${base}/input`) {
        const status = options.inputStatus ?? 200;
        if (status === 'hang') return;
        if (status >= 300 && status < 400)
          return void res.writeHead(status, { location: options.location ?? '/' }).end();
        const body =
          typeof options.input === 'string' ? options.input : JSON.stringify(options.input);
        return void res.writeHead(status, { 'content-type': 'application/json' }).end(body);
      }
      if (req.method === 'GET' && path === `${base}/pdf` && options.pdf)
        return void res
          .writeHead(200, { 'content-type': 'application/pdf' })
          .end(Buffer.from(options.pdf));
      if (req.method === 'PUT' && path === `${base}/result`) {
        results.push(JSON.parse(await readBody(req)));
        const next = options.resultStatuses?.shift();
        if (next !== undefined) return void res.writeHead(next).end();
        if (options.resultStatus === 'hang') return;
        return void res.writeHead(options.resultStatus ?? 204).end();
      }
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    results,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** Agent environment for the fake control API; the agent runs as the current user (SAME_USER_ENV). */
export const agentEnv = (
  control: FakeControl,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => ({
  ...process.env,
  WIDEDOOR_CONTROL_URL: control.url,
  WIDEDOOR_JOB_ID: JOB_ID,
  WIDEDOOR_JOB_TOKEN: TOKEN,
  WIDEDOOR_PROXY_URL: 'http://127.0.0.1:9',
  WIDEDOOR_AGENT_SAME_USER: '1',
  ...extra,
});

/**
 * Every spelling of the local folders a report must not name: as written, with
 * forward slashes, and as JSON writes it.
 */
export function localPathForms(folders: readonly string[]): string[] {
  return folders.flatMap((f) => {
    const forward = f.replace(/\\/g, '/');
    return [f, forward, JSON.stringify(f).slice(1, -1)];
  });
}
