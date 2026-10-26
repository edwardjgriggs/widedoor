import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import {
  buildChecklist,
  checklistSummary,
  manualRuleId,
  type ChecklistItem,
  type ChecklistRollup,
  type ChecklistSummary,
} from './checklist.js';
import { loadStandardsData, type StandardsData } from './data.js';
import { findingId } from './finding-id.js';
import { formatIssues } from './issues.js';
import type { PdfDocumentType, ProfileId } from './profile-ids.js';
import { getProfile } from './profiles.js';
import { ConfigError, parseRepoYaml, readRepoFile } from './repo-files.js';
import { decidingRulesFrom, errataFrom, rollup, type Errata } from './rollup.js';
import {
  FindingSchema,
  type Asset,
  type AssetKind,
  type Finding,
  type Location,
} from './schema.js';
import { safeText } from './text.js';

/*
 * Manual review files (spec section 6): widedoor-review/*.yaml, committed
 * next to the code, one file per asset (<kind>-<16 hex of sha256(uri)>.yaml)
 * plus product.yaml, each a list of manual records sorted by criterion.
 * recordReview is the only writer (the CLI and the local server both call
 * it); loadReviews reads them for a scan and for the checklist.
 *
 * The folder may arrive in a pull request, so nothing in it is trusted:
 * links, devices and oversized files are refused; a record must carry the
 * manual identity the checklist matches (one criterion, rule id wcag-<sc> or
 * 508-<provision>, the finding id of its asset, location and rule), sit in
 * the file named for its asset, be dated no later than tomorrow and be the
 * only record for its item in the folder; and an attachment path is
 * resolved and checked against attachments/ (never trusting the schema
 * pattern) before its first bytes are checked against its extension.
 * Node-only: index.ts, never browser.ts.
 *
 * Leftovers of an interrupted write all end in .lock, .stale or .tmp, so
 * three .gitignore lines cover them (README).
 */

/** Folder of manual review records, next to the config (or the current folder). */
export const REVIEW_DIR = 'widedoor-review';
/** Attachments live here; not under a folder named evidence, which the repo .gitignore skips. */
export const ATTACHMENT_DIR = `${REVIEW_DIR}/attachments`;
const ATTACHMENTS = 'attachments';
/** The file that holds product-scope records. */
export const PRODUCT_FILE = 'product.yaml';
export const MAX_REVIEW_FILES = 1_000;
const MAX_REVIEW_BYTES = 5 * 1024 * 1024;
const MAX_REVIEW_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
const MAX_REVIEWER_CHARS = 200;
const MAX_NOTES_CHARS = 10_000;
/** A lock file older than this is left by a writer that died; the next writer takes it over. */
export const LOCK_STALE_MS = 30_000;
/** A lock dated further ahead than this is stale too (a clock change, or a planted file). */
const LOCK_FUTURE_MS = 5_000;
/** How long a writer waits for a lock before giving up (long enough to see one go stale). */
const LOCK_WAIT_MS = 2 * LOCK_STALE_MS;
/** Failed attempts to move a stale lock aside before giving up. */
const LOCK_TAKEOVER_TRIES = 5;

export const MANUAL_OUTCOMES = ['pass', 'fail', 'not-applicable'] as const;
export type ManualOutcome = (typeof MANUAL_OUTCOMES)[number];

/** Input to recordReview that the report or the files do not support; exit code 2. */
export class ReviewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewInputError';
  }
}

/** A scan report as review files see it (structural, so core does not import @widedoor/report). */
export interface ReviewReport {
  profile: { id: ProfileId; pdfDocumentType: PdfDocumentType };
  assets: readonly Asset[];
  /** Automated findings and the manual records the scan read. */
  findings: readonly Finding[];
  rollup: ChecklistRollup;
  scopeGaps?: readonly string[] | undefined;
}

export interface LoadedReviews {
  files: string[];
  reviews: Finding[];
  /** Attachment path as a record names it (attachments/<name>) to the checked file. */
  attachments: Map<string, string>;
}

/** The standards data review files are checked against. */
export type ReviewData = Pick<StandardsData, 'errata' | 'section508'>;

type CriterionType = ChecklistItem['criterion']['type'];

/** The criteria a record cites, as [type, id] pairs. */
const citedBy = (f: Finding): [CriterionType, string][] => [
  ...(f.criteria.wcag ?? []).map((id): [CriterionType, string] => ['wcag', id]),
  ...(f.criteria.section508 ?? []).map((id): [CriterionType, string] => ['section508', id]),
];

/** The one criterion of a record that passed identityProblem. */
const criterionOf = (f: Finding) => (citedBy(f) as [[CriterionType, string]])[0];

const cites = (f: Finding, type: CriterionType, id: string) =>
  citedBy(f).some(([t, c]) => t === type && c === id);

const quoted = (value: string) => JSON.stringify(safeText(value, 200));

const criterionLabel = (type: CriterionType, id: string) =>
  `${type === 'wcag' ? 'WCAG' : '508'} ${id}`;

/** Section 508 items judged once for the whole product (their records go in product.yaml). */
const productProvisions = (data: Pick<StandardsData, 'section508'>) =>
  new Set(data.section508.provisions.filter((p) => p.manual?.scope === 'product').map((p) => p.id));

/** Why a manual record's identity is not one the checklist can match (ledger ruling 2.3 / 2.4). */
function identityProblem(f: Finding, at: string): string | undefined {
  const cited = citedBy(f);
  const [only] = cited;
  if (cited.length !== 1 || !only)
    return `${at}criteria: record ${f.id} cites ${cited.length} criteria; a manual record cites exactly one`;
  const expected = manualRuleId(only[0], only[1]);
  if (f.source.ruleId !== expected)
    return `${at}source.ruleId: record ${f.id} must use "${expected}", the rule id of the criterion it cites`;
  return undefined;
}

