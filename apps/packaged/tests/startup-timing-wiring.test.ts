import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { API } from "@typescript/native/unstable/sync";
import * as ts from "@typescript/native/unstable/ast";
import type { Node, SourceFile } from "@typescript/native/unstable/ast";
import { describe, expect, it, vi } from "vitest";

const file = fileURLToPath(new URL("../src/index.ts", import.meta.url));

function withSourceAst<T>(run: (ast: SourceFile) => T): T {
  const compiler = new API();
  try {
    using snapshot = compiler.updateSnapshot({ openFiles: [file] });
    const ast = snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file);
    if (!ast) throw new Error(`Native TypeScript could not parse ${file}`);
    return run(ast);
  } finally {
    compiler.close();
  }
}

function select(ast: SourceFile, predicate: (node: Node) => boolean): Node {
  let found: Node | undefined;
  function visit(node: Node) {
    if (predicate(node)) found = node;
    node.forEachChild(visit);
  }
  visit(ast);
  if (!found) throw new Error("startup wiring not found");
  return found;
}

function evaluate(code: string, globals: Record<string, unknown>) {
  return runInNewContext(stripTypeScriptTypes(code), globals);
}

describe("packaged launch timing wiring", () => {
  it("retains daemon/web phase edges", () => {
    const method = withSourceAst((ast) => {
      const node = select(ast, (candidate) => ts.isMethodDeclaration(candidate) && candidate.name.getText(ast) === "onPhase");
      if (!ts.isMethodDeclaration(node)) throw new Error("startup wiring not found");
      return node.getText(ast);
    });
    const mark = vi.fn();
    const onPhase = evaluate(`const options = { ${method} }; options.onPhase;`, {
      packagedStartupTiming: { mark }, setSplashStage: vi.fn(), splash: null,
    }) as (phase: string) => void;
    for (const phase of ["daemon-spawning", "daemon-ready", "web-spawning", "web-ready"]) onPhase(phase);
    expect(mark.mock.calls.flat()).toEqual(["daemon_spawning", "daemon_ready", "web_spawning", "web_ready"]);
  });

  it("logs a fatal startup failure, shows path-access errors, and exits with the launcher exit code", () => {
    const handler = withSourceAst((ast) => {
      const node = select(ast, (candidate) => ts.isCallExpression(candidate) && ts.isPropertyAccessExpression(candidate.expression)
        && candidate.expression.name.text === "catch" && candidate.expression.expression.getText(ast) === "main()");
      if (!ts.isCallExpression(node)) throw new Error("startup wiring not found");
      return node.arguments[0]!.getText(ast);
    });
    class PathAccessError extends Error { title = "Path access"; }
    const exit = vi.fn();
    const showErrorBox = vi.fn();
    const logError = vi.fn();
    const consoleError = vi.fn();
    const run = evaluate(`const handler = ${handler}; handler;`, {
      PackagedPathAccessError: PathAccessError, dialog: { showErrorBox },
      packagedLogger: { error: logError }, console: { error: consoleError },
      process: { exit }, resolveSidecarLauncherExitCode: () => 7,
    }) as (error: Error) => void;

    const failure = new Error("daemon failed");
    run(failure);
    expect(showErrorBox).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledExactlyOnceWith("packaged runtime failed", { error: failure });
    expect(consoleError).toHaveBeenCalledExactlyOnceWith("packaged runtime failed", failure);
    expect(exit).toHaveBeenCalledExactlyOnceWith(7);

    run(new PathAccessError("no access"));
    expect(showErrorBox).toHaveBeenCalledExactlyOnceWith("Path access", "no access");
    expect(exit).toHaveBeenCalledTimes(2);
  });
});


it("does not create a process launch for deferred restores, including a failed restore retry", async () => {
  const { launch, timing } = withSourceAst((ast) => {
    const launchNode = select(ast, (node) => ts.isPropertyAssignment(node) && node.name.getText(ast) === "launch");
    const timingNode = select(ast, (node) => ts.isPropertyAssignment(node) && node.name.getText(ast) === "startupTiming");
    if (!ts.isPropertyAssignment(launchNode) || !ts.isPropertyAssignment(timingNode)) throw new Error("startup wiring not found");
    return { launch: launchNode.initializer.getText(ast), timing: timingNode.initializer.getText(ast) };
  });
  const create = vi.fn();
  const launchDesktop = vi.fn().mockRejectedValueOnce(new Error("restore failed")).mockResolvedValueOnce("restored");
  const globals = {
    deferredHeadless: true, packagedStartupTiming: null, activeConfig: { appVersion: "1.0.0" },
    createDesktopStartupTiming: create,
    createSplashWindow: vi.fn(), splash: null, launchDesktop,
  };
  expect(evaluate(timing, globals)).toBeNull();
  const restore = evaluate(`(${launch})`, globals) as () => Promise<unknown>;
  await expect(restore()).rejects.toThrow("restore failed");
  await expect(restore()).resolves.toBe("restored");
  expect(create).not.toHaveBeenCalled();
});
