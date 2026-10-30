/*
 * AI provider settings, keys among them, stay in the CLI process (spec
 * section 9, D16): no child a scan starts (veraPDF, the Docker CLI,
 * Chromium) inherits them.
 */

/** Names of AI provider settings: ANTHROPIC_* and OPENAI_*, in any case (Windows names are case-insensitive). */
export const PROVIDER_ENV = /^(?:ANTHROPIC|OPENAI)_/i;

/** env without the provider names and without unset values: what a scan's child processes get. */
export function withoutProviderEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (value !== undefined && !PROVIDER_ENV.test(name)) out[name] = value;
  return out;
}
