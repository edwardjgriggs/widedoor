import { join } from 'node:path';
import { safeText } from '@widedoor/core';
import type { ScanReport } from '@widedoor/report';
import {
  AI_SIDECARS,
  UsageError,
  writeSidecars,
  type AiConfig,
  type AiSidecar,
  type AiSuggestionsDoc,
  type LocalAi,
} from '@widedoor/server';
// Types only: erased at build, so loading this module never loads @widedoor/ai (ruling 6).
import type * as Ai from '@widedoor/ai';
import type { AiFlags, AiProviderId } from './args.js';
import type { Io } from './main.js';

/*
 * AI fix suggestions in the CLI (spec section 9, D16): off by default, on
 * with --ai-fixes, --ai-dry-run or ai.enabled. @widedoor/ai, and with it the
 * provider SDKs, is loaded only here and only through a dynamic import when
 * AI runs, so a plain scan never loads it. The provider key is read from the
 * environment in readProviderKey and nowhere else; it is never printed,
 * logged or written. AI never changes the scan's reports or exit code.
 */

export type AiModule = typeof Ai;
export type LoadAi = () => Promise<AiModule>;

/** The only import of @widedoor/ai in the CLI. */
export const loadAi: LoadAi = () => import('@widedoor/ai');

/** Subscribes to stop signals (Ctrl+C); returns the unsubscribe. The shape of @widedoor/server's onStop. */
export type StopSubscribe = (onSignal: (signal: string) => void, cleanup: () => void) => () => void;

/** Test seams: the module loader, a provider in place of the real ones, and the stop signals. */
export interface AiHooks {
  loadAi?: LoadAi;
  provider?: (settings: AiSettings, ai: AiModule) => Ai.FixProvider;
  onStop?: StopSubscribe;
}

export const KEY_VARIABLES: Record<AiProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/** The provider key from the environment; a blank value counts as missing. The one place the CLI reads a key. */
export function readProviderKey(provider: AiProviderId): string | undefined {
  const value = process.env[KEY_VARIABLES[provider]];
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

const LIMIT_NAMES = [
  'maxGroups',
  'maxRequestsPerMinute',
  'concurrency',
  'maxOutputTokens',
  'maxInputTokensTotal',
] as const;

export interface AiSettings {
  provider: AiProviderId;
  /** Absent for anthropic means the provider's default model. */
  model?: string;
  dryRun: boolean;
  /** The ai block's limits; AiLimitsSchema fills the rest with its defaults. */
  limits: Partial<Record<(typeof LIMIT_NAMES)[number], number>>;
}

/**
 * The AI settings of a run, or undefined when AI is off. Flags beat the
 * config. Provider openai has no default model (Decision 4): a missing
 * model is a usage error naming ai.model.
 */
export function aiSettings(flags: AiFlags, config: AiConfig | undefined): AiSettings | undefined {
  const on = flags.fixes || flags.dryRun || config?.enabled === true;
  if (!on) return undefined;
  const provider = flags.provider ?? config?.provider ?? 'anthropic';
  const model = flags.model ?? config?.model;
  if (provider === 'openai' && model === undefined)
    throw new UsageError(
      'AI fix suggestions with provider openai need a model: set ai.model in the config, or --ai-model',
    );
  const limits: AiSettings['limits'] = {};
  for (const name of LIMIT_NAMES) {
    const value = config?.[name];
    if (value !== undefined) limits[name] = value;
  }
  return { provider, ...(model !== undefined ? { model } : {}), dryRun: flags.dryRun, limits };
}

/** The message for a run that needs a key that is not set, or undefined when none is needed or it is set. */
export function missingKey(settings: AiSettings): string | undefined {
  if (settings.dryRun || readProviderKey(settings.provider) !== undefined) return undefined;
  return `AI fix suggestions need ${KEY_VARIABLES[settings.provider]} in the environment (or use --ai-dry-run, which sends nothing)`;
}

/** The sidecar files could not be written: widedoor suggest exits 1. */
export class AiWriteError extends Error {}

/** Text with every occurrence of the key replaced: a last guard on anything printed. */
const scrub = (text: string, key: string | undefined) =>
  key ? text.split(key).join('[key removed]') : text;

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0] ?? '';

/**
 * Suggests fixes for a finished report and writes the two sidecar files to
 * out.dir, or for a dry run prints exactly what would be sent. Returns the
 * files written. Throws UsageError for a missing key and AiWriteError when
 * a file cannot be written; a provider failure never throws (it is recorded
 * in the document). An aborted signal stops new requests; the document is
 * still written, its unsent groups marked as such.
 */
