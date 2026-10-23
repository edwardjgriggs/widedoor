import { describe, expect, it } from 'vitest';
import {
  ProcessTracker,
  containerPrefix,
  hostTag,
  listArgs,
  parseContainerRows,
  staleContainers,
} from '../src/lifecycle.ts';

describe('container names', () => {
  it('names containers by a hashed host tag and the process id, within the runner limits', () => {
    const tag = hostTag('build-host');
    expect(tag).toMatch(/^[0-9a-f]{8}$/);
    expect(containerPrefix(1234, tag)).toBe(`widedoor-verapdf-h${tag}-p1234`);
    // The pdf runner accepts prefixes of at most 48 lowercase characters.
    expect(containerPrefix(4_294_967_295)).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/);
    expect(containerPrefix()).not.toContain('build-host');
  });

  it('lists only labeled containers, and only one run when given its prefix', () => {
    expect(listArgs()).toEqual([
      'ps',
      '--all',
      '--no-trunc',
      '--filter',
      'label=io.widedoor.verapdf=1',
      '--format',
      '{{.ID}}\t{{.Names}}\t{{.State}}',
    ]);
    expect(listArgs('widedoor-verapdf-habc-p1').slice(-2)).toEqual([
      '--filter',
      'name=widedoor-verapdf-habc-p1-',
    ]);
  });

  it('parses docker ps rows', () => {
    expect(parseContainerRows('a1\tone\trunning\r\n\nb2\ttwo\texited\nbroken\n')).toEqual([
      { id: 'a1', name: 'one', state: 'running' },
      { id: 'b2', name: 'two', state: 'exited' },
    ]);
  });
});

describe('staleContainers', () => {
  const host = 'deadbeef';
  const live = new Set([100]);
  const alive = (pid: number) => live.has(pid);
  const row = (id: string, name: string, state = 'running') => ({ id, name, state });

  it('removes containers this host named for dead processes, and others only once exited or dead', () => {
    expect(
      staleContainers(
        [
          row('live', `widedoor-verapdf-h${host}-p100-u1`),
          row('dead', `widedoor-verapdf-h${host}-p200-u2`),
          row('dead-exited', `widedoor-verapdf-h${host}-p300-u3`, 'exited'),
          row('other-host', 'widedoor-verapdf-h00000000-p200-u4'),
          row('other-host-exited', 'widedoor-verapdf-h00000000-p200-u5', 'exited'),
          row('library', 'widedoor-verapdf-6c1f', 'running'),
          row('library-created', 'widedoor-verapdf-77aa', 'created'),
          row('library-paused', 'widedoor-verapdf-88bb', 'paused'),
          row('library-exited', 'widedoor-verapdf-99cc', 'exited'),
          row('library-dead', 'widedoor-verapdf-aadd', 'dead'),
        ],
        host,
        alive,
      ),
    ).toEqual(['dead', 'dead-exited', 'other-host-exited', 'library-exited', 'library-dead']);
  });
});

describe('ProcessTracker', () => {
  it('kills the live processes it started and refuses new ones after stop', async () => {
    const tracker = new ProcessTracker();
    const child = tracker.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const exited = new Promise((done) => child.once('exit', done));
    expect(tracker.size).toBe(1);
    tracker.stop();
    await exited;
    expect(tracker.size).toBe(0);
    expect(() => tracker.spawn(process.execPath, ['-e', ''], {})).toThrow(/stopping/);
  });

  it('forgets processes that exit on their own', async () => {
    const tracker = new ProcessTracker();
    const child = tracker.spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((done) => child.once('exit', done));
    expect(tracker.size).toBe(0);
  });
});
