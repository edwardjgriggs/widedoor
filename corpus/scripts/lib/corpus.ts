import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/*
 * Corpus layout, manifest and expected-file formats. corpus/README.md documents
 * the semantics; corpus/test/corpus.test.ts checks every file against them.
 */

export const corpusDir = fileURLToPath(new URL('../../', import.meta.url));

export const ENGINES = ['axe-core', 'verapdf', 'widedoor'] as const;
export const OUTCOMES = ['pass', 'fail', 'needs-review', 'not-applicable', 'not-tested'] as const;
export type Engine = (typeof ENGINES)[number];
export type Outcome = (typeof OUTCOMES)[number];

const text = z.string().min(1);
const relPath = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._/-]*$/i, 'expected a relative path with forward slashes')
  .refine((p) => !p.split('/').includes('..'), 'path must not leave corpus/');

export const ExpectedEntrySchema = z.strictObject({
  engine: z.enum(ENGINES),
  ruleId: text,
  outcome: z.enum(OUTCOMES),
  /** Set when this entry is not machine-confirmed although the rest of the file is. */
  provisional: z.literal(true).optional(),
});
export type ExpectedEntry = z.infer<typeof ExpectedEntrySchema>;

export const ExpectedFileSchema = z
  .strictObject({
    item: relPath,
    kind: z.enum(['web', 'pdf']),
    source: z.enum(['corpus', 'act']),
    expected: z.array(ExpectedEntrySchema),
    /**
     * Set when the item cannot be scanned: the adapter must report this scan
     * error code (run metadata, not a Finding) and no findings.
     */
    error: z.strictObject({ code: text }).optional(),
    confirmedBy: text.nullable(),
    provisional: z.boolean(),
  })
  .refine(
    (f) => f.error === undefined || f.expected.length === 0,
    'a file that expects a scan error expects no findings',
  )
  .refine(
    (f) => !f.expected.some((e) => e.provisional) || f.provisional,
    'a file with a provisional entry must itself be provisional',
  )
  .refine(
    (f) => f.provisional || f.confirmedBy !== null,
    'a file that is not provisional must name the engine that confirmed it',
  );
export type ExpectedFile = z.infer<typeof ExpectedFileSchema>;

export const ActTestcaseSchema = z.strictObject({
  ruleId: z.string().regex(/^[0-9a-z]{6}$/),
  testcaseId: z.string().regex(/^[0-9a-f]{40}$/),
  title: text,
  outcome: z.enum(['passed', 'failed', 'inapplicable']),
  approved: z.boolean().optional(),
  url: z.url(),
});

export const ManifestItemSchema = z.strictObject({
  path: relPath,
  kind: z.enum(['web', 'pdf']),
  source: z.enum(['corpus', 'act']),
  expected: relPath,
  description: text,
  /** Rule family for corpus/web pages (labels, alt, contrast, ...). */
  family: text.optional(),
  /** ACT rule and test case for vendored ACT items. */
  act: ActTestcaseSchema.optional(),
  /**
   * For an ACT item: the engine result last recorded where it differs from the
   * ACT outcome. verify-web.ts accepts exactly this result; any other is new.
   */
  knownDisagreement: z.strictObject({ engine: text, result: text }).optional(),
  /** Why an item is provisional, or anything a reader must know about its expectations. */
  note: text.optional(),
});
export type ManifestItem = z.infer<typeof ManifestItemSchema>;

export const ManifestSchema = z.strictObject({
  version: z.literal(1),
  items: z.array(ManifestItemSchema),
  /** Files that are not corpus items: ACT assets, license and source records. */
  supportFiles: z.array(z.strictObject({ path: relPath, description: text })),
  /** ACT test cases left out of corpus/act, with the pinned upstream copy and why. */
  notVendored: z.array(z.strictObject({ act: ActTestcaseSchema, upstream: z.url(), reason: text })),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** Files under corpus/ that the manifest does not list. */
export const UNLISTED = ['README.md', 'manifest.json', 'tsconfig.json'];
export const UNLISTED_DIRS = ['scripts/', 'test/'];

export const corpusPath = (rel: string) => `${corpusDir}${rel}`;

export function readManifest(): Manifest {
  return ManifestSchema.parse(JSON.parse(readFileSync(corpusPath('manifest.json'), 'utf8')));
}

export function writeJson(rel: string, value: unknown): void {
  mkdirSync(dirname(corpusPath(rel)), { recursive: true });
  writeFileSync(corpusPath(rel), `${JSON.stringify(value, null, 2)}\n`);
}

export function readExpected(rel: string): ExpectedFile {
  return ExpectedFileSchema.parse(JSON.parse(readFileSync(corpusPath(rel), 'utf8')));
}

/** Expected-file path for a corpus item: expected/<item path without extension>.json. */
export const expectedPathFor = (item: string) => `expected/${item.replace(/\.[^./]+$/, '')}.json`;

/** Every file under corpus/, relative, with forward slashes. */
export function listCorpusFiles(dir = corpusDir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      out.push(relative(corpusDir, `${entry.parentPath}${sep}${entry.name}`).split(sep).join('/'));
    }
  }
  return out.sort();
}

