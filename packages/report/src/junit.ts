import type { Finding } from '@widedoor/core';
import { visibleText } from './escape.js';
import { DISCLAIMER, type ScanReport } from './model.js';
import { loadPlainData, plainFor, type PlainData } from './plain.js';
import { DETERMINATION_TEXT, STANDARD_LABEL, engineName, findingPlace } from './view.js';

/*
 * JUnit XML for CI test views: one testsuite per asset in the roll-up
 * (scanned or not), one testcase per criterion of the profile's first
 * standard view that applies to it, and one more testsuite for the
 * product-scope items. A testcase fails when the criterion fails on that
 * asset (its type is the criterion's level, Does Not Support or Partially
 * Supports); it is skipped, with the reason, when the asset has no deciding
 * result or the criterion reads Not Evaluated (a scope gap caps a pass); a
 * pass or Not Applicable passes, saying what decided it (a pass on the
 * errata basis says so and cites it). Every string is escaped for XML 1.0:
 * characters XML 1.0 does not allow are dropped, invisible and bidi
 * characters become visible [U+XXXX] markers as in the HTML report, and
 * markup characters become entities.
 */

export interface JunitOptions {
  plain?: PlainData;
}

// XML 1.0 Char: tab, line feed, carriage return, U+0020 to U+D7FF, U+E000 to U+FFFD, U+10000 up.
const NOT_XML_CHAR = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  // In an attribute these would be normalized to spaces; as references they survive.
  '\t': '&#9;',
  '\n': '&#10;',
  '\r': '&#13;',
};

const clean = (value: unknown) => visibleText(String(value).replace(NOT_XML_CHAR, ''));

/** Element text: invalid characters dropped, invisible ones marked, markup escaped. */
export const xmlText = (value: unknown): string =>
  clean(value).replace(/[&<>]/g, (c) => ENTITIES[c] as string);

