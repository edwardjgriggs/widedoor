import { describe, expect, it } from 'vitest';
import { EgressRefusedError } from '../src/fetch.js';
import { PinnedResolver, type LookupFn } from '../src/egress/resolver.js';

type Answer = { address: string; family: 4 | 6 }[];

function fakeLookup(...answers: Answer[]): { lookup: LookupFn; calls: () => number } {
  let calls = 0;
  const lookup: LookupFn = async () => {
    const answer = answers[Math.min(calls, answers.length - 1)] ?? [];
    calls += 1;
    return answer;
  };
  return { lookup, calls: () => calls };
}

const v4 = (address: string): Answer[number] => ({ address, family: 4 });

describe('PinnedResolver', () => {
  it('pins the first answer', async () => {
    const fake = fakeLookup([v4('93.184.215.14')], [v4('127.0.0.1')]);
    const resolver = new PinnedResolver({ lookup: fake.lookup });
    expect(await resolver.resolve('a.example.org')).toBe('93.184.215.14');
    expect(await resolver.resolve('a.example.org')).toBe('93.184.215.14');
    expect(fake.calls()).toBe(1);
  });

  it('shares one lookup between concurrent calls', async () => {
    const fake = fakeLookup([v4('93.184.215.14')]);
    const resolver = new PinnedResolver({ lookup: fake.lookup });
    const results = await Promise.all([
      resolver.resolve('a.example.org'),
      resolver.resolve('a.example.org'),
    ]);
    expect(results).toEqual(['93.184.215.14', '93.184.215.14']);
    expect(fake.calls()).toBe(1);
  });

  it('shares one pin between bracketed, dotted and mixed-case spellings', async () => {
    const fake = fakeLookup([v4('93.184.215.14')]);
    const resolver = new PinnedResolver({ lookup: fake.lookup });
    await resolver.resolve('a.example.org');
    await resolver.resolve('a.example.org.');
    await resolver.resolve('A.Example.ORG');
    expect(fake.calls()).toBe(1);
  });

  it('refuses a mixed answer', async () => {
    const fake = fakeLookup([v4('93.184.215.14'), v4('10.0.0.5')]);
    const resolver = new PinnedResolver({ lookup: fake.lookup });
    const failure = resolver.resolve('a.example.org');
    await expect(failure).rejects.toBeInstanceOf(EgressRefusedError);
    await expect(failure).rejects.toThrow(/a\.example\.org.*private/);
  });

  it('remembers a refusal', async () => {
    const fake = fakeLookup([v4('10.0.0.5')], [v4('93.184.215.14')]);
    const resolver = new PinnedResolver({ lookup: fake.lookup });
    const first = await resolver.resolve('a.example.org').catch((e: unknown) => e);
    const second = await resolver.resolve('a.example.org').catch((e: unknown) => e);
    expect(first).toBeInstanceOf(EgressRefusedError);
    expect((second as Error).message).toBe((first as Error).message);
    expect(fake.calls()).toBe(1);
  });

  it('refuses an empty answer', async () => {
    const resolver = new PinnedResolver({ lookup: fakeLookup([]).lookup });
    await expect(resolver.resolve('a.example.org')).rejects.toThrow(/did not resolve/);
  });

  it('refuses when the lookup fails', async () => {
    const lookup: LookupFn = () => Promise.reject(new Error('ENOTFOUND'));
    const resolver = new PinnedResolver({ lookup });
    await expect(resolver.resolve('a.example.org')).rejects.toThrow(/did not resolve/);
  });

  it('refuses a scoped IPv6 answer', async () => {
    const fake = fakeLookup([{ address: 'fe80::1%eth0', family: 6 }]);
    const resolver = new PinnedResolver({ lookup: fake.lookup });
    const failure = resolver.resolve('a.example.org');
    await expect(failure).rejects.toBeInstanceOf(EgressRefusedError);
    await expect(failure).rejects.toThrow(/a\.example\.org/);
  });

  it('times out', async () => {
    const lookup: LookupFn = () => new Promise(() => undefined);
    const resolver = new PinnedResolver({ lookup, timeoutMs: 20 });
    await expect(resolver.resolve('a.example.org')).rejects.toThrow(/did not resolve/);
  });

  it('does not look up refused names', async () => {
    const fake = fakeLookup([v4('93.184.215.14')]);
    const resolver = new PinnedResolver({ lookup: fake.lookup });
    for (const name of [
      'widedoor-api.internal',
      'widedoor.flycast',
      'intranet',
      'localhost.',
      '',
    ]) {
      await expect(resolver.resolve(name)).rejects.toBeInstanceOf(EgressRefusedError);
      await expect(resolver.resolve(name)).rejects.toThrow(/refusing/);
    }
    expect(fake.calls()).toBe(0);
  });

  it('ignores an answer that arrives after the timeout', async () => {
    let calls = 0;
    const lookup: LookupFn = () => {
      calls += 1;
      return new Promise((resolve) => setTimeout(() => resolve([v4('93.184.215.14')]), 50));
    };
    const resolver = new PinnedResolver({ lookup, timeoutMs: 20 });
    const first = await resolver.resolve('a.example.org').catch((e: unknown) => e);
    expect((first as Error).message).toMatch(/did not resolve/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = await resolver.resolve('a.example.org').catch((e: unknown) => e);
    expect((second as Error).message).toBe((first as Error).message);
    expect(calls).toBe(1);
  });

  it('passes IP literals through the policy', async () => {
    const fake = fakeLookup([v4('93.184.215.14')]);
    const resolver = new PinnedResolver({ lookup: fake.lookup });
    await expect(resolver.resolve('[::1]')).rejects.toBeInstanceOf(EgressRefusedError);
    expect(await resolver.resolve('93.184.215.14')).toBe('93.184.215.14');
    expect(fake.calls()).toBe(0);
  });

  it('refuses a new name past maxHosts without a lookup and keeps the pinned ones', async () => {
    const fake = fakeLookup([v4('93.184.215.14')]);
    const resolver = new PinnedResolver({ lookup: fake.lookup, maxHosts: 3 });
    for (const host of ['a.example.org', 'b.example.org', 'c.example.org'])
      expect(await resolver.resolve(host)).toBe('93.184.215.14');
    const refused = await resolver.resolve('d.example.org').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(EgressRefusedError);
    expect(refused).toMatchObject({
      reason: 'policy',
      blockReason: 'host-limit',
      message: 'too many distinct hosts in one scan',
    });
    expect(fake.calls()).toBe(3);
    // Pinned names and IP literals still work, and the refused name is not pinned.
    for (const host of ['a.example.org', 'B.example.org.', 'c.example.org'])
      expect(await resolver.resolve(host)).toBe('93.184.215.14');
    for (let i = 1; i <= 5; i += 1)
      expect(await resolver.resolve(`93.184.215.${i}`)).toBe(`93.184.215.${i}`);
    await expect(resolver.resolve('d.example.org')).rejects.toMatchObject({
      blockReason: 'host-limit',
    });
    expect(fake.calls()).toBe(3);
  });

  it('refuses a maxHosts that would switch the cap off', () => {
    for (const maxHosts of [Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY])
      expect(() => new PinnedResolver({ maxHosts }), String(maxHosts)).toThrow(RangeError);
  });
});

describe('PinnedResolver block reasons', () => {
  it('tags each refusal', async () => {
    const reasonOf = (promise: Promise<string>): Promise<unknown> =>
      promise.then(
        () => undefined,
        (error: unknown) => (error instanceof EgressRefusedError ? error.blockReason : error),
      );
    const resolver = new PinnedResolver({
      lookup: async (host) => (host === 'lan.example.org' ? [v4('192.168.1.1')] : []),
    });
    expect(await reasonOf(resolver.resolve('lan.example.org'))).toBe('private');
    expect(await reasonOf(resolver.resolve('gone.example.org'))).toBe('unresolved');
    expect(await reasonOf(resolver.resolve('db.internal'))).toBe('host-name');
    expect(await reasonOf(resolver.resolve('127.0.0.1'))).toBe('loopback');
  });
});
