// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createExposureClock } from '../../src/observability/responsiveness';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('drops a timer gap longer than the foreground exposure budget', () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const clock = createExposureClock(); now = 90_000;
  expect(clock.tick()).toEqual({ qualified: false, elapsed: null });
  now += 30_000;
  expect(clock.tick()).toEqual({ qualified: true, elapsed: 30_000 });
  clock.stop();
});
