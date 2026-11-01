import { describe, expect, it } from "vitest";

import {
  resolveAboutPanelVersion,
  resolveFirstAvailableBaseUrl,
} from "../../src/main/index.js";

describe("desktop main helpers", () => {
  it("falls through a busy discovery source to the direct daemon URL", async () => {
    await expect(resolveFirstAvailableBaseUrl([
      async () => null,
      async () => "http://127.0.0.1:17456",
      async () => "http://127.0.0.1:17573",
    ])).resolves.toBe("http://127.0.0.1:17456");
  });

  it("continues after a discovery source throws", async () => {
    await expect(resolveFirstAvailableBaseUrl([
      async () => { throw new Error("sidecar busy"); },
      async () => "http://127.0.0.1:17456",
    ])).resolves.toBe("http://127.0.0.1:17456");
  });

  it("uses the active packaged runtime version for the native About panel", () => {
    expect(resolveAboutPanelVersion({ update: { currentVersion: "0.10.0-beta.24" } })).toBe("0.10.0-beta.24");
    expect(resolveAboutPanelVersion({ update: { currentVersion: " 0.10.0-beta.24 " } })).toBe("0.10.0-beta.24");
    expect(resolveAboutPanelVersion({ update: { currentVersion: "" } })).toBeNull();
    expect(resolveAboutPanelVersion({})).toBeNull();
  });
});
