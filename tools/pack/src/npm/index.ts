import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, cp, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { createCommandInvocation, createPackageManagerInvocation } from "@open-design/platform";

import { WORKSPACE_ROOT } from "../config/index.js";
import {
  MAC_DAEMON_PREBUNDLE_ESM_REQUIRE_BANNER,
  MAC_PREBUNDLE_ESBUILD_TARGET,
  MAC_PREBUNDLE_POLICIES,
  assertMacPrebundleMetafile,
} from "../mac/prebundle.js";
import { copyBundledResourceTrees, packBundledDshRuntime } from "../resources/index.js";
import {
  NPM_BIN_RELATIVE_PATH,
  NPM_BUNDLED_INTERNAL_PACKAGES,
  NPM_DAEMON_BUNDLE_RELATIVE_PATH,
  NPM_WEB_RELATIVE_PATH,
  createNpmPackageManifest,
  renderNpmBinShim,
  renderNpmDaemonEntrypoint,
  renderNpmReadme,
  rewriteBundledInternalManifest,
  type PackageManifest,
} from "./manifest.js";

const execFileAsync = promisify(execFile);
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;

export type ToolPackNpmOptions = {
  appVersion?: string;
  dir?: string;
  packageName?: string;
  skipBuild?: boolean;
  tarball?: string;
};

export type NpmPackResult = {
  entryCount: number;
  packageName: string;
  sizeBytes: number;
  stageRoot: string;
  tarballPath: string;
  unpackedSizeBytes: number;
  version: string;
};

export type NpmSmokeResult = {
  dataDir: string;
  health: unknown;
  helpExitCode: number;
  installedRoot: string;
  packageName: string;
  port: number;
  rootContentType: string | null;
  rootStatus: number;
  tarballPath: string;
  version: string;
};

type NpmPaths = {
  entryRoot: string;
  metaRoot: string;
  outRoot: string;
  stageRoot: string;
};

function resolveNpmPaths(dir: string | undefined): NpmPaths {
  const toolPackRoot = resolve(dir ?? join(WORKSPACE_ROOT, ".tmp", "tools-pack"));
  const outRoot = join(toolPackRoot, "out", "npm");
  return {
    entryRoot: join(outRoot, "entry"),
    metaRoot: join(outRoot, "meta"),
    outRoot,
    stageRoot: join(outRoot, "package"),
  };
}

