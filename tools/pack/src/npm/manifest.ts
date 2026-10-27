import { MAC_PREBUNDLE_COPIED_RUNTIME_DEPENDENCIES, MAC_PREBUNDLE_POLICIES } from "../mac/prebundle.js";

/** Bundled daemon CLI inside the package. `lib/daemon` is two levels below the package root, so the daemon's `resolveProjectRoot` lands on the package root. */
export const NPM_DAEMON_BUNDLE_RELATIVE_PATH = "lib/daemon/daemon-cli.mjs";
export const NPM_BIN_RELATIVE_PATH = "bin/od.mjs";
/** Static web export, read by the daemon as `<resource root>/web` (`resolveDaemonWebStaticDir`). */
export const NPM_WEB_RELATIVE_PATH = "web";

/**
 * Internal packages the daemon bundle keeps external (`MAC_PREBUNDLE_POLICIES.daemonCli.externals`).
 * `@open-design/sidecar` spawns its `supervisor.mjs` sibling by file path, so it must stay a real
 * package on disk; it ships inside the tarball as a bundled dependency together with its own
 * dependency `@open-design/platform`.
 */
export const NPM_BUNDLED_INTERNAL_PACKAGES = [
  { directory: "packages/platform", name: "@open-design/platform" },
  { directory: "packages/sidecar", name: "@open-design/sidecar" },
] as const;

export type PackageManifest = {
  bin?: Record<string, string>;
  bundleDependencies?: string[];
  dependencies?: Record<string, string>;
  description?: string;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  exports?: unknown;
  files?: string[];
  homepage?: string;
  keywords?: string[];
  license?: string;
  main?: string;
  name?: string;
  optionalDependencies?: Record<string, string>;
  private?: boolean;
  publishConfig?: Record<string, unknown>;
  repository?: unknown;
  scripts?: Record<string, string>;
  type?: string;
  types?: string;
  version?: string;
};

// npm's own name rules (scoped or unscoped, lowercase, URL-safe).
const NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export function assertNpmPackageName(name: string): string {
  const trimmed = name.trim();
  if (!NPM_PACKAGE_NAME_PATTERN.test(trimmed) || trimmed.length > 214) {
    throw new Error(`invalid npm package name: ${JSON.stringify(name)}`);
  }
  return trimmed;
}

/** Third-party packages the bundled daemon loads from `node_modules` at boot. */
export function npmRuntimeDependencyNames(): string[] {
  return MAC_PREBUNDLE_POLICIES.daemonCli.externals.filter(
    (name) => !name.startsWith("@open-design/") && !(name in MAC_PREBUNDLE_COPIED_RUNTIME_DEPENDENCIES),
  );
}

export type CreateNpmPackageManifestOptions = {
  daemonManifest: PackageManifest;
  description?: string;
  /** Exact versions of the bundled internal packages, keyed by package name. */
  internalVersions: ReadonlyMap<string, string>;
  packageName: string;
  rootManifest: PackageManifest;
  version: string;
};

/**
 * The published manifest. Every runtime dependency is pinned to the exact
 * version `apps/daemon/package.json` declares, so the package can never
 * install a native module the bundle was not built against (the same lockstep
 * rule the mac prebundle enforces, see MAC_PREBUNDLE_RUNTIME_DEPENDENCIES).
 */
export function createNpmPackageManifest(options: CreateNpmPackageManifestOptions): PackageManifest {
  const name = assertNpmPackageName(options.packageName);
  const version = options.version.trim();
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    throw new Error(`invalid package version: ${JSON.stringify(options.version)}`);
  }
  const dependencies: Record<string, string> = {};
  for (const dependency of npmRuntimeDependencyNames()) {
    const pinned = options.daemonManifest.dependencies?.[dependency];
    if (pinned == null || pinned.startsWith("workspace:")) {
      throw new Error(
        `npm runtime dependency ${dependency} is external in the daemon bundle but not pinned in apps/daemon/package.json`,
      );
    }
    dependencies[dependency] = pinned;
  }
  // npm only bundles a `bundleDependencies` entry that is also a declared
  // dependency; the exact version makes the bundled copy satisfy the edge, so
  // installation never consults the registry for these private packages.
  for (const entry of NPM_BUNDLED_INTERNAL_PACKAGES) {
    const version = options.internalVersions.get(entry.name);
    if (version == null) throw new Error(`missing workspace version for bundled internal package ${entry.name}`);
    dependencies[entry.name] = version;
  }
  const repository = options.rootManifest.repository;
  const homepage = options.rootManifest.homepage;
  return {
    name,
    version,
    description: options.description ?? options.rootManifest.description ?? "OpenDesign local daemon and web UI",
    license: options.rootManifest.license ?? "Apache-2.0",
    type: "module",
    bin: { od: `./${NPM_BIN_RELATIVE_PATH}` },
    engines: { node: "~24" },
    dependencies,
    optionalDependencies: { fsevents: MAC_PREBUNDLE_COPIED_RUNTIME_DEPENDENCIES.fsevents },
    bundleDependencies: NPM_BUNDLED_INTERNAL_PACKAGES.map((entry) => entry.name),
    publishConfig: { access: "public" },
    keywords: ["design", "ai", "agent", "prototype", "design-system", "cli", "local-first"],
    ...(repository == null ? {} : { repository }),
    ...(homepage == null ? {} : { homepage }),
  };
}

