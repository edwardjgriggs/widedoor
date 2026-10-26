import type { Finding } from '@widedoor/core';
import {
  OutputError,
  evidencePath,
  isRestricted,
  onStop,
  performScan,
  prepareOut,
  writeReports,
  type ScanPlan,
} from '@widedoor/server';
import { EXIT_ERROR, exitDecision } from './policy.js';
import { printSummary } from './summary.js';
import { firstLine, safeText } from './text.js';
import type { Io } from './main.js';

/**
 * Runs the scan a plan describes (performScan), writes the reports, prints
 * the summary and returns the exit code. The report folder is prepared
 * first, so a folder that cannot be used stops the run before any scan. A
 * stop signal cancels the scan through performScan's signal, which kills its
 * processes and removes its containers, and exits 2 with no report written.
 */
export async function runScan(
  plan: ScanPlan,
  reviews: readonly Finding[],
  io: Io,
): Promise<number> {
  const stop = new AbortController();
  let stopping = false;
  const dispose = onStop(
    (signal) => {
      if (stopping) return;
      stopping = true;
      io.err(`widedoor: interrupted (${signal}); stopping the scan. No report was written.`);
      dispose();
      stop.abort();
      process.exit(EXIT_ERROR);
    },
    () => stop.abort(),
  );
  try {
    const restricted = isRestricted(plan);
    // Signed-in pages put the user's data in screenshots and reports: keep them private.
    try {
      await prepareOut(plan.out, restricted, plan.outRoots);
    } catch (e) {
      if (!(e instanceof OutputError)) throw e;
      io.err(`widedoor: the report folder cannot be used: ${safeText(e.message, 1000)}`);
      return EXIT_ERROR;
    }
    const outcome = await performScan(
      { plan, reviews, evidenceDir: evidencePath(plan.out) },
      { signal: stop.signal, log: (line) => io.err(`widedoor: ${line}`) },
    );
    if (outcome.kind === 'cancelled') return EXIT_ERROR;
    if (outcome.kind === 'error') {
      io.err(`widedoor: ${outcome.message}`);
      return EXIT_ERROR;
    }
    const { report, unscannedListed } = outcome;

    let written: string[];
    try {
      written = await writeReports(report, plan, restricted);
    } catch (e) {
      io.err(`widedoor: the report could not be written: ${safeText(firstLine(e))}`);
      return EXIT_ERROR;
    }

    const decision = exitDecision(report, plan.failOn, {
      unscannedListed,
      ...(plan.web
        ? { maxPages: plan.web.maxPages, maxPagesSetting: plan.web.maxPagesSetting }
        : {}),
    });
    printSummary(report, { written, decision, failOn: plan.failOn }, io);
    return decision.code;
  } finally {
    dispose();
  }
}
