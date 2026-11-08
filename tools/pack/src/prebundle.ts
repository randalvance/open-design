import { readFile } from "node:fs/promises";

/**
 * Daemon CLI esbuild policy shared by the npm package lane.
 * Externals must stay pinned to `apps/daemon/package.json` (see npm manifest).
 */
export const PREBUNDLE_ESBUILD_TARGET = "node24";
export const DAEMON_PREBUNDLE_ESM_REQUIRE_BANNER =
  'import { createRequire as __odCreateRequire } from "node:module"; const require = __odCreateRequire(import.meta.url);';

export const PREBUNDLE_COPIED_RUNTIME_DEPENDENCIES = {
  fsevents: "2.3.3",
} as const;

export const PREBUNDLE_POLICIES = {
  daemonCli: {
    externals: [
      "@ffmpeg-installer/ffmpeg",
      "@open-design/sidecar",
      "better-sqlite3",
      "blake3-wasm",
      "fsevents",
      "hyperframes",
      "gsap",
      "node-pty",
    ],
    forbiddenInputs: [
      "/node_modules/@open-design/daemon/",
      "/node_modules/@ffmpeg-installer/ffmpeg/",
      "/node_modules/better-sqlite3/",
      "/node_modules/blake3-wasm/",
      "/node_modules/electron/",
      "/node_modules/fsevents/",
      "/node_modules/hyperframes/",
      "/node_modules/gsap/",
      "/node_modules/next/",
      "/node_modules/node-pty/",
      "/node_modules/openai/",
      "/node_modules/react/",
      "/node_modules/react-dom/",
    ],
    label: "daemon cli",
  },
} as const;

export type PrebundlePolicyName = keyof typeof PREBUNDLE_POLICIES;

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

export function findForbiddenPrebundleInputs(options: {
  forbiddenInputs: readonly string[];
  inputs: readonly string[];
}): string[] {
  return options.inputs
    .map(toPosixPath)
    .filter((input) => options.forbiddenInputs.some((forbidden) => input.includes(forbidden)));
}

export async function assertPrebundleMetafile(options: {
  metafilePath: string;
  policyName: PrebundlePolicyName;
}): Promise<void> {
  const policy = PREBUNDLE_POLICIES[options.policyName];
  const metafile = JSON.parse(await readFile(options.metafilePath, "utf8")) as {
    inputs?: Record<string, unknown>;
  };
  const matched = findForbiddenPrebundleInputs({
    forbiddenInputs: policy.forbiddenInputs,
    inputs: Object.keys(metafile.inputs ?? {}),
  });
  if (matched.length > 0) {
    throw new Error(`${policy.label} prebundle included forbidden inputs: ${matched.join(", ")}`);
  }
}
