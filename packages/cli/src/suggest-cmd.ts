import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  ReportFileError,
  loadConfig,
  onStop,
  readReport,
  type LoadedConfig,
} from '@widedoor/server';
import { AiWriteError, aiSettings, missingKey, runAiSuggestions, type AiHooks } from './ai.js';
import { CONFIG_FILE, type SuggestArgs } from './args.js';
import type { Io } from './main.js';
import { EXIT_ERROR, EXIT_FAIL, EXIT_OK } from './policy.js';
import { safeText } from './text.js';

/**
 * Whether report.json is private to its owner (no group or other bits), as
 * a scan of signed-in pages leaves it; the sidecars beside it then are too.
 * Windows modes carry no such bits: never private there.
 */
export function reportIsPrivate(
  file: string,
  stat: (path: string) => { mode: number } = statSync,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32' && (stat(file).mode & 0o077) === 0;
}

/*
 * widedoor suggest: AI fix suggestions for an existing report.json, without
 * scanning again. The report file is only read; the sidecar files go to
 * --out, by default the report's folder. Exit 0 when the files are written
 * (whatever each entry's status), 1 when they cannot be written, 2 on bad
 * input, a config problem or a missing key. A stop signal aborts the
 * requests and the document is still written (exit 0); a second one exits
 * at once.
 */
export async function runSuggest(args: SuggestArgs, io: Io, hooks: AiHooks = {}): Promise<number> {
  const discovered = join(io.cwd, CONFIG_FILE);
  const configPath =
    args.config !== undefined
      ? resolve(io.cwd, args.config)
      : existsSync(discovered)
        ? discovered
        : undefined;
  const loaded: LoadedConfig | undefined = configPath ? loadConfig(configPath) : undefined;
  const settings = aiSettings({ ...args.ai, fixes: true }, loaded?.config.ai);
  // fixes: true always turns AI on.
  if (!settings) throw new Error('widedoor suggest: AI settings missing with --ai-fixes implied');
  const missing = missingKey(settings);
  if (missing !== undefined) {
    io.err(`widedoor: ${missing}`);
    return EXIT_ERROR;
  }
  const reportFile = resolve(io.cwd, args.report);
  let report;
  try {
    report = readReport(reportFile);
  } catch (e) {
    if (!(e instanceof ReportFileError)) throw e;
    io.err(`widedoor: ${safeText(args.report, 1000)} cannot be used: ${safeText(e.message, 1000)}`);
    return EXIT_ERROR;
  }
  const dir = resolve(io.cwd, args.out ?? dirname(reportFile));
  const stop = new AbortController();
  const dispose = (hooks.onStop ?? onStop)(
    (signal) => {
      if (!stop.signal.aborted) {
        io.err(
          `widedoor: interrupted (${signal}); finishing the suggestions document. Press Ctrl+C again to stop now.`,
        );
        stop.abort();
        return;
      }
      dispose();
      process.exit(EXIT_ERROR);
    },
    () => stop.abort(),
  );
  try {
    const written = await runAiSuggestions(
      report,
      settings,
      {
        dir,
        restricted: reportIsPrivate(reportFile),
        roots: [io.cwd, ...(loaded ? [loaded.dir] : [])],
      },
      io,
      hooks,
      stop.signal,
    );
    for (const file of written) io.out(`Wrote ${safeText(file, 1000)}`);
    return EXIT_OK;
  } catch (e) {
    if (!(e instanceof AiWriteError)) throw e;
    io.err(`widedoor: the AI suggestions could not be written: ${safeText(e.message, 1000)}`);
    return EXIT_FAIL;
  } finally {
    dispose();
  }
}
