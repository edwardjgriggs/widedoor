import { z } from 'zod';
import { MANUAL_OUTCOMES, PROFILE_IDS, formatIssues } from '@widedoor/core';
import { isHttpUrl } from './config.js';
import { UPLOAD_ID } from './uploads.js';

/*
 * The JSON bodies of the widedoor ui API, as strict zod schemas: an unknown
 * key is refused, so a typo never silently changes a scan or a review.
 * Bodies are read with a byte cap, whatever their Content-Length says.
 */

/** Largest JSON request body. */
export const MAX_JSON_BYTES = 1024 * 1024;
/** URLs one scan request may list. */
export const MAX_REQUEST_URLS = 500;

const uploadId = z.string().regex(UPLOAD_ID, 'must be an upload id (32 hex characters)');

/** POST /api/scans. Without urls and pdfs, the config's scope is scanned (as widedoor scan without targets). */
export const ScanBodySchema = z.strictObject({
  urls: z
    .array(z.string().max(8192).refine(isHttpUrl, 'expected an http or https URL'))
    .max(MAX_REQUEST_URLS)
    .optional(),
  /** PDF uploads (POST /api/uploads?kind=pdf), by id. */
  pdfs: z.array(uploadId).max(MAX_REQUEST_URLS).optional(),
  profile: z.enum(PROFILE_IDS).optional(),
  /** Pages scanned at most; from 1 to the config's page cap. */
  maxPages: z.int().min(1).max(100_000).optional(),
});
export type ScanBody = z.infer<typeof ScanBodySchema>;

/** POST /api/reviews: the fields of widedoor review record; attachments are image uploads, by id. */
export const ReviewBodySchema = z.strictObject({
  item: z.string().max(100),
  outcome: z.enum(MANUAL_OUTCOMES),
  reviewer: z.string().max(10_000),
  notes: z.string().max(100_000).optional(),
  attachments: z
    .array(uploadId)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'names the same upload twice')
    .optional(),
  overrides: z.array(z.string().max(100)).max(1_000).optional(),
});
export type ReviewBody = z.infer<typeof ReviewBodySchema>;

/**
 * POST /api/suggestions: the findings to suggest fixes for (all of the
 * report's fails when absent), and whether to only show what would be sent.
 * 200 ids at most (the ai.maxGroups ceiling); the route also holds them to
 * the run's own maxGroups and to ids the report has.
 */
export const SuggestionsBodySchema = z.strictObject({
  findingIds: z
    .array(z.string().regex(/^wd_[0-9a-f]{16}$/))
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, 'names the same finding twice')
    .optional(),
  dryRun: z.boolean().optional(),
});
export type SuggestionsBody = z.infer<typeof SuggestionsBodySchema>;

/** A request refused; status is the HTTP status that says why. */
export class RequestError extends Error {
  constructor(
    readonly status: 400 | 408 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

/**
 * Reads a request body, at most max bytes (413 past it, before or while reading). With
 * deadlineMs, the whole read must finish in that time: past it the reader is cancelled
 * and the read refused with 408, so a body that drips cannot hold its place for long.
 */
export async function readBody(
  req: Request,
  max: number,
  deadlineMs?: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max)
    throw new RequestError(413, `the body is over ${max} bytes`);
  if (req.body === null) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  let timer: NodeJS.Timeout | undefined;
  const late =
    deadlineMs === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new RequestError(408, 'the body took too long to arrive')),
            Math.max(0, deadlineMs),
          );
        });
  try {
    for (;;) {
      const { done, value } = await (late ? Promise.race([reader.read(), late]) : reader.read());
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        throw new RequestError(413, `the body is over ${max} bytes`);
      }
      chunks.push(value);
    }
  } catch (e) {
    // Not awaited: a cancel that hangs must not hold the request past its deadline.
    if (e instanceof RequestError && e.status === 408) void reader.cancel().catch(() => undefined);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}

/** Whether a Content-Type header names one of the media types (parameters such as charset allowed). */
export function hasType(header: string | null, types: readonly string[]): boolean {
  const type = header?.split(';')[0]?.trim().toLowerCase();
  return type !== undefined && types.includes(type);
}

/**
 * Reads and validates a JSON body: 415 unless it is application/json, 413 over the cap, 400
 * when it does not parse or fit, 408 past deadlineMs (readBody).
 */
export async function readJson<T>(
  req: Request,
  schema: z.ZodType<T>,
  deadlineMs?: number,
): Promise<T> {
  if (!hasType(req.headers.get('content-type'), ['application/json']))
    throw new RequestError(415, 'the body must be application/json');
  const bytes = await readBody(req, MAX_JSON_BYTES, deadlineMs);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new RequestError(400, 'the body is not valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new RequestError(
      400,
      `the request is not valid: ${formatIssues(parsed.error.issues).join('; ')}`,
    );
  return parsed.data;
}
