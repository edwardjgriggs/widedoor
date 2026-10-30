import { z } from 'zod';

/*
 * The hosted page's only client storage (ledger R47): this tab's session
 * storage holds the verification the user made, as { id, host, expiresAt },
 * so a reload in the same tab keeps it. Never the token (it is shown once and
 * kept in memory), no cookies, no localStorage. Storage that is off or full
 * only means a reload forgets the verification.
 */

export const VERIFICATION_KEY = 'widedoor-verification';

const StoredSchema = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{32}$/),
  host: z.string().min(1).max(253),
  expiresAt: z.iso.datetime(),
});
export type StoredVerification = z.infer<typeof StoredSchema>;

/** The stored verification, if there is a readable one. */
export function loadVerification(): StoredVerification | undefined {
  try {
    const raw = window.sessionStorage.getItem(VERIFICATION_KEY);
    return raw === null ? undefined : StoredSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Keeps the verification's id, host and expiry (and nothing else) for this tab. */
export function saveVerification(v: StoredVerification): void {
  try {
    window.sessionStorage.setItem(
      VERIFICATION_KEY,
      JSON.stringify({ id: v.id, host: v.host, expiresAt: v.expiresAt }),
    );
  } catch {
    // Storage is off or full: a reload then forgets it.
  }
}

export function forgetVerification(): void {
  try {
    window.sessionStorage.removeItem(VERIFICATION_KEY);
  } catch {
    // Nothing to forget.
  }
}
