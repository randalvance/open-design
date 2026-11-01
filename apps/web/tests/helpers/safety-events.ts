// What the observers under test handed to `reportSafetyEvent`.
//
// The reporter itself is a no-op, so a spec that still uses an event as its
// signal has to watch the call. This spies on the export rather than using
// `vi.mock`: the Vitest setup files already load much of `src/`, including
// `observability/responsiveness`, so a per-file `vi.mock` would miss every
// caller imported before it. The spy is read through the live export binding
// and sees all of them.
//
// Call `watchSafetyEvents()` from `beforeEach`.
import { type MockInstance, vi } from 'vitest';

import * as errorTracking from '../../src/analytics/error-tracking';

export interface ReportedSafetyEvent {
  event: string;
  properties: Record<string, unknown>;
}

let spy: MockInstance<typeof errorTracking.reportSafetyEvent> | null = null;

export function watchSafetyEvents(): void {
  spy = vi.spyOn(errorTracking, 'reportSafetyEvent');
  spy.mockClear();
}

export function clearReportedSafetyEvents(): void {
  spy?.mockClear();
}

export function reportedSafetyEvents(): ReportedSafetyEvent[] {
  return (spy?.mock.calls ?? []).map(([event, properties]) => ({
    event,
    properties: properties ?? {},
  }));
}

export function reportedSafetyEventsNamed(name: string): Array<Record<string, unknown>> {
  return reportedSafetyEvents()
    .filter((reported) => reported.event === name)
    .map((reported) => reported.properties);
}
