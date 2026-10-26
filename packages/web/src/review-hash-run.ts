import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(
  new URL(
    import.meta.url.endsWith('.ts') ? './review-hash-worker.ts' : './review-hash-worker.js',
    import.meta.url,
  ),
);

export interface ReviewHashRunOptions {
  /** Wall-clock budget for the normalizer, in milliseconds. Default 2000. */
  timeoutMs?: number;
  /** V8 old-generation heap cap of the worker, in MiB. Default 256. */
  maxHeapMb?: number;
}

export interface ReviewHashResult {
  hash: string;
  /** Why the hash is the content hash instead of the normalized one; absent when normalized. */
  fallback?: string;
}

/**
 * The hash a manual review is anchored to, for the bytes a page was served as.
 * The bytes are decoded as UTF-8; a document that is not valid UTF-8 (the
 * decoder would substitute U+FFFD) is not decoded by its declared charset but
 * anchored to the content hash. The normalizer runs in a worker with a time and
 * heap budget because parse5 is synchronous and quadratic on some inputs; on a
 * timeout, a worker failure or a document it refuses, the content hash is used
 * and `fallback` says why. Never throws, and the worker is gone when this settles.
 */
export async function reviewHashFor(
  bytes: Uint8Array,
  contentHash: string,
  options: ReviewHashRunOptions = {},
): Promise<ReviewHashResult> {
  const fallback = (why: string): ReviewHashResult => ({ hash: contentHash, fallback: why });
  const html = new TextDecoder('utf-8').decode(bytes);
  if (html.includes('�')) return fallback('the document is not valid UTF-8');

  const timeoutMs = options.timeoutMs ?? 2_000;
  let worker: Worker;
  try {
    worker = new Worker(workerPath, {
      workerData: html,
      resourceLimits: { maxOldGenerationSizeMb: options.maxHeapMb ?? 256 },
    });
  } catch {
    return fallback('the normalizer could not start');
  }
  const result = await new Promise<ReviewHashResult>((settle) => {
    const timer = setTimeout(
      () => settle(fallback(`normalizing took over ${timeoutMs} ms`)),
      timeoutMs,
    );
    const finish = (r: ReviewHashResult) => {
      clearTimeout(timer);
      settle(r);
    };
    worker.once('message', (m: { ok: boolean; hash?: string; message?: string }) =>
      finish(
        m.ok && typeof m.hash === 'string' && /^sha256:[0-9a-f]{64}$/.test(m.hash)
          ? { hash: m.hash }
          : fallback('the document could not be normalized'),
      ),
    );
    worker.once('error', () => finish(fallback('the normalizer failed')));
    worker.once('exit', () => finish(fallback('the normalizer exited early')));
  });
  await worker.terminate().catch(() => undefined);
  return result;
}
