// Exception and stability reporting has been removed: nothing here talks to a
// network, and the browser's own console still shows uncaught errors. These
// no-ops stay so the existing call sites keep compiling.

export function reportHandledException(_error: unknown, _message?: string): void {}

export function reportClientMetricEvent(_event: string, _properties: Record<string, unknown>): boolean {
  return false;
}

export function reportSafetyEvent(
  _eventName: string,
  _properties: Record<string, unknown> = {},
  _options: { currentUrlOverride?: string } = {},
): void {}

/** Input-responsiveness aggregation is not collected, so no checkpoint is ever held. */
export function checkpointInputResponsiveness(_properties: Record<string, unknown>, _final: boolean): boolean {
  return false;
}

export function registerInputCollectorFlush(_flush: () => void): () => void {
  return () => {};
}
