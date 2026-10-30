import { describe, expectTypeOf, it } from 'vitest';
import type { AiSuggestions } from '@widedoor/ai';
import type { AiPreview, AiProviderId, AiSuggestionsDoc } from '@widedoor/server';
import type { AiModule } from '../src/ai.ts';

/*
 * The server's types-only copy of the suggestions shapes (ai-types.ts, which
 * the viewer shares) against @widedoor/ai's real ones (Task 3b.8). The
 * checks are types: the typecheck gate fails when the two drift apart, and
 * the run itself only confirms the file loads. The CLI is the one package
 * that sees both.
 */

type PreviewOf = ReturnType<AiModule['previewFixes']>;

describe('the server copy of the AI suggestion types', () => {
  it('is mutually assignable with @widedoor/ai AiSuggestions', () => {
    expectTypeOf<AiSuggestions>().toExtend<AiSuggestionsDoc>();
    expectTypeOf<AiSuggestionsDoc>().toExtend<AiSuggestions>();
  });

  it('names the same providers', () => {
    expectTypeOf<AiSuggestions['provider']>().toEqualTypeOf<AiProviderId>();
  });

  it('has the preview fields previewFixes returns', () => {
    expectTypeOf<Pick<PreviewOf, keyof AiPreview>>().toExtend<AiPreview>();
  });
});
