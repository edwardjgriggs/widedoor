import { z } from 'zod';
import { toPlainData, type PlainData } from '@widedoor/report/browser';

/*
 * Reference data the viewer needs besides the report: plain-language text per
 * rule and the WCAG and Section 508 titles. The build reads them with the
 * same loaders the HTML report uses (vite.config.ts) and bundles them as
 * JSON; they are validated again here.
 */

export interface UiData {
  plain: PlainData;
  wcagTitle: ReadonlyMap<string, string>;
  provisionTitle: ReadonlyMap<string, string>;
}

const pairs = z.array(z.tuple([z.string().min(1), z.string().min(1)]));

export const BundledDataSchema = z.strictObject({
  plain: z.unknown(),
  wcag: pairs,
  provisions: pairs,
});
export type BundledData = z.infer<typeof BundledDataSchema>;

export function toUiData(value: unknown): UiData {
  const data = BundledDataSchema.parse(value);
  return {
    plain: toPlainData(data.plain),
    wcagTitle: new Map(data.wcag),
    provisionTitle: new Map(data.provisions),
  };
}

/** A screenshot the server loaded through the report package's containment loader, or why it did not. */
export type ScreenshotView = { ok: true; dataUri: string } | { ok: false; reason: string };

export const ScreenshotsSchema = z.record(
  z.string(),
  z.union([
    z.strictObject({
      ok: z.literal(true),
      dataUri: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/),
    }),
    z.strictObject({ ok: z.literal(false), reason: z.string() }),
  ]),
);

/** What a screenshot path shows when the server did not load it (a report opened from a file). */
export const NO_EVIDENCE: ScreenshotView = { ok: false, reason: 'no evidence folder was given' };
