import { safeText } from '@widedoor/core';
import { isHttpUrl } from '../config.js';
import { TIER_NAMES, type Tier } from './limits.js';
import {
  CONTACT_URL_ENV,
  CONTROL_URL_ENV,
  JOB_ID,
  JOB_ID_ENV,
  JOB_TOKEN_ENV,
  isToken,
} from './protocol.js';

/*
 * A small typed client for the Fly Machines REST API: the hosted API starts one
 * machine per scan and destroys it afterwards, and sweeps machines that outlive
 * their scan. Every input is checked before a request goes out, and no thrown
 * error carries the API token or a job token: Fly may echo a machine's config
 * (which holds the job token) back in an error body.
 */

const DEFAULT_BASE_URL = 'https://api.machines.dev/v1';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_CHARS = 300;
const SCAN_ROLE = 'scan';
/** Largest response body read, in bytes. */
const MAX_BODY_BYTES = 1024 * 1024;
/** Most machines one sweep destroys; the rest wait for the next call. */
export const MAX_SWEEP_DESTROYS = 50;

const APP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MACHINE_ID = /^[a-z0-9]{1,64}$/i;
/** A Fly region code, such as iad. */
export const REGION = /^[a-z]{3}$/;
/** ISO 8601 with a time zone; looser forms ("1") parse as some date and are not trusted. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** Hosts that may be reached over plain http: Fly's 6PN Machines API, and loopback for tests. */
const PLAIN_HTTP_HOSTS = new Set(['_api.internal', '127.0.0.1', '[::1]', 'localhost']);

/** What a scan machine is started with. */
export interface ScanMachineSpec {
  jobId: string;
  token: string;
  image: string;
  controlUrl: string;
  /** Named in the scan's user agent: the API's WIDEDOOR_CONTACT_URL, the one source. */
  contactUrl: string;
  tier: Tier;
  /** The Fly region to create it in (the API's own, FLY_REGION). Default: Fly picks. */
  region?: string;
}

export interface ScanMachine {
  id: string;
  createdAt: string;
  jobId: string;
  state: string;
}

export interface FlyClient {
  createScanMachine(spec: ScanMachineSpec): Promise<{ id: string }>;
  /**
   * Resolves the status Fly answered: 200 for any 2xx, 404 when the machine was already
   * gone (auto_destroy) or the app is wrong, which the caller logs.
   */
  destroy(id: string): Promise<{ status: 200 | 404 }>;
  listScanMachines(): Promise<ScanMachine[]>;
  /**
   * How many of the app's machines carry no widedoor_role (the whole list, unfiltered):
   * machines the API did not create. They are counted for the log, never destroyed.
   */
  countForeignMachines(): Promise<number>;
}

/** A failed Fly call. Status 0 means no HTTP answer (bad input, network, timeout). */
export class FlyError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'FlyError';
    this.status = status;
  }
}

export interface FlyClientOptions {
  app: string;
  apiToken: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A URL with no user name, password, query or fragment. */
function isPlainUrl(value: string): boolean {
  if (/[?#]/.test(value)) return false;
  const url = new URL(value);
  return url.username === '' && url.password === '';
}

/** An https URL with no user name or password (api-bin's rule for WIDEDOOR_CONTACT_URL). */
function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** The base URL carries the API token: https, or http only for a host that stays on this machine or the 6PN. */
function checkBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FlyError(0, 'Fly base URL is not valid');
  }
  const plainOk = url.protocol === 'http:' && PLAIN_HTTP_HOSTS.has(url.hostname);
  if ((url.protocol !== 'https:' && !plainOk) || url.username !== '' || url.password !== '') {
    throw new FlyError(0, 'Fly base URL is not allowed');
  }
}

/** Every form a secret can take in an API error body: raw, JSON, Go JSON (<, > and & escaped) and percent-encoded. */
function secretForms(secret: string): string[] {
  const json = JSON.stringify(secret).slice(1, -1);
  const go = json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return [secret, json, go, encodeURIComponent(secret)].filter((form) => form !== '');
}

/**
 * The parts of a Fly token an error body may echo on their own: what follows `FlyV1 `,
 * and each comma-separated macaroon of it.
 */
function tokenParts(token: string): string[] {
  const rest = token.replace(/^FlyV1 /, '');
  return [rest, ...rest.split(',').map((part) => part.trim())].filter((part) => part !== '');
}

function checkSpec(spec: ScanMachineSpec): void {
  if (!JOB_ID.test(spec.jobId)) throw new FlyError(0, 'Fly machine spec: bad job id');
  if (!isHttpUrl(spec.controlUrl) || !isPlainUrl(spec.controlUrl)) {
    throw new FlyError(0, 'Fly machine spec: bad control URL');
  }
  if (!isHttpsUrl(spec.contactUrl) || /\s/.test(spec.contactUrl)) {
    throw new FlyError(0, 'Fly machine spec: bad contact URL');
  }
  if (!(TIER_NAMES as readonly string[]).includes(spec.tier)) {
    throw new FlyError(0, 'Fly machine spec: bad tier');
  }
  if (spec.image === '' || /\s/.test(spec.image)) {
    throw new FlyError(0, 'Fly machine spec: bad image');
  }
  if (!isToken(spec.token)) throw new FlyError(0, 'Fly machine spec: bad job token');
  if (spec.region !== undefined && !REGION.test(spec.region)) {
    throw new FlyError(0, 'Fly machine spec: bad region');
  }
}

/** The machine config sent for one scan (ruling R34: init.entrypoint, no services, no mounts). */
function machineConfig(spec: ScanMachineSpec) {
  return {
    image: spec.image,
    guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 },
    auto_destroy: true,
    restart: { policy: 'no' },
    init: { entrypoint: ['/app/docker/scan-entry.sh'] },
    env: {
      [CONTROL_URL_ENV]: spec.controlUrl,
      [CONTACT_URL_ENV]: spec.contactUrl,
      [JOB_ID_ENV]: spec.jobId,
      [JOB_TOKEN_ENV]: spec.token,
    },
    metadata: { widedoor_role: SCAN_ROLE, widedoor_job: spec.jobId, widedoor_tier: spec.tier },
  };
}