/** The review file that holds a record: one per asset, product.yaml for product scope. */
export const reviewFileName = (item: {
  asset?: { kind: AssetKind; uri: string } | undefined;
}): string =>
  item.asset
    ? `${item.asset.kind}-${createHash('sha256').update(item.asset.uri).digest('hex').slice(0, 16)}.yaml`
    : PRODUCT_FILE;

/** UTC dates as YYYY-MM-DD; a review may be dated at most one day ahead (time zones). */
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const today = () => isoDay(Date.now());
const tomorrow = () => isoDay(Date.now() + 86_400_000);

// Attachments: attachments/<name>.<png|jpg|jpeg>, one segment, no dots or spaces Windows strips.
const ATTACHMENT_NAME = /^[A-Za-z0-9_-]{1,100}\.(?:png|jpg|jpeg)$/;
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

type ImageType = 'png' | 'jpeg';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const imageTypeOf = (head: Uint8Array): ImageType | undefined =>
  PNG_SIGNATURE.every((b, i) => head[i] === b)
    ? 'png'
    : head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
      ? 'jpeg'
      : undefined;
const imageTypeOfName = (name: string): ImageType | undefined => {
  const ext = extname(name).toLowerCase();
  return ext === '.png' ? 'png' : ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : undefined;
};
const IMAGE_LABEL: Record<ImageType, string> = { png: 'PNG', jpeg: 'JPEG' };

/** Why an attachment a record names cannot be used. */
class AttachmentError extends Error {}

/**
 * Checks one attachment a record names and returns its file. Throws
 * AttachmentError: the path must be attachments/<name> with a plain name,
 * resolve (and realpath) inside attachments/, be a regular file reached
 * through no link, fit the size cap and start with the bytes of its type.
 */
function checkAttachment(folder: string, path: string): string {
  const parts = path.split('/');
  const name = parts[1] ?? '';
  if (
    parts.length !== 2 ||
    parts[0] !== ATTACHMENTS ||
    !ATTACHMENT_NAME.test(name) ||
    DEVICE_NAME.test(name.slice(0, name.indexOf('.')))
  )
    throw new AttachmentError(
      `${quoted(path)} is not ${ATTACHMENTS}/<name>.png or .jpg (letters, digits, _ and - in the name)`,
    );
  const dir = join(folder, ATTACHMENTS);
  const file = join(dir, name);
  if (dirname(resolve(folder, path)) !== resolve(dir))
    throw new AttachmentError(`${quoted(path)} is outside ${ATTACHMENTS}/`);
  let link;
  try {
    link = lstatSync(dir);
  } catch {
    throw new AttachmentError(`${quoted(path)}: there is no ${ATTACHMENTS} folder`);
  }
  if (link.isSymbolicLink())
    throw new AttachmentError(
      `${ATTACHMENTS}/ is a symbolic link or junction; Widedoor reads only a real folder here`,
    );
  if (!link.isDirectory()) throw new AttachmentError(`${ATTACHMENTS}/ is not a folder`);
  try {
    link = lstatSync(file);
  } catch {
    throw new AttachmentError(`${quoted(path)}: no such file`);
  }
  if (link.isSymbolicLink()) throw new AttachmentError(`${quoted(path)} is a symbolic link`);
  if (!link.isFile()) throw new AttachmentError(`${quoted(path)} is not a regular file`);
  let inside;
  try {
    inside = dirname(realpathSync(file)) === realpathSync(dir);
  } catch {
    throw new AttachmentError(`${quoted(path)} changed while it was being read`);
  }
  if (!inside) throw new AttachmentError(`${quoted(path)} is outside ${ATTACHMENTS}/`);
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    throw new AttachmentError(`${quoted(path)} could not be read`);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== link.ino || opened.dev !== link.dev)
      throw new AttachmentError(`${quoted(path)} changed while it was being read`);
    if (opened.size > MAX_ATTACHMENT_BYTES)
      throw new AttachmentError(`${quoted(path)} is over 5 MiB`);
    const head = Buffer.alloc(PNG_SIGNATURE.length);
    readSync(fd, head, 0, head.length, 0);
    const expected = imageTypeOfName(name) as ImageType;
    if (imageTypeOf(head) !== expected)
      throw new AttachmentError(
        `${quoted(path)} is not a ${IMAGE_LABEL[expected]} image (its first bytes do not match its extension)`,
      );
  } finally {
    closeSync(fd);
  }
  return file;
}

/** What parseReviewFile checks records against, shared by the files of one folder. */
interface FolderContext {
  folder: string;
  errata: Errata;
  product: ReadonlySet<string>;
  /** Items already seen in the folder (asset uri or product, criterion) and the file that holds each. */
  seen: Map<string, string>;
  attachments: Map<string, string>;
  /** Latest review date allowed. */
  latest: string;
}

function folderContext(folder: string, data: ReviewData): FolderContext {
  return {
    folder,
    errata: errataFrom(data),
    product: productProvisions(data),
    seen: new Map(),
    attachments: new Map(),
    latest: tomorrow(),
  };
}

