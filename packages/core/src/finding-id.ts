import { createHash } from 'node:crypto';
import type { Engine, Location } from './schema.js';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** Stable finding id: wd_ + first 16 hex chars of SHA-256 over a canonical serialization. */
export function findingId(
  assetUri: string,
  location: Location,
  engine: Engine,
  ruleId: string,
): string {
  const canonical = JSON.stringify(canonicalize([assetUri, location, engine, ruleId]));
  return `wd_${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}
