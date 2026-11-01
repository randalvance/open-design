import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  attachDesktopChildProcessCrashLogger,
  attachDesktopHostLifecycleRecorder,
  type DesktopChildProcessGoneDetails,
} from "../../src/main/host-lifecycle.js";
import {
  beginDesktopSession,
  clearReportedCrash,
  markDesktopSessionRunning,
  recordDesktopHostEvent,
} from "../../src/main/session-lifecycle.js";

let dir: string;
let stateFilePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desktop-host-lifecycle-"));
  stateFilePath = join(dir, "session-state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function beginNextRunAfterDirtyRun(events: Array<[Parameters<typeof recordDesktopHostEvent>[1], string]>) {
  beginDesktopSession({ stateFilePath, sessionId: "run-a", version: "0.24.1", now: () => new Date("2026-10-02T10:00:00.000Z") });
  markDesktopSessionRunning({ stateFilePath });
  for (const [event, at] of events) recordDesktopHostEvent({ stateFilePath, now: () => new Date(at) }, event);
  // The process dies here: no endDesktopSessionCleanly.
  return beginDesktopSession({
    stateFilePath, sessionId: "run-b", version: "0.24.1", now: () => new Date("2026-10-02T12:00:00.000Z"),
  }).previousUncleanSessions;
}

describe("attachDesktopHostLifecycleRecorder", () => {
  test("records power and session-end events from Electron", () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const powerMonitor = { on: vi.fn((event: string, fn: (...args: unknown[]) => void) => { handlers.set(`power:${event}`, fn); }) };
    const window = { on: vi.fn((event: string, fn: (...args: unknown[]) => void) => { handlers.set(`window:${event}`, fn); }) };
    const record = vi.fn();
    attachDesktopHostLifecycleRecorder({ powerMonitor, window, record });
    handlers.get("power:suspend")!();
    handlers.get("power:resume")!();
    handlers.get("power:shutdown")!();
    handlers.get("window:session-end")!({ reasons: ["logoff", "close-app"] });
    expect(record.mock.calls.map((call) => call[0])).toEqual([
      { kind: "suspend" },
      { kind: "resume" },
      { kind: "shutdown" },
      { kind: "session-end", reasons: ["logoff", "close-app"] },
    ]);
  });
});

describe("recordDesktopHostEvent", () => {
  test("carries the host events of the run that died into the next run's marker", () => {
    const [crash] = beginNextRunAfterDirtyRun([
      [{ kind: "suspend" }, "2026-10-02T11:00:00.000Z"],
      [{ kind: "quit-requested" }, "2026-10-02T11:01:00.000Z"],
    ]);
    expect(crash?.hostEvents).toEqual([
      { kind: "suspend", at: "2026-10-02T11:00:00.000Z" },
      { kind: "quit-requested", at: "2026-10-02T11:01:00.000Z" },
    ]);
  });

  test("keeps one session end when several windows report it", () => {
    const [crash] = beginNextRunAfterDirtyRun([
      [{ kind: "session-end", reasons: ["shutdown"] }, "2026-10-02T11:00:00.000Z"],
      [{ kind: "session-end", reasons: ["shutdown"] }, "2026-10-02T11:00:00.300Z"],
      [{ kind: "suspend" }, "2026-10-02T11:00:01.000Z"],
    ]);
    expect(crash?.hostEvents?.map((event) => event.kind)).toEqual(["session-end:shutdown", "suspend"]);
  });
});

describe("prior abnormal exits", () => {
  test("do not recur on later launches once cleared after logging", () => {
    const [crash] = beginNextRunAfterDirtyRun([]);
    clearReportedCrash({ stateFilePath }, crash!.sessionId);
    const { previousUncleanSessions } = beginDesktopSession({
      stateFilePath, sessionId: "run-c", version: "0.24.1", now: () => new Date("2026-10-02T13:00:00.000Z"),
    });
    expect(previousUncleanSessions).toEqual([]);
  });
});

describe("attachDesktopChildProcessCrashLogger", () => {
  test("logs abnormal child-process exits and ignores clean exits", () => {
    type ChildProcessGoneListener = (event: unknown, details: DesktopChildProcessGoneDetails) => void;
    const listeners: ChildProcessGoneListener[] = [];
    const app = {
      on: vi.fn((event: "child-process-gone", nextListener: ChildProcessGoneListener) => {
        expect(event).toBe("child-process-gone");
        listeners.push(nextListener);
      }),
    };
    const logger = { error: vi.fn() };

    attachDesktopChildProcessCrashLogger(app, logger);
    const capturedListener = listeners[0];
    if (!capturedListener) throw new Error("child-process-gone listener was not registered");
    capturedListener(null, { type: "GPU", reason: "crashed", exitCode: 139 });
    capturedListener(null, { type: "Utility", reason: "clean-exit", exitCode: 0 });

    expect(logger.error).toHaveBeenCalledExactlyOnceWith("[open-design desktop] child-process-gone", {
      type: "GPU",
      reason: "crashed",
      exitCode: 139,
    });
  });
});
