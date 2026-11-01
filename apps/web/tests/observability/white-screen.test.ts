// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installWhiteScreenDetector } from '../../src/observability/white-screen';
import { type ReportedSafetyEvent, reportedSafetyEvents, watchSafetyEvents } from '../helpers/safety-events';


/**
 * The detector is allowed to be conservative on the false-negative side
 * (don't fire when the app actually rendered something) but must fire
 * when the user is really stuck on a non-app screen. The critical case —
 * called out by codex review on PR #2527 — is the dynamic-import loading
 * shell: `<div class="od-loading-shell">Loading OpenDesign…</div>`. That
 * string is well above the visible-text floor, so an earlier
 * implementation that only checked `body.innerText.length` would silently
 * treat the loading sentinel as a successful mount and cancel the timer.
 */

beforeEach(() => {
  watchSafetyEvents();
  vi.useFakeTimers({ shouldAdvanceTime: false });
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-od-app-mounted');
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-od-app-mounted');
});

function lastSentEvent(): ReportedSafetyEvent | null {
  return reportedSafetyEvents().at(-1) ?? null;
}

describe('observability/white-screen', () => {
  it('fires client_white_screen when only the dynamic-import loading shell is in the DOM after the timeout', () => {
    // Reproduces the codex-review reported bug: the loading shell text
    // "Loading OpenDesign…" is longer than the legacy 10-char floor.
    const shell = document.createElement('div');
    shell.className = 'od-loading-shell';
    shell.textContent = 'Loading OpenDesign…';
    document.body.appendChild(shell);

    installWhiteScreenDetector();
    // Drive the 5s timeout. requestIdleCallback/setTimeout are both fake-
    // timer-aware via vi.useFakeTimers above.
    vi.advanceTimersByTime(6000);

    expect(reportedSafetyEvents()).not.toHaveLength(0);
    const sent = lastSentEvent();
    expect(sent?.event).toBe('client_white_screen');
    expect(sent?.properties).toMatchObject({
      reason: 'app_not_mounted_after_timeout',
      timeout_ms: 5000,
    });
  });

  it('does NOT fire when the app sets the data-od-app-mounted marker before the timeout', () => {
    // Simulate App.tsx's first useEffect setting the attribute.
    document.documentElement.setAttribute('data-od-app-mounted', '1');

    installWhiteScreenDetector();
    vi.advanceTimersByTime(6000);

    expect(reportedSafetyEvents()).toHaveLength(0);
  });

  it('cancels the timer the moment a non-loading-shell child appears with real content', () => {
    // Start with only the loading shell.
    const shell = document.createElement('div');
    shell.className = 'od-loading-shell';
    shell.textContent = 'Loading OpenDesign…';
    document.body.appendChild(shell);

    installWhiteScreenDetector();
    // Wait halfway through the timeout window — still only loading shell.
    vi.advanceTimersByTime(2500);
    expect(reportedSafetyEvents()).toHaveLength(0);

    // Now the real App mounts — adds a meaningful child alongside the shell.
    const real = document.createElement('div');
    real.className = 'workspace-shell';
    real.textContent = 'New project · Recent · Plugins · …';
    document.body.appendChild(real);
    // Let MutationObserver microtasks process. jsdom runs them
    // synchronously after the mutation, but we still need to flush the
    // scheduled idle/timer queue.
    return Promise.resolve().then(() => {
      vi.advanceTimersByTime(3500);
      expect(reportedSafetyEvents()).toHaveLength(0);
    });
  });

  it('fires when only sub-MIN_VISIBLE_TEXT non-shell content is present (still effectively blank)', () => {
    const tiny = document.createElement('div');
    tiny.textContent = '...';
    document.body.appendChild(tiny);

    installWhiteScreenDetector();
    vi.advanceTimersByTime(6000);

    expect(reportedSafetyEvents()).not.toHaveLength(0);
    const sent = lastSentEvent();
    expect(sent?.event).toBe('client_white_screen');
  });
});
