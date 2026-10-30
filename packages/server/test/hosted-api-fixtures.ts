import {
  FlyError,
  type FlyClient,
  type ScanMachine,
  type ScanMachineSpec,
} from '../src/hosted/fly.ts';
import type { Scheduler } from '../src/hosted/jobs.ts';

/*
 * Shared by the hosted API tests: a fake clock and scheduler, and a fake
 * Machines API. No test reaches the real one.
 */

/** A clock and a scheduler that run only when advanced. */
export class FakeClock {
  t = Date.UTC(2026, 9, 27, 12);
  private timers: { at: number; fire: () => void; live: boolean }[] = [];
  now = () => this.t;
  schedule: Scheduler = (fire, ms) => {
    const timer = { at: this.t + ms, fire, live: true };
    this.timers.push(timer);
    return () => void (timer.live = false);
  };
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.live && timer.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      due.live = false;
      this.t = due.at;
      due.fire();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

/** Lets pending promise callbacks run. */
export const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
};

/** A fake Machines API: records creates and destroys; create and list can be swapped. */
export function fakeFly() {
  const created: ScanMachineSpec[] = [];
  const destroyed: string[] = [];
  const lists: number[] = [];
  const fake = {
    created,
    destroyed,
    lists,
    machines: [] as ScanMachine[],
    create: (spec: ScanMachineSpec): Promise<{ id: string }> =>
      Promise.resolve({ id: `m${spec.jobId.slice(0, 8)}` }),
    list: (): Promise<ScanMachine[]> => Promise.resolve(fake.machines),
    destroyError: undefined as FlyError | undefined,
    destroyGone: false,
    /** What countForeignMachines answers. */
    foreign: (): Promise<number> => Promise.resolve(0),
  };
  const client: FlyClient = {
    createScanMachine: (spec) => {
      created.push(spec);
      return fake.create(spec);
    },
    destroy: (id) => {
      destroyed.push(id);
      return fake.destroyError
        ? Promise.reject(fake.destroyError)
        : Promise.resolve({ status: fake.destroyGone ? (404 as const) : (200 as const) });
    },
    listScanMachines: () => {
      lists.push(lists.length);
      return fake.list();
    },
    countForeignMachines: () => fake.foreign(),
  };
  return { ...fake, fake, client };
}
