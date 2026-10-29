/*
 * The control app's result gate: one result PUT is read, parsed and rendered
 * at a time, so only one result is held in transit. The others wait in
 * arrival order, each for at most its own time; one that runs out of time
 * leaves the queue and is never admitted.
 */

/** One holder at a time; the others wait in order, each for at most its own time. */
export class Gate {
  private held = false;
  private readonly waiting: ((leave: () => void) => void)[] = [];

  /** Resolves with the function that lets the next one in, or undefined if ms passed first. */
  enter(ms: number): Promise<(() => void) | undefined> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve(this.pass());
    }
    return new Promise((done) => {
      const admit = (leave: () => void) => {
        clearTimeout(timer);
        done(leave);
      };
      const timer = setTimeout(
        () => {
          this.waiting.splice(this.waiting.indexOf(admit), 1);
          done(undefined);
        },
        Math.max(0, ms),
      );
      this.waiting.push(admit);
    });
  }

  /** A leave that works once: it hands the gate to the next waiter, or opens it. */
  private pass(): () => void {
    let left = false;
    return () => {
      if (left) return;
      left = true;
      const next = this.waiting.shift();
      if (next) next(this.pass());
      else this.held = false;
    };
  }
}