/** Why a valid manual record cannot be used where it sits, if it cannot. */
function placementProblem(f: Finding, name: string, at: string, ctx: FolderContext) {
  const [type, id] = criterionOf(f);
  const basis = type === 'wcag' ? ctx.errata.get(id) : undefined;
  // Any outcome: a fail would move 4.1.1 off the Supports the template requires, and a pass or N/A adds nothing.
  if (basis)
    return `${at}criteria: record ${f.id} cites WCAG ${id}, which is satisfied by the errata; no review needed, so no outcome (${f.outcome}) is accepted. Basis: ${basis.citations.map((c) => `${c.name} (${c.url})`).join('; ')}`;
  const expectedId = findingId(f.asset.uri, f.location, 'manual', f.source.ruleId);
  if (f.id !== expectedId)
    return `${at}id: record ${f.id} does not match its asset, location and rule (expected ${expectedId})`;
  const product = type === 'section508' && ctx.product.has(id);
  const home = reviewFileName(product ? {} : { asset: f.asset });
  if (name !== home)
    return `${at}asset.uri: record ${f.id} belongs in ${home}, the file for ${product ? 'product-scope items' : 'its asset'}`;
  if ('review' in f && f.review.date > ctx.latest)
    return `${at}review.date: record ${f.id} is dated ${f.review.date}, after tomorrow`;
  const key = JSON.stringify([product ? null : f.asset.uri, type, id]);
  const other = ctx.seen.get(key);
  if (other !== undefined)
    return `${at}asset.uri: record ${f.id} repeats the result for ${criterionLabel(type, id)}${product ? '' : ` on ${safeText(f.asset.uri, 300)}`} already in ${other}; keep one`;
  ctx.seen.set(key, name);
  return undefined;
}

/** Validates the records of one review file. Throws ConfigError naming the file and every bad record. */
function parseReviewFile(file: string, text: string, ctx: FolderContext): Finding[] {
  const raw = parseRepoYaml(file, text);
  const records = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const problems: string[] = [];
  const out: Finding[] = [];
  records.forEach((record, i) => {
    const at = Array.isArray(raw) ? [i] : [];
    const prefix = at.length ? `[${i}].` : '';
    const parsed = FindingSchema.safeParse(record);
    if (!parsed.success) {
      problems.push(...formatIssues(parsed.error.issues, at));
      return;
    }
    const f = parsed.data;
    if (f.source.engine !== 'manual' || !('review' in f)) {
      problems.push(`${prefix}source.engine: review files hold manual records only`);
      return;
    }
    const problem = identityProblem(f, prefix) ?? placementProblem(f, basename(file), prefix, ctx);
    if (problem) {
      problems.push(problem);
      return;
    }
    const named = f.review.attachments ?? [];
    if (named.length > MAX_ATTACHMENTS)
      problems.push(`${prefix}review.attachments: at most ${MAX_ATTACHMENTS} per record`);
    let ok = named.length <= MAX_ATTACHMENTS;
    for (const path of named) {
      try {
        ctx.attachments.set(path, checkAttachment(ctx.folder, path));
      } catch (e) {
        if (!(e instanceof AttachmentError)) throw e;
        ok = false;
        problems.push(`${prefix}review.attachments: ${e.message}`);
      }
    }
    if (ok) out.push(f);
  });
  if (problems.length > 0) throw new ConfigError(file, problems);
  return out;
}

/**
 * Reads widedoor-review/*.yaml (and *.yml) under dir. Each file holds one
 * manual record or a list of them, in the Finding schema, checked as the
 * module comment says. Links, devices and oversized folders are refused
 * rather than followed. Throws ConfigError naming the file and every
 * problem. Records for assets a report did not scan are not errors here;
 * screenReviews and reviewChecklist list them as orphaned.
 */
export async function loadReviews(
  dir: string,
  data: ReviewData = loadStandardsData(),
): Promise<LoadedReviews> {
  const folder = join(dir, REVIEW_DIR);
  const ctx = folderContext(folder, data);
  let link;
  try {
    link = lstatSync(folder);
  } catch {
    return { files: [], reviews: [], attachments: ctx.attachments };
  }
  if (link.isSymbolicLink())
    throw new ConfigError(folder, [
      'a symbolic link or junction; Widedoor reads only a real folder here',
    ]);
  if (!link.isDirectory()) throw new ConfigError(folder, ['not a folder']);

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
    reviews.push(...parseReviewFile(file, text, ctx));
  }
  return { files: names.map((n) => join(folder, n)), reviews, attachments: ctx.attachments };
}

export type NotAppliedReason =
  | 'bad-identity'
  | 'orphaned'
  | 'kind-mismatch'
  | 'bad-override'
  | 'superseded'
  | 'no-item'
  | 'out-of-profile';

export interface NotApplied {
  record: Finding;
  reason: NotAppliedReason;
  /** Plain-language reason; holds review-file content, so escape it on output. */
  detail: string;
}

/** The records that count and the ones that do not, each in input order. */
export interface ScreenedReviews {
  applied: Finding[];
  notApplied: NotApplied[];
}

export interface ReviewChecklist extends ScreenedReviews {
  /** The checklist with the applied records counted (the roll-up is re-run with them). */
  items: ChecklistItem[];
  summary: ChecklistSummary;
}

/** What a set of records is screened against: a scan run, or a report. */
export interface ReviewScope {
  /** Scanned assets. */
  assets: readonly { uri: string; kind: AssetKind }[];
  /**
   * Assets in scope that were not scanned (errors, skipped pages). Records for
   * them are kept, and the roll-up ignores them; without this list they are orphaned.
   */
  unscanned?: readonly { uri: string; kind: AssetKind }[] | undefined;
  /** Automated findings of the run, to check overrides against. */
  automated: readonly Finding[];
}

/** Override ids that are not automated fails on the record's asset that cite its criterion. */
function badOverrides(
  ids: readonly string[],
  uri: string,
  type: CriterionType,
  id: string,
  automated: readonly Finding[],
): string[] {
  return ids.filter(
    (wd) =>
      !automated.some(
        (f) => f.id === wd && f.outcome === 'fail' && f.asset.uri === uri && cites(f, type, id),
      ),
  );
}

