// @vitest-environment jsdom
//
// Red-spec (W82 item 1): `GET /api/projects/<id>/files` ran 4× on one cold
// conversation open even though the repo already ships a single-flight reader
// for it. Measured in a real browser with `window.fetch` wrapped to record
// `new Error().stack`:
//
//   t=5044  useDesignMdState.compute            → raw fetch()
//   t=5045  ProjectView.refreshProjectFiles     → fetchProjectFiles (shared)
//   t=5049  useDesignMdState.compute            → raw fetch()          (replay)
//   t=6877  ProjectView.refreshProjectFiles     → fetchProjectFiles (forced)
//
// `useDesignMdState` called `fetch('/api/projects/<id>/files')` directly
// instead of `fetchProjectFiles`, so it sat outside the coalescer entirely:
// its own effect replay was a second request, and neither of its requests
// could join the one ProjectView had already opened for the same list under
// the same Workspace identity.
//
// Nothing here is a new cache. `fetchProjectFiles` already owns this URL, its
// key (project), its invalidation fence, and its
// cancellation semantics; the hook just stops going around it.

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDesignMdState } from '../../src/hooks/useDesignMdState';
import { fetchProjectFiles } from '../../src/providers/registry';

const fetchCalls: string[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchCalls.length = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    fetchCalls.push(url);
    if (url.includes('/files/DESIGN.md')) {
      return new Response('# DESIGN.md\n', {
        status: 200,
        headers: { 'content-type': 'text/markdown' },
      });
    }
    if (url.endsWith('/files')) return jsonResponse({ files: [] });
    if (url.endsWith('/conversations')) return jsonResponse({ conversations: [] });
    return new Response('not found', { status: 404 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const fileListCalls = (projectId: string): string[] =>
  fetchCalls.filter((url) => url.endsWith(`/api/projects/${projectId}/files`));

describe('useDesignMdState reads the project file list through the shared reader', () => {
  it('shares ProjectView\'s in-flight /files request instead of opening its own', async () => {
    const projectView = fetchProjectFiles('p-share');
    const { result } = renderHook(() => useDesignMdState('p-share', 0));

    await waitFor(() => expect(result.current.loading).toBe(false));
    await projectView;

    expect(fileListCalls('p-share')).toHaveLength(1);
  });

  it('does NOT share across projects', async () => {
    // Scope guard: collapsing on the URL alone would be a different bug.
    const a = renderHook(() => useDesignMdState('p-one', 0));
    const b = renderHook(() => useDesignMdState('p-two', 0));

    await waitFor(() => expect(a.result.current.loading).toBe(false));
    await waitFor(() => expect(b.result.current.loading).toBe(false));

    expect(fileListCalls('p-one')).toHaveLength(1);
    expect(fileListCalls('p-two')).toHaveLength(1);
  });

  it('surfaces a transport failure as an error, not an empty directory', async () => {
    // Reverse control: `fetchProjectFiles` swallows failures into `[]` for
    // list/card callers. This hook must keep distinguishing "no DESIGN.md"
    // from "could not read the directory", or a failed read would silently
    // render as "DESIGN.md does not exist".
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      fetchCalls.push(url);
      if (url.endsWith('/files')) return new Response('nope', { status: 500 });
      return new Response('not found', { status: 404 });
    });

    const { result } = renderHook(() => useDesignMdState('p-fail', 0));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.exists).toBe(false);
  });
});
