import { describe, expect, it } from 'vitest';

import {
  IMAGE_MODELS,
  MEDIA_PROVIDERS,
  canonicalMediaModelId,
  findMediaModel,
} from '../../src/media/models.js';

describe('image model defaults', () => {
  it('uses OpenAI BYOK as the only default image route', () => {
    expect(IMAGE_MODELS.filter((model) => model.default).map((model) => model.id)).toEqual([
      'gpt-image-2',
    ]);
    expect(MEDIA_PROVIDERS.some((provider) => provider.id === 'codex')).toBe(false);
    expect(IMAGE_MODELS.some((model) => model.provider === 'codex')).toBe(false);
  });

  it('migrates the removed Codex image model id to OpenAI', () => {
    expect(canonicalMediaModelId('codex-gpt-image-2')).toBe('gpt-image-2');
  });

  it('resolves the nano-banana shorthands to the registered Nano Banana model', () => {
    for (const id of ['nano-banana', 'nano-banana-2']) {
      expect(findMediaModel(id)?.id).toBe('gemini-3.1-flash-image-preview');
      expect(findMediaModel(id)?.provider).toBe('nanobanana');
    }
  });

  it('no longer knows a saved Cloud model id, so it falls through to normal validation', () => {
    for (const id of ['vela/gpt-image-2', 'vela/nano-banana-2', 'vela/doubao-seedance-2-0-260128']) {
      expect(findMediaModel(id)).toBeNull();
    }
    expect(MEDIA_PROVIDERS.some((provider) => provider.id === 'vela')).toBe(false);
  });

  it('preserves explicit OpenAI BYOK model selection', () => {
    expect(canonicalMediaModelId('gpt-image-2')).toBe('gpt-image-2');
    expect(findMediaModel('gpt-image-2')?.provider).toBe('openai');
  });
});
