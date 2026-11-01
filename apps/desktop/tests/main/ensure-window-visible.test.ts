import { describe, expect, it, vi } from "vitest";

import type { BrowserWindow } from "electron";

import { ensureWindowVisible } from "../../src/main/runtime.js";

describe("ensureWindowVisible", () => {
  function mockWindow(state: { minimized?: boolean; visible?: boolean; destroyed?: boolean }) {
    return {
      isDestroyed: vi.fn(() => state.destroyed ?? false),
      isMinimized: vi.fn(() => state.minimized ?? false),
      isVisible: vi.fn(() => state.visible ?? true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
  }

  // The revealed path of `DesktopRuntime.show()` routes through this helper:
  // `focus()` alone leaves a minimized window in the Dock, which would turn an
  // external show into a no-op.
  it("restores a minimized window before focusing it", () => {
    const window = mockWindow({ minimized: true, visible: true });

    ensureWindowVisible(window as unknown as BrowserWindow);

    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it("shows a hidden window and focuses a normal one without disturbing its state", () => {
    const hidden = mockWindow({ visible: false });
    ensureWindowVisible(hidden as unknown as BrowserWindow);
    expect(hidden.show).toHaveBeenCalledTimes(1);
    expect(hidden.restore).not.toHaveBeenCalled();

    const normal = mockWindow({});
    ensureWindowVisible(normal as unknown as BrowserWindow);
    expect(normal.restore).not.toHaveBeenCalled();
    expect(normal.show).not.toHaveBeenCalled();
    expect(normal.focus).toHaveBeenCalledTimes(1);

    const destroyed = mockWindow({ destroyed: true });
    ensureWindowVisible(destroyed as unknown as BrowserWindow);
    expect(destroyed.focus).not.toHaveBeenCalled();
  });
});