async function readManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, "utf8")) as PackageManifest;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runPnpm(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const invocation = createPackageManagerInvocation(args, env);
  await execFileAsync(invocation.command, invocation.args, {
    cwd: WORKSPACE_ROOT,
    env,
    maxBuffer: EXEC_MAX_BUFFER,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

async function runNpm(args: string[], cwd: string): Promise<string> {
  const invocation = createCommandInvocation({
    args,
    command: process.platform === "win32" ? "npm.cmd" : "npm",
  });
  const { stdout } = await execFileAsync(invocation.command, invocation.args, {
    cwd,
    env: process.env,
    maxBuffer: EXEC_MAX_BUFFER,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  return stdout;
}

function toRelativeImportSpecifier(fromDirectory: string, targetPath: string): string {
  const specifier = relative(fromDirectory, targetPath).replaceAll("\\", "/");
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

async function buildWorkspaceInputs(): Promise<void> {
  // The daemon and every workspace package it imports; `...` selects dependencies.
  await runPnpm(["--filter", "@open-design/daemon...", "--workspace-concurrency=4", "--if-present", "run", "build"]);
  // Static export: next.config.ts exports when OD_WEB_OUTPUT_MODE is unset and NODE_ENV is not development.
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
  delete env.OD_WEB_OUTPUT_MODE;
  await runPnpm(["--filter", "@open-design/web", "exec", "next", "build"], env);
}

async function assertBuildInputs(): Promise<void> {
  const required = [
    join(WORKSPACE_ROOT, "apps", "daemon", "dist", "cli.js"),
    join(WORKSPACE_ROOT, "apps", "web", "out", "index.html"),
    ...NPM_BUNDLED_INTERNAL_PACKAGES.map((entry) => join(WORKSPACE_ROOT, entry.directory, "dist", "index.mjs")),
  ];
  for (const path of required) {
    if (!(await pathExists(path))) {
      throw new Error(`npm build input is missing: ${relative(WORKSPACE_ROOT, path)} (run without --skip-build)`);
    }
  }
}

async function bundleDaemon(paths: NpmPaths): Promise<void> {
  const entryPath = join(paths.entryRoot, "daemon-cli.js");
  const outDir = join(paths.stageRoot, dirname(NPM_DAEMON_BUNDLE_RELATIVE_PATH));
  const metafilePath = join(paths.metaRoot, "daemon.meta.json");
  await mkdir(paths.entryRoot, { recursive: true });
  await mkdir(paths.metaRoot, { recursive: true });
  await writeFile(
    entryPath,
    renderNpmDaemonEntrypoint(
      toRelativeImportSpecifier(paths.entryRoot, join(WORKSPACE_ROOT, "apps", "daemon", "dist", "cli.js")),
    ),
    "utf8",
  );
  await runPnpm([
    "--filter",
    "@open-design/tools-pack",
    "exec",
    "esbuild",
    entryPath,
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--target=${MAC_PREBUNDLE_ESBUILD_TARGET}`,
    `--banner:js=${MAC_DAEMON_PREBUNDLE_ESM_REQUIRE_BANNER}`,
    ...MAC_PREBUNDLE_POLICIES.daemonCli.externals.map((dependency) => `--external:${dependency}`),
    `--outdir=${outDir}`,
    "--entry-names=[name]",
    "--out-extension:.js=.mjs",
    `--metafile=${metafilePath}`,
  ]);
  await assertMacPrebundleMetafile({ metafilePath, policyName: "daemonCli" });
  if (!(await pathExists(join(paths.stageRoot, NPM_DAEMON_BUNDLE_RELATIVE_PATH)))) {
    throw new Error(`esbuild did not produce ${NPM_DAEMON_BUNDLE_RELATIVE_PATH}`);
  }
}

async function readInternalManifests(): Promise<Map<string, PackageManifest>> {
  const manifests = new Map<string, PackageManifest>();
  for (const entry of NPM_BUNDLED_INTERNAL_PACKAGES) {
    const manifest = await readManifest(join(WORKSPACE_ROOT, entry.directory, "package.json"));
    if (manifest.name !== entry.name || typeof manifest.version !== "string") {
      throw new Error(`unexpected manifest for ${entry.directory}`);
    }
    manifests.set(entry.name, manifest);
  }
  return manifests;
}

async function readInternalVersions(): Promise<Map<string, string>> {
  return new Map([...(await readInternalManifests())].map(([name, manifest]) => [name, manifest.version!]));
}

async function stageBundledInternalPackages(stageRoot: string): Promise<void> {
  const manifests = await readInternalManifests();
  const versions = new Map([...manifests].map(([name, manifest]) => [name, manifest.version!]));
  for (const entry of NPM_BUNDLED_INTERNAL_PACKAGES) {
    const manifest = manifests.get(entry.name)!;
    const sourceRoot = join(WORKSPACE_ROOT, entry.directory);
    const targetRoot = join(stageRoot, "node_modules", ...entry.name.split("/"));
    await mkdir(targetRoot, { recursive: true });
    for (const file of manifest.files ?? ["dist"]) {
      await cp(join(sourceRoot, file), join(targetRoot, file), { dereference: true, recursive: true });
    }
    await writeFile(
      join(targetRoot, "package.json"),
      `${JSON.stringify(rewriteBundledInternalManifest(manifest, versions), null, 2)}\n`,
      "utf8",
    );
  }
}

async function stageWebExport(stageRoot: string): Promise<void> {
  // Browser sourcemaps stay out of the package, as they do in packaged builds.
  await cp(join(WORKSPACE_ROOT, "apps", "web", "out"), join(stageRoot, NPM_WEB_RELATIVE_PATH), {
    filter: (source) => !source.endsWith(".map"),
    recursive: true,
  });
}

function repositoryUrl(rootManifest: PackageManifest): string | null {
  const repository = rootManifest.repository;
  if (typeof repository === "string") return repository;
  if (repository != null && typeof repository === "object" && typeof (repository as { url?: unknown }).url === "string") {
    return (repository as { url: string }).url.replace(/^git\+/, "").replace(/\.git$/, "");
  }
  return null;
}

export async function packNpm(options: ToolPackNpmOptions = {}): Promise<NpmPackResult> {
  const paths = resolveNpmPaths(options.dir);
  const rootManifest = await readManifest(join(WORKSPACE_ROOT, "package.json"));
  const daemonManifest = await readManifest(join(WORKSPACE_ROOT, "apps", "daemon", "package.json"));
  const version = options.appVersion?.trim() || rootManifest.version;
  if (typeof version !== "string") throw new Error("root package.json has no version");
  const manifest = createNpmPackageManifest({
    daemonManifest,
    internalVersions: await readInternalVersions(),
    packageName: options.packageName?.trim() || rootManifest.name || "open-design",
    rootManifest,
    version,
  });

  if (options.skipBuild !== true) await buildWorkspaceInputs();
  await assertBuildInputs();

  await rm(paths.outRoot, { force: true, recursive: true });
  await mkdir(paths.stageRoot, { recursive: true });

  await bundleDaemon(paths);
  await stageBundledInternalPackages(paths.stageRoot);
  await stageWebExport(paths.stageRoot);
  await copyBundledResourceTrees({ workspaceRoot: WORKSPACE_ROOT, resourceRoot: paths.stageRoot });
  await packBundledDshRuntime({ workspaceRoot: WORKSPACE_ROOT, resourceRoot: paths.stageRoot });

  const binPath = join(paths.stageRoot, NPM_BIN_RELATIVE_PATH);
  await mkdir(dirname(binPath), { recursive: true });
  await writeFile(binPath, renderNpmBinShim(), "utf8");
  await chmod(binPath, 0o755);
  await writeFile(join(paths.stageRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(
    join(paths.stageRoot, "README.md"),
    renderNpmReadme({ packageName: manifest.name!, repositoryUrl: repositoryUrl(rootManifest), version }),
    "utf8",
  );
  await copyFile(join(WORKSPACE_ROOT, "LICENSE"), join(paths.stageRoot, "LICENSE"));

  const packOutput = await runNpm(["pack", "--json", "--pack-destination", paths.outRoot], paths.stageRoot);
  const [packed] = JSON.parse(packOutput) as Array<{ entryCount: number; filename: string; size: number; unpackedSize: number }>;
  if (packed == null) throw new Error("npm pack produced no tarball");
  return {
    entryCount: packed.entryCount,
    packageName: manifest.name!,
    sizeBytes: packed.size,
    stageRoot: paths.stageRoot,
    tarballPath: join(paths.outRoot, packed.filename),
    unpackedSizeBytes: packed.unpackedSize,
    version,
  };
}

async function findLatestTarball(outRoot: string): Promise<string> {
  const entries = (await readdir(outRoot).catch(() => [] as string[])).filter((entry) => entry.endsWith(".tgz"));
  if (entries.length === 0) throw new Error(`no npm tarball under ${outRoot}; run \`tools-pack npm build\` first`);
  const dated = await Promise.all(entries.map(async (entry) => ({ entry, mtime: (await stat(join(outRoot, entry))).mtimeMs })));
  dated.sort((a, b) => b.mtime - a.mtime);
  return join(outRoot, dated[0]!.entry);
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address != null ? address.port : 0;
      server.close(() => (port > 0 ? resolvePort(port) : reject(new Error("no free port"))));
    });
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise<void>((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

/**
 * Installs the tarball the way a user would (`npm install` from a tarball into
 * an empty prefix), then boots the installed `od` headless and checks that the
 * daemon answers `/api/health`, serves the web UI at `/`, and writes its data
 * where `OD_DATA_DIR` points instead of into the package.
 */
export async function smokeNpm(options: ToolPackNpmOptions = {}): Promise<NpmSmokeResult> {
  const paths = resolveNpmPaths(options.dir);
  const tarballPath = options.tarball ? resolve(options.tarball) : await findLatestTarball(paths.outRoot);
  const stagedManifest = await readManifest(join(paths.stageRoot, "package.json")).catch(() => null);
  const packageName = options.packageName?.trim() || stagedManifest?.name;
  if (!packageName) throw new Error("pass --package-name; no staged package manifest to read it from");

  const smokeRoot = join(paths.outRoot, "smoke");
  await rm(smokeRoot, { force: true, recursive: true });
  await mkdir(smokeRoot, { recursive: true });
  await writeFile(join(smokeRoot, "package.json"), '{"name":"open-design-npm-smoke","private":true}\n', "utf8");
  await runNpm(["install", "--no-audit", "--no-fund", "--no-package-lock", "--omit=dev", tarballPath], smokeRoot);

  const installedRoot = join(smokeRoot, "node_modules", ...packageName.split("/"));
  const installedManifest = await readManifest(join(installedRoot, "package.json"));
  const shim = join(installedRoot, NPM_BIN_RELATIVE_PATH);
  const dataDir = join(smokeRoot, "data");
  const env: NodeJS.ProcessEnv = { ...process.env, OD_DATA_DIR: dataDir };
  delete env.OD_RESOURCE_ROOT;
  delete env.OD_PORT;

  let helpExitCode = 0;
  try {
    await execFileAsync(process.execPath, [shim, "--help"], { env, maxBuffer: EXEC_MAX_BUFFER });
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown; stdout?: unknown };
    helpExitCode = typeof failure.code === "number" ? failure.code : 1;
    const detail = [failure.stdout, failure.stderr]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join("\n")
      .slice(-8_000);
    throw new Error(`installed od --help exited with ${helpExitCode}:\n${detail}`);
  }

  const port = await freePort();
  const child = spawn(process.execPath, [shim, "--port", String(port), "--no-open"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-16_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 120_000;
    let health: unknown = null;
    while (health == null) {
      if (child.exitCode != null) throw new Error(`installed od exited early (${child.exitCode}):\n${output}`);
      if (Date.now() > deadline) throw new Error(`installed od did not answer /api/health within 120s:\n${output}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) health = await response.json();
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      }
    }
    const rootResponse = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(10_000) });
    const rootContentType = rootResponse.headers.get("content-type");
    if (rootResponse.status !== 200 || !(rootContentType ?? "").includes("text/html")) {
      throw new Error(`installed od served / as ${rootResponse.status} ${rootContentType ?? ""}; the web export is missing`);
    }
    if (!(await pathExists(dataDir))) throw new Error(`OD_DATA_DIR was not honored: ${dataDir} does not exist`);
    if (await pathExists(join(installedRoot, ".od"))) throw new Error("daemon wrote data into the installed package");
    return {
      dataDir,
      health,
      helpExitCode,
      installedRoot,
      packageName,
      port,
      rootContentType,
      rootStatus: rootResponse.status,
      tarballPath,
      version: installedManifest.version ?? "",
    };
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child, 15_000);
  }
}
