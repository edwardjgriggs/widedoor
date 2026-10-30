import { describe, expect, it } from 'vitest';
import { EgressRefusedError, PinnedResolver } from '@widedoor/web/egress';
import {
  DNS_RESOLVER_OPTIONS,
  caresLookup,
  caresTxtLookup,
  type AddressResolver,
  type TxtResolver,
} from '../src/hosted/dns.ts';

/*
 * The hosted API's c-ares lookups over a fake Resolver: A and AAAA asked in
 * parallel, an empty answer for a name with neither, any other DNS failure
 * thrown, and the pinned resolver judging what it returns; and the TXT lookup
 * of domain verification.
 */

const dnsError = (code: string) => Object.assign(new Error(`query failed ${code}`), { code });

/** A fake Resolver whose answers are held until released, recording each query. */
function fakeResolver(answers: { v4: string[] | string; v6: string[] | string }) {
  const asked: string[] = [];
  const held: (() => void)[] = [];
  const answer = (value: string[] | string) =>
    new Promise<string[]>((done, fail) =>
      held.push(() => (typeof value === 'string' ? fail(dnsError(value)) : done(value))),
    );
  const resolver: AddressResolver = {
    resolve4: ((host: string) => {
      asked.push(`A ${host}`);
      return answer(answers.v4);
    }) as AddressResolver['resolve4'],
    resolve6: ((host: string) => {
      asked.push(`AAAA ${host}`);
      return answer(answers.v6);
    }) as AddressResolver['resolve6'],
  };
  return { resolver, asked, release: () => held.splice(0).forEach((go) => go()) };
}

describe('caresLookup', () => {
  it('asks A and AAAA in parallel and gives the A answers, then the AAAA answers', async () => {
    const fake = fakeResolver({ v4: ['93.184.215.14'], v6: ['2606:2800:21f:cb07::1'] });
    const pending = caresLookup(() => fake.resolver)('site.example.org');
    // Both queries are out before either answers.
    expect(fake.asked).toEqual(['A site.example.org', 'AAAA site.example.org']);
    fake.release();
    expect(await pending).toEqual([
      { address: '93.184.215.14', family: 4 },
      { address: '2606:2800:21f:cb07::1', family: 6 },
    ]);
  });

  it('takes a missing record type as an empty answer', async () => {
    for (const code of ['ENODATA', 'ENOTFOUND']) {
      const fake = fakeResolver({ v4: ['93.184.215.14'], v6: code });
      const pending = caresLookup(() => fake.resolver)('site.example.org');
      fake.release();
      expect(await pending).toEqual([{ address: '93.184.215.14', family: 4 }]);
    }
  });

  it('gives an empty answer for a name with neither, which the resolver refuses', async () => {
    const fake = fakeResolver({ v4: 'ENOTFOUND', v6: 'ENODATA' });
    const lookup = caresLookup(() => fake.resolver);
    const pending = lookup('nothing.example.org');
    fake.release();
    expect(await pending).toEqual([]);
    const refused = new PinnedResolver({ lookup }).resolve('nothing.example.org');
    await Promise.resolve();
    fake.release();
    await expect(refused).rejects.toThrow('refusing nothing.example.org: did not resolve');
  });

  it('throws any other DNS failure, which the resolver refuses as not resolving', async () => {
    for (const code of ['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED']) {
      const fake = fakeResolver({ v4: ['93.184.215.14'], v6: code });
      const pending = caresLookup(() => fake.resolver)('site.example.org');
      fake.release();
      await expect(pending).rejects.toMatchObject({ code });
      const refused = new PinnedResolver({ lookup: caresLookup(() => fake.resolver) }).resolve(
        'site.example.org',
      );
      await Promise.resolve();
      fake.release();
      await expect(refused).rejects.toBeInstanceOf(EgressRefusedError);
    }
  });

  it('lets the resolver refuse a private AAAA next to a public A', async () => {
    const fake = fakeResolver({ v4: ['93.184.215.14'], v6: ['fd00::1'] });
    const refused = new PinnedResolver({ lookup: caresLookup(() => fake.resolver) }).resolve(
      'site.example.org',
    );
    await Promise.resolve();
    fake.release();
    await expect(refused).rejects.toMatchObject({ blockReason: 'private' });
  });

  it('makes its Resolver with a 2 s timeout and 2 tries', () => {
    const made: unknown[] = [];
    const fake = fakeResolver({ v4: [], v6: [] });
    caresLookup((options) => {
      made.push(options);
      return fake.resolver;
    });
    expect(made).toEqual([{ timeout: 2000, tries: 2 }]);
    expect(DNS_RESOLVER_OPTIONS).toEqual({ timeout: 2000, tries: 2 });
    // The default makes a real node:dns Resolver.
    expect(typeof caresLookup()).toBe('function');
  });
});

describe('caresTxtLookup', () => {
  const txtResolver = (answer: string[][] | string, asked: string[] = []): TxtResolver => ({
    resolveTxt: ((name: string) => {
      asked.push(name);
      return typeof answer === 'string'
        ? Promise.reject(dnsError(answer))
        : Promise.resolve(answer);
    }) as TxtResolver['resolveTxt'],
  });

  it('gives the records, each as its chunks', async () => {
    const asked: string[] = [];
    const records = [['widedoor-verification=', 'abc'], ['v=spf1 -all']];
    const lookup = caresTxtLookup(() => txtResolver(records, asked));
    expect(await lookup('_widedoor-challenge.site.example.org')).toEqual(records);
    expect(asked).toEqual(['_widedoor-challenge.site.example.org']);
  });

  it('takes no record and no such name as an empty answer, and throws anything else', async () => {
    for (const code of ['ENODATA', 'ENOTFOUND'])
      expect(await caresTxtLookup(() => txtResolver(code))('a.example.org')).toEqual([]);
    for (const code of ['ESERVFAIL', 'ETIMEOUT', 'EREFUSED'])
      await expect(caresTxtLookup(() => txtResolver(code))('a.example.org')).rejects.toMatchObject({
        code,
      });
  });

  it('makes its Resolver with a 2 s timeout and 2 tries', () => {
    const made: unknown[] = [];
    caresTxtLookup((options) => {
      made.push(options);
      return txtResolver([]);
    });
    expect(made).toEqual([{ timeout: 2000, tries: 2 }]);
    expect(typeof caresTxtLookup()).toBe('function');
  });
});
