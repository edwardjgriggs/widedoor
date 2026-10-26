import type { ProfileId } from '@widedoor/core';

/*
 * Scan settings and their defaults, shared by widedoor scan (the CLI parses
 * flags into them) and the scan jobs of widedoor ui (a request sets a few,
 * the config the rest).
 */

export const FORMATS = [
  'html',
  'json',
  'sarif',
  'junit',
  'openacr',
  'vpat-html',
  'vpat-docx',
] as const;
export type Format = (typeof FORMATS)[number];
/** What a scan writes without --format or report.formats; junit and the ACR formats are opt-in (ledger ruling 2.5). */
export const DEFAULT_FORMATS: readonly Format[] = ['html', 'json', 'sarif'];
/** Formats that write an ACR: they need the Section 508 view and acr.product.name. */
export const ACR_FORMATS: readonly Format[] = ['openacr', 'vpat-html', 'vpat-docx'];

/** `--fail-on` levels, most severe first; `none` turns the threshold off. */
export const FAIL_ON = ['critical', 'serious', 'moderate', 'minor', 'none'] as const;
export type FailOn = (typeof FAIL_ON)[number];

export const DEFAULT_PROFILE: ProfileId = '508+wcag21aa';
export const DEFAULT_FAIL_ON: FailOn = 'serious';
export const DEFAULT_OUT = 'widedoor-report';
export const CONFIG_FILE = 'widedoor.config.yaml';
/** One page and one PDF at a time keeps a default run small (ledger F1). */
export const DEFAULT_CONCURRENCY = 1;
/** Memory cap per PDF, in MiB, for the veraPDF container and the PDF reader. */
export const DEFAULT_MEMORY_MB = 768;
export const MIN_MEMORY_MB = 256;
export const MAX_MEMORY_MB = 65_536;
export const MAX_CONCURRENCY = 32;

/** Bad input for a scan (a command line, or a scan request): the CLI prints it with the usage hint and exits 2. */
export class UsageError extends Error {
  constructor(
    message: string,
    /** Print the full usage text, not just the hint. */
    readonly showUsage = false,
  ) {
    super(message);
    this.name = 'UsageError';
  }
}
