import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ReviewService } from "../../src/review";

const workRoot = path.resolve("test", ".review-lifecycle-work");
const repositoryRoot = path.join(workRoot, "repo");
const storageRoot = path.join(workRoot, "storage");
const nestedPath = path.join(repositoryRoot, "nested");
const userConfig = [
  "--config",
  "user.name=InReview Lifecycle Test",
  "--config",
  "user.email=inreview-lifecycle@example.invalid",
] as const;

function jjAvailable(): boolean {
  return spawnSync("jj", ["--version"], {
    shell: false,
    stdio: "ignore",
  }).status === 0;
}

function runJj(args: readonly string[]): void {
  const result = spawnSync(
    "jj",
    [...userConfig, "--repository", repositoryRoot, ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}

describe.skipIf(!jjAvailable())("review lifecycle integration", () => {
  beforeAll(async () => {
    await fs.rm(workRoot, { recursive: true, force: true });
    await fs.mkdir(nestedPath, { recursive: true });
    const initialized = spawnSync(
      "jj",
      ["git", "init", "--colocate", repositoryRoot],
      {
        encoding: "utf8",
        shell: false,
      },
    );
    if (initialized.status !== 0) {
      throw new Error(initialized.stderr);
    }
    await fs.writeFile(path.join(repositoryRoot, "review.txt"), "first\n");
    runJj(["describe", "--message", "Selected change"]);
  });

  afterAll(async () => {
    await fs.rm(workRoot, { recursive: true, force: true });
  });

  it("resolves the canonical root and refreshes only the stored full change ID", async () => {
    const service = await ReviewService.create({
      repositoryPath: nestedPath,
      environment: "integration-test",
      storageRoot,
      clock: () => new Date("2026-08-25T20:00:00.000Z"),
    });
    try {
      const started = await service.startReview({ requestedChangeCount: 1 });
      const selectedChangeId = started.record.review.orderedChangeIds[0];
      const oldCommitId =
        started.record.snapshots[0]?.changes[0]?.commitId;
      if (selectedChangeId === undefined) {
        throw new Error("The test review has no selected change.");
      }

      runJj([
        "describe",
        "--message",
        "Selected change rewritten",
        selectedChangeId,
      ]);
      runJj(["new", "--message", "Unselected child"]);
      const refreshed = await service.refreshReview();

      expect(refreshed.changed).toBe(true);
      expect(refreshed.record.review.orderedChangeIds).toEqual([
        selectedChangeId,
      ]);
      expect(
        refreshed.record.snapshots.at(-1)?.changes[0]?.subject,
      ).toBe("Selected change rewritten");
      expect(
        refreshed.record.snapshots.at(-1)?.changes[0]?.commitId,
      ).not.toBe(oldCommitId);
      expect(path.resolve(service.canonicalRepositoryRoot)).toBe(
        path.resolve(repositoryRoot),
      );
    } finally {
      await service.close();
    }
  });

  it("adds a new descendant change to the active review", async () => {
    const service = await ReviewService.create({
      repositoryPath: nestedPath,
      environment: "integration-extend-test",
      storageRoot,
      clock: () => new Date("2026-08-25T20:00:00.000Z"),
    });
    try {
      const started = await service.startReview({ requestedChangeCount: 1 });
      runJj(["new", "--message", "Agent feedback fix"]);
      await fs.writeFile(path.join(repositoryRoot, "review.txt"), "fixed\n");

      const extended = await service.includeNewChanges();

      expect(extended.addedChangeCount).toBe(1);
      expect(extended.record.review.orderedChangeIds).toHaveLength(
        started.record.review.orderedChangeIds.length + 1,
      );
      expect(extended.record.snapshots.at(-1)?.changes.at(-1)?.subject).toBe(
        "Agent feedback fix",
      );
    } finally {
      await service.close();
    }
  });
});
