import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootstrapProjectRoute } from '../src/state/projects';
import { resetCoalescedGet } from '../src/lib/coalesced-get';

const PROJECT_ID = 'project-a';
const PROJECT_A = {
  id: PROJECT_ID,
  name: 'Project A',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoalescedGet();
});

describe('bootstrapProjectRoute', () => {
  it('reads the project row once with cache disabled and reports its resolved directory', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        project: PROJECT_A,
        resolvedDir: '/projects/project-a',
      }), { status: 200 });
    }));

    await expect(bootstrapProjectRoute(PROJECT_ID)).resolves.toEqual({
      kind: 'found',
      project: PROJECT_A,
      resolvedDir: '/projects/project-a',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`/api/projects/${PROJECT_ID}`);
    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('falls back to metadata.baseDir when the daemon omits resolvedDir', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      project: { ...PROJECT_A, metadata: { kind: 'prototype', baseDir: '/imported/a' } },
    }), { status: 200 })));

    await expect(bootstrapProjectRoute(PROJECT_ID)).resolves.toMatchObject({
      kind: 'found',
      resolvedDir: '/imported/a',
    });
  });

  it.each([
    { status: 403, kind: 'forbidden' as const },
    { status: 404, kind: 'not-found' as const },
    { status: 503, kind: 'unavailable' as const },
  ])('maps HTTP $status to $kind', async ({ status, kind }) => {
    const fetchMock = vi.fn(async () => new Response('{}', { status }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(bootstrapProjectRoute(PROJECT_ID)).resolves.toEqual({ kind });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a row for a different project as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      project: { ...PROJECT_A, id: 'different-project' },
    }), { status: 200 })));

    await expect(bootstrapProjectRoute(PROJECT_ID)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('single-flights concurrent opens and never caches a failed read', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ project: PROJECT_A }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([bootstrapProjectRoute(PROJECT_ID), bootstrapProjectRoute(PROJECT_ID)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resetCoalescedGet();
    const failedFetch = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', failedFetch);
    await bootstrapProjectRoute(PROJECT_ID);
    await bootstrapProjectRoute(PROJECT_ID);
    expect(failedFetch).toHaveBeenCalledTimes(2);
  });
});
