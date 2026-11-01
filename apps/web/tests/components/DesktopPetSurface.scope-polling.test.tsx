// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listProjectRuns = vi.fn();

vi.mock('@open-design/host', () => ({ setHostPetVisible: vi.fn() }));
vi.mock('../../src/providers/daemon', () => ({
  RUNS_CHANGED_EVENT: 'od:runs-changed',
  listProjectRuns: (...args: unknown[]) => listProjectRuns(...args),
}));
vi.mock('../../src/state/projects', () => ({ listProjects: vi.fn(async () => []) }));
vi.mock('../../src/state/config', () => ({
  // A fresh object on every call, like the real localStorage-backed loader.
  loadConfig: () => ({ pet: { adopted: true, enabled: true, petId: 'mochi', custom: {} } }),
}));
vi.mock('../../src/components/pet/PetOverlay', () => ({ PetOverlay: () => null }));

import { DesktopPetSurface } from '../../src/components/pet/DesktopPetSurface';

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('DesktopPetSurface task polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listProjectRuns.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('keeps polling on the task interval, not on every config reload', async () => {
    listProjectRuns.mockResolvedValue([]);
    render(<DesktopPetSurface />);
    await flush();

    for (let i = 0; i < 6; i++) {
      await act(async () => { vi.advanceTimersByTime(1000); });
      await flush();
    }
    // Initial read plus three 2s ticks; config reloads every 1.5s add nothing.
    expect(listProjectRuns).toHaveBeenCalledTimes(4);
  });
});
