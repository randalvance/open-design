// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `release_channel` is the correlation field that separates "the packaged
 * stable build is janky" from "a dev daemon is janky". Its producer sits one
 * line away from a value already in hand, the daemon's `/api/version` answer,
 * and it was once never called.
 */

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/version')) {
      return new Response(
        JSON.stringify({
          version: {
            version: '1.2.3',
            channel: 'prerelease',
            packaged: true,
            platform: 'darwin',
            arch: 'arm64',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('chat correlation — boot-time identity', () => {
  it('keeps the release channel the daemon already answers with', async () => {
    const { resolveAppVersionForCapture } = await import('../../src/analytics/provider');
    const { chatCorrelation } = await import('../../src/observability/chat-context');

    await resolveAppVersionForCapture('0.0.0');

    expect(chatCorrelation().release_channel).toBe('prerelease');
  });
});
