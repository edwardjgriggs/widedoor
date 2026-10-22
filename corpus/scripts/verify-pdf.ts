import { execFileSync } from 'node:child_process';
import {
  compareExact,
  corpusPath,
  readExpected,
  readManifest,
  type ExpectedEntry,
} from './lib/corpus.ts';

/*
 * Validates every PDF in the manifest with veraPDF (PDF/UA-1 profile, Docker
 * image pinned below, no network) and compares the veraPDF entries of each
 * expected file exactly (see README). Widedoor-engine entries are provisional
 * until Task 1.2 implements those checks, so they are not compared here.
 */

const VERAPDF_IMAGE = 'verapdf/cli:v1.30.3';
const VERAPDF_VERSION = '1.30.3';
const confirmedBy = `veraPDF ${VERAPDF_VERSION}`;

interface RuleSummary {
  clause: string;
  testNumber: number;
  status: 'passed' | 'failed';
}

function verapdf(file: string): ExpectedEntry[] {
  let stdout: string;
  try {
    stdout = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--mount',
        `type=bind,src=${corpusPath('pdf')},dst=/data,readonly`,
        VERAPDF_IMAGE,
        '--flavour',
        'ua1',
        '--format',
        'json',
        '--success',
        '--maxfailuresdisplayed',
        '1',
        `/data/${file}`,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    // veraPDF exits 1 when the file is not compliant; the report is still on stdout.
    const out = (e as { stdout?: string }).stdout;
    if (!out) throw new Error(`veraPDF did not run on ${file}`, { cause: e });
    stdout = out;
  }
  const report = JSON.parse(stdout).report;
  const version = report.buildInformation.releaseDetails.find(
    (d: { id: string }) => d.id === 'core',
  )?.version;
  if (version !== VERAPDF_VERSION)
    throw new Error(`expected veraPDF ${VERAPDF_VERSION}, got ${version}`);
  const result = report.jobs[0].validationResult[0];
  return (result.details.ruleSummaries as RuleSummary[]).map((r) => ({
    engine: 'verapdf' as const,
    ruleId: `${r.clause}-${r.testNumber}`,
    outcome: r.status === 'failed' ? ('fail' as const) : ('pass' as const),
  }));
}

let failures = 0;
const items = readManifest().items.filter((i) => i.kind === 'pdf');
for (const item of items) {
  const expected = readExpected(item.expected);
  if (!item.path.startsWith('pdf/') || item.path.slice(4).includes('/')) {
    throw new Error(`not a corpus/pdf file: ${item.path}`);
  }
  const actual = verapdf(item.path.slice('pdf/'.length));
  const { missing, unexpected } = compareExact('verapdf', expected.expected, actual);
  const failed = actual.filter((a) => a.outcome === 'fail').map((a) => a.ruleId);
  if (missing.length || unexpected.length || expected.confirmedBy !== confirmedBy) {
    failures++;
    const lines = [
      ...missing.map((k) => `missing ${k}`),
      ...unexpected.map((k) => `unexpected ${k}`),
    ];
    if (expected.confirmedBy !== confirmedBy) lines.push(`confirmedBy is ${expected.confirmedBy}`);
    console.error(`FAIL ${item.path}: ${lines.join('; ')}`);
  } else {
    console.log(
      `ok ${item.path}: ${failed.length ? `fails ${failed.sort().join(', ')}` : 'no failed rules'}`,
    );
  }
}
console.log(`corpus/pdf: ${items.length - failures}/${items.length} files match ${confirmedBy}`);
if (failures) process.exitCode = 1;
