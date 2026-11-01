// The daemon's analytics service is a no-op, but `run_finished`-style events are
// still how several suites observe Run behaviour. These suites swap the service
// for an in-memory recorder at the module boundary:
//
//   vi.mock('../src/analytics.js', (original) => recordingAnalyticsModule(original));
import type * as AnalyticsModule from '../../src/analytics.js';

export type RecordedAnalyticsEvent = {
  event: string;
  properties: Record<string, unknown>;
};

export const recordedAnalyticsEvents: RecordedAnalyticsEvent[] = [];

export async function recordingAnalyticsModule(
  original: () => Promise<unknown>,
): Promise<unknown> {
  const actual = await original() as typeof AnalyticsModule;
  const service: AnalyticsModule.AnalyticsService = {
    capture: async ({ eventName, properties }) => {
      recordedAnalyticsEvents.push({ event: eventName, properties });
      return { status: 'queued', acknowledgement: 'local_buffer', errorType: null };
    },
    captureSafety: async ({ eventName, properties }) => {
      recordedAnalyticsEvents.push({ event: eventName, properties });
    },
    mergeAnonymousPerson: async () => undefined,
    identifyGroup: async () => undefined,
    shutdown: async () => undefined,
  };
  return { ...actual, createAnalyticsService: () => service };
}
