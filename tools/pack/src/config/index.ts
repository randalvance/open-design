import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveToolPackRoot(startDir: string): string {
  let candidate = startDir;
  while (true) {
    const packageJsonPath = join(candidate, "package.json");
    if (existsSync(packageJsonPath)) {
      const require = createRequire(packageJsonPath);
      const packageJson = require(packageJsonPath) as { name?: string };
      if (packageJson.name === "@open-design/tools-pack") return candidate;
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new Error(`could not locate @open-design/tools-pack package from ${startDir}`);
    }
    candidate = parent;
  }
}

export const WORKSPACE_ROOT = resolve(resolveToolPackRoot(__dirname), "../..");

export type ToolPackCliOptions = {
  appVersion?: string;
  dir?: string;
  json?: boolean;
  packageName?: string;
  skipBuild?: boolean;
  tarball?: string;
};
