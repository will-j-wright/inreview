import path from "node:path";
import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  preflightSnapshot,
  prepareSnapshot,
  type SnapshotReadSession,
} from "../../src/jj/snapshotBuilder";
import type {
  JjChangedFile,
  JjFile,
  JjFileProbe,
  JjOperation,
  ReviewSelection,
} from "../../src/jj/types";
import { BlobStore } from "../../src/storage";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const CHANGE = "k".repeat(32);
const OPERATION: JjOperation = {
  id: "a".repeat(128),
  parentIds: [],
  description: "test operation",
  timestamp: "2026-08-25T00:00:00Z",
  snapshot: true,
  root: false,
};
const SELECTION: ReviewSelection = {
  operationId: OPERATION.id,
  requestedCount: 1,
  actualCount: 1,
  truncatedAtRoot: false,
  commits: [
    {
      changeId: CHANGE,
      normalChangeId: "b".repeat(32),
      commitId: HEAD,
      parentCommitIds: [BASE],
      description: "change\n",
      subject: "change",
      conflict: false,
      divergent: false,
      root: false,
      currentWorkingCopy: true,
    },
  ],
  changeIds: [CHANGE],
  commitIds: [HEAD],
  baseCommitId: BASE,
  headCommitId: HEAD,
};

const usedRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...usedRoots].map(async (root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  usedRoots.clear();
});

class FakeSession implements SnapshotReadSession {
  public readonly operationId = OPERATION.id;
  public readonly operation = OPERATION;
  public readonly listCalls: {
    readonly commitId: string;
    readonly paths: readonly string[];
  }[] = [];
  public readonly readCalls: string[] = [];

  public constructor(
    private readonly patch: Buffer,
    private readonly changedFiles: readonly JjChangedFile[],
    private readonly files: ReadonlyMap<string, readonly JjFile[]>,
    private readonly contents: ReadonlyMap<string, Buffer> = new Map(),
    private readonly probes: ReadonlyMap<string, JjFileProbe> = new Map(),
  ) {}

  public diffGit(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.patch));
  }

  public listChangedFiles(): Promise<readonly JjChangedFile[]> {
    return Promise.resolve(this.changedFiles);
  }

  public listFiles(
    commitId: string,
    repositoryRelativePaths: readonly string[],
  ): Promise<readonly JjFile[]> {
    this.listCalls.push({ commitId, paths: [...repositoryRelativePaths] });
    const paths = new Set(repositoryRelativePaths);
    return Promise.resolve(
      (this.files.get(commitId) ?? []).filter((file) => paths.has(file.path)),
    );
  }

  public readFile(
    commitId: string,
    repositoryRelativePath: string,
  ): Promise<Buffer> {
    const key = `${commitId}\0${repositoryRelativePath}`;
    this.readCalls.push(key);
    const content = this.contents.get(key);
    if (content === undefined) {
      return Promise.reject(new Error(`Unexpected full read: ${key}`));
    }
    return Promise.resolve(Buffer.from(content));
  }

  public probeFile(
    commitId: string,
    repositoryRelativePath: string,
  ): Promise<JjFileProbe> {
    const key = `${commitId}\0${repositoryRelativePath}`;
    const configured = this.probes.get(key);
    if (configured !== undefined) {
      return Promise.resolve(configured);
    }
    const content = this.contents.get(key);
    if (content === undefined) {
      throw new Error(`Unexpected probe: ${key}`);
    }
    return Promise.resolve({
      prefix: content.subarray(0, 8192),
      byteLength: content.byteLength,
      containsNul: content.includes(0),
    });
  }
}

function file(pathValue: string, fileType: string): JjFile {
  return {
    path: pathValue,
    fileType,
    executable: false,
    conflict: fileType === "conflict",
  };
}

async function build(session: FakeSession) {
  const preflight = await preflightSnapshot(SELECTION, session);
  return await prepareSnapshot(SELECTION, session, {
    preflight,
    snapshotId: "44444444-4444-4444-8444-444444444444",
    capturedAt: "2026-08-25T00:00:00Z",
  });
}

