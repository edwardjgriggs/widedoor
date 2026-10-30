import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadReviews } from '@widedoor/core';
import {
  ConfigError,
  buildPlan,
  isRestricted,
  loadConfig,
  type LoadedConfig,
} from '@widedoor/server';
import {
  CONFIG_AI_SKIPPED,
  SIGNED_IN_AI,
  aiSettings,
  missingKey,
  type AiHooks,
  type AiSettings,
} from './ai.js';
import { CONFIG_FILE, USAGE, UsageError, parseCommand } from './args.js';
import { EXIT_ERROR, EXIT_OK } from './policy.js';
import { safeText } from './text.js';

export interface Io {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
}

export const processIo = (): Io => ({
  out: (line) => void process.stdout.write(`${line}\n`),
  err: (line) => void process.stderr.write(`${line}\n`),
  cwd: process.cwd(),
});

/** Version of the CLI: the @widedoor/cli package version. */
export const CLI_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

function configError(e: ConfigError, io: Io): number {
  io.err(`widedoor: ${safeText(e.file, 1000)} is not usable:`);
  for (const p of e.problems) io.err(`  ${safeText(p, 1000)}`);
  return EXIT_ERROR;
}

/** Test seams; the CLI itself passes none. */
export interface MainHooks {
  ai?: AiHooks;
}

/** The CLI: parses argv (without node and the script), runs the command and returns the exit code. */
export async function main(
  argv: readonly string[],
  io: Io = processIo(),
  hooks: MainHooks = {},
): Promise<number> {
  try {
    const command = parseCommand(argv);
    if (command.command === 'help') {
      io.out(USAGE.trimEnd());
      return EXIT_OK;
    }
    if (command.command === 'version') {
      io.out(CLI_VERSION);
      return EXIT_OK;
    }
    if (command.command === 'ui') {
      const { runUi } = await import('./ui.js');
      return await runUi(command, io, undefined, hooks.ai);
    }
    if (command.command === 'review') {
      const { runReview } = await import('./review-cmd.js');
      return await runReview(command, io);
    }
    if (command.command === 'diff') {
      const { runDiff } = await import('./diff-cmd.js');
      return runDiff(command, io);
    }
    if (command.command === 'mcp') {
      // Never loads @widedoor/ai: the MCP server calls no AI provider (ruling 7).
      const { runMcp } = await import('./mcp/server.js');
      return await runMcp(command, io);
    }
    if (command.command === 'suggest') {
      const { runSuggest } = await import('./suggest-cmd.js');
      return await runSuggest(command, io, hooks.ai);
    }
    const discovered = join(io.cwd, CONFIG_FILE);
    const configPath =
      command.config !== undefined
        ? resolve(io.cwd, command.config)
        : existsSync(discovered)
          ? discovered
          : undefined;
    if (configPath === undefined && command.targets.length === 0) {
      io.err(`widedoor: give URLs or PDF files to scan, or add ${CONFIG_FILE}.\n`);
      io.err(USAGE.trimEnd());
      return EXIT_ERROR;
    }
    const loaded: LoadedConfig | undefined = configPath ? loadConfig(configPath) : undefined;
    const plan = buildPlan(command, loaded, io.cwd);
    // An explicit --ai-fixes or --ai-dry-run makes an AI problem an error before the scan;
    // ai.enabled in the config alone only warns and leaves the scan as it would be.
    const explicit = command.ai.fixes || command.ai.dryRun;
    let ai: AiSettings | undefined;
    try {
      ai = aiSettings(command.ai, loaded?.config.ai);
    } catch (e) {
      if (!(e instanceof UsageError) || explicit) throw e;
      io.err(CONFIG_AI_SKIPPED);
    }
    const missing = ai ? missingKey(ai) : undefined;
    if (missing !== undefined) {
      if (explicit) {
        io.err(`widedoor: ${missing}`);
        return EXIT_ERROR;
      }
      io.err(CONFIG_AI_SKIPPED);
      ai = undefined;
    }
    // A signed-in scan's snippets can hold personal data: AI needs ai.allowSignedIn (a dry run sends nothing).
    if (ai && !ai.dryRun && isRestricted(plan) && loaded?.config.ai?.allowSignedIn !== true) {
      if (explicit) {
        io.err(`widedoor: ${SIGNED_IN_AI}`);
        return EXIT_ERROR;
      }
      io.err(`widedoor: warning: ${SIGNED_IN_AI} The scan goes on without them.`);
      ai = undefined;
    }
    const { reviews } = await loadReviews(plan.reviewDir);
    const { runScan } = await import('./run.js');
    return await runScan(
      plan,
      reviews,
      io,
      { ignoreOverrides: command.ignoreOverrides },
      ai ? { settings: ai, hooks: hooks.ai ?? {} } : undefined,
    );
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`widedoor: ${safeText(e.message, 1000)}`);
      io.err(e.showUsage ? `\n${USAGE.trimEnd()}` : 'Run "widedoor --help" for usage.');
      return EXIT_ERROR;
    }
    if (e instanceof ConfigError) return configError(e, io);
    io.err(`widedoor: ${safeText(String((e as Error)?.message ?? e).split('\n')[0], 1000)}`);
    return EXIT_ERROR;
  }
}
