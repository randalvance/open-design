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
  it('lists and revokes surfaces', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/revoke')) return Response.json({ ok: true });
      return Response.json({ surfaces: [SURFACE] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<GenUIInbox projectId="project-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

});
