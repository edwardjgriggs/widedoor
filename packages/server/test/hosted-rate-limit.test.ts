import { describe, expect, it } from 'vitest';
import {
  MAX_RATE_KEYS,
  RateLimiter,
  isClientIp,
  logPrefix,
  rateKey,
  takeAll,
  wideKey,
} from '../src/hosted/rate-limit.ts';

/*
 * The hosted API's rate limit: a sliding hour per IPv4 /32 or IPv6 /64, with
 * IPv4-mapped IPv6 the same client as plain IPv4, and a cap on the keys held;
 * the looser per-network key, and taking from two limiters at once.
 */

const HOUR = 60 * 60_000;

function limiter(perHour = 10) {
  let t = Date.UTC(2026, 9, 27, 12);
  const rate = new RateLimiter({ perHour, now: () => t });
  return { rate, advance: (ms: number) => void (t += ms) };
}

const takeN = (rate: RateLimiter, ip: string, n: number) =>
  Array.from({ length: n }, () => rate.take(ip));

describe('RateLimiter', () => {
  it('takes perHour requests in an hour and refuses the next with the wait in seconds', () => {
    const { rate, advance } = limiter();
    for (let i = 0; i < 10; i++) {
      expect(rate.take('198.51.100.7')).toEqual({ ok: true });
      advance(60_000);
    }
    // The first request was 10 minutes ago: it leaves the window in 50 minutes.
    expect(rate.take('198.51.100.7')).toEqual({ ok: false, retryAfterS: 50 * 60 });
    expect(rate.take('198.51.100.8')).toEqual({ ok: true });
  });

  it('slides: a request older than an hour no longer counts', () => {
    const { rate, advance } = limiter(2);
    rate.take('198.51.100.7');
    advance(30 * 60_000);
    rate.take('198.51.100.7');
    expect(rate.take('198.51.100.7').ok).toBe(false);
    advance(30 * 60_000 + 1);
    expect(rate.take('198.51.100.7').ok).toBe(true);
    expect(rate.take('198.51.100.7').ok).toBe(false);
    advance(HOUR);
    expect(rate.take('198.51.100.7').ok).toBe(true);
  });

  it('gives two IPv6 addresses in one /64 one bucket, and another /64 its own', () => {
    const { rate } = limiter();
    takeN(rate, '2001:db8:1:2::1', 5);
    takeN(rate, '2001:0db8:0001:0002:ffff:ffff:ffff:ffff', 5);
    expect(rate.take('2001:db8:1:2:abcd::9').ok).toBe(false);
    expect(rate.take('2001:db8:1:3::1').ok).toBe(true);
  });

  it('treats ::ffff:a.b.c.d (dotted or hex) as the plain IPv4 address', () => {
    const { rate } = limiter();
    takeN(rate, '198.51.100.7', 4);
    takeN(rate, '::ffff:198.51.100.7', 3);
    takeN(rate, '::ffff:c633:6407', 3);
    expect(rate.take('198.51.100.7').ok).toBe(false);
    expect(rate.take('198.51.100.6').ok).toBe(true);
  });

  it('holds at most MAX_RATE_KEYS keys, dropping the least recently used', () => {
    const { rate } = limiter(1);
    rate.take('10.0.0.0');
    for (let i = 1; i <= MAX_RATE_KEYS; i++)
      rate.take(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    expect(rate.size).toBe(MAX_RATE_KEYS);
    // The first key was dropped, so its client starts afresh; the newest is still held.
    expect(rate.take('10.0.0.0').ok).toBe(true);
    expect(
      rate.take(
        `10.${(MAX_RATE_KEYS >> 16) & 255}.${(MAX_RATE_KEYS >> 8) & 255}.${MAX_RATE_KEYS & 255}`,
      ).ok,
    ).toBe(false);
  });

  it('refuses a perHour that is not a positive integer', () => {
    expect(() => new RateLimiter({ perHour: 0 })).toThrow(RangeError);
    expect(() => new RateLimiter({ perHour: Number.NaN })).toThrow(RangeError);
    expect(() => new RateLimiter({ perHour: 30 })).not.toThrow();
  });
});

describe('client addresses', () => {
  it('keys IPv4 by /32 and IPv6 by /64, and names them in logs by /24 and /48', () => {
    expect(rateKey('198.51.100.7')).toBe('198.51.100.7');
    expect(logPrefix('198.51.100.7')).toBe('198.51.100.0');
    expect(rateKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::');
    expect(logPrefix('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1::');
    expect(rateKey('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(logPrefix('::')).toBe('0:0:0::');
  });

  it('takes only IP addresses, with no zone id', () => {
    for (const ip of ['198.51.100.7', '2001:db8::1', '::ffff:1.2.3.4'])
      expect(isClientIp(ip)).toBe(true);
    for (const bad of ['', 'test', '198.51.100.256', 'fe80::1%eth0', '[2001:db8::1]', ' 1.2.3.4'])
      expect(isClientIp(bad)).toBe(false);
  });
});

describe('wider buckets', () => {
  it('keys by IPv4 /24 and IPv6 /48 with wideKey', () => {
    let t = 0;
    const wide = new RateLimiter({ perHour: 3, keyOf: wideKey, now: () => t });
    for (const ip of ['198.51.100.1', '198.51.100.2', '::ffff:198.51.100.3'])
      expect(wide.take(ip)).toEqual({ ok: true });
    expect(wide.take('198.51.100.4').ok).toBe(false);
    expect(wide.take('198.51.101.1').ok).toBe(true);
    for (const ip of ['2001:db8:1:1::1', '2001:db8:1:2::1', '2001:db8:1:ffff::1'])
      expect(wide.take(ip).ok).toBe(true);
    expect(wide.take('2001:db8:1:abcd::1').ok).toBe(false);
    t += HOUR + 1;
    expect(wide.take('198.51.100.4').ok).toBe(true);
  });

  it('check counts nothing', () => {
    const { rate } = limiter(1);
    expect(rate.check('198.51.100.7')).toEqual({ ok: true });
    expect(rate.check('198.51.100.7')).toEqual({ ok: true });
    rate.take('198.51.100.7');
    expect(rate.check('198.51.100.7')).toEqual({ ok: false, retryAfterS: 3600 });
  });

  it('takeAll counts in every limiter or in none, with the longest wait', () => {
    let t = 0;
    const narrow = new RateLimiter({ perHour: 2, now: () => t });
    const wide = new RateLimiter({ perHour: 3, keyOf: wideKey, now: () => t });
    expect(takeAll([narrow, wide], '198.51.100.1')).toEqual({ ok: true });
    t += 1000;
    expect(takeAll([narrow, wide], '198.51.100.1')).toEqual({ ok: true });
    // The narrow bucket refuses: the wide one is not charged.
    expect(takeAll([narrow, wide], '198.51.100.1')).toEqual({ ok: false, retryAfterS: 3599 });
    expect(takeAll([narrow, wide], '198.51.100.2')).toEqual({ ok: true });
    expect(takeAll([narrow, wide], '198.51.100.3')).toEqual({ ok: false, retryAfterS: 3599 });
    // Neither was charged by the refusal: another /24 still has its whole bucket.
    expect(narrow.check('198.51.100.3')).toEqual({ ok: true });
  });
});
