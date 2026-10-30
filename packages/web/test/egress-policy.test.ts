import { describe, expect, it } from 'vitest';
import { BLOCKED_V4, BLOCKED_V6, checkTarget, classifyAddress } from '../src/egress/policy.js';
import { EgressRefusedError } from '../src/fetch.js';

describe('classifyAddress', () => {
  it.each(['93.184.215.14', '1.1.1.1', '2606:4700:4700::1111'])('classifies %s as ok', (ip) => {
    expect(classifyAddress(ip)).toEqual({ ok: true });
  });

  it.each([
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['192.168.1.1', 'private'],
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'metadata'],
    ['169.254.1.1', 'link-local'],
    ['100.64.0.1', 'cgnat'],
    ['100.100.100.200', 'metadata'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['0.0.0.0', 'unspecified'],
    ['198.18.0.1', 'reserved'],
    ['192.0.2.1', 'reserved'],
    ['203.0.113.9', 'reserved'],
  ])('blocks IPv4 %s as %s', (ip, reason) => {
    expect(classifyAddress(ip)).toEqual({ ok: false, reason });
  });

  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fdaa::3', 'private'],
    ['fd00:ec2::254', 'metadata'],
    ['FD00:EC2:0:0:0:0:0:254', 'metadata'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'reserved'],
  ])('blocks IPv6 %s as %s', (ip, reason) => {
    expect(classifyAddress(ip)).toEqual({ ok: false, reason });
  });

  it.each([
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:a9fe:a9fe', 'metadata'],
    ['64:ff9b::7f00:1', 'reserved'],
    ['2002:7f00:1::', 'reserved'],
    ['2001:0:4136:e378::1', 'reserved'],
    ['::10.0.0.1', 'reserved'],
  ])('unwraps or blocks IPv6 form %s', (ip, reason) => {
    expect(classifyAddress(ip)).toEqual({ ok: false, reason });
  });

  it('allows a mapped public IPv4 address', () => {
    expect(classifyAddress('::ffff:93.184.215.14')).toEqual({ ok: true });
  });

  it.each(['example.org', '127.1', '', 'fe80::1%eth0', '1.2.3.256'])(
    'throws TypeError for %j',
    (text) => {
      expect(() => classifyAddress(text)).toThrow(TypeError);
    },
  );

  it.each([
    '100.63.255.255',
    '100.128.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '198.17.255.255',
    '198.20.0.1',
    '11.0.0.1',
    '2000::1',
    '2001:4860:4860::8888',
    '2001:200::1',
    '3fff:1000::1',
  ])('keeps %s just outside a blocked range ok', (ip) => {
    expect(classifyAddress(ip)).toEqual({ ok: true });
  });

  it.each([
    ['172.31.255.255', 'private'],
    ['100.127.255.255', 'cgnat'],
    ['198.19.255.255', 'reserved'],
    ['192.88.99.1', 'reserved'],
    ['192.0.0.1', 'reserved'],
    ['198.51.100.1', 'reserved'],
    ['240.0.0.1', 'reserved'],
    ['1fff:ffff::1', 'reserved'],
    ['3fff:fff::1', 'reserved'],
    ['64:ff9b:1::1', 'reserved'],
  ])('blocks %s at the edge of a range as %s', (ip, reason) => {
    expect(classifyAddress(ip)).toEqual({ ok: false, reason });
  });

  it('exports the CIDR tables', () => {
    expect(BLOCKED_V4).toContain('100.64.0.0/10');
    expect(BLOCKED_V6).toContain('2002::/16');
  });
});

describe('checkTarget', () => {
  it.each([
    'ftp://a.com/',
    'http://a.com:8080/',
    'http://localhost/',
    'http://localhost./',
    'http://localhost../',
    'http://intranet../',
    'http://printer.local../',
    'http://a..com/',
    'http://app.localhost/',
    'http://printer.local/',
    'http://api.internal/',
    'http://widedoor.flycast/',
    'http://router.home.arpa/',
    'http://x.onion/',
    'http://a.test/',
    'http://a.invalid/',
    'http://a.example/',
    'http://intranet/',
    'http://u:p@a.com/',
    'http://u@a.com/',
    'http://127.1/',
    'http://0x7f000001/',
    'http://2130706433/',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'http://169.254.169.254/latest/meta-data',
  ])('refuses %s', (text) => {
    expect(() => checkTarget(new URL(text))).toThrow(EgressRefusedError);
  });

  it.each([
    'https://example.org/',
    'http://example.org:80/',
    'https://93.184.215.14/',
    'https://[2606:4700:4700::1111]/',
  ])('accepts %s', (text) => {
    expect(() => checkTarget(new URL(text))).not.toThrow();
  });

  it('reports the scheme reason for a non-http scheme and policy otherwise', () => {
    expect.assertions(2);
    try {
      checkTarget(new URL('ftp://a.com/'));
    } catch (error) {
      expect((error as EgressRefusedError).reason).toBe('scheme');
    }
    try {
      checkTarget(new URL('http://10.0.0.1/'));
    } catch (error) {
      expect((error as EgressRefusedError).reason).toBe('policy');
    }
  });

  it('names the host and never the path, query or credentials', () => {
    expect.assertions(3);
    try {
      checkTarget(new URL('http://user:secret@10.0.0.1/private/path?token=abc'));
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('10.0.0.1');
      expect(message).not.toMatch(/secret|token|private\/path/);
      expect(message).not.toContain('user');
    }
  });
});

describe('EgressRefusedError.blockReason', () => {
  const cases = [
    ['ftp://example.org/', 'scheme'],
    ['http://example.org:8080/', 'port'],
    ['http://user:pw@example.org/', 'credentials'],
    ['http://10.0.0.1/', 'private'],
    ['http://169.254.169.254/', 'metadata'],
    ['http://[::1]/', 'loopback'],
    ['http://metadata.internal/', 'host-name'],
    ['http://intranet/', 'host-name'],
  ] as const;
  it.each(cases)('%s is tagged %s', (text, blockReason) => {
    let caught: unknown;
    try {
      checkTarget(new URL(text));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EgressRefusedError);
    expect((caught as EgressRefusedError).blockReason).toBe(blockReason);
  });
});
