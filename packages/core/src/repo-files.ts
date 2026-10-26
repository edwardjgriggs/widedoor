import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { safeText } from './text.js';

/*
 * Reading files a repo controls (the config, review files). They may come
 * from a pull request, so links, devices and oversized files are refused
 * rather than followed. Node-only: exported from index.ts, never browser.ts.
 */

/** A config file (or review file) that cannot be used; exit code 2. */
export class ConfigError extends Error {
  constructor(
    readonly file: string,
    readonly problems: readonly string[],
  ) {
    super(`${file}: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Reads a small regular file that the repo controls: never through a link,
 * never a device or FIFO, at most max bytes (checked on the open file).
 * Returns undefined when the file does not exist. Throws ConfigError.
 */
export function readRepoFile(file: string, max: number): string | undefined {
  let link;
  try {
    link = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError(file, ['the file could not be read']);
  }
  if (link.isSymbolicLink())
    throw new ConfigError(file, ['a symbolic link; Widedoor reads only regular files here']);
  if (!link.isFile()) throw new ConfigError(file, ['not a regular file']);
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    throw new ConfigError(file, ['the file could not be read']);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== link.ino || stat.dev !== link.dev)
      throw new ConfigError(file, ['the file changed while it was being read']);
    const buffer = Buffer.alloc(Math.min(stat.size, max) + 1);
    let length = 0;
    for (;;) {
      const n = readSync(fd, buffer, length, buffer.length - length, length);
      if (n === 0) break;
      length += n;
      if (length > max) throw new ConfigError(file, [`the file is over ${max / 1024 / 1024} MiB`]);
      if (length === buffer.length) break;
    }
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Parses YAML strictly: duplicate keys, syntax errors and warnings (an
 * unknown tag such as !!js/function) are all problems, and nothing is
 * printed by the parser itself. Throws ConfigError.
 */
export function parseRepoYaml(file: string, text: string): unknown {
  const doc = parseDocument(text, { uniqueKeys: true, logLevel: 'silent', prettyErrors: false });
  const problems = [...doc.errors, ...doc.warnings].map(
    (e) => `not valid YAML: ${safeText(String(e.message).split('\n')[0], 300)}`,
  );
  if (problems.length > 0) throw new ConfigError(file, problems);
  try {
    return doc.toJS({ maxAliasCount: 100 });
  } catch (e) {
    throw new ConfigError(file, [
      `not valid YAML: ${safeText(String((e as Error).message).split('\n')[0], 300)}`,
    ]);
  }
}
