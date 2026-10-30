import { createServer, type Server } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../src/providers/anthropic.ts';

/** The guard's message (setup-no-network.ts); not imported, so the setup file is evaluated only once. */
const NETWORK_OFF = 'network is off in unit tests';

// Built at the file's top level, before any hook runs: the guard must already be installed.
const topLevelClient = new Anthropic({ apiKey: 'x', maxRetries: 0, logLevel: 'off' });

/** The error chain of a thrown value, outermost first. */
function chain(e: unknown): string[] {
  const out: string[] = [];
  for (let cur = e; cur instanceof Error && out.length < 10; cur = cur.cause) out.push(cur.message);
  return out;
}

describe('the no-network guard (packages/ai unit tests)', () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((_, res) => res.end('loopback ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('blocks fetch to the Anthropic API', async () => {
    await expect(fetch('https://api.anthropic.com')).rejects.toThrow(NETWORK_OFF);
  });

  it('allows fetch to 127.0.0.1', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('loopback ok');
  });

  it('blocks https.request and a raw socket to a public address', () => {
    expect(() => https.request('https://api.openai.com/v1/responses')).toThrow(NETWORK_OFF);
    expect(() => https.get({ hostname: 'example.com', path: '/' })).toThrow(NETWORK_OFF);
    expect(() => new net.Socket().connect(443, '93.184.216.34')).toThrow(NETWORK_OFF);
    expect(() => net.connect({ host: 'example.com', port: 80 })).toThrow(NETWORK_OFF);
  });

  it('stops a real SDK client with no injected fetch, at the guard', async () => {
    globalThis.__widedoorBlocked = [];
    const client = new Anthropic({ apiKey: 'x', maxRetries: 0, logLevel: 'off' });
    const error = await client.messages
      .create({
        model: 'claude-opus-5-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(Anthropic.APIConnectionError);
    expect(chain(error).some((m) => m.includes(NETWORK_OFF))).toBe(true);
    expect(globalThis.__widedoorBlocked).toEqual(['fetch api.anthropic.com']);
  });

  it('stops a client built at the top level of a test file', async () => {
    globalThis.__widedoorBlocked = [];
    const error = await topLevelClient.messages
      .create({
        model: 'claude-opus-5-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(Anthropic.APIConnectionError);
    expect(globalThis.__widedoorBlocked).toEqual(['fetch api.anthropic.com']);
  });

  it('stops the provider with no injected fetch, at the guard', async () => {
    globalThis.__widedoorBlocked = [];
    const provider = createAnthropicProvider({ apiKey: 'x' });
    const answer = await provider.suggestFix({
      system: 's',
      user: 'u',
      schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      maxOutputTokens: 16,
      signal: new AbortController().signal,
    });
    expect(answer).toEqual({
      status: 'error',
      reason: 'could not reach the Anthropic API',
      fatal: false,
    });
    expect(globalThis.__widedoorBlocked).toEqual(['fetch api.anthropic.com']);
  });
});
