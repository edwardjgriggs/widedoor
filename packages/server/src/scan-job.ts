import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadReviews, safeText } from '@widedoor/core';
import { buildPlan, isHttpUrl, loadConfig, type LoadedConfig, type ScanPlan } from './config.js';
import { performScan as defaultPerformScan } from './engine.js';
import type { JobContext, JobEnd } from './jobs.js';
import { rootRelative, withoutPaths } from './paths.js';
import { reportBodyOf, type CurrentReport } from './report-file.js';
import type { ScanBody } from './requests.js';
import { CONFIG_FILE, DEFAULT_CONCURRENCY, UsageError } from './settings.js';
import type { Upload, Uploads } from './uploads.js';

/*
 * A scan job of widedoor ui, as widedoor scan would plan it in the root
 * folder: the config there (or the one --config named) and its
 * widedoor-review/. The request's urls and pdfs replace the config's scope
 * as command-line targets do; profile and maxPages override it. Every other
 * setting (auth, pdf.fetch, acr, caps) comes from the config, and Chromium
 * keeps its sandbox.
 *
 * A job writes nothing under the root (ruling 4, revised): it runs in a
 * private work folder (from mkdtemp, in the uploads folder), where uploaded
 * PDFs are copied under their names (so a rescan of the same file records it
 * under the same uri) and screenshots are written. A finished report is
 * held in memory as the current report, with its screenshots in that work
 * folder until another report replaces it or the server stops; files reach
 * disk only as GET /api/export downloads. A cancelled or failed job leaves
 * the current report alone.
 */

/** Where widedoor ui works: the folder that holds the config and widedoor-review/. */
export interface LocalRoot {
  dir: string;
  /** The config file --config named; else widedoor.config.yaml in dir, when present. */
  configFile?: string;
}

/** The root's config, or undefined when it has none. Throws ConfigError. */
export function loadRootConfig(root: LocalRoot): LoadedConfig | undefined {
  const file = root.configFile ?? join(root.dir, CONFIG_FILE);
  return root.configFile !== undefined || existsSync(file) ? loadConfig(file) : undefined;
}

export interface PlannedScan {
  /** The plan as widedoor scan would build it in the root folder; uploaded PDFs are named relative to it. */
  plan: ScanPlan;
  /** The PDF uploads the scan reads. */
  pdfs: Upload[];
  /** The root folder; a job error names a file relative to it. */
  rootDir: string;
}

/** The plan for a scan request. Throws UsageError (a bad request) or ConfigError. */
export function planScan(
  body: ScanBody,
  root: LocalRoot,
  uploads: Uploads,
  env: NodeJS.ProcessEnv = process.env,
): PlannedScan {
  const pdfs = (body.pdfs ?? []).map((id) => {
    const upload = uploads.get(id, 'pdf');
    if (!upload) throw new UsageError(`there is no PDF upload ${id}`);
    return upload;
  });
  const names = new Set<string>();
  for (const { name } of pdfs) {
    const key = (name as string).toLowerCase();
    if (names.has(key))
      throw new UsageError(`two PDF uploads are named ${name}; give each its own name`);
    names.add(key);
  }
  const plan = buildPlan(
    {
      targets: [...(body.urls ?? []), ...pdfs.map((p) => p.name as string)],
      ...(body.profile !== undefined ? { profile: body.profile } : {}),
      ...(body.maxPages !== undefined ? { maxPages: body.maxPages } : {}),
      unsafeNoSandbox: false,
      concurrency: DEFAULT_CONCURRENCY,
    },
    loadRootConfig(root),
    root.dir,
    env,
  );
  return { plan, pdfs, rootDir: root.dir };
}

export interface ScanJobDeps {
  uploads: Uploads;
  /**
   * Makes a finished scan's report the current one. Its work folder, when
   * set, holds the screenshots and is the new current report's to remove
   * once it is replaced.
   */
  setCurrent(current: CurrentReport): void;
  /** For tests; the real engine otherwise. */
  performScan?: typeof defaultPerformScan;
}

/** Runs a planned scan as a job and makes its report the current one; writes nothing under the root. */
export async function runScanJob(
  planned: PlannedScan,
  context: JobContext,
  deps: ScanJobDeps,
): Promise<JobEnd> {
  const { pdfs } = planned;
  const performScan = deps.performScan ?? defaultPerformScan;
  // What the page sees of the job: staged PDFs and engine errors name no absolute path.
  const forPage = (text: string) =>
    withoutPaths(text, planned.rootDir, {
      folders: [deps.uploads.dir, tmpdir()],
      home: homedir(),
    });
  // In use: they must not expire while the scan reads them.
  deps.uploads.claim(pdfs.map((p) => p.id));
  const work = await mkdtemp(join(deps.uploads.dir, 'scan-'));
  // Removed at the end unless the current report still needs its screenshots.
  let keepWork = false;
  let finished = false;
  try {
    let plan = planned.plan;
    if (pdfs.length > 0 && plan.pdf) {
      const stage = join(work, 'pdf');
      await mkdir(stage, { mode: 0o700 });
      for (const p of pdfs) await copyFile(p.path, join(stage, p.name as string));
      plan = { ...plan, pdf: { ...plan.pdf, baseDir: stage } };
    }
    const evidence = join(work, 'evidence');
    await mkdir(evidence, { mode: 0o700 });
    let reviews;
    try {
      ({ reviews } = await loadReviews(plan.reviewDir));
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      // As widedoor scan says it: the review file and what is wrong with it.
      const problems = e.problems.join('; ');
      return {
        status: 'failed',
        error: safeText(
          forPage(`${rootRelative(planned.rootDir, e.file)} is not usable: ${problems}`),
          1000,
        ),
        cause: safeText(`${e.file} is not usable: ${problems}`, 1000),
      };
    }
    const outcome = await performScan(
      { plan, reviews, evidenceDir: evidence, hideAllPaths: true },
      {
        signal: context.signal,
        // A URL as it is; a PDF the scan read from disk by its name.
        progress: ({ current, ...p }) =>
          context.progress({
            ...p,
            ...(current !== undefined
              ? { current: isHttpUrl(current) ? current : forPage(current) }
              : {}),
          }),
      },
    );
    if (outcome.kind === 'cancelled' || context.signal.aborted) return { status: 'cancelled' };
    finished = true;
    if (outcome.kind === 'error')
      return { status: 'failed', error: forPage(outcome.message), cause: outcome.message };
    const { report, inputs, restricted } = outcome;
    // The screenshots stay in the work folder while the report is current.
    deps.setCurrent({
      ...(restricted ? { signedIn: true } : {}),
      report,
      evidenceDir: evidence,
      body: reportBodyOf(report, evidence, plan.reviewDir, 'live'),
      workDir: work,
      inputs,
    });
    keepWork = true;
    return { status: 'done' };
  } finally {
    if (!keepWork) await removeWorkDir(work);
    // A cancelled scan keeps its uploads, so it can be started again (until they expire).
    if (finished) await deps.uploads.delete(pdfs.map((p) => p.id));
    else deps.uploads.unclaim(pdfs.map((p) => p.id));
  }
}

/** Removes a job's work folder; never throws. */
export const removeWorkDir = (dir: string): Promise<void> =>
  // Windows can hold a just-closed file for a moment (antivirus, indexer).
  rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
