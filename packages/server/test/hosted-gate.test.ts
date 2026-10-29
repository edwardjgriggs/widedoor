import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gate } from '../src/hosted/gate.ts';

/*
 * The control app's result gate, on fake timers: one holder, waiters admitted
 * in arrival order, a waiter that runs out of time removed and never admitted,
 * and a leave that works only once.
 */

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

/** Enters and records when (and whether) the entry resolves. */
function track(gate: Gate, name: string, ms: number, order: string[]) {
  const entry = { leave: undefined as (() => void) | undefined, settled: false };
  void gate.enter(ms).then((leave) => {
    entry.settled = true;
    entry.leave = leave;
    order.push(leave ? name : `${name} timed out`);
  });
  return entry;
}

describe('Gate', () => {
  it('admits one holder and lets waiters in first come, first served', async () => {
    const gate = new Gate();
    const order: string[] = [];
    const a = track(gate, 'a', 1_000, order);
    await vi.advanceTimersByTimeAsync(0);
    const b = track(gate, 'b', 1_000, order);
    const c = track(gate, 'c', 1_000, order);
    const d = track(gate, 'd', 1_000, order);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['a']);
    a.leave?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['a', 'b']);
    b.leave?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.settled).toBe(true);
    c.leave?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    d.leave?.();
    // Open again: the next entry is admitted at once.
    const e = track(gate, 'e', 0, order);
    await vi.advanceTimersByTimeAsync(0);
    expect(e.leave).toBeDefined();
  });

  it('removes a waiter that runs out of time and never admits it', async () => {
    const gate = new Gate();
    const order: string[] = [];
    const a = track(gate, 'a', 1_000, order);
    await vi.advanceTimersByTimeAsync(0);
    const b = track(gate, 'b', 100, order);
    track(gate, 'c', 1_000, order);
    await vi.advanceTimersByTimeAsync(99);
    expect(b.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(['a', 'b timed out']);
    expect(b.leave).toBeUndefined();
    a.leave?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['a', 'b timed out', 'c']);
    // c's own timer was cleared on admission: it never also times out.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(order).toEqual(['a', 'b timed out', 'c']);
  });

  it('lets a leave work once: a second call admits no one else', async () => {
    const gate = new Gate();
    const order: string[] = [];
    const a = track(gate, 'a', 1_000, order);
    await vi.advanceTimersByTimeAsync(0);
    track(gate, 'b', 1_000, order);
    track(gate, 'c', 1_000, order);
    a.leave?.();
    a.leave?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['a', 'b']);
    // c is still waiting, and times out rather than being let in by the repeated leave.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(order).toEqual(['a', 'b', 'c timed out']);
  });
});
