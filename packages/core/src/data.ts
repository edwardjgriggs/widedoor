import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

/*
 * Standards data (spec section 4): WCAG criteria, Section 508 provisions, ICT
 * Testing Baseline tests and the engine rule maps. Every file under data/ has
 * a strict schema; validateStandardsData() also checks that every SC and 508
 * provision referenced anywhere exists. `npm run check:data` runs it in CI.
 */

const scId = z.string().regex(/^\d\.\d{1,2}\.\d{1,2}$/, 'expected a WCAG SC id such as 1.4.3');
const provisionId = z
  .string()
  .regex(/^(?:E\d{3}|\d{3})(?:\.\d+)*$/, 'expected a 508 provision id such as E205.4 or 502.3.1');
const isoDate = z.iso.date();
const text = z.string().min(1);

const MetaSchema = z.strictObject({
  sources: z.array(z.url()).min(1),
  retrieved: isoDate,
  edition: text.optional(),
  standard: text.optional(),
  engine: z.enum(['axe-core', 'verapdf', 'widedoor']).optional(),
  engineVersion: text.optional(),
  profile: text.optional(),
  specification: text.optional(),
  branch: text.optional(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  baselines: z
    .record(z.enum(['web', 'document']), z.strictObject({ name: text, version: text }))
    .optional(),
});

export const WcagLevelSchema = z.enum(['A', 'AA']);
export type WcagLevel = z.infer<typeof WcagLevelSchema>;
export const WcagVersionSchema = z.enum(['2.0', '2.1']);
export type WcagVersion = z.infer<typeof WcagVersionSchema>;

export const WcagDataSchema = z.strictObject({
  meta: MetaSchema,
  criteria: z
    .array(
      z.strictObject({ id: scId, title: text, level: WcagLevelSchema, version: WcagVersionSchema }),
    )
    .min(1),
});

export const ManualScopeSchema = z.enum(['product', 'web']);
export type ManualScope = z.infer<typeof ManualScopeSchema>;
export const ManualConditionSchema = z.strictObject({ provision: provisionId, text });
export type ManualCondition = z.infer<typeof ManualConditionSchema>;

export const Section508DataSchema = z.strictObject({
  meta: MetaSchema,
  provisions: z
    .array(
      z.strictObject({
        id: provisionId,
        title: text,
        kind: z.enum(['section', 'scoping', 'requirement']),
        incorporatesWcag20: z.literal(true).optional(),
        exceptions: z
          .array(
            z.strictObject({
              appliesTo: z.enum([
                'non-web-document',
                'non-web-software',
                'assistive-technology-software',
                'web-application-without-platform-services',
              ]),
              criteria: z.array(scId).min(1).optional(),
              provisions: z.array(provisionId).min(1).optional(),
              conformanceRequirement: z.number().int().min(1).max(5).optional(),
              text,
            }),
          )
          .min(1)
          .optional(),
        manual: z
          .strictObject({
            scope: ManualScopeSchema,
            /** When the item applies; a reviewer marks it N/A citing `provision` otherwise. */
            condition: ManualConditionSchema.optional(),
          })
          .optional(),
        note: text.optional(),
      }),
    )
    .min(1),
});

export const BaselineDataSchema = z.strictObject({
  meta: MetaSchema.extend({ commit: z.string().regex(/^[0-9a-f]{40}$/) }),
  tests: z
    .array(
      z
        .strictObject({
          id: z.string().regex(/^\d{1,2}\.[A-Z]-[A-Za-z]+$/, 'expected a Baseline Test ID'),
          baseline: z.enum(['web', 'document']),
          title: text,
          wcag: z.array(scId),
          section508: z.array(provisionId).min(1).optional(),
          conformanceRequirement: z.number().int().min(1).max(5).optional(),
          notApplicable: text.optional(),
          basis: text.optional(),
        })
        .refine(
          (t) =>
            t.notApplicable !== undefined ||
            t.wcag.length > 0 ||
            t.section508 !== undefined ||
            t.conformanceRequirement !== undefined,
          'a test must cite an SC, a 508 provision or a conformance requirement, or be notApplicable',
        ),
    )
    .min(1),
});

const decides = z.boolean();
const impact = z.enum(['critical', 'serious', 'moderate', 'minor']);

export const AxeMapSchema = z.strictObject({
  meta: MetaSchema.extend({ engine: z.literal('axe-core'), engineVersion: text }),
  rules: z
    .array(
      z.strictObject({
        id: text,
        wcag: z.array(scId).min(1),
        /** SC the rule is tagged with that are outside WCAG 2.0/2.1 A/AA (for example AAA). */
        wcagOutOfScope: z.array(scId).min(1).optional(),
        actRules: z.array(z.string().regex(/^[0-9a-z]{6}$/, 'expected an ACT rule id')),
        decides,
        status: z.enum(['deprecated', 'experimental']).optional(),
      }),
    )
    .min(1),
});

const verapdfId = {
  id: z.string().regex(/^\d+(?:\.\d+)*-\d+$/, 'expected <clause>-<testNumber>'),
  clause: z.string().regex(/^\d+(?:\.\d+)*$/),
  testNumber: z.number().int().min(1),
};
const idMatchesClause = (r: { id: string; clause: string; testNumber: number }) =>
  r.id === `${r.clause}-${r.testNumber}`;

export const VerapdfMapSchema = z.strictObject({
  meta: MetaSchema.extend({
    engine: z.literal('verapdf'),
    specification: text,
    commit: z.string().regex(/^[0-9a-f]{40}$/),
  }),
  rules: z
    .array(
      z
        .strictObject({
          ...verapdfId,
          wcag: z.array(scId).min(1),
          /** Default severity of a fail or needs-review finding from this rule. */
          impact,
          decides,
          basis: text,
        })
        .refine(idMatchesClause, 'id must be <clause>-<testNumber>'),
    )
    .min(1),
  unmapped: z.array(
    z
      .strictObject({ ...verapdfId, reason: text })
      .refine(idMatchesClause, 'id must be <clause>-<testNumber>'),
  ),
});

export const WidedoorMapSchema = z.strictObject({
  meta: MetaSchema.extend({ engine: z.literal('widedoor') }),
  rules: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z][a-z0-9-]*$/),
        title: text,
        wcag: z.array(scId).min(1),
        /** Default severity of a fail or needs-review finding from this rule. */
        impact,
        decides,
        basis: text,
      }),
    )
    .min(1),
});

