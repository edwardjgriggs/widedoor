import { DataValidationError, loadStandardsData } from '../src/data.ts';

// Validates every file under data/ (schemas and cross-references). Run in CI.
try {
  const d = loadStandardsData();
  console.log(
    [
      `wcag: ${d.wcag.criteria.length} SC`,
      `section508: ${d.section508.provisions.length} provisions`,
      `baseline: ${d.baseline.tests.length} tests`,
      `axe: ${d.axe.rules.length} rules`,
      `verapdf: ${d.verapdf.rules.length} rules, ${d.verapdf.unmapped.length} unmapped`,
      `widedoor: ${d.widedoor.rules.length} rules`,
    ].join('\n'),
  );
} catch (e) {
  if (!(e instanceof DataValidationError)) throw e;
  console.error(e.message);
  process.exitCode = 1;
}
