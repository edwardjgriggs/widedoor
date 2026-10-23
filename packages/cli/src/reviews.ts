import { lstatSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FindingSchema, type Finding } from '@widedoor/core';
import { ConfigError, parseRepoYaml, readRepoFile } from './config.js';
import { formatIssues } from './issues.js';

/** Folder of manual review records, committed next to the code (spec section 6). */
export const REVIEW_DIR = 'widedoor-review';
const MAX_REVIEW_BYTES = 5 * 1024 * 1024;
export const MAX_REVIEW_FILES = 1_000;
const MAX_REVIEW_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * Reads widedoor-review/*.yaml (and *.yml) under dir. Each file holds one
 * manual record (source.engine: manual) or a list of them, in the Finding
 * schema. The folder may come from a pull request, so links, devices and
 * oversized folders are refused rather than followed. Throws ConfigError
 * naming the file and every problem.
 */
export async function loadReviews(dir: string): Promise<{ files: string[]; reviews: Finding[] }> {
  const folder = join(dir, REVIEW_DIR);
  let stat;
  try {
    stat = lstatSync(folder);
  } catch {
    return { files: [], reviews: [] };
  }
  if (stat.isSymbolicLink())
    throw new ConfigError(folder, [
      'a symbolic link or junction; Widedoor reads only a real folder here',
    ]);
  if (!stat.isDirectory()) throw new ConfigError(folder, ['not a folder']);

  const names = (await readdir(folder)).filter((n) => /\.ya?ml$/i.test(n)).sort();
  if (names.length > MAX_REVIEW_FILES)
    throw new ConfigError(folder, [`more than ${MAX_REVIEW_FILES} review files`]);
  const reviews: Finding[] = [];
  let total = 0;
  for (const name of names) {
    const file = join(folder, name);
    const text = readRepoFile(file, MAX_REVIEW_BYTES) ?? '';
    total += Buffer.byteLength(text);
    if (total > MAX_REVIEW_TOTAL_BYTES)
      throw new ConfigError(folder, ['the review files are over 50 MiB in all']);
    const raw = parseRepoYaml(file, text);
    const records = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const problems: string[] = [];
    records.forEach((record, i) => {
      const at = Array.isArray(raw) ? [i] : [];
      const parsed = FindingSchema.safeParse(record);
      if (!parsed.success) {
        problems.push(...formatIssues(parsed.error.issues, at));
        return;
      }
      if (parsed.data.source.engine !== 'manual') {
        problems.push(
          `${at.length ? `[${i}].` : ''}source.engine: review files hold manual records only`,
        );
        return;
      }
      reviews.push(parsed.data);
    });
    if (problems.length > 0) throw new ConfigError(file, problems);
  }
  return { files: names.map((n) => join(folder, n)), reviews };
}
