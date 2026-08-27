import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

import { listFiles } from "@vscode/vsce";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const bridgeManifest = await readFile("bridge/Cargo.toml", "utf8");
const bridgeProtocol = await readFile("src/bridge/protocol.ts", "utf8");

assert.equal(manifest.name, "inreview");
assert.equal(manifest.displayName, "InReview");
assert.deepEqual(manifest.extensionKind, ["workspace"]);
assert.equal(manifest.main, "./dist/extension.js");
assert.equal(manifest.version, "0.0.1");
assert.match(
  bridgeManifest,
  new RegExp(`^version = "${manifest.version.replaceAll(".", "\\.")}"$`, "mu"),
);
assert.match(
  bridgeProtocol,
  new RegExp(
    `^export const BRIDGE_VERSION = "${manifest.version.replaceAll(".", "\\.")}";$`,
    "mu",
  ),
);
assert.equal(manifest.license, "UNLICENSED");
assert.equal(
  manifest.repository.url,
  "git+https://github.com/will-j-wright/inreview.git",
);
assert.equal(
  manifest.homepage,
  "https://github.com/will-j-wright/inreview#readme",
);
assert.equal(
  manifest.bugs.url,
  "https://github.com/will-j-wright/inreview/issues",
);
assert.equal(manifest.capabilities.untrustedWorkspaces.supported, "limited");
assert.equal(manifest.capabilities.virtualWorkspaces.supported, false);
assert.equal("enabledApiProposals" in manifest, false);
assert.ok(
  Object.values(manifest.scripts).every(
    (script) => !String(script).includes(".test-work"),
  ),
  "Package scripts must not include local test review data.",
);

const commands = manifest.contributes.commands.map(({ command }) => command);
assert.equal(new Set(commands).size, commands.length);
assert.ok(commands.every((command) => command.startsWith("inreview.")));

const activationEvents = new Set(manifest.activationEvents);
assert.ok(
  activationEvents.has("onStartupFinished"),
  "InReview must activate after startup so its workspace registers with the MCP bridge.",
);
for (const command of commands) {
  assert.ok(
    activationEvents.has(`onCommand:${command}`),
    `Missing activation event for ${command}.`,
  );
}

const views = manifest.contributes.views.inreview;
assert.deepEqual(
  views.map(({ id }) => id),
  ["inreview.activeReview", "inreview.comments", "inreview.history"],
);

const menus = manifest.contributes.menus;
const menuCommands = (menu) => (menus[menu] ?? []).map(({ command }) => command);
assert.ok(
  menuCommands("comments/commentThread/context").includes(
    "inreview.submitComment",
  ),
  "Submit Comment must use the comment editor context that supplies CommentReply.",
);
assert.ok(
  !menuCommands("comments/commentThread/title").includes(
    "inreview.submitComment",
  ),
  "Submit Comment must not use the thread title toolbar.",
);
for (const command of [
  "inreview.saveComment",
  "inreview.cancelCommentEdit",
]) {
  assert.ok(
    menuCommands("comments/comment/context").includes(command),
    `${command} must use the editable comment context.`,
  );
}

await Promise.all([
  access("dist/extension.js"),
  access(
    process.platform === "win32"
      ? "dist/bridge/inreview-bridge.exe"
      : "dist/bridge/inreview-bridge",
  ),
  access("media/inreview.svg"),
  access(".vscodeignore"),
]);

const vscodeIgnore = await readFile(".vscodeignore", "utf8");
for (const excluded of [
  ".git/**",
  ".jj/**",
  ".test-work/**",
  ".verification/**",
  "**/*.map",
  "**/*.lock",
  "**/*.vsix",
  "AGENTS.md",
  "plan-*.md",
  "bridge/**",
  "vitest.config.mjs",
  "package-lock.json",
]) {
  assert.ok(
    vscodeIgnore.split(/\r?\n/u).includes(excluded),
    `.vscodeignore must exclude ${excluded}.`,
  );
}

const packageFiles = await listFiles({ packagedDependencies: [] });
assert.deepEqual(packageFiles.sort(), [
  "CHANGELOG.md",
  "README.md",
  process.platform === "win32"
    ? "dist/bridge/inreview-bridge.exe"
    : "dist/bridge/inreview-bridge",
  "dist/extension.js",
  "media/inreview.svg",
  "package.json",
]);

console.log("The extension manifest and package contents are valid.");
