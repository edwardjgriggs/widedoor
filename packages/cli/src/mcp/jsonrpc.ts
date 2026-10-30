/*
 * JSON-RPC 2.0 over stdio for widedoor mcp (MCP basic/transports/stdio):
 * one message per line, UTF-8, no embedded newlines. A line over
 * MAX_MESSAGE_BYTES is dropped as it streams in, without being kept or
 * parsed, and answered with one -32600. Batches are not part of MCP and are
 * refused. The server never sends requests, so a response that arrives is
 * ignored.
 */

/** The largest message read, in bytes, without its newline. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export const ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** MCP basic/lifecycle: the requested protocol version is not one this server speaks. */
  unsupportedVersion: -32022,
} as const;

export type Id = string | number;
export type Params = Record<string, unknown>;

export type Incoming =
  | { kind: 'request'; id: Id; method: string; params: Params | undefined }
  | { kind: 'notification'; method: string; params: Params | undefined }
  | { kind: 'response' }
  | { kind: 'invalid'; id: Id | null; code: number; message: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isId = (v: unknown): v is Id =>
  (typeof v === 'string' && v.length <= 200) || (typeof v === 'number' && Number.isFinite(v));

const decoder = new TextDecoder('utf-8', { fatal: true });

/** What one line holds. Never throws. */
export function classify(line: Uint8Array): Incoming {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(line));
  } catch {
    return { kind: 'invalid', id: null, code: ERROR.parse, message: 'Parse error' };
  }
  if (Array.isArray(value))
    return {
      kind: 'invalid',
      id: null,
      code: ERROR.invalidRequest,
      message: 'Invalid Request: batches are not supported',
    };
  if (!isObject(value) || value.jsonrpc !== '2.0')
    return { kind: 'invalid', id: null, code: ERROR.invalidRequest, message: 'Invalid Request' };
  const id = 'id' in value ? value.id : undefined;
  if (!('method' in value)) {
    if (('result' in value || 'error' in value) && isId(id)) return { kind: 'response' };
    return {
      kind: 'invalid',
      id: isId(id) ? id : null,
      code: ERROR.invalidRequest,
      message: 'Invalid Request',
    };
  }
  const { method, params } = value;
  if (typeof method !== 'string' || (params !== undefined && !isObject(params)))
    return {
      kind: 'invalid',
      id: isId(id) ? id : null,
      code: ERROR.invalidRequest,
      message: 'Invalid Request',
    };
  if (id === undefined) return { kind: 'notification', method, params };
  if (!isId(id))
    return {
      kind: 'invalid',
      id: null,
      code: ERROR.invalidRequest,
      message: 'Invalid Request: the id must be a string or a number',
    };
  return { kind: 'request', id, method, params };
}

export const result = (id: Id, value: unknown) => ({ jsonrpc: '2.0' as const, id, result: value });

export const failure = (id: Id | null, code: number, message: string, data?: unknown) => ({
  jsonrpc: '2.0' as const,
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

/**
 * Splits a byte stream into lines of at most `max` bytes. A longer line is
 * dropped as it arrives (nothing of it is kept) and reported once through
 * onOversize when its newline comes or the stream ends.
 */
export class LineReader {
  private parts: Buffer[] = [];
  private size = 0;
  private dropping = false;

  constructor(
    private readonly onLine: (line: Buffer) => void,
    private readonly onOversize: () => void,
    private readonly max = MAX_MESSAGE_BYTES,
  ) {}

  push(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!this.dropping) {
        if (this.size + (end - start) > this.max) {
          this.dropping = true;
          this.parts = [];
          this.size = 0;
        } else if (end > start) {
          this.parts.push(chunk.subarray(start, end));
          this.size += end - start;
        }
      }
      if (newline === -1) return;
      this.finish();
      start = newline + 1;
    }
  }

  /** The stream ended: a last line without its newline still counts. */
  end(): void {
    if (this.dropping || this.size > 0) this.finish();
  }

  private finish(): void {
    if (this.dropping) {
      this.dropping = false;
      this.onOversize();
      return;
    }
    let line = Buffer.concat(this.parts, this.size);
    this.parts = [];
    this.size = 0;
    if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
    if (line.length > 0) this.onLine(line);
  }
}
