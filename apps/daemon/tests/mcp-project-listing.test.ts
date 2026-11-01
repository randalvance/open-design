import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleMcpToolCall, TOOL_DEFS } from '../src/mcp.js';

const BASE = 'http://127.0.0.1:19002';
const originalFetch = globalThis.fetch;

function firstJson<T>(result: { content: Array<{ text: string }> }): T {
  const item = result.content[0];
  if (!item) throw new Error('expected MCP text content');
  return JSON.parse(item.text) as T;
}

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe('MCP project listing', () => {
  it('list_projects needs no workspace context: one plain /api/projects read', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ projects: [{ id: 'p1', name: 'Local' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall(BASE, 'list_projects', {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/api/projects`);
    expect(fetchMock.mock.calls[0]?.[1]).toBeUndefined();
    expect(firstJson<{ projects: Array<{ name: string }> }>(result).projects[0]?.name).toBe('Local');
  });

  it('resolves a project name through the same plain catalog', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith('/api/projects')) {
        return new Response(JSON.stringify({ projects: [{ id: 'p-named', name: 'Named Project' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }));

    await handleMcpToolCall('http://127.0.0.1:19003', 'list_files', { project: 'Named Project' });

    expect(urls[0]).toBe('http://127.0.0.1:19003/api/projects');
    expect(urls[1]).toBe('http://127.0.0.1:19003/api/projects/p-named/files');
    expect(urls.some((url) => url.includes('/api/workspace'))).toBe(false);
  });

  it('offers no cloud sign-in tools', () => {
    const names = TOOL_DEFS.map((tool) => tool.name);
    expect(names).not.toContain('start_vela_login');
    expect(names).not.toContain('get_vela_login_status');
    expect(names).toContain('list_projects');
  });
});
