import { describe, expect, it } from 'vitest';

import {
  IMAGE_MODELS,
  MEDIA_PROVIDERS,
  canonicalMediaModelId,
  findMediaModel,
} from '../../src/media/models.js';

describe('image model defaults', () => {
  it('uses OpenAI gpt-image-2 as the only default image route', () => {
    expect(IMAGE_MODELS.filter((model) => model.default).map((model) => model.id)).toEqual([
      'gpt-image-2',
    ]);
    expect(MEDIA_PROVIDERS.some((provider) => provider.id === 'codex')).toBe(false);
    expect(IMAGE_MODELS.some((model) => model.provider === 'codex')).toBe(false);
  });

  it('migrates the removed Codex image model id to the OpenAI model', () => {
    expect(canonicalMediaModelId('codex-gpt-image-2')).toBe('gpt-image-2');
  });

  it('routes persisted OpenDesign Cloud model ids to the local models they wrapped', () => {
    // Projects created before the managed catalogue was removed still carry
    // these ids in their metadata; reopening them must not reject generation.
    expect(findMediaModel('vela/gpt-image-2')?.id).toBe('gpt-image-2');
    expect(findMediaModel('vela/nano-banana-2')?.id).toBe('gemini-3.1-flash-image-preview');
    expect(findMediaModel('vela/nano-banana-2-lite')?.id).toBe('gemini-3.1-flash-image-preview');
    expect(findMediaModel('vela/seedream-5.0')?.id).toBe('doubao-seedream-5-0-260128');
    expect(findMediaModel('vela/seedream-5.0-pro')?.id).toBe('doubao-seedream-5-0-260128');
    expect(findMediaModel('vela/doubao-seedance-2-0-260128')?.id).toBe('doubao-seedance-2-0-260128');
  });

  it('preserves explicit OpenAI BYOK model selection', () => {
    expect(canonicalMediaModelId('gpt-image-2')).toBe('gpt-image-2');
    expect(findMediaModel('gpt-image-2')?.provider).toBe('openai');
  });
});
