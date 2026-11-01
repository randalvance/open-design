'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { APP_VERSION_PLACEHOLDER } from './app-version';
import { setChatCorrelation } from '../observability/chat-context';
import type { AnalyticsConfigureGlobals } from '@open-design/contracts/analytics';
import { getAnonymousId, getSessionId } from './identity';
import { randomUUID } from '../utils/uuid';

// Product analytics has been removed. `track` and the setters are no-ops: the
// typed wrappers in events.ts and their call sites remain, but nothing is
// captured or sent, and no analytics headers are attached to daemon requests.
interface AnalyticsContextValue {
  track: (
    event: string,
    properties: Record<string, unknown>,
    options?: { requestId?: string; insertId?: string },
  ) => void;
  setConsent: (granted: boolean) => void;
  setIdentity: (installationId: string | null) => void;
  setConfigureGlobals: (next: AnalyticsConfigureGlobals) => void;
  setUserId: (userId: string | null) => void;
  anonymousId: string;
  sessionId: string;
  newRequestId: () => string;
}

const Ctx = createContext<AnalyticsContextValue | null>(null);

let runtimeAppVersion: string | null = null;
let runtimeAppVersionPromise: Promise<string | null> | null = null;

// Shared single-flight fetch of the daemon-pinned version. Cached at module
// scope so the hook, the capture paths, and repeated calls all settle on one
// /api/version round-trip and the same resolved value.
async function loadRuntimeAppVersion(): Promise<string | null> {
  if (runtimeAppVersion) return runtimeAppVersion;
  if (!runtimeAppVersionPromise) {
    runtimeAppVersionPromise = (async () => {
      try {
        const res = await fetch('/api/version');
        if (!res.ok) return null;
        const body = (await res.json()) as {
          version?: { version?: string; channel?: string };
        };
        // The daemon has always answered with `channel` alongside `version`
        // (see `resolveAppVersionInfo`); we simply dropped it on the floor.
        // It is the one dimension that separates "the packaged stable build
        // is janky" from "a dev daemon is janky", so a chat-health dashboard
        // without it cannot tell a real regression from local noise. Stamped
        // before the early return below so a daemon that reports a channel but
        // no version still contributes it.
        setChatCorrelation({ release_channel: body?.version?.channel });
        const next = body?.version?.version;
        if (!next) return null;
        runtimeAppVersion = next;
        return next;
      } catch {
        return null;
      } finally {
        // Allow a retry on the next call when the fetch yielded nothing.
        if (!runtimeAppVersion) runtimeAppVersionPromise = null;
      }
    })();
  }
  return runtimeAppVersionPromise;
}

// Capture paths call this before emitting so an event never ships with the
// placeholder once the real version is knowable. When the caller already has
// a real version (state resolved) it returns immediately; otherwise it awaits
// the shared fetch. This closes the race where high-frequency early events
// (page_view in particular) fired before the version-resolving effect re-ran
// and re-registered the PostHog super-property, permanently stamping them
// with app_version='0.0.0'.
export async function resolveAppVersionForCapture(current: string): Promise<string> {
  if (current && current !== APP_VERSION_PLACEHOLDER) return current;
  return (await loadRuntimeAppVersion()) ?? current;
}

// App version is read from a runtime endpoint rather than at build time so
// the same web bundle reports the daemon-pinned version even when running
// against a newer/older daemon during dev. The hook exposes the placeholder
// for first paint, but capture() paths call resolveAppVersionForCapture() so
// early events wait for the real value instead of permanently shipping with
// app_version='0.0.0'. Earlier `useRef` shape silently broke even the hook:
// ref writes don't trigger re-renders, so every event shipped with '0.0.0'.
export function useAppVersion(): string {
  const [version, setVersion] = useState(APP_VERSION_PLACEHOLDER);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await loadRuntimeAppVersion();
      if (!cancelled && next) setVersion(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return version;
}

const noop = () => undefined;

export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const value = useMemo<AnalyticsContextValue>(
    () => ({
      track: noop,
      setConsent: noop,
      setIdentity: noop,
      setConfigureGlobals: noop,
      setUserId: noop,
      anonymousId: getAnonymousId(),
      sessionId: getSessionId(),
      newRequestId: () => randomUUID(),
    }),
    [],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAnalytics(): AnalyticsContextValue {
  const value = useContext(Ctx);
  if (!value) {
    // Stub for unit tests / SSR / consumers rendered outside the provider tree,
    // which keeps every call site free of null checks.
    return {
      track: noop,
      setConsent: noop,
      setIdentity: noop,
      setConfigureGlobals: noop,
      setUserId: noop,
      anonymousId: 'unmounted',
      sessionId: 'unmounted',
      newRequestId: () => randomUUID(),
    };
  }
  return value;
}
