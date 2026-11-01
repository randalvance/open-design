// Product analytics has been removed: nothing here talks to a network. These
// no-ops stay so the existing call sites keep compiling without carrying any
// knowledge of that.

/** There is no analytics identity, so handoff links never carry a device id. */
export function getResolvedDeviceId(): string | null {
  return null;
}

export function setAnalyticsUserId(_userId: string | null): void {}

export function setAnalyticsPersonProperties(_properties: Record<string, unknown>): void {}
