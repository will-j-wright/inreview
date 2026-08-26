import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  captureSnapshot,
  JjClient,
  preflightSnapshot,
  prepareSnapshot,
  shouldWarnForChangedLines,
  type ReviewSelection,
} from "../../src/jj";
import { BlobStore } from "../../src/storage";

const WORK_ROOT = path.resolve("test", ".snapshot-capture-work");
const REPOSITORY = path.join(WORK_ROOT, "repo");
const BLOB_ROOT = path.join(WORK_ROOT, "blobs");
const FAILURE_BLOB_ROOT = path.join(WORK_ROOT, "failure-blobs");
const USER_CONFIG = [
  "--config",
  "user.name=InReview Snapshot Test",
  "--config",
  "user.email=inreview-snapshot@example.invalid",
] as const;

let symbolicLinkCreated = false;

function jjAvailable(): boolean {
  return spawnSync("jj", ["--version"], {
    shell: false,
    stdio: "ignore",
  }).status === 0;
}

function runJj(args: readonly string[]): void {
  const result = spawnSync(
    "jj",
    [...USER_CONFIG, "--repository", REPOSITORY, ...args],
    {
      cwd: REPOSITORY,
      encoding: "utf8",
      shell: false,
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}

describe.skipIf(!jjAvailable())("snapshot capture integration", () => {
  let selection: ReviewSelection;

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

    await Promise.all([
      fs.writeFile(path.join(REPOSITORY, "keep.txt"), "alpha\n"),
      fs.writeFile(path.join(REPOSITORY, "gone.txt"), "delete me\n"),
      fs.writeFile(path.join(REPOSITORY, "old name.txt"), "rename me\n"),
      fs.writeFile(path.join(REPOSITORY, "script.sh"), "#!/bin/sh\necho base\n"),
      fs.writeFile(path.join(REPOSITORY, "empty.txt"), ""),
      fs.writeFile(
        path.join(REPOSITORY, "legacy.txt"),
        Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
      ),
    ]);
    runJj(["describe", "--message", "base"]);
    runJj(["new"]);

    await fs.writeFile(path.join(REPOSITORY, "keep.txt"), "alpha\nbeta\n");
    await fs.writeFile(
      path.join(REPOSITORY, "legacy.txt"),
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x0a]),
    );
    await fs.writeFile(path.join(REPOSITORY, "script.sh"), "#!/bin/sh\necho oldest\n");
    runJj(["file", "chmod", "x", "script.sh"]);
    runJj(["describe", "--message", "oldest selected"]);
    runJj(["new"]);

    await fs.rm(path.join(REPOSITORY, "gone.txt"));
    await fs.rename(
      path.join(REPOSITORY, "old name.txt"),
      path.join(REPOSITORY, "new name.txt"),
    );
    await fs.writeFile(
      path.join(REPOSITORY, "binary data.bin"),
      Buffer.from([0, 1, 2, 3, 255]),
    );
    await fs.writeFile(path.join(REPOSITORY, "no-newline.txt"), "last line");
    try {
      await fs.symlink("keep.txt", path.join(REPOSITORY, "keep-link"));
      symbolicLinkCreated = true;
    } catch {
      symbolicLinkCreated = false;
    }
    runJj(["describe", "--message", "newest selected"]);

    const session = await new JjClient(REPOSITORY).openReadSession();
    selection = await session.selectLast(2);
  });

  afterAll(async () => {
    await fs.rm(WORK_ROOT, { recursive: true, force: true });
  });

  it("preflights and captures coherent combined and per-change views", async () => {
    const session = await new JjClient(REPOSITORY).openReadSession();
    selection = await session.resolveSelection(selection.changeIds);
    const preflight = await preflightSnapshot(selection, session, {
      maxConcurrency: 2,
    });

    expect(preflight.operationId).toBe(session.operationId);
    expect(preflight.views).toHaveLength(3);
    expect(preflight.views[0]).toMatchObject({
      identity: { mode: "combined" },
      baseCommitId: selection.baseCommitId,
      headCommitId: selection.headCommitId,
    });
    expect(preflight.combinedChangedLineCount).toBeGreaterThan(0);
    expect(shouldWarnForChangedLines(preflight, 0)).toBe(true);
    expect(
      shouldWarnForChangedLines(preflight, preflight.combinedChangedLineCount),
    ).toBe(false);

    const store = new BlobStore(BLOB_ROOT);
    await store.initialize();
    const snapshot = await captureSnapshot(selection, session, store, {
      preflight,
      maxConcurrency: 2,
      snapshotId: "11111111-1111-4111-8111-111111111111",
      capturedAt: "2026-08-25T12:00:00.000Z",
    });

    expect(snapshot.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(snapshot.operation).toEqual(session.operation);
    expect(snapshot.orderedChangeIds).toEqual(selection.changeIds);
    expect(snapshot.changes.map(({ commitId }) => commitId)).toEqual(
      selection.commitIds,
    );
    expect(snapshot.baseCommitId).toBe(selection.baseCommitId);
    expect(snapshot.headCommitId).toBe(selection.headCommitId);

    const combined = snapshot.views[0];
    expect(combined?.changedLineCount).toBe(preflight.combinedChangedLineCount);
    const statuses = new Map(
      combined?.files.map((file) => [
        file.currentPath ?? file.originalPath ?? "",
        file.status,
      ]),
    );
    expect(statuses.get("keep.txt")).toBe("modified");
    expect(statuses.get("gone.txt")).toBe("deleted");
    expect(statuses.get("new name.txt")).toBe("renamed");
    expect(statuses.get("binary data.bin")).toBe("added");

    const keep = combined?.files.find(({ currentPath }) => currentPath === "keep.txt");
    const deleted = combined?.files.find(
      ({ originalPath }) => originalPath === "gone.txt",
    );
    const renamed = combined?.files.find(
      ({ currentPath }) => currentPath === "new name.txt",
    );
    const binary = combined?.files.find(
      ({ currentPath }) => currentPath === "binary data.bin",
    );
    const legacy = combined?.files.find(
      ({ currentPath }) => currentPath === "legacy.txt",
    );
    expect(keep?.kind).toBe("text");
    expect(keep?.commentableRanges?.length).toBeGreaterThan(0);
    expect(deleted).toMatchObject({
      status: "deleted",
      currentPath: null,
      kind: "text",
      commentableRanges: [],
    });
    expect(renamed).toMatchObject({
      status: "renamed",
      originalPath: "old name.txt",
      currentPath: "new name.txt",
    });
    expect(binary).toMatchObject({
      kind: "binary",
      hunks: [],
      commentableRanges: [],
    });
    expect(legacy).toMatchObject({
      kind: "text",
      summary: { kind: "text", encoding: "windows-1252" },
    });
    expect(
      legacy?.hunks.some(({ lines }) =>
        lines.some(({ content }) => content.includes("–")),
      ),
    ).toBe(true);

    if (
      keep?.originalContent === null ||
      keep?.originalContent === undefined ||
      keep.modifiedContent === null ||
      deleted?.originalContent === null ||
      deleted?.originalContent === undefined ||
      deleted.modifiedContent === null ||
      renamed?.originalContent === null ||
      renamed?.originalContent === undefined ||
      renamed.modifiedContent === null ||
      binary === undefined
      || legacy?.modifiedContent === null
      || legacy?.modifiedContent === undefined
      || legacy.patch === null
    ) {
      throw new Error("The snapshot did not retain the expected content references.");
    }
    expect(await store.get(keep.originalContent)).toEqual(Buffer.from("alpha\n"));
    expect(await store.get(keep.modifiedContent)).toEqual(
      Buffer.from("alpha\nbeta\n"),
    );
    expect(await store.get(deleted.originalContent)).toEqual(
      Buffer.from("delete me\n"),
    );
    expect(await store.get(deleted.modifiedContent)).toEqual(Buffer.alloc(0));
    expect(await store.get(renamed.originalContent)).toEqual(
      Buffer.from("rename me\n"),
    );
    expect(await store.get(renamed.modifiedContent)).toEqual(
      Buffer.from("rename me\n"),
    );
    expect(binary.modifiedContent).toBeNull();
    expect(binary.summary).toEqual({
      kind: "binary",
      originalByteLength: 0,
      modifiedByteLength: 5,
    });
    expect(await store.get(legacy.modifiedContent)).toEqual(
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x0a]),
    );
    expect((await store.get(legacy.patch)).includes(Buffer.from([0xe9]))).toBe(
      true,
    );
    expect(
      (await store.get(legacy.patch)).includes(Buffer.from([0xef, 0xbf, 0xbd])),
    ).toBe(false);

    if (symbolicLinkCreated) {
      const link = combined?.files.find(({ currentPath }) => currentPath === "keep-link");
      expect(link).toMatchObject({
        kind: "symbolic-link",
        summary: {
          kind: "symbolic-link",
          originalTarget: null,
          modifiedTarget: "keep.txt",
        },
        hunks: [],
        commentableRanges: [],
      });
    }
  });

  it("keeps prepared snapshots uncommitted and publishes no blobs after capture failure", async () => {
    const session = await new JjClient(REPOSITORY).openReadSession();
    const current = await session.resolveSelection(selection.changeIds);
    const preflight = await preflightSnapshot(current, session);
    const store = new BlobStore(FAILURE_BLOB_ROOT);
    await store.initialize();

    const prepared = await prepareSnapshot(current, session, {
      preflight,
      snapshotId: "22222222-2222-4222-8222-222222222222",
      capturedAt: "2026-08-25T12:00:00.000Z",
    });
    expect(prepared.snapshot.views).toHaveLength(3);
    expect(await fs.readdir(FAILURE_BLOB_ROOT)).toEqual([]);

    await expect(
      captureSnapshot(current, session, store, {
        preflight,
        snapshotId: "not-a-uuid",
      }),
    ).rejects.toThrow();
    expect(await fs.readdir(FAILURE_BLOB_ROOT)).toEqual([]);
  });
});
