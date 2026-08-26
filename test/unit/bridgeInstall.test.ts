import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installBridge } from "../../src/bridge";

const root = path.resolve(".test-work", "bridge-install");

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("native bridge installation", () => {
  it("installs a versioned binary and a stable runtime-free launcher", async () => {
    const extensionRoot = path.join(root, "extension");
    const storageRoot = path.join(root, "storage");
    const packagedBinary = path.join(
      extensionRoot,
      "dist",
      "bridge",
      process.platform === "win32"
        ? "inreview-bridge.exe"
        : "inreview-bridge",
    );
    await mkdir(path.dirname(packagedBinary), { recursive: true });
    await writeFile(packagedBinary, "native bridge fixture");

    const installed = await installBridge({
      globalStorageUri: { fsPath: storageRoot },
      asAbsolutePath: (relativePath) =>
        path.join(extensionRoot, relativePath),
    });

    expect(await readFile(installed.executablePath, "utf8")).toBe(
      "native bridge fixture",
    );
    const launcher = await readFile(installed.launcherPath, "utf8");
    expect(launcher).toContain(installed.executablePath);
    expect(launcher).toContain(installed.endpoint);
    expect(launcher).not.toMatch(/\bnode(?:\.exe)?\b/iu);
    expect(launcher).not.toContain('"$@"');
    expect(launcher).not.toContain("%*");
    expect(installed.endpoint).toContain("v2");
    expect(installed.endpoint).not.toMatch(/:\d{2,5}/u);
    if (process.platform !== "win32") {
      expect((await stat(installed.executablePath)).mode & 0o777).toBe(0o700);
      expect((await stat(installed.launcherPath)).mode & 0o777).toBe(0o700);
    }
  });

  it("does not replace an unchanged versioned executable", async () => {
    const extensionRoot = path.join(root, "extension");
    const packagedBinary = path.join(
      extensionRoot,
      "dist",
      "bridge",
      process.platform === "win32"
        ? "inreview-bridge.exe"
        : "inreview-bridge",
    );
    await mkdir(path.dirname(packagedBinary), { recursive: true });
    await writeFile(packagedBinary, "same bytes");
    const context = {
      globalStorageUri: { fsPath: path.join(root, "storage") },
      asAbsolutePath: (relativePath: string) =>
        path.join(extensionRoot, relativePath),
    };

    const first = await installBridge(context);
    const firstStat = await stat(first.executablePath);
    const second = await installBridge(context);
    const secondStat = await stat(second.executablePath);

    expect(secondStat.ino).toBe(firstStat.ino);
  });
});
