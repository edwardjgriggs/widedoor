import type { z } from 'zod';

type Issue = z.core.$ZodIssue;
type Key = PropertyKey;

/** A path as a reader writes it: web.crawl.maxPages, web.urls[0]. */
export function formatPath(path: readonly Key[]): string {
  if (path.length === 0) return '(top level)';
  return path
    .map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`))
    .join('');
}

/**
 * Readable lines for Zod issues, one per problem. A failed union lists every
 * branch's issues; only the closest branch (fewest issues, first on a tie) is
 * shown, so a four-way Finding union reads as one record's problems.
 */
export function formatIssues(issues: readonly Issue[], base: readonly Key[] = []): string[] {
  const lines: string[] = [];
  for (const issue of issues) {
    const path = [...base, ...issue.path];
    if (issue.code === 'invalid_union' && issue.errors.length > 0) {
      const closest = issue.errors.reduce((best, branch) =>
        branch.length < best.length ? branch : best,
      );
      lines.push(...formatIssues(closest, path));
      continue;
    }
    if (issue.code === 'unrecognized_keys') {
      const keys = issue.keys.map((k) => JSON.stringify(k)).join(', ');
      lines.push(
        `${formatPath(path)}: unknown ${issue.keys.length === 1 ? 'key' : 'keys'} ${keys}`,
      );
      continue;
    }
    lines.push(`${formatPath(path)}: ${issue.message}`);
  }
  return [...new Set(lines)];
}
