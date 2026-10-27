import { describe, expect, it } from 'vitest';
import { JOB_THREW, Jobs, type JobContext, type JobEnd } from '../src/jobs.ts';

/*
 * Scan jobs: one at a time, random 128-bit ids, the five statuses, progress,
 * cancel through the job's AbortSignal, and only the last job's record kept.
 */

/** A job that runs until the test ends it (or its signal fires, when it honors it). */
function controlled(honorSignal = true) {
  let end: (value: JobEnd) => void = () => undefined;
  let context: JobContext | undefined;
  const work = (c: JobContext) =>
    new Promise<JobEnd>((done) => {
      context = c;
      end = done;
      if (honorSignal)
        c.signal.addEventListener('abort', () => done({ status: 'cancelled' }), { once: true });
    });
  return { work, end: (value: JobEnd) => end(value), context: () => context };
}

const tick = () => new Promise((done) => setTimeout(done, 0));

describe('Jobs', () => {
  it('starts a job queued with a random 128-bit hex id, then runs it to done', async () => {
    const jobs = new Jobs();
    const job = controlled();
    const view = jobs.start(job.work);
    expect(view).toMatchObject({ status: 'queued', progress: { done: 0, known: 0 } });
    expect(view?.id).toMatch(/^[0-9a-f]{32}$/);
    expect(jobs.busy).toBe(true);
    await tick();
    expect(jobs.get(view?.id ?? '')?.status).toBe('running');
    job.context()?.progress({ done: 1, known: 3, current: 'https://example.com/' });
    expect(jobs.get(view?.id ?? '')?.progress).toEqual({
      done: 1,
      known: 3,
      current: 'https://example.com/',
    });
    job.end({ status: 'done' });
    await jobs.idle();
    const done = jobs.get(view?.id ?? '');
    expect(done?.status).toBe('done');
    expect(done?.finishedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(jobs.busy).toBe(false);
  });

  it('gives each job its own id', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const jobs = new Jobs();
      ids.add(jobs.start(async () => ({ status: 'done' }))?.id ?? '');
    }
    expect(ids.size).toBe(20);
  });

  it('refuses a second start while one is queued or running', async () => {
    const jobs = new Jobs();
    const job = controlled();
    expect(jobs.start(job.work)).toBeDefined();
    expect(jobs.start(job.work)).toBeUndefined();
    await tick();
    expect(jobs.start(job.work)).toBeUndefined();
    job.end({ status: 'done' });
    await jobs.idle();
    expect(jobs.start(async () => ({ status: 'done' }))).toBeDefined();
  });

  it('keeps only the last job, and knows no other id', async () => {
    const jobs = new Jobs();
    const first = jobs.start(async () => ({ status: 'done' }));
    await jobs.idle();
    const second = jobs.start(async () => ({ status: 'done' }));
    await jobs.idle();
    expect(jobs.get(first?.id ?? '')).toBeUndefined();
    expect(jobs.get(second?.id ?? '')?.status).toBe('done');
    expect(jobs.get('0'.repeat(32))).toBeUndefined();
  });

  it('records a failure with its message, and a throw as failed with its cause for the log only', async () => {
    const causes: (string | undefined)[] = [];
    const jobs = new Jobs((_, cause) => void causes.push(cause));
    const failed = jobs.start(async () => ({ status: 'failed', error: 'the scan could not run' }));
    await jobs.idle();
    expect(jobs.get(failed?.id ?? '')).toMatchObject({
      status: 'failed',
      error: 'the scan could not run',
    });
    const thrown = jobs.start(async () => {
      throw new Error("ENOENT: no such file, open 'C:\\Users\\ann\\x.pdf' \u001b[31m\nsecond line");
    });
    await jobs.idle();
    const view = jobs.get(thrown?.id ?? '');
    expect(view?.status).toBe('failed');
    // The cause may name local paths: the page gets a fixed sentence, the log the cause, escaped.
    expect(view?.error).toBe(JOB_THREW);
    expect(causes).toEqual([
      'the scan could not run',
      "the scan failed: ENOENT: no such file, open 'C:\\Users\\ann\\x.pdf' \\x1b[31m",
    ]);
    const withCause = jobs.start(async () => ({
      status: 'failed',
      error: 'x.pdf could not be read',
      cause: 'C:\\Users\\ann\\x.pdf could not be read',
    }));
    await jobs.idle();
    expect(jobs.get(withCause?.id ?? '')?.error).toBe('x.pdf could not be read');
    expect(causes.at(-1)).toBe('C:\\Users\\ann\\x.pdf could not be read');
  });

  it('cancels a running job through its signal', async () => {
    const jobs = new Jobs();
    const job = controlled();
    const view = jobs.start(job.work);
    await tick();
    const cancelling = jobs.cancel(view?.id ?? '');
    expect(cancelling).toMatchObject({ cancelling: true });
    expect(job.context()?.signal.aborted).toBe(true);
    await jobs.idle();
    const over = jobs.get(view?.id ?? '');
    expect(over?.status).toBe('cancelled');
    expect(over?.cancelling).toBeUndefined();
    expect(jobs.cancel(view?.id ?? '')).toBe('over');
    expect(jobs.cancel('f'.repeat(32))).toBe('unknown');
  });

  it('cancels a queued job before it runs', async () => {
    const jobs = new Jobs();
    let ran = false;
    const view = jobs.start(async () => {
      ran = true;
      return { status: 'done' };
    });
    jobs.cancel(view?.id ?? '');
    await jobs.idle();
    expect(ran).toBe(false);
    expect(jobs.get(view?.id ?? '')?.status).toBe('cancelled');
  });

  it('ends a job that throws after its signal fired as cancelled, and ignores late progress', async () => {
    const jobs = new Jobs();
    let context: JobContext | undefined;
    const view = jobs.start(async (c): Promise<JobEnd> => {
      context = c;
      await new Promise((done) => c.signal.addEventListener('abort', done, { once: true }));
      throw new Error('browser closed');
    });
    await tick();
    jobs.abort();
    await jobs.idle();
    expect(jobs.get(view?.id ?? '')?.status).toBe('cancelled');
    context?.progress({ done: 9, known: 9 });
    expect(jobs.get(view?.id ?? '')?.progress).toEqual({ done: 0, known: 0 });
  });

  it('tells onEnd once per job, and a throwing onEnd changes nothing', async () => {
    const ended: string[] = [];
    const jobs = new Jobs((view) => {
      ended.push(view.status);
      throw new Error('the log sink is broken');
    });
    const done = jobs.start(async () => ({ status: 'done' }));
    await jobs.idle();
    expect(jobs.get(done?.id ?? '')?.status).toBe('done');
    const failed = jobs.start(async () => ({ status: 'failed', error: 'no browser' }));
    await jobs.idle();
    expect(jobs.get(failed?.id ?? '')).toMatchObject({ status: 'failed', error: 'no browser' });
    expect(ended).toEqual(['done', 'failed']);
  });

  it('hands out copies, so a caller cannot change the record', async () => {
    const jobs = new Jobs();
    const view = jobs.start(async () => ({ status: 'done' }));
    await jobs.idle();
    const copy = jobs.get(view?.id ?? '');
    if (copy) {
      copy.status = 'failed';
      copy.progress.done = 99;
    }
    expect(jobs.get(view?.id ?? '')).toMatchObject({ status: 'done', progress: { done: 0 } });
  });
});
