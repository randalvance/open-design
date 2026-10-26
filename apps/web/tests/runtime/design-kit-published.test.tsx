// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Brand } from '@open-design/contracts';
import { useDesignKit } from '../../src/runtime/design-kit';

const brand: Brand = {
  name: 'Shared brand', tagline: '', description: '', sourceUrl: '',
  logo: { primary: 'assets/logo.svg', alternates: [], notes: '' },
  colors: [],
  typography: {
    display: { family: 'Inter', fallbacks: [], weights: [700] },
    body: { family: 'Inter', fallbacks: [], weights: [400] },
  },
  voice: { adjectives: [], tone: '', messagingPillars: [], vocabulary: { use: [], avoid: [] } },
  imagery: { style: '', subjects: [], treatment: '', avoid: [] },
  layout: { radius: '', borderWeight: '', spacing: '', postureRules: [] },
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([true, false])('publishedAssets=%s uses only its resource family', async publishedAssets => {
  const requests: Array<{ url: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    requests.push({ url: String(input) });
    return Response.json(brand);
  }));
  const { result } = renderHook(() => useDesignKit({
    designSystemId: 'user:shared', projectId: 'private-backing-project', title: 'Shared brand',
    body: '# Shared brand', editable: false, publishedAssets,
  }));
  await waitFor(() => expect(result.current.kit?.logoSrc).toBeTruthy());
  expect(requests).toHaveLength(1);
  if (publishedAssets) {
    expect(requests[0]?.url).toContain('/api/design-systems/user%3Ashared/static?path=brand.json');
    expect(requests[0]?.url).not.toContain('/api/projects/');
    expect(result.current.kit?.logoSrc).toContain('/api/design-systems/user%3Ashared/static?path=assets%2Flogo.svg');
    expect(result.current.kit?.logoSrc).not.toContain('private-backing-project');
  } else {
    expect(requests[0]?.url).toContain('/api/projects/private-backing-project/');
    expect(result.current.kit?.logoSrc).toContain('/api/projects/private-backing-project/raw/assets/logo.svg');
  }
});
