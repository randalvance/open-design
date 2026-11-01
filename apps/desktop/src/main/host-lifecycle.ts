import type { DesktopHostEvent } from "./session-lifecycle.js";

export type DesktopChildProcessGoneDetails = {
  type?: string;
  reason?: string;
  exitCode?: number;
};

export type DesktopChildProcessGoneApp = {
  on(
    event: "child-process-gone",
    listener: (event: unknown, details: DesktopChildProcessGoneDetails) => void,
  ): void;
};

/** Log abnormal child-process exits to the local desktop log; `clean-exit` is normal teardown. */
export function attachDesktopChildProcessCrashLogger(
  app: DesktopChildProcessGoneApp,
  logger: Pick<Console, "error"> = console,
): void {
  app.on("child-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    logger.error("[open-design desktop] child-process-gone", {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
}

type HostEventEmitter = { on(event: string, listener: (...args: any[]) => void): unknown };

/**
 * Record OS power and session-end events into this run's marker: sleep/wake and
 * shutdown via `powerMonitor` (shutdown is Linux/macOS only), and Windows
 * shutdown, restart or log-off via the window's `session-end`.
 */
export function attachDesktopHostLifecycleRecorder(input: {
  powerMonitor: HostEventEmitter;
  window?: HostEventEmitter | null;
  record: (event: DesktopHostEvent) => void;
}): void {
  input.powerMonitor.on("suspend", () => input.record({ kind: "suspend" }));
  input.powerMonitor.on("resume", () => input.record({ kind: "resume" }));
  input.powerMonitor.on("shutdown", () => input.record({ kind: "shutdown" }));
  input.window?.on("session-end", (event: { reasons?: unknown } | undefined) => {
    const reasons = Array.isArray(event?.reasons) ? event.reasons.filter((r): r is string => typeof r === "string") : [];
    input.record({ kind: "session-end", reasons });
  });
}
