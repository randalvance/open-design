// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GenUIInbox } from '../../src/components/GenUIInbox';

const SURFACE = {
  id: 'row-1',
  surfaceId: 'approval-1',
  projectId: 'project-1',
  kind: 'confirmation',
  persist: 'project',
  status: 'resolved',
  requestedAt: 1,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GenUIInbox transport', () => {
  it('lists surfaces, revokes through the daemon route, then refreshes', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/revoke')) return Response.json({ ok: true });
      return Response.json({ surfaces: [SURFACE] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<GenUIInbox projectId="project-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/projects/project-1/genui');
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('/api/projects/project-1/genui/approval-1/revoke');
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe('/api/projects/project-1/genui');
  });
});
