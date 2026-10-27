import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MAC_PREBUNDLE_POLICIES } from "@/mac/prebundle.js";
import {
  NPM_BUNDLED_INTERNAL_PACKAGES,
  NPM_DAEMON_BUNDLE_RELATIVE_PATH,
  createNpmPackageManifest,
  npmRuntimeDependencyNames,
  renderNpmBinShim,
  renderNpmDaemonEntrypoint,
  rewriteBundledInternalManifest,
  type PackageManifest,
} from "@/npm/manifest.js";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function readManifest(relativePath: string): PackageManifest {
  return JSON.parse(readFileSync(join(workspaceRoot, relativePath, "package.json"), "utf8")) as PackageManifest;
}

const rootManifest = readManifest(".");
const daemonManifest = readManifest("apps/daemon");
const internalVersions = new Map<string, string>(
  NPM_BUNDLED_INTERNAL_PACKAGES.map((entry) => [entry.name, readManifest(entry.directory).version!] as const),
);

describe("npm runtime dependencies", () => {
  it("are exactly the third-party externals of the daemon bundle", () => {
    const names = npmRuntimeDependencyNames();
    expect(names).not.toContain("fsevents");
    expect(names.some((name) => name.startsWith("@open-design/"))).toBe(false);
    for (const name of names) expect(MAC_PREBUNDLE_POLICIES.daemonCli.externals).toContain(name);
    expect(names).toContain("better-sqlite3");
    expect(names).toContain("node-pty");
  });

  it("every internal external of the daemon bundle ships as a bundled dependency", () => {
    const internalExternals = MAC_PREBUNDLE_POLICIES.daemonCli.externals.filter((name) => name.startsWith("@open-design/"));
    const bundled = NPM_BUNDLED_INTERNAL_PACKAGES.map((entry) => entry.name);
    for (const name of internalExternals) expect(bundled).toContain(name);
    // ...together with their own workspace dependencies.
    for (const entry of NPM_BUNDLED_INTERNAL_PACKAGES) {
      const deps = Object.keys(readManifest(entry.directory).dependencies ?? {}).filter((d) => d.startsWith("@open-design/"));
      for (const dep of deps) expect(bundled).toContain(dep);
    }
  });
});

describe("createNpmPackageManifest", () => {
  it("pins every runtime dependency to the daemon's exact version from the real workspace", () => {
    const manifest = createNpmPackageManifest({ daemonManifest, internalVersions, packageName: "open-design", rootManifest, version: "0.25.1" });
    expect(manifest.name).toBe("open-design");
    expect(manifest.bin).toEqual({ od: "./bin/od.mjs" });
    expect(manifest.type).toBe("module");
    expect(manifest.engines).toEqual({ node: "~24" });
    expect(manifest.bundleDependencies).toEqual(["@open-design/platform", "@open-design/sidecar"]);
    expect(manifest.publishConfig).toEqual({ access: "public" });
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      expect(version).toBe(name.startsWith("@open-design/") ? internalVersions.get(name) : daemonManifest.dependencies?.[name]);
      expect(version).toMatch(/^\d/);
    }
    // Bundled internal packages are declared too: npm bundles only declared dependencies.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
      [...npmRuntimeDependencyNames(), ...NPM_BUNDLED_INTERNAL_PACKAGES.map((entry) => entry.name)].sort(),
    );
    for (const bundled of manifest.bundleDependencies ?? []) expect(manifest.dependencies).toHaveProperty(bundled);
    expect(manifest.optionalDependencies).toEqual({ fsevents: expect.stringMatching(/^\d/) });
    expect(manifest.private).toBeUndefined();
  });

  it("fails closed when a bundle external is not pinned by the daemon", () => {
    const { "better-sqlite3": _dropped, ...dependencies } = daemonManifest.dependencies ?? {};
    expect(() =>
      createNpmPackageManifest({ daemonManifest: { dependencies }, internalVersions, packageName: "open-design", rootManifest, version: "0.25.1" }),
    ).toThrow(/better-sqlite3/);
  });

  it("accepts scoped names and rejects invalid ones", () => {
    expect(
      createNpmPackageManifest({ daemonManifest, internalVersions, packageName: "@acme/open-design", rootManifest, version: "1.2.3-beta.1" }).name,
    ).toBe("@acme/open-design");
    for (const bad of ["Open-Design", "", " spaced name", "@scope", "../x"]) {
      expect(() => createNpmPackageManifest({ daemonManifest, internalVersions, packageName: bad, rootManifest, version: "0.1.0" })).toThrow(/package name/);
    }
    expect(() => createNpmPackageManifest({ daemonManifest, internalVersions, packageName: "open-design", rootManifest, version: "v1" })).toThrow(/version/);
  });
});

describe("rewriteBundledInternalManifest", () => {
  it("replaces workspace specifiers with the bundled sibling's version and drops build-only fields", () => {
    const sidecar = readManifest("packages/sidecar");
    const platform = readManifest("packages/platform");
    const rewritten = rewriteBundledInternalManifest(
      { ...sidecar, devDependencies: { vitest: "1.0.0" }, scripts: { build: "tsc" } },
      new Map([[platform.name!, platform.version!]]),
    );
    expect(rewritten.dependencies).toEqual({ "@open-design/platform": platform.version });
    expect(rewritten.devDependencies).toBeUndefined();
    expect(rewritten.scripts).toBeUndefined();
    expect(rewritten.files).toEqual(sidecar.files);
    expect(rewritten.exports).toEqual(sidecar.exports);
  });

  it("refuses an unknown workspace dependency instead of leaving a workspace: specifier behind", () => {
    expect(() =>
      rewriteBundledInternalManifest({ name: "@open-design/x", version: "1.0.0", dependencies: { "@open-design/y": "workspace:*" } }, new Map()),
    ).toThrow(/@open-design\/y/);
  });
});

describe("generated entry files", () => {
  it("the bin shim defaults the resource root to the package and the data dir to a per-user path", () => {
    const shim = renderNpmBinShim();
    expect(shim.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(shim).toContain('process.env.OD_RESOURCE_ROOT ||= packageRoot;');
    expect(shim).toContain('process.env.OD_DATA_DIR ||= defaultDataDir();');
    expect(shim).toContain('join(packageRoot, "lib", "daemon", "daemon-cli.mjs")');
    expect(NPM_DAEMON_BUNDLE_RELATIVE_PATH).toBe("lib/daemon/daemon-cli.mjs");
    expect(shim).toContain('"open-design", "cli"');
  });

  it("the daemon entrypoint pins OD_BIN and OD_DAEMON_CLI_PATH before importing the CLI", () => {
    const entry = renderNpmDaemonEntrypoint("../../apps/daemon/dist/cli.js");
    expect(entry).toContain("process.env.OD_BIN ??= selfPath;");
    expect(entry).toContain("process.env.OD_DAEMON_CLI_PATH ??= selfPath;");
    expect(entry.trimEnd().endsWith('await import("../../apps/daemon/dist/cli.js");')).toBe(true);
  });
});