export type WcagData = z.infer<typeof WcagDataSchema>;
export type WcagCriterion = WcagData['criteria'][number];
export type Section508Data = z.infer<typeof Section508DataSchema>;
export type Section508Provision = Section508Data['provisions'][number];
export type BaselineData = z.infer<typeof BaselineDataSchema>;
export type AxeMap = z.infer<typeof AxeMapSchema>;
export type VerapdfMap = z.infer<typeof VerapdfMapSchema>;
export type WidedoorMap = z.infer<typeof WidedoorMapSchema>;

export const DATA_FILES = {
  wcag: 'wcag.yaml',
  section508: 'section508.yaml',
  baseline: 'baseline.yaml',
  axe: 'axe-map.yaml',
  verapdf: 'verapdf-map.yaml',
  widedoor: 'widedoor-map.yaml',
} as const;
export type DataFileKey = keyof typeof DATA_FILES;

const SCHEMAS = {
  wcag: WcagDataSchema,
  section508: Section508DataSchema,
  baseline: BaselineDataSchema,
  axe: AxeMapSchema,
  verapdf: VerapdfMapSchema,
  widedoor: WidedoorMapSchema,
} as const;

export interface StandardsData {
  wcag: WcagData;
  section508: Section508Data;
  baseline: BaselineData;
  axe: AxeMap;
  verapdf: VerapdfMap;
  widedoor: WidedoorMap;
}

/** Parsed but unvalidated file contents, keyed like DATA_FILES. */
export type RawStandardsData = Record<DataFileKey, unknown>;

