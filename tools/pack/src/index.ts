import { cac } from "cac";

import type { ToolPackCliOptions } from "./config/index.js";
import { packNpm, smokeNpm } from "./npm/index.js";

type CliOptions = ToolPackCliOptions;

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

const cli = cac("tools-pack");

cli
  .command("npm <action>", "npm package commands: build|smoke")
  .option("--app-version <version>", "override the package version (default: root package.json version)")
  .option("--dir <path>", "tools-pack output root directory")
  .option("--json", "print JSON")
  .option("--package-name <name>", "npm package name (default: root package.json name)")
  .option("--skip-build", "reuse the existing daemon dist and web static export instead of rebuilding them")
  .option("--tarball <path>", "smoke: tarball to install (default: the newest tarball under the npm output root)")
  .action(async (action: string, options: CliOptions) => {
    switch (action) {
      case "build":
        printJson(await packNpm(options));
        return;
      case "smoke":
        printJson(await smokeNpm(options));
        return;
      default:
        throw new Error(`unsupported npm action: ${action}`);
    }
  });

cli.help();
cli.parse();
