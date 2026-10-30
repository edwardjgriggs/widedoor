import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ReportFileError, loadConfig, readReport, type LoadedConfig } from '@widedoor/server';
import { AiWriteError, aiSettings, missingKey, runAiSuggestions, type AiHooks } from './ai.js';
import { CONFIG_FILE, type SuggestArgs } from './args.js';
import type { Io } from './main.js';
import { EXIT_ERROR, EXIT_FAIL, EXIT_OK } from './policy.js';
import { safeText } from './text.js';

/*
 * widedoor suggest: AI fix suggestions for an existing report.json, without
 * scanning again. The report file is only read; the sidecar files go to
 * --out, by default the report's folder. Exit 0 when the files are written
 * (whatever each entry's status), 1 when they cannot be written, 2 on bad
 * input, a config problem or a missing key.
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
  if (!settings) return EXIT_ERROR;
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
  try {
    const written = await runAiSuggestions(
      report,
      settings,
      { dir, restricted: false, roots: [io.cwd, ...(loaded ? [loaded.dir] : [])] },
      io,
      hooks,
    );
    for (const file of written) io.out(`Wrote ${safeText(file, 1000)}`);
    return EXIT_OK;
  } catch (e) {
    if (!(e instanceof AiWriteError)) throw e;
    io.err(`widedoor: the AI suggestions could not be written: ${safeText(e.message, 1000)}`);
    return EXIT_FAIL;
  }
}