/** A double-quoted attribute value; tabs and line breaks are kept as character references. */
export const xmlAttr = (value: unknown): string =>
  clean(value).replace(/[&<>"'\t\n\r]/g, (c) => ENTITIES[c] as string);

type Row = ScanReport['rollup']['standards'][number]['criteria'][number];
type Determination = Omit<Row['assets'][number], 'uri' | 'kind'>;

interface Case {
  name: string;
  result:
    | { kind: 'failure'; type: string; message: string; body: string }
    | { kind: 'skipped'; message: string }
    | { kind: 'pass'; out: string };
}

interface Suite {
  name: string;
  kind: string;
  cases: Case[];
}

/** The fail records behind a failure, one line each: id, rule, plain text and place. */
function failBody(d: Determination, byId: Map<string, Finding[]>, plain: PlainData): string {
  return d.evidence
    .flatMap((id) => byId.get(id) ?? [])
    .filter((f) => f.outcome === 'fail')
    .map((f) => {
      const p = plainFor(f, plain);
      return `${f.id} ${engineName(f.source.engine)} ${f.source.ruleId}: ${p?.what ?? 'failed.'} ${findingPlace(f)}`;
    })
    .join('\n');
}

function caseOf(c: Row, d: Determination, byId: Map<string, Finding[]>, plain: PlainData): Case {
  const name = `${c.id} ${c.title}`;
  const why = DETERMINATION_TEXT[d.reason];
  if (d.state === 'fail')
    return {
      name,
      result: {
        kind: 'failure',
        type: c.level,
        message: `Fails here: ${why}. Across the report: ${c.level}.`,
        body: failBody(d, byId, plain),
      },
    };
  if (d.state === 'not-evaluated')
    return { name, result: { kind: 'skipped', message: `Not Evaluated: ${why}.` } };
  const here = d.state === 'pass' ? 'Passes here' : 'Not applicable here';
  if (c.level === 'Not Evaluated')
    return {
      name,
      result: { kind: 'skipped', message: `Not Evaluated: ${here}, but ${c.reason}.` },
    };
  // A pass on the errata basis carries the criterion's reason, which cites the errata.
  const out =
    d.reason === 'errata'
      ? `${here}: ${why}. ${c.reason}`
      : `${here}: ${why}${d.exception ? ` (${d.exception.provision}: ${d.exception.reason})` : ''}.`;
  return { name, result: { kind: 'pass', out } };
}

/** The suites of a report: assets in roll-up order, then the product-scope items. */
function suitesOf(report: ScanReport, plain: PlainData): { suites: Suite[]; view: string } {
  const view = report.rollup.standards[0];
  const byId = new Map<string, Finding[]>();
  for (const f of report.findings) byId.set(f.id, [...(byId.get(f.id) ?? []), f]);
  const suites = new Map<string, Suite>();
  const product: Suite = {
    name: 'Product (judged once for the whole product)',
    kind: 'product',
    cases: [],
  };
  for (const c of view?.criteria ?? []) {
    if (c.product) product.cases.push(caseOf(c, c.product, byId, plain));
    for (const unit of c.assets) {
      const suite = suites.get(unit.uri) ?? { name: unit.uri, kind: unit.kind, cases: [] };
      suite.cases.push(caseOf(c, unit, byId, plain));
      suites.set(unit.uri, suite);
    }
  }
  return {
    suites: [...suites.values(), ...(product.cases.length > 0 ? [product] : [])],
    view: view ? (STANDARD_LABEL[view.standard] ?? view.standard) : '',
  };
}

const counts = (cases: readonly Case[]) => ({
  tests: cases.length,
  failures: cases.filter((c) => c.result.kind === 'failure').length,
  skipped: cases.filter((c) => c.result.kind === 'skipped').length,
});

/** Serializes the JUnit XML report. */
export function serializeJunit(report: ScanReport, options: JunitOptions = {}): string {
  const plain = options.plain ?? loadPlainData();
  const { suites, view } = suitesOf(report, plain);
  const all = counts(suites.flatMap((s) => s.cases));
  const testcase = (c: Case) => {
    const head = `    <testcase classname="${xmlAttr(view)}" name="${xmlAttr(c.name)}">\n`;
    const r = c.result;
    const inner =
      r.kind === 'failure'
        ? `      <failure message="${xmlAttr(r.message)}" type="${xmlAttr(r.type)}">${xmlText(r.body)}</failure>\n`
        : r.kind === 'skipped'
          ? `      <skipped message="${xmlAttr(r.message)}"/>\n`
          : `      <system-out>${xmlText(r.out)}</system-out>\n`;
    return `${head}${inner}    </testcase>\n`;
  };
  // JUnit's timestamp is an ISO 8601 date and time with no zone and no fraction (UTC here).
  const timestamp = new Date(report.startedAt).toISOString().slice(0, 19);
  const suite = (s: Suite) => {
    const n = counts(s.cases);
    return (
      `  <testsuite name="${xmlAttr(s.name)}" tests="${n.tests}" failures="${n.failures}" errors="0" skipped="${n.skipped}" timestamp="${timestamp}">\n` +
      `    <properties>\n      <property name="kind" value="${xmlAttr(s.kind)}"/>\n    </properties>\n` +
      s.cases.map(testcase).join('') +
      '  </testsuite>\n'
    );
  };
  const scopeComplete =
    report.errors.length === 0 &&
    report.skipped.length === 0 &&
    (report.scopeGaps ?? []).length === 0 &&
    !report.scope.web?.truncated;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<testsuites name="${xmlAttr(`Widedoor ${report.tool.version}, profile ${report.profile.id}`)}" tests="${all.tests}" failures="${all.failures}" errors="0" skipped="${all.skipped}">\n` +
    // Fixed text only: a comment cannot hold "--", so nothing from a scan goes here.
    `  <!-- ${DISCLAIMER} Scope complete: ${scopeComplete ? 'yes' : 'no'}. -->\n` +
    suites.map(suite).join('') +
    '</testsuites>\n'
  );
}
