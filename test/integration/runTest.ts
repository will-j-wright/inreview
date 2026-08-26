import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { runTests } from "@vscode/test-electron";

const extensionDevelopmentPath = path.resolve(".");
const extensionTestsPath = path.resolve(
  extensionDevelopmentPath,
  "dist/test/suite/index.js",
);
const eligibleWorkspace = path.resolve(
  extensionDevelopmentPath,
  ".test-work",
  "vscode-host-eligible",
);
const execFileAsync = promisify(execFile);
const extensionTestsEnv = { GIT_CONFIG_VALUE_2: "false" };

async function main(): Promise<void> {
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ["--disable-workspace-trust"],
      extensionTestsEnv,
    });

    await rm(eligibleWorkspace, { recursive: true, force: true });
    await mkdir(path.join(eligibleWorkspace, ".vscode"), { recursive: true });
    await execFileAsync("jj", [
      "git",
      "init",
      "--colocate",
      eligibleWorkspace,
    ]);
    await writeFile(
      path.join(eligibleWorkspace, "README.txt"),
      "VS Code host smoke fixture.\n",
      "utf8",
    );
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [eligibleWorkspace, "--disable-workspace-trust"],
      extensionTestsEnv,
    });
  } catch (error: unknown) {
    console.error("The VS Code extension-host tests failed.", error);
    process.exitCode = 1;
  } finally {
    await rm(eligibleWorkspace, { recursive: true, force: true });
  }
}

void main();