export async function runAiSuggestions(
  report: ScanReport,
  settings: AiSettings,
  out: { dir: string; restricted: boolean; roots: readonly string[] },
  io: Io,
  hooks: AiHooks = {},
  signal?: AbortSignal,
): Promise<string[]> {
  const ai = await (hooks.loadAi ?? loadAi)();
  const limits = ai.AiLimitsSchema.parse(settings.limits);
  const preview = ai.previewFixes(report, limits);
  if (settings.dryRun) {
    io.out('AI fix suggestions, dry run: nothing is sent.');
    io.out(`System prompt:\n${preview.system}`);
    preview.messages.forEach((message, i) =>
      io.out(`\nMessage ${i + 1} of ${preview.messages.length}:\n${message}`),
    );
    io.out(
      `\n${preview.messages.length} requests, about ${preview.estimatedInputTokens} input tokens; ${preview.skipped} groups past the limit would not be sent.`,
    );
    return [];
  }
  const key = readProviderKey(settings.provider);
  let provider: Ai.FixProvider;
  if (hooks.provider) provider = hooks.provider(settings, ai);
  else if (key === undefined) throw new UsageError(missingKey(settings) ?? 'no key');
  else if (settings.provider === 'anthropic')
    provider = ai.createAnthropicProvider({
      apiKey: key,
      ...(settings.model !== undefined ? { model: settings.model } : {}),
    });
  else provider = ai.createOpenAiProvider({ apiKey: key, model: settings.model ?? '' });
  io.out(
    `AI fix suggestions: sending ${preview.groups.length} redacted snippets to ${settings.provider} (${safeText(provider.model, 100)}). Nothing else from the scan is sent.`,
  );
  const doc = await ai.suggestFixes({
    report,
    provider,
    limits,
    ...(signal ? { signal } : {}),
    // Fixed-shape lines only; the stop line says why a run ended early.
    log: (line) => {
      if (line.startsWith('ai_stop ')) io.err(`widedoor: ${line}`);
    },
  });
  const files: Record<AiSidecar, string> = {
    'ai-suggestions.json': `${JSON.stringify(doc, null, 2)}\n`,
    'ai-suggestions.html': ai.renderAiSuggestionsHtml(doc),
  };
  try {
    await writeSidecars(out.dir, files, out.restricted, out.roots);
  } catch (e) {
    throw new AiWriteError(scrub(firstLine(e), key));
  }
  const written = AI_SIDECARS.map((name) => join(out.dir, name));
  const ok = doc.entries.filter((e) => e.status === 'ok').length;
  io.out(
    `AI fix suggestions: ${ok} of ${doc.entries.length} groups got a suggestion (AI-generated: review before use).`,
  );
  return written;
}

/** The report with only the findings named (all of them when ids is undefined); buildGroups reads only findings and the roll-up. */
const withFindings = (report: ScanReport, ids: readonly string[] | undefined): ScanReport => {
  if (ids === undefined) return report;
  const keep = new Set(ids);
  return { ...report, findings: report.findings.filter((f) => keep.has(f.id)) };
};

/**
 * widedoor ui's AI capability for the local server, or why there is none.
 * Loads @widedoor/ai only when ai.enabled is set and the provider's key is
 * there; the server gets an object that suggests, previews and renders, and
 * never the key (ruling 1). The provider seam is for tests only: no flag,
 * variable or config key can reach it.
 */
export async function localAi(
  config: AiConfig | undefined,
  hooks: AiHooks = {},
): Promise<{ ai: LocalAi } | { unavailable: string }> {
  let settings: AiSettings | undefined;
  try {
    settings = aiSettings({ fixes: false, dryRun: false }, config);
  } catch (e) {
    return { unavailable: firstLine(e) };
  }
  if (!settings)
    return { unavailable: 'AI fix suggestions are off: set ai.enabled in widedoor.config.yaml.' };
  const key = readProviderKey(settings.provider);
  if (key === undefined && !hooks.provider)
    return {
      unavailable: `AI fix suggestions need ${KEY_VARIABLES[settings.provider]} in the environment of widedoor ui.`,
    };
  const ai = await (hooks.loadAi ?? loadAi)();
  const limits = ai.AiLimitsSchema.parse(settings.limits);
  const chosen = settings;
  let provider: Ai.FixProvider;
  if (hooks.provider) provider = hooks.provider(chosen, ai);
  else if (chosen.provider === 'anthropic')
    provider = ai.createAnthropicProvider({
      apiKey: key ?? '',
      ...(chosen.model !== undefined ? { model: chosen.model } : {}),
    });
  else provider = ai.createOpenAiProvider({ apiKey: key ?? '', model: chosen.model ?? '' });
  return {
    ai: {
      provider: chosen.provider,
      model: provider.model,
      maxGroups: limits.maxGroups,
      // The groups come from the findings named; the document still describes the whole report.
      suggest: async (report, { findingIds, signal }) => {
        const doc = await ai.suggestFixes({
          report: withFindings(report, findingIds),
          provider,
          limits,
          signal,
        });
        return {
          ...doc,
          report: { startedAt: report.startedAt, findings: report.findings.length },
        };
      },
      preview: (report, { findingIds }) => {
        const p = ai.previewFixes(withFindings(report, findingIds), limits);
        return {
          system: p.system,
          messages: p.messages,
          estimatedInputTokens: p.estimatedInputTokens,
          skipped: p.skipped,
        };
      },
      renderHtml: (doc: AiSuggestionsDoc) => ai.renderAiSuggestionsHtml(doc),
    },
  };
}