/** The body as text, or undefined when it is longer than MAX_BODY_BYTES (the rest is not read). */
async function readCapped(res: Response): Promise<string | undefined> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function createFlyClient(options: FlyClientOptions): FlyClient {
  if (!APP_NAME.test(options.app)) throw new FlyError(0, 'Fly app name is not valid');
  const app = encodeURIComponent(options.app);
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  checkBaseUrl(baseUrl);
  const base = baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** One request; returns the status and body text, or throws FlyError. Never follows a redirect. */
  async function request(
    method: string,
    path: string,
    body: unknown,
    secrets: string[],
  ): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The timer wins the race even when an injected fetch ignores the signal.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new FlyError(0, 'Fly API timed out'));
      }, timeoutMs);
    });
    const exchange = async (): Promise<{ status: number; text: string }> => {
      const headers: Record<string, string> = { Authorization: `Bearer ${options.apiToken}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await doFetch(`${base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'manual',
        signal: controller.signal,
      });
      const text = await readCapped(res);
      if (text === undefined)
        throw new FlyError(res.status, `Fly API ${res.status}: response too large`);
      if (res.status < 200 || res.status > 299) {
        throw new FlyError(res.status, `Fly API ${res.status}: ${describe(text, secrets)}`);
      }
      return { status: res.status, text };
    };
    const work = exchange();
    // If the timer wins, the abandoned exchange must not become an unhandled rejection.
    work.catch(() => undefined);
    try {
      return await Promise.race([work, deadline]);
    } catch (error) {
      if (error instanceof FlyError) throw error;
      // Never the underlying error's text, and no cause.
      throw new FlyError(0, timedOut ? 'Fly API timed out' : 'Fly API unreachable');
    } finally {
      clearTimeout(timer);
    }
  }

  /** An error body as message text: its error string if it has one, redacted, escaped and cut. */
  function describe(text: string, secrets: string[]): string {
    // Longest form first, so a form that holds another is replaced whole.
    const forms = [options.apiToken, ...tokenParts(options.apiToken), ...secrets]
      .flatMap(secretForms)
      .sort((a, b) => b.length - a.length);
    const redact = (value: string) =>
      forms.reduce((out, form) => out.split(form).join('[REDACTED]'), value);
    // Redact the raw body, then again after the error field is decoded from JSON.
    let message = redact(text);
    try {
      const parsed: unknown = JSON.parse(message);
      if (isRecord(parsed) && typeof parsed['error'] === 'string') {
        message = redact(parsed['error']);
      }
    } catch {
      // Not JSON: the body text stands.
    }
    return Array.from(safeText(message, MAX_MESSAGE_CHARS)).slice(0, MAX_MESSAGE_CHARS).join('');
  }

  function parseJson(status: number, text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      throw new FlyError(status, `Fly API ${status}: unreadable answer`);
    }
  }

  return {
    async createScanMachine(spec) {
      checkSpec(spec);
      const { status, text } = await request(
        'POST',
        `/apps/${app}/machines`,
        {
          config: machineConfig(spec),
          ...(spec.region !== undefined ? { region: spec.region } : {}),
        },
        [spec.token],
      );
      const parsed = parseJson(status, text);
      const id = isRecord(parsed) ? parsed['id'] : undefined;
      if (typeof id !== 'string' || !MACHINE_ID.test(id)) {
        throw new FlyError(status, `Fly API ${status}: no machine id`);
      }
      return { id };
    },

    async destroy(id) {
      if (!MACHINE_ID.test(id)) throw new FlyError(0, 'Fly machine id is not valid');
      try {
        await request(
          'DELETE',
          `/apps/${app}/machines/${encodeURIComponent(id)}?force=true`,
          undefined,
          [],
        );
        return { status: 200 };
      } catch (error) {
        // Already gone: auto_destroy may beat us.
        if (error instanceof FlyError && error.status === 404) return { status: 404 };
        throw error;
      }
    },

    async listScanMachines() {
      const { status, text } = await request(
        'GET',
        `/apps/${app}/machines?${encodeURIComponent('metadata.widedoor_role')}=${SCAN_ROLE}`,
        undefined,
        [],
      );
      const parsed = parseJson(status, text);
      if (!Array.isArray(parsed))
        throw new FlyError(status, `Fly API ${status}: not a machine list`);
      const machines: ScanMachine[] = [];
      for (const entry of parsed) {
        if (!isRecord(entry)) continue;
        const { id, created_at: createdAt, state, config } = entry;
        const metadata = isRecord(config) && isRecord(config['metadata']) ? config['metadata'] : {};
        if (metadata['widedoor_role'] !== SCAN_ROLE) continue;
        if (
          typeof id !== 'string' ||
          !MACHINE_ID.test(id) ||
          typeof createdAt !== 'string' ||
          createdAt === ''
        ) {
          continue;
        }
        const job = metadata['widedoor_job'];
        machines.push({
          id,
          createdAt,
          jobId: typeof job === 'string' ? job : '',
          state: typeof state === 'string' ? state : '',
        });
      }
      return machines;
    },

    async countForeignMachines() {
      const { status, text } = await request('GET', `/apps/${app}/machines`, undefined, []);
      const parsed = parseJson(status, text);
      if (!Array.isArray(parsed))
        throw new FlyError(status, `Fly API ${status}: not a machine list`);
      let foreign = 0;
      for (const entry of parsed) {
        const config = isRecord(entry) ? entry['config'] : undefined;
        const metadata = isRecord(config) && isRecord(config['metadata']) ? config['metadata'] : {};
        if (metadata['widedoor_role'] !== SCAN_ROLE) foreign += 1;
      }
      return foreign;
    },
  };
}

