import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONFIG_FILE, USAGE, UsageError, parseCommand } from './args.js';
import { ConfigError, buildPlan, loadConfig, type LoadedConfig } from './config.js';
import { EXIT_ERROR, EXIT_OK } from './policy.js';
import { loadReviews } from './reviews.js';
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

/** The CLI: parses argv (without node and the script), runs the command and returns the exit code. */
export async function main(argv: readonly string[], io: Io = processIo()): Promise<number> {
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
      // Loaded only for the viewer: it pulls in the HTTP server.
      const { runUi } = await import('./ui.js');
      return await runUi(command, io);
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
    const { reviews } = await loadReviews(plan.reviewDir);
    // Loaded only for a scan: it pulls in Playwright, pdf.js and the reporters.
    const { runScan } = await import('./run.js');
    return await runScan(plan, reviews, io);
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
