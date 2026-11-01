import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _listMcpResources,
  _readMcpResource,
  createMcpDaemonTarget,
  OPEN_DESIGN_BRIEF_APP_RESOURCE,
} from '../src/mcp.js';

const originalFetch = globalThis.fetch;
const BASE = 'http://127.0.0.1:19001';

function target() {
  return createMcpDaemonTarget({ daemonUrl: BASE });
}

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe('MCP resource handlers', () => {
  it('list_resources reads the plain skill and design-system catalogs', async () => {
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/api/skills')) {
        return new Response(JSON.stringify({ skills: [] }), { status: 200 });
      }
      if (url.endsWith('/api/design-systems')) {
        return new Response(JSON.stringify({ designSystems: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await _listMcpResources(target());

    const skillCall = calls.find((c) => c.url.endsWith('/api/skills'));
    const dsCall = calls.find((c) => c.url.endsWith('/api/design-systems'));
    expect(skillCall?.init?.headers).toBeUndefined();
    expect(dsCall?.init?.headers).toBeUndefined();
    // Built-in resources still listed.
    expect(result.resources.some((r) => r.uri === OPEN_DESIGN_BRIEF_APP_RESOURCE)).toBe(true);
    expect(result.resources.some((r) => r.uri === 'od://focus/active')).toBe(true);
  });

  it('read_resource reads a design system without any scope headers', async () => {
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.match(/\/api\/design-systems\/[^/]+$/u)) {
        return new Response(
          JSON.stringify({
            designSystem: {
              id: 'brand-1',
              body: 'palette: indigo/violet\nfonts: Inter\nvoice: crisp',
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await _readMcpResource(target(), 'od://design-systems/brand-1/DESIGN.md');

    const read = calls.find((c) => c.url.endsWith('/api/design-systems/brand-1'));
    expect(read).toBeTruthy();
    expect(read?.init?.headers).toBeUndefined();

    expect(result.contents[0]?.mimeType).toBe('text/markdown');
    expect(result.contents[0]?.text).toContain('palette: indigo/violet');
  });

  it('read_resource still serves the brief app resource without touching the daemon', async () => {
    const fetchMock = vi.fn(async () => new Response('should-not-be-called', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await _readMcpResource(target(), OPEN_DESIGN_BRIEF_APP_RESOURCE);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.contents[0]?.mimeType).toBe('text/html;profile=mcp-app');
  });

  it('read_resource rejects unsupported URIs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));

    await expect(
      _readMcpResource(target(), 'od://unknown/foo/bar'),
    ).rejects.toThrow(/unsupported resource URI/u);
  });
});