describe("snapshot capture hardening", () => {
  it("round-trips CP1252 patch and body bytes without replacement corruption", async () => {
    const patch = Buffer.concat([
      Buffer.from(
        [
          "diff --git a/note.txt b/note.txt",
          "index 1111111..2222222 100644",
          "--- a/note.txt",
          "+++ b/note.txt",
          "@@ -1 +1 @@",
          "-plain",
          "+caf",
        ].join("\n"),
      ),
      Buffer.from([0xe9, 0x0a]),
    ]);
    const oldBody = Buffer.from("plain\n");
    const newBody = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    const changed: JjChangedFile = {
      status: "modified",
      originalPath: "note.txt",
      currentPath: "note.txt",
      oldFileType: "file",
      newFileType: "file",
    };
    const session = new FakeSession(
      patch,
      [changed],
      new Map([
        [BASE, [file("note.txt", "file")]],
        [HEAD, [file("note.txt", "file")]],
      ]),
      new Map([
        [`${BASE}\0note.txt`, oldBody],
        [`${HEAD}\0note.txt`, newBody],
      ]),
    );
    const prepared = await build(session);
    const entry = prepared.snapshot.views[0]?.files[0];
    expect(entry?.summary).toEqual({
      kind: "text",
      encoding: "windows-1252",
    });
    expect(entry?.hunks[0]?.lines[1]?.content).toBe("café");

    const root = path.resolve(".test-work", "snapshot-byte-roundtrip");
    usedRoots.add(root);
    const store = new BlobStore(root);
    await store.initialize();
    await prepared.persistBlobs(store);
    if (
      entry?.patch === null ||
      entry?.patch === undefined ||
      entry.modifiedContent === null
    ) {
      throw new Error("Expected patch and modified content references.");
    }
    expect(await store.get(entry.patch)).toEqual(patch);
    expect(await store.get(entry.modifiedContent)).toEqual(newBody);
  });

  it("stores only metadata for a binary larger than the old 64 MB limit", async () => {
    const patch = Buffer.from(
      [
        "diff --git a/huge.bin b/huge.bin",
        "new file mode 100644",
        "index 0000000..2222222",
        "Binary files /dev/null and b/huge.bin differ",
        "",
      ].join("\n"),
    );
    const size = 70 * 1024 * 1024;
    const session = new FakeSession(
      patch,
      [
        {
          status: "added",
          originalPath: null,
          currentPath: "huge.bin",
          oldFileType: null,
          newFileType: "file",
        },
      ],
      new Map([[HEAD, [file("huge.bin", "file")]]]),
      new Map(),
      new Map([
        [
          `${HEAD}\0huge.bin`,
          { prefix: Buffer.from([0]), byteLength: size, containsNul: true },
        ],
      ]),
    );

    const prepared = await build(session);
    const entry = prepared.snapshot.views[0]?.files[0];
    expect(entry).toMatchObject({
      kind: "binary",
      originalContent: null,
      modifiedContent: null,
      summary: {
        kind: "binary",
        originalByteLength: 0,
        modifiedByteLength: size,
      },
    });
    expect(session.readCalls).toEqual([]);
    expect(
      session.listCalls.every(({ paths }) =>
        paths.length === 1 && paths[0] === "huge.bin",
      ),
    ).toBe(true);
  });

  it("uses the unchanged symlink target for a pure rename counterpart", async () => {
    const patch = Buffer.from(
      [
        "diff --git a/old-link b/new-link",
        "similarity index 100%",
        "rename from old-link",
        "rename to new-link",
        "",
      ].join("\n"),
    );
    const target = Buffer.from("target/file");
    const session = new FakeSession(
      patch,
      [
        {
          status: "renamed",
          originalPath: "old-link",
          currentPath: "new-link",
          oldFileType: "symlink",
          newFileType: "symlink",
        },
      ],
      new Map([
        [BASE, [file("old-link", "symlink")]],
        [HEAD, [file("new-link", "symlink")]],
      ]),
      new Map([
        [`${BASE}\0old-link`, Buffer.alloc(0)],
        [`${HEAD}\0new-link`, target],
      ]),
    );

    const entry = (await build(session)).snapshot.views[0]?.files[0];
    expect(entry).toMatchObject({
      kind: "symbolic-link",
      status: "renamed",
      summary: {
        kind: "symbolic-link",
        originalTarget: "target/file",
        modifiedTarget: "target/file",
      },
      hunks: [],
      commentableRanges: [],
    });
  });

  it("summarizes a Git submodule without treating it as empty text", async () => {
    const patch = Buffer.from(
      [
        "diff --git a/vendor b/vendor",
        "new file mode 160000",
        "index 0000000..2222222",
        "",
      ].join("\n"),
    );
    const session = new FakeSession(
      patch,
      [
        {
          status: "added",
          originalPath: null,
          currentPath: "vendor",
          oldFileType: null,
          newFileType: "git-submodule",
        },
      ],
      new Map([[HEAD, [file("vendor", "git-submodule")]]]),
    );

    const entry = (await build(session)).snapshot.views[0]?.files[0];
    expect(entry).toMatchObject({
      kind: "non-regular",
      modifiedContent: null,
      hunks: [],
      commentableRanges: [],
      summary: {
        kind: "non-regular",
        originalType: null,
        modifiedType: "git-submodule",
      },
    });
    expect(session.readCalls).toEqual([]);
  });

  it("allows a selected change that resolves a conflict in its base", async () => {
    const patch = Buffer.from(
      [
        "diff --git a/resolved.txt b/resolved.txt",
        "index 1111111..2222222 100644",
        "--- a/resolved.txt",
        "+++ b/resolved.txt",
        "@@ -1 +1 @@",
        "-conflicted",
        "+resolved",
        "",
      ].join("\n"),
    );
    const session = new FakeSession(
      patch,
      [
        {
          status: "modified",
          originalPath: "resolved.txt",
          currentPath: "resolved.txt",
          oldFileType: "conflict",
          newFileType: "file",
        },
      ],
      new Map([
        [BASE, [file("resolved.txt", "conflict")]],
        [HEAD, [file("resolved.txt", "file")]],
      ]),
      new Map([
        [`${BASE}\0resolved.txt`, Buffer.from("conflicted\n")],
        [`${HEAD}\0resolved.txt`, Buffer.from("resolved\n")],
      ]),
    );

    await expect(build(session)).resolves.toBeDefined();
  });
});
