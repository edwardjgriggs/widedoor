import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  RESOURCE_LIMIT_MARKER,
  type InspectErrorCode,
  type InspectReply,
} from './inspect-child.js';
import { runProcess, type SpawnFn } from './verapdf.js';

export type { PdfInspection, InspectErrorCode } from './inspect-child.js';

export interface InspectLimits {
  /** Documents with more pages are not read. */
  maxPages: number;
  /** Wall-clock budget for the whole document; the reader process is killed after it. */
  timeoutMs: number;
  /** V8 heap cap of the reader process, in MiB (--max-old-space-size). */
  maxHeapMb: number;
  /** Resident memory cap of the reader process, in MiB; its watchdog kills it above this. */
  maxRssMb: number;
}

export type InspectOutcome =
  | Extract<InspectReply, { ok: true }>
  | { ok: false; code: InspectErrorCode | 'timeout' | 'resource-limit'; message: string };

// Tests run the sources, where the reader is still a .ts file (Node strips its types).
const childPath = fileURLToPath(
  new URL(
    import.meta.url.endsWith('.ts') ? './inspect-child.ts' : './inspect-child.js',
    import.meta.url,
  ),
);

/** Largest reply read from the reader. */
const MAX_REPLY_BYTES = 4 * 1024 * 1024;

/** The reply the reader may send, bounded; anything else is a reader failure. */
const InspectReplySchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    inspection: z.strictObject({
      pages: z.number().int().min(0).max(1_000_000),
      title: z.string().max(1024).nullable(),
      displayDocTitle: z.boolean(),
      lang: z.string().max(1024).nullable(),
      outlineItems: z.number().int().min(0),
      tagged: z.boolean(),
      structureTypes: z.array(z.string().max(64)).max(10_000),
      structureTruncated: z.boolean(),
      imageOnlyPages: z.array(z.number().int().min(1)).max(1_000_000),
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['malformed-pdf', 'encrypted-pdf', 'too-many-pages', 'scan-failed']),
    message: z.string().max(1024),
  }),
]);

/**
 * The only parent variables the reader gets: enough for Node and the OS to
 * start a process and find a temp dir. Secrets in the scanner's environment
 * (CI tokens, API keys) never reach the process that parses untrusted PDFs.
 */
const ENV_ALLOWLIST = new Set([
  'PATH',
  'SYSTEMROOT',
  'WINDIR',
  'SYSTEMDRIVE',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'TZ',
]);

/** The allow-listed subset of the parent environment (keys compared case-insensitively). */
export function readerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env))
    if (value !== undefined && ENV_ALLOWLIST.has(key.toUpperCase())) out[key] = value;
  return out;
}

const OUT_OF_MEMORY = /heap out of memory|Allocation failed|ERR_WORKER_OUT_OF_MEMORY|ENOMEM/;

/**
 * Reads a PDF with pdf.js in a separate Node process under the given limits:
 * heap cap, resident-memory watchdog, wall-clock deadline and a reply cap. A
 * reader that runs out of memory or is killed costs only that process; the
 * scanner gets `resource-limit` or `timeout`. Never throws.
 */
export async function inspectPdf(
  bytes: Uint8Array,
  limits: InspectLimits,
  spawn: SpawnFn = nodeSpawn,
): Promise<InspectOutcome> {
  const env = readerEnv();
  let run;
  try {
    run = await runProcess(
      process.execPath,
      [
        `--max-old-space-size=${limits.maxHeapMb}`,
        childPath,
        String(limits.maxPages),
        String(limits.maxRssMb),
        String(limits.timeoutMs),
      ],
      { timeoutMs: limits.timeoutMs, maxOutputBytes: MAX_REPLY_BYTES },
      { spawn, input: bytes, spawnOptions: { env } },
    );
  } catch {
    return { ok: false, code: 'scan-failed', message: 'the PDF reader did not start' };
  }
  if (run.timedOut)
    return {
      ok: false,
      code: 'timeout',
      message: `reading the PDF took longer than ${limits.timeoutMs} ms`,
    };
  if (run.stderr.includes(RESOURCE_LIMIT_MARKER) || OUT_OF_MEMORY.test(run.stderr))
    return { ok: false, code: 'resource-limit', message: 'reading the PDF passed its memory cap' };
  if (run.truncated)
    return { ok: false, code: 'scan-failed', message: 'the PDF reader reply was too large' };
  if (run.exitCode === 0) {
    try {
      const reply = InspectReplySchema.safeParse(JSON.parse(run.stdout));
      if (reply.success) return reply.data satisfies InspectReply;
      return { ok: false, code: 'scan-failed', message: 'the PDF reader sent an unexpected reply' };
    } catch {
      // Falls through to the generic failure.
    }
  }
  // Killed from outside, or crashed without a word: treat as the reader's limit being hit.
  if (run.exitCode === null)
    return { ok: false, code: 'resource-limit', message: 'the PDF reader was killed' };
  return {
    ok: false,
    code: 'scan-failed',
    message: `the PDF reader exited with ${run.exitCode}`,
  };
}
