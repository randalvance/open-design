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
  it('reads a local project with no workspace headers', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ project: PROJECT_A, resolvedDir: '/tmp/project-a' }), { status: 200 });
    }));

    await expect(bootstrapProjectRoute(PROJECT_ID)).resolves.toMatchObject({
      kind: 'found',
      resolvedDir: '/tmp/project-a',
    });
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.init?.headers).has('x-od-workspace-id')).toBe(false);
  });

  it('opens a project that still carries leftover workspace metadata', async () => {
    const leftover = { ...PROJECT_A, workspaceId: 'workspace-a', metadata: { workspaceId: 'workspace-a' } };
    vi.stubGlobal('fetch', vi.fn(async () => (
      new Response(JSON.stringify({ project: leftover }), { status: 200 })
    )));

    await expect(bootstrapProjectRoute(PROJECT_ID)).resolves.toMatchObject({
      kind: 'found',
      project: { id: PROJECT_ID },
    });
  });

  it('reports a missing project, and an unusable answer as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    await expect(bootstrapProjectRoute(PROJECT_ID)).resolves.toEqual({ kind: 'not-found' });

    resetCoalescedGet();
    vi.stubGlobal('fetch', vi.fn(async () => (
      new Response(JSON.stringify({ project: { ...PROJECT_A, id: 'someone-else' } }), { status: 200 })
    )));
    await expect(bootstrapProjectRoute(PROJECT_ID)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('single-flights concurrent openers and retries failures', async () => {
    const okFetch = vi.fn(async () => new Response(JSON.stringify({ project: PROJECT_A }), { status: 200 }));
    vi.stubGlobal('fetch', okFetch);
    await Promise.all([bootstrapProjectRoute(PROJECT_ID), bootstrapProjectRoute(PROJECT_ID)]);
    expect(okFetch).toHaveBeenCalledTimes(1);

    resetCoalescedGet();
    const failedFetch = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', failedFetch);
    await bootstrapProjectRoute(PROJECT_ID);
    await bootstrapProjectRoute(PROJECT_ID);
    expect(failedFetch).toHaveBeenCalledTimes(2);
  });
});