export class DataValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`standards data is invalid:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'DataValidationError';
  }
}

export const defaultDataDir = new URL('../data/', import.meta.url);

export function readRawStandardsData(dir: URL = defaultDataDir): RawStandardsData {
  const raw = {} as RawStandardsData;
  const issues: string[] = [];
  for (const [key, file] of Object.entries(DATA_FILES) as [DataFileKey, string][]) {
    try {
      raw[key] = parse(readFileSync(new URL(file, dir), 'utf8'));
    } catch (e) {
      issues.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (issues.length) throw new DataValidationError(issues);
  return raw;
}

const where = (path: PropertyKey[]) => path.map(String).join('.') || '(root)';

export function validateStandardsData(raw: RawStandardsData): StandardsData {
  const issues: string[] = [];
  const out: Partial<Record<DataFileKey, unknown>> = {};
  for (const key of Object.keys(DATA_FILES) as DataFileKey[]) {
    const result = SCHEMAS[key].safeParse(raw[key]);
    if (result.success) out[key] = result.data;
    else {
      for (const issue of result.error.issues) {
        issues.push(`${DATA_FILES[key]}: ${where(issue.path)}: ${issue.message}`);
      }
    }
  }
  if (issues.length) throw new DataValidationError(issues);
  const data = out as StandardsData;
  crossCheck(data, issues);
  if (issues.length) throw new DataValidationError(issues);
  return data;
}

function crossCheck(data: StandardsData, issues: string[]): void {
  const sc = new Set<string>();
  const dup = (file: string, kind: string, seen: Set<string>, id: string, path: string) => {
    if (seen.has(id)) issues.push(`${file}: ${path}: duplicate ${kind} ${id}`);
    seen.add(id);
  };
  data.wcag.criteria.forEach((c, i) => dup(DATA_FILES.wcag, 'SC', sc, c.id, `criteria.${i}.id`));
  const wcag20 = new Set(data.wcag.criteria.filter((c) => c.version === '2.0').map((c) => c.id));

  const provisions = new Set<string>();
  data.section508.provisions.forEach((p, i) =>
    dup(DATA_FILES.section508, 'provision', provisions, p.id, `provisions.${i}.id`),
  );

  const checkSc = (file: string, path: string, ids: readonly string[], set = sc, what = 'SC') =>
    ids.forEach((id, j) => {
      if (!set.has(id)) issues.push(`${file}: ${path}.${j}: unknown ${what} ${id}`);
    });

  data.section508.provisions.forEach((p, i) =>
    p.exceptions?.forEach((e, k) =>
      checkSc(
        DATA_FILES.section508,
        `provisions.${i}.exceptions.${k}.criteria`,
        e.criteria ?? [],
        wcag20,
        'WCAG 2.0 SC',
      ),
    ),
  );
  data.section508.provisions.forEach((p, i) => {
    p.exceptions?.forEach((e, k) =>
      checkSc(
        DATA_FILES.section508,
        `provisions.${i}.exceptions.${k}.provisions`,
        e.provisions ?? [],
        provisions,
        'provision',
      ),
    );
    const c = p.manual?.condition;
    if (c && !provisions.has(c.provision)) {
      issues.push(
        `${DATA_FILES.section508}: provisions.${i}.manual.condition.provision: unknown provision ${c.provision}`,
      );
    }
    // Chapter 5 applies to a web asset only conditionally (501.1, 504.1, platform addressees).
    if (p.manual?.scope === 'web' && !c) {
      issues.push(
        `${DATA_FILES.section508}: provisions.${i}.manual: web-scope item ${p.id} needs a condition`,
      );
    }
  });
  for (const required of ['E205.4', '501.1']) {
    if (!provisions.has(required)) issues.push(`${DATA_FILES.section508}: missing ${required}`);
  }

  const tests = new Set<string>();
  data.baseline.tests.forEach((t, i) => {
    dup(DATA_FILES.baseline, 'test', tests, `${t.baseline}:${t.id}`, `tests.${i}.id`);
    checkSc(DATA_FILES.baseline, `tests.${i}.wcag`, t.wcag, wcag20, 'WCAG 2.0 SC');
    checkSc(
      DATA_FILES.baseline,
      `tests.${i}.section508`,
      t.section508 ?? [],
      provisions,
      'provision',
    );
  });

  const maps = [
    [DATA_FILES.axe, data.axe.rules],
    [DATA_FILES.verapdf, data.verapdf.rules],
    [DATA_FILES.widedoor, data.widedoor.rules],
  ] as const;
  for (const [file, rules] of maps) {
    const seen = new Set<string>();
    rules.forEach((r, i) => {
      dup(file, 'rule', seen, r.id, `rules.${i}.id`);
      checkSc(file, `rules.${i}.wcag`, r.wcag);
    });
  }
  const verapdfSeen = new Set(data.verapdf.rules.map((r) => r.id));
  data.verapdf.unmapped.forEach((u, i) =>
    dup(DATA_FILES.verapdf, 'rule', verapdfSeen, u.id, `unmapped.${i}.id`),
  );
}

let cached: StandardsData | undefined;

/** Loads and validates every data file. Throws DataValidationError on any problem. */
export function loadStandardsData(dir?: URL): StandardsData {
  if (dir) return validateStandardsData(readRawStandardsData(dir));
  cached ??= validateStandardsData(readRawStandardsData());
  return cached;
}