const overrideProblem = (bad: readonly string[], uri: string, type: CriterionType, id: string) =>
  `${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not an automated fail on ${safeText(uri, 300)} that cites ${criterionLabel(type, id)}`;

/** Newest review date first, then the larger id: the same pick as the checklist. */
const newest = (a: Finding, b: Finding) => {
  const da = 'review' in a ? a.review.date : '';
  const db = 'review' in b ? b.review.date : '';
  return da !== db ? (da < db ? 1 : -1) : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

/**
 * The records a scan or a report may use. A record is left out, with why,
 * when it lacks the manual identity (records that did not come through
 * loadReviews), its asset is not in scope, its asset kind differs (the
 * roll-up would throw), an override names anything but an automated fail on
 * its asset and criterion, or a newer record exists for the same item (one
 * per asset and criterion, or per criterion for product scope). Used by
 * widedoor scan, review list and the local server alike.
 */
export function screenReviews(
  reviews: readonly Finding[],
  scope: ReviewScope,
  data: Pick<StandardsData, 'section508'> = loadStandardsData(),
): ScreenedReviews {
  const scanned = new Map(scope.assets.map((a) => [a.uri, a.kind]));
  const unscanned = new Map((scope.unscanned ?? []).map((a) => [a.uri, a.kind]));
  const product = productProvisions(data);
  const reasons = new Map<Finding, Omit<NotApplied, 'record'>>();
  const groups = new Map<string, Finding[]>();
  for (const f of reviews) {
    const identity = f.source.engine === 'manual' ? identityProblem(f, '') : 'not a manual record';
    if (identity) {
      reasons.set(f, { reason: 'bad-identity', detail: identity });
      continue;
    }
    const [type, id] = criterionOf(f);
    const uri = safeText(f.asset.uri, 300);
    const kind = scanned.get(f.asset.uri) ?? unscanned.get(f.asset.uri);
    if (kind === undefined) {
      reasons.set(f, { reason: 'orphaned', detail: `this scan did not cover ${uri}` });
      continue;
    }
    if (kind !== f.asset.kind) {
      reasons.set(f, {
        reason: 'kind-mismatch',
        detail: `the record is for a ${f.asset.kind} asset but ${uri} is ${kind}`,
      });
      continue;
    }
    const named = 'review' in f && f.outcome === 'pass' ? (f.review.overrides ?? []) : [];
    const bad = scanned.has(f.asset.uri)
      ? badOverrides(named, f.asset.uri, type, id, scope.automated)
      : [];
    if (bad.length > 0) {
      reasons.set(f, {
        reason: 'bad-override',
        detail: overrideProblem(bad, f.asset.uri, type, id),
      });
      continue;
    }
    const key = JSON.stringify([
      type === 'section508' && product.has(id) ? null : f.asset.uri,
      type,
      id,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const group of groups.values())
    for (const f of [...group].sort(newest).slice(1))
      reasons.set(f, {
        reason: 'superseded',
        detail: 'a newer record for the same item replaces it',
      });
  return {
    applied: reviews.filter((f) => !reasons.has(f)),
    notApplied: reviews.flatMap((record) => {
      const why = reasons.get(record);
      return why ? [{ record, ...why }] : [];
    }),
  };
}

const automatedOf = (report: ReviewReport) =>
  report.findings.filter((f) => f.source.engine !== 'manual');

/** Assets in the report's scope that were not scanned, from its roll-up. */
const unscannedOf = (report: ReviewReport) => [
  ...new Map(
    report.rollup.standards.flatMap((v) =>
      v.criteria.flatMap((c) =>
        c.assets
          .filter((u) => u.reason === 'not-scanned')
          .map((u) => [u.uri, { uri: u.uri, kind: u.kind }] as const),
      ),
    ),
  ).values(),
];

/** The checklist and its summary for a report with these manual records in place of its own. */
function checklistOf(report: ReviewReport, applied: readonly Finding[], data: StandardsData) {
  const automated = automatedOf(report);
  const rolled = rollup({
    findings: automated,
    reviews: applied,
    profile: getProfile(report.profile.id, { pdfDocumentType: report.profile.pdfDocumentType }),
    assets: report.assets,
    decidingRules: decidingRulesFrom(data),
    errata: errataFrom(data),
    unscanned: unscannedOf(report),
    scopeGaps: report.scopeGaps ?? [],
  });
  const input = {
    report: {
      assets: report.assets,
      findings: [...automated, ...applied],
      rollup: rolled,
      profile: report.profile,
    },
    data,
  };
  return { items: buildChecklist(input), summary: checklistSummary(input) };
}

/**
 * The checklist items of a report before any manual result: the units no
 * automated result, errata basis or profile exception settles. A record is
 * applied only to one of these, so a hand-written record can never turn a
 * settled unit into an item (or reach the roll-up for it).
 */
const itemsOf = (report: ReviewReport, data: StandardsData) => checklistOf(report, [], data).items;

const itemKey = (uri: string | undefined, type: CriterionType, id: string) =>
  JSON.stringify([uri ?? null, type, id]);

/** Whether a profile view for the asset kind (any for a product-scope 508 item) has a row for the criterion. */
function inProfile(
  report: ReviewReport,
  kind: AssetKind,
  type: CriterionType,
  id: string,
  product: ReadonlySet<string>,
): boolean {
  const profile = getProfile(report.profile.id, {
    pdfDocumentType: report.profile.pdfDocumentType,
  });
  const kinds: AssetKind[] = type === 'section508' && product.has(id) ? ['web', 'pdf'] : [kind];
  return kinds.some((k) =>
    profile.assets[k].standards.some((v) =>
      type === 'wcag'
        ? v.applicable.some((c) => c.id === id) || v.notApplicable.some((c) => c.id === id)
        : v.manual.some((m) => m.id === id),
    ),
  );
}

/** The warning for a record whose criterion the profile does not have; holds review-file content, escaped. */
export function outOfProfileWarning(f: Finding, profile: ProfileId): string {
  const [type, id] = criterionOf(f);
  return `manual review record ${f.id} on ${safeText(f.asset.uri, 300)}: ${criterionLabel(type, id)} is not in profile ${profile}; the record is not used`;
}

/**
 * Records, among ones screenReviews applied, whose criterion is not a
 * checklist item on their scanned asset (nor a product-scope item) before
 * any manual result. When the profile has no row for the criterion on the
 * asset's kind the reason is out-of-profile; otherwise (the unit is settled
 * without a reviewer: a deciding automated pass, a profile exception) it is
 * no-item. A record for an asset the report did not scan is not judged
 * here. The report's own manual records are ignored; only its automated
 * findings and roll-up scope count.
 */
export function itemlessReviews(
  report: ReviewReport,
  reviews: readonly Finding[],
  data: StandardsData = loadStandardsData(),
): NotApplied[] {
  const scanned = new Set(report.assets.map((a) => a.uri));
  const judged = reviews.filter((f) => scanned.has(f.asset.uri) && !identityProblem(f, ''));
  if (judged.length === 0) return [];
  const items = new Set(
    itemsOf(report, data).map((i) => itemKey(i.asset?.uri, i.criterion.type, i.criterion.id)),
  );
  const product = productProvisions(data);
  return judged.flatMap((f): NotApplied[] => {
    const [type, id] = criterionOf(f);
    // A product-scope item is judged once, so its record may sit on any scanned asset.
    if (items.has(itemKey(f.asset.uri, type, id)) || items.has(itemKey(undefined, type, id)))
      return [];
    if (!inProfile(report, f.asset.kind, type, id, product))
      return [
        {
          record: f,
          reason: 'out-of-profile',
          detail: `${criterionLabel(type, id)} is not in profile ${report.profile.id}; the record is not used`,
        },
      ];
    return [
      {
        record: f,
        reason: 'no-item',
        detail: `${criterionLabel(type, id)} on ${safeText(f.asset.uri, 300)} is not a checklist item in this report`,
      },
    ];
  });
}

/** The warning for a manual fail on a unit with no checklist item; holds review-file content, escaped. */
export function keptFailWarning(f: Finding): string {
  const [type, id] = criterionOf(f);
  return `manual review record ${f.id} on ${safeText(f.asset.uri, 300)} for ${criterionLabel(type, id)}: manual fail recorded on a unit automation decided; the manual fail is kept`;
}

export interface ItemlessScreen {
  /** The records a scan applies: every input record but the dropped ones. */
  applied: Finding[];
  /** Manual fails on a profile row with no checklist item, kept (each gets keptFailWarning). */
  kept: Finding[];
  /**
   * Every other record with no checklist item, left out: out-of-profile ones whatever their
   * outcome (each gets outOfProfileWarning), and no-item ones that are not a fail.
   */
  dropped: NotApplied[];
}

/**
 * The no-item rule for a scan (ledger ruling 9), fail-safe: a record with no
 * checklist item must never loosen a settled unit, and a failure a person
 * reported must never be hidden. So a manual fail on a row the profile has is
 * kept (with a warning; it can turn Supports into Does Not Support, the
 * honest direction) and any other outcome is left out. A record for a
 * criterion the profile does not have (Level AAA, a 508 provision under
 * wcag21aa) decides nothing in this report, so it is left out whatever its
 * outcome (fix round 1, I1). review list leaves out all of them, since it
 * lists items, but warns about the kept fails and the out-of-profile records
 * the same way.
 */
export function screenItemless(
  report: ReviewReport,
  reviews: readonly Finding[],
  data: StandardsData = loadStandardsData(),
): ItemlessScreen {
  const itemless = itemlessReviews(report, reviews, data);
  const keeps = (n: NotApplied) => n.reason === 'no-item' && n.record.outcome === 'fail';
  const kept = itemless.filter(keeps).map((n) => n.record);
  const dropped = itemless.filter((n) => !keeps(n));
  const left = new Set(dropped.map((n) => n.record));
  return { applied: reviews.filter((f) => !left.has(f)), kept, dropped };
}

/**
 * The checklist for a report with the records from the review files in
 * place of the ones the scan read. screenReviews decides which records
 * count (records for assets outside the report's scope are orphaned here;
 * records for assets in scope that failed to scan are kept, as a scan keeps them);
 * a record whose criterion is not a checklist item on its asset is left out
 * too (itemlessReviews). Records left out are listed in notApplied and never
 * reach the roll-up.
 */
export function reviewChecklist(
  report: ReviewReport,
  reviews: readonly Finding[],
  data: StandardsData = loadStandardsData(),
): ReviewChecklist {
  const screened = screenReviews(
    reviews,
    { assets: report.assets, unscanned: unscannedOf(report), automated: automatedOf(report) },
    data,
  );
  const noItem = new Map(itemlessReviews(report, screened.applied, data).map((n) => [n.record, n]));
  const applied = screened.applied.filter((f) => !noItem.has(f));
  const left = new Map(screened.notApplied.map((n) => [n.record, n]));
  return {
    ...checklistOf(report, applied, data),
    applied,
    notApplied: reviews.flatMap((f) => {
      const why = left.get(f) ?? noItem.get(f);
      return why ? [why] : [];
    }),
  };
}

export interface RecordInput {
  report: ReviewReport;
  /** Checklist item id (ck_...). */
  item: string;
  outcome: ManualOutcome;
  /** Who reviewed it; stored as given. */
  reviewer: string;
  /** Free text, stored as given; needed for not-applicable and overrides. */
  notes?: string | undefined;
  /** Image files to copy in (PNG or JPEG, by content), as paths the caller resolved. */
  attach?: readonly string[] | undefined;
  /** Automated fail ids on the item's asset and criterion that a pass sets aside. */
  overrides?: readonly string[] | undefined;
  /** The Widedoor version, recorded as source.engineVersion. */
  version: string;
  /** YYYY-MM-DD, at most tomorrow; defaults to today (UTC). */
  date?: string | undefined;
  /** Defaults to the standards data shipped in @widedoor/core. */
  data?: StandardsData | undefined;
}

interface Image {
  bytes: Buffer;
  ext: 'png' | 'jpg';
}

/** Reads an image the reviewer named (their own file, so links are followed). */
async function readImage(path: string): Promise<Image> {
  const name = basename(path);
  const expected = imageTypeOfName(name);
  if (!expected)
    throw new ReviewInputError(
      `--attach ${quoted(name)}: attachments must be PNG or JPEG files (.png, .jpg or .jpeg)`,
    );
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new ReviewInputError(`--attach ${quoted(path)}: no such file`);
  if (info.size > MAX_ATTACHMENT_BYTES)
    throw new ReviewInputError(`--attach ${quoted(name)} is over 5 MiB`);
  const bytes = await readFile(path);
  if (bytes.length > MAX_ATTACHMENT_BYTES)
    throw new ReviewInputError(`--attach ${quoted(name)} is over 5 MiB`);
  if (imageTypeOf(bytes) !== expected)
    throw new ReviewInputError(
      `--attach ${quoted(name)} is not a ${IMAGE_LABEL[expected]} image (its first bytes do not match its extension)`,
    );
  return { bytes, ext: expected === 'png' ? 'png' : 'jpg' };
}

const ITEM_ID = /^ck_[0-9a-f]{16}$/;
const FINDING_ID = /^wd_[0-9a-f]{16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkInput(input: RecordInput): void {
  const fail = (message: string) => {
    throw new ReviewInputError(message);
  };
  if (!ITEM_ID.test(input.item))
    fail(`--item must be a checklist item id (ck_ and 16 hex characters)`);
  if (!(MANUAL_OUTCOMES as readonly string[]).includes(input.outcome))
    fail(`--outcome must be one of ${MANUAL_OUTCOMES.join(', ')}`);
  if (input.reviewer.trim() === '') fail('--reviewer needs a name');
  if (input.reviewer.length > MAX_REVIEWER_CHARS)
    fail(`--reviewer is over ${MAX_REVIEWER_CHARS} characters`);
  if ((input.notes?.length ?? 0) > MAX_NOTES_CHARS)
    fail(`--notes is over ${MAX_NOTES_CHARS} characters`);
  const hasNotes = (input.notes ?? '').trim() !== '';
  const overrides = input.overrides ?? [];
  for (const id of overrides)
    if (!FINDING_ID.test(id))
      fail(`--override ${quoted(id)} is not a finding id (wd_ and 16 hex characters)`);
  if (overrides.length > 0 && input.outcome !== 'pass')
    fail('--override goes only with --outcome pass');
  if (overrides.length > 0 && !hasNotes)
    fail('--override needs --notes saying why the automated fail is a false positive');
  if (input.outcome === 'not-applicable' && !hasNotes)
    fail('--outcome not-applicable needs --notes saying why the criterion does not apply');
  if ((input.attach?.length ?? 0) > MAX_ATTACHMENTS)
    fail(`--attach takes at most ${MAX_ATTACHMENTS} files per record`);
  if (
    input.date !== undefined &&
    !(DATE.test(input.date) && !Number.isNaN(Date.parse(input.date)) && input.date <= tomorrow())
  )
    fail('the review date must be YYYY-MM-DD, no later than tomorrow');
}

const linkRefused = (path: string) =>
  new ConfigError(path, [
    'a symbolic link or junction; Widedoor writes only into a real folder here',
  ]);

/** A real folder at path (created when missing and create is set); never a link. */
async function realFolder(path: string, create: boolean): Promise<void> {
  let info = await lstat(path).catch(() => undefined);
  if (!info && create) {
    await mkdir(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST')
        throw new ConfigError(path, [`cannot be created (${e.code ?? 'error'})`]);
    });
    info = await lstat(path).catch(() => undefined);
  }
  if (!info) throw new ConfigError(path, ['no such folder']);
  if (info.isSymbolicLink()) throw linkRefused(path);
  if (!info.isDirectory()) throw new ConfigError(path, ['not a folder']);
}

/** Refuses a link, folder or device at a file name about to be replaced. */
async function checkFileName(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (info?.isSymbolicLink())
    throw new ConfigError(path, ['a symbolic link; Widedoor does not write through links']);
  if (info && !info.isFile()) throw new ConfigError(path, ['not a regular file']);
}

const RETRY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A temp file name in the same folder; ends in .tmp (a .gitignore line covers leftovers). */
const tempName = (name: string) => `.${name}.${randomBytes(6).toString('hex')}.tmp`;

/** Writes data to a new wx temp file in folder and returns its path. */
async function writeTemp(folder: string, name: string, data: string | Uint8Array) {
  const temp = join(folder, tempName(name));
  const file = await open(temp, 'wx', 0o644);
  try {
    await file.writeFile(data);
  } catch (e) {
    await file.close().catch(() => undefined);
    await rm(temp, { force: true });
    throw e;
  }
  await file.close();
  return temp;
}

/**
 * Renames a temp file onto target, which replaces a link at the name
 * instead of writing through it. Windows can refuse a rename for a moment
 * while another process reads the target, so a refused rename is retried
 * briefly; the temp file is removed if it never lands.
 */
async function renameInto(temp: string, target: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, target);
      return;
    } catch (e) {
      if (attempt < 10 && RETRY.has((e as NodeJS.ErrnoException).code ?? '')) {
        await sleep(20 * (attempt + 1));
        continue;
      }
      await rm(temp, { force: true });
      throw e;
    }
  }
}

