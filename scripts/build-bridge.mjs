import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const release = process.argv.includes("--release");
const executable = process.platform === "win32"
  ? "inreview-bridge.exe"
  : "inreview-bridge";
const commandArguments = ["build", "--manifest-path", "bridge/Cargo.toml"];
if (release) {
  commandArguments.push("--release", "--locked");
}

await new Promise((resolve, reject) => {
  const child = spawn("cargo", commandArguments, {
    stdio: "inherit",
    shell: false,
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) {
      resolve();
    } else {
      reject(
        new Error(
          signal === null
            ? `cargo exited with code ${String(code)}`
            : `cargo exited with signal ${signal}`,
        ),
      );
    }
  });
});

const profile = release ? "release" : "debug";
const outputDirectory = path.join("dist", "bridge");
await mkdir(outputDirectory, { recursive: true });
await copyFile(
  path.join("bridge", "target", profile, executable),
  path.join(outputDirectory, executable),
);
