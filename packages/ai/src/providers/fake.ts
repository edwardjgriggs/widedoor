import type { ProviderId } from '../model.js';
import type { FixProvider, ProviderAnswer } from '../provider.js';

/**
 * A provider for tests: answers from a script, records every call, never touches the network.
 * Not exported from the package index: tests import this file.
 */
export function createFakeProvider(
  script: (user: string) => ProviderAnswer | Promise<ProviderAnswer>,
  options: { id?: ProviderId; model?: string } = {},
): FixProvider & { calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];
  return {
    id: options.id ?? 'anthropic',
    model: options.model ?? 'fake-model',
    calls,
    async suggestFix({ system, user }) {
      calls.push({ system, user });
      return script(user);
    },
  };
}
