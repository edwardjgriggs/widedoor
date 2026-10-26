import { randomBytes } from 'node:crypto';
import { firstLine, safeText } from '@widedoor/core';

/*
 * Scan jobs of widedoor ui: one at a time, each with a random 128-bit id,
 * a status, its progress, and a cancel that fires the job's AbortSignal.
 * Only the last job's record is kept.
 */

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobProgress {
  /** Assets done. */
  done: number;
  /** Assets known so far (a crawl and PDFs found on pages add more). */
  known: number;
  /** The asset just started: a URL, or a PDF's name. */
  current?: string;
}

export interface JobView {
  id: string;
  status: JobStatus;
  progress: JobProgress;
  /** Why the job failed (failed only). */
  error?: string;
  /** True once a cancel was asked for and the job has not ended yet. */
  cancelling?: boolean;
  startedAt: string;
  finishedAt?: string;
}

export interface JobContext {
  signal: AbortSignal;
  progress(progress: JobProgress): void;
}

/**
 * How a job ended. A job whose signal fired should end cancelled once it has
 * stopped; one past the point of no return (writing its reports) may still
 * end done. A job that throws after its signal fired ends cancelled.
 */
export type JobEnd =
  { status: 'done' } | { status: 'failed'; error: string } | { status: 'cancelled' };

interface Job {
  view: JobView;
  stop: AbortController;
  ended: Promise<void>;
}

const isOver = (status: JobStatus) => status !== 'queued' && status !== 'running';

export class Jobs {
  private last: Job | undefined;

  /** onEnd is told each job's view once it has ended (done, failed or cancelled). */
  constructor(private readonly onEnd?: (view: JobView) => void) {}

  /** Whether a job is queued or running. */
  get busy(): boolean {
    return this.last !== undefined && !isOver(this.last.view.status);
  }

  /** Starts work as the next job and returns its view, or undefined while another runs. */
  start(work: (context: JobContext) => Promise<JobEnd>): JobView | undefined {
    if (this.busy) return undefined;
    const stop = new AbortController();
    const view: JobView = {
      id: randomBytes(16).toString('hex'),
      status: 'queued',
      progress: { done: 0, known: 0 },
      startedAt: new Date().toISOString(),
    };
    const finish = (end: JobEnd) => {
      delete view.cancelling;
      view.status = end.status;
      if (end.status === 'failed') view.error = end.error;
      view.finishedAt = new Date().toISOString();
      try {
        this.onEnd?.(this.snapshot(view));
      } catch {
        // A failing log sink must not end the job a second time or change how it ended.
      }
    };
    const ended = (async () => {
      // Started on the next turn, so the caller sees the job queued first.
      await Promise.resolve();
      if (stop.signal.aborted) return finish({ status: 'cancelled' });
      view.status = 'running';
      try {
        finish(
          await work({
            signal: stop.signal,
            progress: (p) => {
              if (!isOver(view.status)) view.progress = { ...p };
            },
          }),
        );
      } catch (e) {
        finish(
          stop.signal.aborted
            ? { status: 'cancelled' }
            : { status: 'failed', error: `the scan failed: ${safeText(firstLine(e), 1000)}` },
        );
      }
    })();
    this.last = { view, stop, ended };
    return this.snapshot(view);
  }

  /** The job's view; undefined for an id that is not the last job's. */
  get(id: string): JobView | undefined {
    return this.last?.view.id === id ? this.snapshot(this.last.view) : undefined;
  }

  /** Cancels a queued or running job: 'unknown' id, 'over' when it has ended, else its view. */
  cancel(id: string): JobView | 'unknown' | 'over' {
    const job = this.last;
    if (job?.view.id !== id) return 'unknown';
    if (isOver(job.view.status)) return 'over';
    job.view.cancelling = true;
    job.stop.abort();
    return this.snapshot(job.view);
  }

  /** Fires the running job's signal (synchronously, for an exit handler). */
  abort(): void {
    if (this.busy) this.last?.stop.abort();
  }

  /** Resolves once no job runs. */
  async idle(): Promise<void> {
    await this.last?.ended;
  }

  private snapshot(view: JobView): JobView {
    return { ...view, progress: { ...view.progress } };
  }
}
