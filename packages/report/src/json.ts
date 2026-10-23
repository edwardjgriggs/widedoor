import { ScanReportCheckedSchema, type ScanReport } from './model.js';

/** The JSON report: the ScanReport, validated, with two-space indent and a final newline. */
export function serializeJson(report: ScanReport): string {
  return `${JSON.stringify(ScanReportCheckedSchema.parse(report), null, 2)}\n`;
}

/** Reads a JSON report back; throws a ZodError when it does not match report.v1.json or lists a record for an unknown asset. */
export function parseJsonReport(text: string): ScanReport {
  return ScanReportCheckedSchema.parse(JSON.parse(text));
}