/** What sweepScanMachines asks of a Fly client. */
export type SweepClient = Pick<FlyClient, 'listScanMachines' | 'destroy'>;

export interface SweepOptions {
  /**
   * Destroy every scan machine whatever its age or date (a fresh API holds no jobs, so
   * none of them is its own), except those keep names. Default false.
   */
  all?: boolean;
  /** Machines never destroyed (in an all sweep: a job this API already started). */
  keep?: (machine: ScanMachine) => boolean;
}

/**
 * Destroys every scan machine created more than maxAgeMs before now (epoch ms) and returns
 * how many went. Nothing is destroyed when now or maxAgeMs is not a usable number. A machine
 * with an unreadable date is never destroyed (but for an all sweep); a failed destroy does
 * not stop the sweep, and is reported to onFailure (whose own errors are ignored). At most
 * MAX_SWEEP_DESTROYS machines are tried per call; the rest wait for the next one.
 */
export async function sweepScanMachines(
  client: SweepClient,
  now: number,
  maxAgeMs: number,
  onFailure?: (id: string, error: FlyError) => void,
  options: SweepOptions = {},
): Promise<number> {
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return 0;
  let destroyed = 0;
  let tried = 0;
  for (const machine of await client.listScanMachines()) {
    if (options.keep?.(machine) === true) continue;
    const created = ISO_DATE.test(machine.createdAt) ? Date.parse(machine.createdAt) : Number.NaN;
    if (options.all !== true && (Number.isNaN(created) || now - created <= maxAgeMs)) continue;
    if (tried >= MAX_SWEEP_DESTROYS) break;
    tried += 1;
    try {
      await client.destroy(machine.id);
      destroyed += 1;
    } catch (error) {
      // Counted out; the next sweep tries again.
      try {
        onFailure?.(
          machine.id,
          error instanceof FlyError ? error : new FlyError(0, 'Fly API unreachable'),
        );
      } catch {
        // A failing callback must not stop the sweep.
      }
    }
  }
  return destroyed;
}
