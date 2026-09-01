import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const xvfbMarker = "INREVIEW_INTEGRATION_XVFB";

async function runUnderVirtualDisplayIfNeeded(): Promise<number | undefined> {
  if (
    process.platform !== "linux" ||
    process.env.DISPLAY ||
    process.env[xvfbMarker]
  ) {
    return undefined;
  }

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(
      "xvfb-run",
      [
        "-a",
        process.execPath,
        "--import",
        "tsx",
        fileURLToPath(import.meta.url),
      ],
      {
        env: { ...process.env, [xvfbMarker]: "1" },
        stdio: "inherit",
      },
    );

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`xvfb-run terminated with signal ${signal}`));
        return;
      }

      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  let userDataDirectory: string | undefined;
  try {
    const xvfbExitCode = await runUnderVirtualDisplayIfNeeded();
    if (xvfbExitCode !== undefined) {
      process.exitCode = xvfbExitCode;
      return;
    }

    userDataDirectory = await mkdtemp(
      path.join(tmpdir(), "inreview-vscode-test-"),
    );
    const profileArgument = `--user-data-dir=${userDataDirectory}`;
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [profileArgument, "--disable-workspace-trust"],
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
      launchArgs: [
        eligibleWorkspace,
        profileArgument,
        "--disable-workspace-trust",
      ],
      extensionTestsEnv,
    });
  } catch (error: unknown) {
    console.error("The VS Code extension-host tests failed.", error);
    process.exitCode = 1;
  } finally {
    await rm(eligibleWorkspace, { recursive: true, force: true });
    if (userDataDirectory !== undefined) {
      await rm(userDataDirectory, { recursive: true, force: true });
    }
  }
}

void main();