/** Why a lock file cannot be used at all (not a stale lock: a folder, a link, a device). */
const lockRefused = (lock: string, why: string) =>
  new ConfigError(lock, [`${why}; remove it if no Widedoor is running`]);

/**
 * Runs fn while holding <file>.lock, created with wx so only one writer
 * holds it. A lock older than LOCK_STALE_MS (or dated in the future) was
 * left by a writer that died: it is renamed aside to <file>.lock.<hex>.stale
 * (only one waiter's rename succeeds) and taken over. A lock that cannot be
 * moved, a folder or link at the lock name, and a wait past LOCK_WAIT_MS
 * end with a ConfigError naming the lock. The lock is removed in finally,
 * unless another writer took it over.
 */
async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const token = `${process.pid} ${randomBytes(8).toString('hex')}\n`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let failedTakeovers = 0;
  for (;;) {
    const held = await lstat(lock).catch(() => undefined);
    if (held && !held.isFile())
      throw lockRefused(lock, held.isSymbolicLink() ? 'a symbolic link' : 'not a regular file');
    if (!held) {
      try {
        const handle = await open(lock, 'wx', 0o644);
        await handle.writeFile(token).finally(() => handle.close());
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST')
          throw new ConfigError(lock, [`the lock file cannot be created (${code ?? 'error'})`]);
      }
    } else {
      const age = Date.now() - held.mtimeMs;
      if (age > LOCK_STALE_MS || age < -LOCK_FUTURE_MS) {
        const aside = `${lock}.${randomBytes(6).toString('hex')}.stale`;
        const moved = await rename(lock, aside).then(
          () => true,
          () => false,
        );
        if (moved) {
          const took = await lstat(aside).catch(() => undefined);
          // Another waiter may have replaced the stale lock first: put its fresh lock back,
          // unless a third writer holds the name by now (link never replaces a file).
          if (took && took.mtimeMs !== held.mtimeMs) await link(aside, lock).catch(() => undefined);
          await rm(aside, { force: true });
          continue;
        }
        // Another waiter moved it first, or the system refuses (a sharing violation, EACCES).
        if (++failedTakeovers >= LOCK_TAKEOVER_TRIES)
          throw lockRefused(lock, 'a stale lock that cannot be moved aside');
      }
    }
    if (Date.now() > deadline)
      throw new ConfigError(lock, [
        'another writer has held this lock for too long; remove it if no Widedoor is running',
      ]);
    await sleep(10 + Math.random() * 40);
  }
  try {
    return await fn();
  } finally {
    const current = await readFile(lock, 'utf8').catch(() => undefined);
    if (current === token) await rm(lock, { force: true });
  }
}