const order = (e: ExpectedEntry) => `${e.engine}\u0000${e.ruleId}\u0000${e.outcome}`;

/** Sorted, deduplicated entries, so files diff cleanly. */
export function sortEntries(entries: ExpectedEntry[]): ExpectedEntry[] {
  const seen = new Map<string, ExpectedEntry>();
  for (const e of entries) seen.set(order(e), e);
  return [...seen.values()].sort((a, b) => order(a).localeCompare(order(b)));
}

export const key = (e: { engine: string; ruleId: string; outcome: string }) =>
  `${e.engine} ${e.ruleId} ${e.outcome}`;

/** Outcomes an engine must report completely for an item (see README, "exact match"). */
export const isFinding = (o: Outcome) => o === 'fail' || o === 'needs-review';

export interface Comparison {
  missing: string[];
  unexpected: string[];
}

/**
 * Exact-match comparison for one engine's results on a corpus item: the fail and
 * needs-review triples must be equal, and every expected pass or not-applicable
 * triple must be present. Provisional entries and other engines are ignored.
 */
export function compareExact(
  engine: Engine,
  expected: readonly ExpectedEntry[],
  actual: readonly ExpectedEntry[],
): Comparison {
  const want = expected.filter((e) => e.engine === engine && !e.provisional);
  const got = actual.filter((a) => a.engine === engine);
  const act = new Set(got.map(key));
  const exp = new Set(want.map(key));
  const missing = want.filter((e) => !act.has(key(e))).map(key);
  const unexpected = got.filter((a) => isFinding(a.outcome) && !exp.has(key(a))).map(key);
  return { missing: [...new Set(missing)], unexpected: [...new Set(unexpected)] };
}

/**
 * ACT-level outcome over the axe rules that implement one ACT rule: fail if any
 * fails, else needs-review if any is incomplete, else pass if any passes, else
 * not-applicable if any was inapplicable. No result at all is not-tested.
 */
export function aggregate(outcomes: readonly Outcome[]): Outcome {
  for (const o of ['fail', 'needs-review', 'pass', 'not-applicable'] as const) {
    if (outcomes.includes(o)) return o;
  }
  return 'not-tested';
}

export interface ActAgreement {
  ok: boolean;
  got: Outcome;
  /** Mapped rules the engine did not evaluate at all (for example experimental rules). */
  notRun: string[];
  detail: string;
}

/**
 * Whether an engine run agrees with an ACT item's expected outcome. Every mapped
 * rule must have been evaluated: a rule that never ran cannot confirm anything,
 * not even "inapplicable".
 */
export function actAgreement(
  expected: readonly ExpectedEntry[],
  actual: readonly ExpectedEntry[],
): ActAgreement {
  const rules = [...new Set(expected.map((e) => e.ruleId))].sort();
  const want = expected[0]?.outcome;
  const seen = actual.filter((a) => rules.includes(a.ruleId));
  const notRun = rules.filter((r) => !seen.some((a) => a.ruleId === r));
  const got = notRun.length ? 'not-tested' : aggregate(seen.map((a) => a.outcome));
  const results = [...new Set(seen.map((a) => `${a.ruleId}:${a.outcome}`))].sort();
  const detail =
    `expected ${want}, engine reports ${got}` +
    (results.length ? ` (${results.join(', ')})` : '') +
    (notRun.length ? `; not run: ${notRun.join(', ')}` : '');
  return { ok: want !== undefined && notRun.length === 0 && got === want, got, notRun, detail };
}
