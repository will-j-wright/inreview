import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { BRIDGE_PROTOCOL_VERSION, BRIDGE_VERSION } from "./protocol";

export interface InstalledBridge {
  readonly executablePath: string;
  readonly launcherPath: string;
  readonly endpoint: string;
}

export interface BridgeInstallContext {
  readonly globalStorageUri: { readonly fsPath: string };
  asAbsolutePath(relativePath: string): string;
}

export async function installBridge(
  context: BridgeInstallContext,
): Promise<InstalledBridge> {
  const directory = path.join(context.globalStorageUri.fsPath, "bridge");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
  }

  const executableName =
    process.platform === "win32"
      ? `inreview-bridge-${BRIDGE_VERSION}.exe`
      : `inreview-bridge-${BRIDGE_VERSION}`;
  const source = context.asAbsolutePath(
    path.join(
      "dist",
      "bridge",
      process.platform === "win32" ? "inreview-bridge.exe" : "inreview-bridge",
    ),
  );
  const executablePath = path.join(directory, executableName);
  await atomicCopy(source, executablePath);
  if (process.platform !== "win32") {
    await chmod(executablePath, 0o700);
  }

  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\inreview-v${String(BRIDGE_PROTOCOL_VERSION)}-${createHash("sha256").update(directory).digest("hex").slice(0, 20)}`
      : path.join(
          directory,
          `bridge-v${String(BRIDGE_PROTOCOL_VERSION)}.sock`,
        );
  const launcherPath = path.join(
    directory,
    process.platform === "win32" ? "inreview-bridge.cmd" : "inreview-bridge",
  );
  await atomicWrite(
    launcherPath,
    launcherContents(executablePath, endpoint),
  );
  if (process.platform !== "win32") {
    await chmod(launcherPath, 0o700);
  }
  return { executablePath, launcherPath, endpoint };
}

async function atomicCopy(source: string, destination: string): Promise<void> {
  const content = await readFile(source);
  const installed = await readFile(destination).catch(() => undefined);
  if (installed?.equals(content) === true) {
    return;
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o700 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function atomicWrite(destination: string, content: string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, {
      encoding: "utf8",
      mode: 0o700,
    });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function launcherContents(executablePath: string, endpoint: string): string {
  if (process.platform === "win32") {
    return `@echo off\r\n"${escapeCmd(executablePath)}" mcp --endpoint "${escapeCmd(endpoint)}"\r\n`;
  }
  return `#!/bin/sh\nexec ${quoteShell(executablePath)} mcp --endpoint ${quoteShell(endpoint)}\n`;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function escapeCmd(value: string): string {
  return value.replaceAll("%", "%%").replaceAll('"', '""');
}