/** The last writer queued on each file in this process (resolved path), until it settles. */
const queued = new Map<string, Promise<void>>();

/**
 * Runs fn under withFileLock, after every earlier caller in this process for
 * the same file has settled. Writers in one process (the local server's
 * requests) never race each other for the lock file, so only another
 * process can meet a stale lock at the same moment.
 */
async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(file);
  // The queued promise never rejects, so a failed writer does not stop the next one.
  const run = (queued.get(key) ?? Promise.resolve()).then(() => withFileLock(file, fn));
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queued.set(key, settled);
  try {
    return await run;
  } finally {
    if (queued.get(key) === settled) queued.delete(key);
  }
}

/** Natural order of criterion ids: 1.4.4 before 1.4.10. */
function compareIds(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    if (x === y) continue;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** WCAG criteria first, then 508 provisions, each in natural order; then asset uri and id. */
function byCriterion(a: Finding, b: Finding): number {
  const [ta, ia] = criterionOf(a);
  const [tb, ib] = criterionOf(b);
  if (ta !== tb) return ta === 'wcag' ? -1 : 1;
  const ids = compareIds(ia, ib);
  if (ids !== 0) return ids;
  if (a.asset.uri !== b.asset.uri) return a.asset.uri < b.asset.uri ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The leading comment of a review file; informational. The uri goes through
 * safeText, which escapes CR, LF, NEL and the line and paragraph separators,
 * so it cannot end the comment line and start YAML of its own.
 */
const header = (uri: string | undefined) =>
  uri === undefined
    ? '# Widedoor manual review records for product-scope items (written by widedoor review record).\n' +
      '# Each is anchored to the first scanned asset of the report it was recorded against\n' +
      '# (asset.uri) and expires when that asset changes.\n'
    : '# Widedoor manual review records (written by widedoor review record).\n' +
      `# Asset: ${safeText(uri, 2000)}\n` +
      "# Each record's asset.uri is what counts; these comments are for reading only.\n";

/**
 * Attachment paths that any record in the folder names, read leniently (no
 * parser output, records of any shape). Undefined when the folder or any file
 * in it cannot be read or parsed, or the folder is over the loader's caps
 * (file count, total bytes), so the caller deletes nothing.
 */
async function namedAttachments(folder: string): Promise<Set<string> | undefined> {
  const names = await readdir(folder).catch(() => undefined);
  if (!names) return undefined;
  const files = names.filter((n) => /\.ya?ml$/i.test(n));
  if (files.length > MAX_REVIEW_FILES) return undefined;
  const named = new Set<string>();
  let total = 0;
  for (const name of files) {
    let raw: unknown;
    try {
      const text = readRepoFile(join(folder, name), MAX_REVIEW_BYTES) ?? '';
      total += Buffer.byteLength(text);
      if (total > MAX_REVIEW_TOTAL_BYTES) return undefined;
      raw = parse(text, { logLevel: 'silent' });
    } catch {
      return undefined;
    }
    for (const r of Array.isArray(raw) ? raw : [raw]) {
      const list = (r as { review?: { attachments?: unknown } } | null)?.review?.attachments;
      if (Array.isArray(list)) for (const p of list) if (typeof p === 'string') named.add(p);
    }
  }
  return named;
}

/**
 * Records one manual result for a checklist item and returns the file and
 * the record. Validates against the report (the item exists, overrides
 * name automated fails on its asset and criterion), then, under the file's
 * lock, re-reads the file and replaces any record for the same item. New
 * attachments get fresh names (<ck id>-<n>-<hex>.<ext>), are written before
 * the YAML and removed again if it does not land, so the record on disk
 * never names an image it did not write; the images of the replaced record
 * are deleted only after the YAML lands, and only those no record in the
 * folder still names. Throws ReviewInputError for input the report does not
 * support, ConfigError for a review folder or file that cannot be used.
 */
export async function recordReview(
  dir: string,
  input: RecordInput,
): Promise<{ file: string; record: Finding }> {
  checkInput(input);
  const data = input.data ?? loadStandardsData();
  const images: Image[] = [];
  for (const path of input.attach ?? []) images.push(await readImage(path));

  const item = itemsOf(input.report, data).find((i) => i.id === input.item);
  if (!item) throw new ReviewInputError(`there is no checklist item ${input.item} in the report`);
  // A product-scope record anchors to the first scanned asset in report order.
  const asset = item.asset
    ? input.report.assets.find((a) => a.uri === item.asset?.uri)
    : input.report.assets[0];
  if (!asset) throw new ReviewInputError(`the report has no scanned asset for ${input.item}`);
  const { type, id } = item.criterion;
  const overrides = [...new Set(input.overrides ?? [])];
  const bad = badOverrides(overrides, asset.uri, type, id, automatedOf(input.report));
  if (bad.length > 0)
    throw new ReviewInputError(`--override ${overrideProblem(bad, asset.uri, type, id)}`);

  const ruleId = manualRuleId(type, id);
  const location: Location = asset.kind === 'web' ? { selector: 'html' } : {};
  const stamp = randomBytes(4).toString('hex');
  const names = images.map((img, i) => `${ATTACHMENTS}/${item.id}-${i + 1}-${stamp}.${img.ext}`);
  const record = FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(asset.uri, location, 'manual', ruleId),
    asset: {
      kind: asset.kind,
      uri: asset.uri,
      contentHash: asset.contentHash,
      ...(asset.reviewHash ? { reviewHash: asset.reviewHash } : {}),
    },
    location,
    source: { engine: 'manual', engineVersion: input.version, ruleId },
    criteria: {
      ...(type === 'wcag' ? { wcag: [id] } : { section508: [id] }),
      ...(item.baselineTests[0] ? { baselineTest: item.baselineTests[0] } : {}),
    },
    outcome: input.outcome,
    review: {
      reviewer: input.reviewer,
      date: input.date ?? today(),
      ...(input.notes ? { notes: input.notes } : {}),
      expiresOnChangeOf: asset.reviewHash ?? asset.contentHash,
      ...(overrides.length > 0 ? { overrides } : {}),
      ...(names.length > 0 ? { attachments: names } : {}),
    },
  });

  const folder = join(dir, REVIEW_DIR);
  const target = reviewFileName(item);
  await realFolder(folder, true);
  const file = join(folder, target);

  return withLock(file, async () => {
    // Read under the lock, so a concurrent writer's record is kept.
    await realFolder(folder, false);
    await checkFileName(file);
    const text = readRepoFile(file, MAX_REVIEW_BYTES);
    const existing =
      text === undefined ? [] : parseReviewFile(file, text, folderContext(folder, data));
    const sameItem = (f: Finding) =>
      f.source.ruleId === ruleId && (item.scope === 'product' || f.asset.uri === asset.uri);
    const replaced = existing.filter(sameItem);
    const records = [...existing.filter((f) => !sameItem(f)), record].sort(byCriterion);

    const attachDir = join(folder, ATTACHMENTS);
    const written: string[] = [];
    try {
      if (images.length > 0) await realFolder(attachDir, true);
      for (const [i, img] of images.entries()) {
        const target = join(attachDir, basename(names[i] as string));
        await checkFileName(target);
        await renameInto(await writeTemp(attachDir, basename(target), img.bytes), target);
        written.push(target);
      }
      await realFolder(folder, false);
      await checkFileName(file);
      const yaml =
        header(item.asset?.uri) +
        stringify(records, { aliasDuplicateObjects: false, lineWidth: 0 });
      await renameInto(await writeTemp(folder, target, yaml), file);
    } catch (e) {
      for (const path of written) await rm(path, { force: true });
      throw e;
    }

    // Images of the replaced record that are this item's and that no record still names.
    const own = new RegExp(`^${ATTACHMENTS}/${item.id}-\\d+(?:-[0-9a-f]{8})?\\.(?:png|jpg)$`);
    const stale = replaced
      .flatMap((f) => ('review' in f ? (f.review.attachments ?? []) : []))
      .filter((path) => own.test(path) && !names.includes(path));
    const stillNamed = stale.length > 0 ? await namedAttachments(folder) : undefined;
    for (const path of new Set(stale)) {
      if (!stillNamed || stillNamed.has(path)) continue;
      const old = join(attachDir, basename(path));
      const info = await lstat(old).catch(() => undefined);
      if (info?.isFile()) await rm(old, { force: true });
    }
    return { file, record };
  });
}