/**
 * Manifest of an internal package as shipped inside `node_modules/` of the
 * tarball. `workspace:*` specifiers become the sibling package's exact version
 * so npm resolves them against the bundled copy instead of the registry, and
 * build-only fields are dropped.
 */
export function rewriteBundledInternalManifest(
  manifest: PackageManifest,
  workspaceVersions: ReadonlyMap<string, string>,
): PackageManifest {
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error("bundled internal package manifest needs a name and version");
  }
  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).map(([dependency, specifier]) => {
      if (!specifier.startsWith("workspace:")) return [dependency, specifier] as const;
      const version = workspaceVersions.get(dependency);
      if (version == null) {
        throw new Error(`bundled internal package ${manifest.name} depends on unknown workspace package ${dependency}`);
      }
      return [dependency, version] as const;
    }),
  );
  return {
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description == null ? {} : { description: manifest.description }),
    license: manifest.license ?? "Apache-2.0",
    ...(manifest.type == null ? {} : { type: manifest.type }),
    ...(manifest.main == null ? {} : { main: manifest.main }),
    ...(manifest.types == null ? {} : { types: manifest.types }),
    ...(manifest.exports == null ? {} : { exports: manifest.exports }),
    ...(manifest.files == null ? {} : { files: manifest.files }),
    ...(Object.keys(dependencies).length === 0 ? {} : { dependencies }),
  };
}

/** esbuild entrypoint: pins the daemon CLI identity to the bundle before the CLI module evaluates. */
export function renderNpmDaemonEntrypoint(cliSpecifier: string): string {
  return [
    'import { fileURLToPath } from "node:url";',
    "const selfPath = fileURLToPath(import.meta.url);",
    "process.env.OD_BIN ??= selfPath;",
    "process.env.OD_DAEMON_CLI_PATH ??= selfPath;",
    `await import(${JSON.stringify(cliSpecifier)});`,
    "",
  ].join("\n");
}

/**
 * The `od` bin. The package is its own resource root (skills, design systems,
 * templates, plugins, and the `web/` export all sit beside `lib/`), and daemon
 * data defaults to a per-user directory so a global install never writes into
 * the package. Every variable is a default: an explicit environment wins.
 */
export function renderNpmBinShim(): string {
  return `#!/usr/bin/env node
// Generated by \`tools-pack npm build\`. Starts the bundled OpenDesign daemon CLI.
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const daemonEntry = join(packageRoot, ${NPM_DAEMON_BUNDLE_RELATIVE_PATH.split("/").map((segment) => JSON.stringify(segment)).join(", ")});

function defaultDataDir() {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(base, "open-design", "cli");
  }
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "open-design", "cli");
}

process.env.OD_RESOURCE_ROOT ||= packageRoot;
process.env.OD_DATA_DIR ||= defaultDataDir();

await import(pathToFileURL(daemonEntry).href);
`;
}

export function renderNpmReadme(options: { packageName: string; repositoryUrl?: string | null; version: string }): string {
  const source = options.repositoryUrl ? `\n## Source\n\n${options.repositoryUrl} (Apache-2.0)\n` : "";
  return `# ${options.packageName}

OpenDesign as a single npm package: the local daemon, the \`od\` CLI, the web UI,
and the bundled skills, design systems, design templates, and official plugins.
Version ${options.version}.

## Install

\`\`\`bash
npm install -g ${options.packageName}
od            # starts the daemon on http://127.0.0.1:7456 and opens the web UI
od --no-open  # headless: serve the UI without opening a browser
od --help
\`\`\`

Requires Node 24. The daemon drives the coding-agent CLIs already on your
\`PATH\` (claude, codex, opencode, cursor-agent, ...) or a provider API key you
configure in Settings.

## Data

Projects, settings, and generated files live under
\`$XDG_DATA_HOME/open-design/cli\` (default \`~/.local/share/open-design/cli\`;
\`%LOCALAPPDATA%\\open-design\\cli\` on Windows). Set \`OD_DATA_DIR\` to move
them. Set \`OD_PORT\` or pass \`--port\` to change the port.
${source}`;
}
