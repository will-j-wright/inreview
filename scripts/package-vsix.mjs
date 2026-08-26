import { createVSIX } from "@vscode/vsce";

const targets = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64",
  "linux-x64": "linux-x64",
  "win32-arm64": "win32-arm64",
  "win32-x64": "win32-x64",
};
const key = `${process.platform}-${process.arch}`;
const target = targets[key];
if (target === undefined) {
  throw new Error(`Unsupported VSIX target: ${key}`);
}

await createVSIX({
  cwd: process.cwd(),
  dependencies: false,
  skipLicense: true,
  target,
});

