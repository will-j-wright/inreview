import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JjClient, JjExecutableNotFoundError } from "../../src/jj";

const WORK_ROOT = path.resolve("test", ".jj-adapter-work");
const REPOSITORY = path.join(WORK_ROOT, "repo");
const USER_CONFIG = [
  "--config",
  "user.name=InReview Test",
  "--config",
  "user.email=inreview@example.invalid",
] as const;

function jjAvailable(): boolean {
  return spawnSync("jj", ["--version"], {
    shell: false,
    stdio: "ignore",
  }).status === 0;
}

function runJj(args: readonly string[]): void {
  const result = spawnSync("jj", [...USER_CONFIG, "--repository", REPOSITORY, ...args], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}

describe.skipIf(!jjAvailable())("jj adapter integration", () => {
  beforeAll(async () => {
    await fs.rm(WORK_ROOT, { recursive: true, force: true });
    await fs.mkdir(REPOSITORY, { recursive: true });
    const initialized = spawnSync("jj", ["git", "init", "--colocate", REPOSITORY], {
      encoding: "utf8",
      shell: false,
    });
    if (initialized.status !== 0) {
      throw new Error(initialized.stderr);
    }

    await fs.writeFile(path.join(REPOSITORY, "oldest.txt"), "oldest\n");
    runJj(["describe", "--message", "oldest"]);
    runJj(["new"]);
    await fs.writeFile(path.join(REPOSITORY, "middle.txt"), "middle\n");
    runJj(["describe", "--message", "middle"]);
    runJj(["new"]);
    await fs.writeFile(
      path.join(REPOSITORY, "--config=evil;$(no-shell).bin"),
      Buffer.from([0, 1, 2, 3, 255]),
    );
    runJj(["describe", "--message", "newest"]);
  });

  afterAll(async () => {
    await fs.rm(WORK_ROOT, { recursive: true, force: true });
  });

  it("selects Last 1, Last X, and fewer ancestors in stable order", async () => {
    const session = await new JjClient(REPOSITORY).openReadSession();
    const lastOne = await session.selectLast(1);
    const lastThree = await session.selectLast(3);
    const fewer = await session.selectLast(20);

    expect(lastOne.actualCount).toBe(1);
    expect(lastOne.commits[0]?.subject).toBe("newest");
    expect(lastThree.commits.map(({ subject }) => subject)).toEqual([
      "oldest",
      "middle",
      "newest",
    ]);
    expect(fewer.actualCount).toBe(3);
    expect(fewer.truncatedAtRoot).toBe(true);
  });

  it("selects a historical range and the same range through a revset", async () => {
    const session = await new JjClient(REPOSITORY).openReadSession();
    const history = await session.listHistory(3);
    const [oldest, middle] = history.commits;
    expect(oldest).toBeDefined();
    expect(middle).toBeDefined();

    const range = await session.selectRange(
      oldest?.changeId ?? "",
      middle?.changeId ?? "",
    );
    const revset = await session.selectRevset(
      `change_id("${oldest?.changeId ?? ""}")::change_id("${middle?.changeId ?? ""}")`,
      10,
    );

    expect(range.commits.map(({ subject }) => subject)).toEqual([
      "oldest",
      "middle",
    ]);
    expect(range.commits.some(({ currentWorkingCopy }) => currentWorkingCopy)).toBe(
      false,
    );
    expect(revset.changeIds).toEqual(range.changeIds);
  });

  it("reads operation data, Git diffs, metadata, and exact binary bytes", async () => {
    const session = await new JjClient(REPOSITORY).openReadSession();
    const selection = await session.selectLast(3);
    const diff = await session.diffGit(
      selection.baseCommitId,
      selection.headCommitId,
    );
    const files = await session.listFiles(selection.headCommitId);
    const hostilePath = "--config=evil;$(no-shell).bin";
    const bytes = await session.readFile(selection.headCommitId, hostilePath);

    expect(session.operation.id).toHaveLength(128);
    expect(diff.toString("utf8")).toContain("oldest.txt");
    expect(files.some(({ path: filePath }) => filePath === hostilePath)).toBe(true);
    expect(bytes).toEqual(Buffer.from([0, 1, 2, 3, 255]));
  });

  it("refreshes rewritten commits by stable full change ID without following a new child", async () => {
    const originalSession = await new JjClient(REPOSITORY).openReadSession();
    const original = await originalSession.selectLast(2);
    runJj([
      "describe",
      "--message",
      "middle rewritten",
      original.changeIds[0] ?? "",
    ]);
    runJj(["new", "--message", "unselected child"]);

    const refreshedSession = await new JjClient(REPOSITORY).openReadSession();
    const refreshed = await refreshedSession.resolveSelection(original.changeIds);

    expect(refreshed.changeIds).toEqual(original.changeIds);
    expect(refreshed.commits[0]?.subject).toBe("middle rewritten");
    expect(refreshed.commitIds).not.toEqual(original.commitIds);
    expect(refreshed.commits.at(-1)?.subject).toBe("newest");
  });

  it("explicitly extends a stored selection through new descendants at @", async () => {
    const originalSession = await new JjClient(REPOSITORY).openReadSession();
    const original = await originalSession.selectLast(1);
    runJj(["new", "--message", "feedback fix"]);

    const extendedSession = await new JjClient(REPOSITORY).openReadSession();
    const extended = await extendedSession.extendSelection(original.changeIds);

    expect(extended.changeIds.slice(0, original.changeIds.length)).toEqual(
      original.changeIds,
    );
    expect(extended.actualCount).toBe(original.actualCount + 1);
    expect(extended.commits.at(-1)?.subject).toBe("feedback fix");
    expect(extended.commits.at(-1)?.currentWorkingCopy).toBe(true);
  });

  it("reports a missing configured executable", async () => {
    await expect(
      new JjClient(REPOSITORY, {
        executable: `missing-jj-${crypto.randomUUID()}`,
      }).checkCapabilities(),
    ).rejects.toBeInstanceOf(JjExecutableNotFoundError);
  });
});
