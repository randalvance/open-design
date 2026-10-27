import { describe, expect, it } from 'vitest';

import { canonicalMediaModelId, findMediaModel } from '../../src/media/models';

describe('media model aliases', () => {
  it('routes persisted OpenDesign Cloud model ids to the local models they wrapped', () => {
    // Projects created before the managed catalogue was removed still carry
    // these ids in their metadata; the picker must resolve them like the daemon.
    expect(canonicalMediaModelId('vela/gpt-image-2')).toBe('gpt-image-2');
    expect(findMediaModel('vela/gpt-image-2')?.provider).toBe('openai');
    expect(findMediaModel('vela/nano-banana-2')?.id).toBe('gemini-3.1-flash-image-preview');
    expect(findMediaModel('vela/nano-banana-2-lite')?.id).toBe('gemini-3.1-flash-image-preview');
    expect(findMediaModel('vela/seedream-5.0')?.id).toBe('doubao-seedream-5-0-260128');
    expect(findMediaModel('vela/seedream-5.0-pro')?.id).toBe('doubao-seedream-5-0-260128');
    expect(findMediaModel('vela/doubao-seedance-2-0-260128')?.id).toBe('doubao-seedance-2-0-260128');
  });

  it('keeps the removed Codex renderer id on the OpenAI model', () => {
    expect(canonicalMediaModelId('codex-gpt-image-2')).toBe('gpt-image-2');
  });
});
