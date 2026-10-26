import { parentPort, workerData } from 'node:worker_threads';

/*
 * Runs reviewHashOf off the main thread, so a document that sends parse5 into
 * quadratic work can be terminated by the host. This file must stay loadable by
 * Node's type stripping (tests run it from source): type-only imports, no enums.
 */

// Tests run the sources, where the module is a .ts file.
const mod = (await import(
  import.meta.url.endsWith('.ts') ? './review-hash.ts' : './review-hash.js'
)) as typeof import('./review-hash.js');

try {
  parentPort?.postMessage({ ok: true, hash: mod.reviewHashOf(workerData as string) });
} catch (e) {
  parentPort?.postMessage({ ok: false, message: String((e as Error)?.message ?? e) });
}
