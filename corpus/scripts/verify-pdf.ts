import { readFileSync } from 'node:fs';
import {
  PdfScanner,
  VERAPDF_VERSION,
  WIDEDOOR_PDF_VERSION,
  parseVerapdfOutput,
  type PdfFileScan,
} from '@widedoor/pdf';
import {
  compareExact,
  corpusDir,
  corpusPath,
  readExpected,
  readManifest,
  type ExpectedEntry,
} from './lib/corpus.ts';

/*
 * Scans every PDF in the manifest with the shipped PDF adapter (@widedoor/pdf,
 * built first by tsc -b): veraPDF PDF/UA-1 through its sandboxed runner, plus
 * the Widedoor PDF checks. Both engines' entries are compared exactly (see
 * README); veraPDF's unmapped rules count as veraPDF results. An item whose
 * expected file names a scan error must get that error and no findings, and
 * veraPDF run directly must refuse the file the same way.
 */

const confirmedBy = `veraPDF ${VERAPDF_VERSION}, Widedoor ${WIDEDOOR_PDF_VERSION}`;

function triples(scan: PdfFileScan): ExpectedEntry[] {
  return [
    ...scan.findings.map((f) => ({
      engine: f.source.engine as ExpectedEntry['engine'],
      ruleId: f.source.ruleId,
      outcome: f.outcome,
    })),
    ...scan.informational.map((i) => ({ engine: i.engine, ruleId: i.ruleId, outcome: i.outcome })),
  ];
}

const scanner = await PdfScanner.create({ baseDir: corpusDir });
if (!scanner.runner)
  throw new Error('veraPDF is not available; see the scanner error for how to get it');
for (const w of scanner.warnings) console.warn(`warning: ${w}`);

let failures = 0;
const items = readManifest().items.filter((i) => i.kind === 'pdf');
for (const item of items) {
  const expected = readExpected(item.expected);
  const scan = await scanner.scanFile(item.path);
  const lines: string[] = [];
  if (expected.confirmedBy !== confirmedBy) lines.push(`confirmedBy is ${expected.confirmedBy}`);
  if (expected.error) {
    if (scan.error?.code !== expected.error.code)
      lines.push(`expected error ${expected.error.code}, got ${scan.error?.code ?? 'none'}`);
    if (scan.findings.length) lines.push(`${scan.findings.length} findings despite the error`);
    const direct = parseVerapdfOutput(
      await scanner.runner.run(readFileSync(corpusPath(item.path)), {
        timeoutMs: 120_000,
        maxOutputBytes: 1024 * 1024,
        maxFailuresDisplayed: 1,
      }),
    );
    if (direct.ok || direct.code !== expected.error.code)
      lines.push(`veraPDF alone gives ${direct.ok ? 'a report' : direct.code}`);
  } else if (scan.error) {
    lines.push(`scan error ${scan.error.code}: ${scan.error.message}`);
  } else {
    const actual = triples(scan);
    for (const engine of ['verapdf', 'widedoor'] as const) {
      const { missing, unexpected } = compareExact(engine, expected.expected, actual);
      lines.push(
        ...missing.map((k) => `missing ${k}`),
        ...unexpected.map((k) => `unexpected ${k}`),
      );
    }
    if (scan.findings.some((f) => f.asset.contentHash !== scan.asset?.contentHash))
      lines.push('a finding carries another content hash');
  }
  if (lines.length) {
    failures++;
    console.error(`FAIL ${item.path}: ${lines.join('; ')}`);
  } else {
    const found = triples(scan)
      .filter((a) => a.outcome === 'fail' || a.outcome === 'needs-review')
      .map((a) => `${a.engine} ${a.ruleId} ${a.outcome}`);
    const summary = expected.error
      ? `error ${expected.error.code}`
      : found.length
        ? [...new Set(found)].sort().join(', ')
        : 'no findings';
    console.log(`ok ${item.path}: ${summary}`);
  }
}
console.log(
  `corpus/pdf: ${items.length - failures}/${items.length} files match ${confirmedBy} (runner: ${scanner.runner.kind})`,
);
if (failures) process.exitCode = 1;
