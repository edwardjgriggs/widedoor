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
import { runAiSuggestions, type AiHooks, type AiSettings } from './ai.js';
import { EXIT_ERROR, exitDecision, type GateOptions } from './policy.js';
import { printSummary } from './summary.js';
import { firstLine, safeText } from './text.js';
import type { Io } from './main.js';

/**
 * Runs the scan a plan describes (performScan), writes the reports, prints
 * the summary and returns the exit code. The report folder is prepared
 * first, so a folder that cannot be used stops the run before any scan. A
 * stop signal cancels the scan through performScan's signal, which kills its
 * processes and removes its containers, and exits 2 with no report written.
 * With AI on, suggestions run after the reports are written and the summary
 * printed; whatever happens to them, the exit code is the scan's. A stop
 * signal then no longer exits: it aborts the suggestions, whose document is
 * still written, and the scan's exit code is returned. A second one exits
 * at once with that code.
 */
export async function runScan(
  plan: ScanPlan,
  reviews: readonly Finding[],
  io: Io,
  gate: GateOptions = {},
  ai?: { settings: AiSettings; hooks: AiHooks },
): Promise<number> {
  const stop = new AbortController();
  // Set once the reports are written and the AI step starts, with the scan's exit code.
  let suggesting: { stop: AbortController; code: number } | undefined;
  let stopping = false;
  const dispose = (ai?.hooks.onStop ?? onStop)(
    (signal) => {
      if (suggesting) {
        if (!suggesting.stop.signal.aborted) {
          io.err(
            `widedoor: interrupted (${signal}); finishing the suggestions document. The reports are written. Press Ctrl+C again to stop now.`,
          );
          suggesting.stop.abort();
          return;
        }
        dispose();
        process.exit(suggesting.code);
      }
      if (stopping) return;
      stopping = true;
      io.err(`widedoor: interrupted (${signal}); stopping the scan. No report was written.`);
      dispose();
      stop.abort();
      process.exit(EXIT_ERROR);
    },
    () => {
      stop.abort();
      suggesting?.stop.abort();
    },
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

    const decision = exitDecision(
      report,
      plan.failOn,
      {
        unscannedListed,
        ...(plan.web
          ? { maxPages: plan.web.maxPages, maxPagesSetting: plan.web.maxPagesSetting }
          : {}),
      },
      gate,
    );
    printSummary(
      report,
      {
        written,
        decision,
        failOn: plan.failOn,
        ...(gate.ignoreOverrides ? { ignoreOverrides: true } : {}),
      },
      io,
    );
    if (ai) {
      suggesting = { stop: new AbortController(), code: decision.code };
      try {
        const written = await runAiSuggestions(
          report,
          ai.settings,
          { dir: plan.out, restricted, roots: plan.outRoots },
          io,
          ai.hooks,
          suggesting.stop.signal,
        );
        for (const file of written) io.out(`Wrote ${safeText(file, 1000)}`);
      } catch (e) {
        io.err(`widedoor: AI fix suggestions failed: ${safeText(firstLine(e), 1000)}`);
      }
    }
    return decision.code;
  } finally {
    dispose();
  }
}
