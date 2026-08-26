import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ReviewRecord } from "../../src/domain/comments";
import type {
  BlobReference,
  FileKind,
  FileManifestEntry,
  FileStatus,
  FileSummary,
  Snapshot,
} from "../../src/domain/review";
import {
  NativeDiffContent,
  NativeDiffError,
  summarizeNonTextFile,
} from "../../src/vscode/nativeDiffContent";
import {
  NativeDiffService,
  type NativeDiffVscodeApi,
} from "../../src/vscode/nativeDiffService";
import {
  InvalidVirtualDocumentUriError,
  MODIFIED_DOCUMENT_SCHEME,
  ORIGINAL_DOCUMENT_SCHEME,
  VirtualDocumentUriCodec,
  type UriFactory,
  type VirtualDocumentIdentity,
} from "../../src/vscode/virtualDocumentProvider";

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const ARCHIVED_REVIEW_ID = "22222222-2222-4222-8222-222222222222";
const CURRENT_ID = "33333333-3333-4333-8333-333333333333";
const HISTORICAL_ID = "44444444-4444-4444-8444-444444444444";
const CHANGE_ID = "change-one";
const uriFactory: UriFactory = {
  from: (components) =>
    ({
      ...components,
      query: "",
      fragment: "",
    }) as never,
};

interface Fixture {
  readonly record: ReviewRecord;
  readonly contents: Map<string, Buffer>;
}

describe("virtual native diff URIs", () => {
  const codec = new VirtualDocumentUriCodec("stable-test-key", uriFactory);
  const identity: VirtualDocumentIdentity = {
    reviewId: REVIEW_ID,
    snapshotId: CURRENT_ID,
    view: { mode: "per-change", changeId: CHANGE_ID },
    fileId: "rename",
    side: "modified",
    repositoryPath: "src/new name.ts",
    readOnly: false,
  };

  it("round-trips every target field with a path-like suffix", () => {
    const uri = codec.encode(identity);
    expect(uri.scheme).toBe(MODIFIED_DOCUMENT_SCHEME);
    expect(uri.path).toBe("/src/new name.ts");
    expect(uri.authority).not.toContain(REVIEW_ID);
    expect(codec.decode(uri)).toEqual(identity);
    expect(
      codec.decode(codec.encode({ ...identity, side: "original" })).side,
    ).toBe("original");
  });

  it.each([
    ["changed signature", (uri: TestUri) => ({ ...uri, authority: `${uri.authority}0` })],
    ["changed path", (uri: TestUri) => ({ ...uri, path: "/src/other.ts" })],
    ["wrong scheme", (uri: TestUri) => ({ ...uri, scheme: "file" })],
    ["query", (uri: TestUri) => ({ ...uri, query: "token=secret" })],
    ["fragment", (uri: TestUri) => ({ ...uri, fragment: "changed" })],
    ["malformed authority", (uri: TestUri) => ({ ...uri, authority: "v2.bad" })],
  ])("rejects a %s URI", (_name, mutate) => {
    const uri = codec.encode(identity) as unknown as TestUri;
    expect(() => codec.decode(mutate(uri) as never)).toThrow(
      InvalidVirtualDocumentUriError,
    );
  });

  it.each(["/../secret.ts", "/src/../../secret.ts", "/C:/secret.ts", "/src\\secret.ts"])(
    "rejects traversal or an absolute path: %s",
    (path) => {
      const uri = codec.encode(identity) as unknown as TestUri;
      expect(() => codec.decode({ ...uri, path } as never)).toThrow(
        InvalidVirtualDocumentUriError,
      );
    },
  );
});

describe("native diff content", () => {
  it("resolves combined, per-change, current, archived, and historical targets", async () => {
    const fixture = buildFixture();
    const archived = buildFixture(ARCHIVED_REVIEW_ID, "archived").record;
    const content = makeContent(fixture, archived);

    const combined = await content.resolve(request("modified"));
    expect(combined.snapshot.id).toBe(CURRENT_ID);
    expect(combined.view.identity).toEqual({ mode: "combined" });
    expect(combined.title).toContain("Combined — Current");

    const perChange = await content.resolve({
      ...request("modified"),
      view: { mode: "per-change", changeId: CHANGE_ID },
    });
    expect(perChange.title).toContain("Change change-one — Current");

    const historical = await content.resolve({
      ...request("modified"),
      snapshotId: HISTORICAL_ID,
    });
    expect(historical.title).toContain("Historical 2026-08-24T00:00:00.000Z");

    const archivedTarget = await content.resolve({
      ...request("modified"),
      reviewId: ARCHIVED_REVIEW_ID,
    });
    expect(archivedTarget.title).toContain("Archived");
  });

  it.each([
    ["added", "original", ""],
    ["deleted", "modified", ""],
    ["modified", "original", "before\r\n"],
    ["modified", "modified", "after\r\n"],
    ["renamed", "original", "old name\n"],
    ["renamed", "modified", "new name\n"],
    ["copied", "original", "copy source\n"],
    ["copied", "modified", "copy target\n"],
  ] as const)(
    "reads %s %s text with the correct empty side and stored line endings",
    async (fileId, side, expected) => {
      const fixture = buildFixture();
      const content = makeContent(fixture);
      const resolved = await content.resolve(request(fileId));
      const identity = side === "original" ? resolved.original : resolved.modified;
      expect(await content.readDocument(identity)).toBe(expected);
    },
  );

  it("uses the snapshot CP1252 fallback for invalid UTF-8", async () => {
    const fixture = buildFixture();
    const content = makeContent(fixture);
    const resolved = await content.resolve(request("added"));
    expect(await content.readDocument(resolved.modified)).toBe("café\r\n");
  });

  it("uses each path of a rename in its original and modified URI", async () => {
    const resolved = await makeContent(buildFixture()).resolve(request("renamed"));
    expect(resolved.original.repositoryPath).toBe("src/old-name.ts");
    expect(resolved.modified.repositoryPath).toBe("src/new-name.ts");
    expect(resolved.title).toContain(
      "src/old-name.ts → src/new-name.ts",
    );
  });

  it.each([
    ["binary", "Binary", "Original size: 3 bytes", "Modified size: 5 bytes"],
    [
      "link",
      "Symbolic link",
      'Original target: "safe-old"',
      'Modified target: "unsafe\\nvalue"',
    ],
    [
      "special",
      "Non-regular entry",
      'Original type: "submodule"',
      'Modified type: "tree"',
    ],
  ] as const)(
    "returns a safe %s summary without reading content blobs",
    async (fileId, kind, firstMetadata, secondMetadata) => {
      const fixture = buildFixture();
      const get = vi.fn((reference: BlobReference) => {
        const value = fixture.contents.get(reference.sha256);
        if (value === undefined) {
          return Promise.reject(new Error("missing"));
        }
        return Promise.resolve(value);
      });
      const content = new NativeDiffContent(
        { getReview: () => Promise.resolve(fixture.record) },
        { get },
      );
      const resolved = await content.resolve(request(fileId));
      const display = await content.readDocument(resolved.modified);
      expect(display).toContain(`Kind: ${kind}`);
      expect(display).toContain(firstMetadata);
      expect(display).toContain(secondMetadata);
      expect(display).not.toContain("\nvalue\n");
      expect(get).not.toHaveBeenCalled();
    },
  );

  it("reports missing snapshots, views, files, blobs, and mismatched URI paths", async () => {
    const fixture = buildFixture();
    const content = makeContent(fixture);
    await expect(
      content.resolve({ ...request("modified"), snapshotId: "missing" }),
    ).rejects.toMatchObject({ code: "snapshot-not-found" });
    await expect(
      content.resolve({
        ...request("modified"),
        view: { mode: "per-change", changeId: "missing" },
      }),
    ).rejects.toMatchObject({ code: "view-not-found" });
    await expect(content.resolve(request("missing"))).rejects.toMatchObject({
      code: "file-not-found",
    });

    const resolved = await content.resolve(request("modified"));
    await expect(
      content.readDocument({
        ...resolved.modified,
        repositoryPath: "wrong.ts",
      }),
    ).rejects.toMatchObject({ code: "uri-target-mismatch" });

    fixture.contents.delete(referenceFor("after\r\n").sha256);
    await expect(content.readDocument(resolved.modified)).rejects.toThrow(
      "Blob content is missing.",
    );
  });

  it("rejects malformed reveal requests with a typed, user-facing error", async () => {
    const content = makeContent(buildFixture());
    const error = await content
      .resolve({ ...request("modified"), extra: true })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(NativeDiffError);
    if (!(error instanceof NativeDiffError)) {
      throw new Error("Expected a native diff error.");
    }
    expect(error.code).toBe("invalid-request");
    expect(error.message).toContain("Refresh the InReview view");
  });

  it("keeps summaries bounded and does not dump metadata as raw lines", () => {
    const fixture = buildFixture();
    const link = currentSnapshot(fixture.record).views[0]?.files.find(
      ({ fileId }) => fileId === "link",
    );
    if (link === undefined) {
      throw new Error("Missing symbolic-link fixture.");
    }
    const summary = summarizeNonTextFile({
      ...link,
      summary: {
        kind: "symbolic-link",
        originalTarget: "a".repeat(3_000),
        modifiedTarget: "\u001b[31m\nspoof",
      },
    });
    expect(summary.length).toBeLessThan(5_000);
    expect(summary).toContain("\\u001b[31m\\nspoof");
    expect(summary).not.toContain("\nspoof\n");
  });
});

describe("native diff VS Code adapter", () => {
  it("registers both immutable providers, executes vscode.diff, and disposes", async () => {
    const fixture = buildFixture();
    const providers = new Map<string, unknown>();
    const disposed: string[] = [];
    const executeCommand = vi.fn<
      NativeDiffVscodeApi["commands"]["executeCommand"]
    >(() => Promise.resolve(undefined));
    const api: NativeDiffVscodeApi = {
      Uri: uriFactory,
      workspace: {
        registerTextDocumentContentProvider: (scheme, provider) => {
          providers.set(scheme, provider);
          return { dispose: () => disposed.push(scheme) };
        },
      },
      commands: { executeCommand },
    };
    const service = new NativeDiffService({
      reviews: { getReview: () => Promise.resolve(fixture.record) },
      blobs: blobReader(fixture),
      signingKey: "stable-test-key",
      vscode: api,
    });

    await service.revealFile(request("renamed"));
    expect([...providers.keys()]).toEqual([
      ORIGINAL_DOCUMENT_SCHEME,
      MODIFIED_DOCUMENT_SCHEME,
    ]);
    expect(executeCommand).toHaveBeenCalledOnce();
    const call = executeCommand.mock.calls[0];
    if (call === undefined) {
      throw new Error("The diff command was not called.");
    }
    const [command, original, modified, title, options] =
      call;
    expect(command).toBe("vscode.diff");
    expect((original as TestUri).scheme).toBe(ORIGINAL_DOCUMENT_SCHEME);
    expect((modified as TestUri).scheme).toBe(MODIFIED_DOCUMENT_SCHEME);
    expect(title).toContain("Combined — Current");
    expect(options).toEqual({ preview: false });

    service.dispose();
    service.dispose();
    expect(disposed).toEqual([
      MODIFIED_DOCUMENT_SCHEME,
      ORIGINAL_DOCUMENT_SCHEME,
    ]);
    await expect(service.revealFile(request("renamed"))).rejects.toThrow(
      "service is closed",
    );
  });
});

interface TestUri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
}

function makeContent(
  fixture: Fixture,
  archived?: ReviewRecord,
): NativeDiffContent {
  return new NativeDiffContent(
    {
      getReview: (reviewId) => {
        if (reviewId === fixture.record.review.id) {
          return Promise.resolve(fixture.record);
        }
        if (archived?.review.id === reviewId) {
          return Promise.resolve(archived);
        }
        return Promise.reject(new Error("Review is missing."));
      },
    },
    blobReader(fixture),
  );
}

function blobReader(fixture: Fixture) {
  return {
    get: (reference: BlobReference): Promise<Buffer> => {
      const value = fixture.contents.get(reference.sha256);
      if (value === undefined) {
        return Promise.reject(new Error("Blob content is missing."));
      }
      return Promise.resolve(Buffer.from(value));
    },
  };
}

function request(fileId: string) {
  return {
    reviewId: REVIEW_ID,
    snapshotId: CURRENT_ID,
    view: { mode: "combined" } as const,
    fileId,
    readOnly: false,
  };
}

function buildFixture(
  reviewId = REVIEW_ID,
  state: "active" | "archived" = "active",
): Fixture {
  const contents = new Map<string, Buffer>();
  const textFile = (
    fileId: string,
    status: FileStatus,
    originalPath: string | null,
    currentPath: string | null,
    original: Buffer | null,
    modified: Buffer | null,
  ): FileManifestEntry => ({
    fileId,
    status,
    kind: "text",
    originalPath,
    currentPath,
    originalContent: store(contents, original),
    modifiedContent: store(contents, modified),
    patch: null,
    hunks: [],
    addedLines: modified === null ? 0 : 1,
    deletedLines: original === null ? 0 : 1,
    summary: {
      kind: "text",
      encoding:
        original?.includes(0xe9) === true || modified?.includes(0xe9) === true
          ? "windows-1252"
          : "utf-8",
    },
  });
  const files: FileManifestEntry[] = [
    textFile(
      "added",
      "added",
      null,
      "notes/café.txt",
      null,
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a]),
    ),
    textFile(
      "deleted",
      "deleted",
      "deleted.ts",
      null,
      Buffer.from("removed\n"),
      null,
    ),
    textFile(
      "modified",
      "modified",
      "modified.ts",
      "modified.ts",
      Buffer.from("before\r\n"),
      Buffer.from("after\r\n"),
    ),
    textFile(
      "renamed",
      "renamed",
      "src/old-name.ts",
      "src/new-name.ts",
      Buffer.from("old name\n"),
      Buffer.from("new name\n"),
    ),
    textFile(
      "copied",
      "copied",
      "src/source.ts",
      "src/copy.ts",
      Buffer.from("copy source\n"),
      Buffer.from("copy target\n"),
    ),
    metadataFile("binary", "modified", "binary", {
      kind: "binary",
      originalByteLength: 3,
      modifiedByteLength: 5,
    }),
    metadataFile("link", "renamed", "symbolic-link", {
      kind: "symbolic-link",
      originalTarget: "safe-old",
      modifiedTarget: "unsafe\nvalue",
    }),
    metadataFile("special", "modified", "non-regular", {
      kind: "non-regular",
      originalType: "submodule",
      modifiedType: "tree",
    }),
  ];
  const current = snapshot(CURRENT_ID, "2026-08-25T00:00:00.000Z", files);
  const historical = snapshot(
    HISTORICAL_ID,
    "2026-08-24T00:00:00.000Z",
    files,
  );
  const record: ReviewRecord = {
    review: {
      id: reviewId,
      name: state === "active" ? "Working review" : "Archived review",
      state,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      archivedAt:
        state === "archived" ? "2026-08-25T00:00:00.000Z" : null,
      repositoryFingerprint: "a".repeat(64),
      requestedChangeCount: 1,
      orderedChangeIds: [CHANGE_ID],
      currentSnapshotId: CURRENT_ID,
      snapshotIds: [HISTORICAL_ID, CURRENT_ID],
      counts: { open: 0, outdated: 0, resolved: 0 },
    },
    snapshots: [historical, current],
    threads: [],
  };
  return { record, contents };
}

function snapshot(
  id: string,
  capturedAt: string,
  files: readonly FileManifestEntry[],
): Snapshot {
  const views = [
    {
      identity: { mode: "combined" } as const,
      baseCommitId: "base",
      headCommitId: "head",
      files: [...files],
      changedLineCount: 10,
    },
    {
      identity: { mode: "per-change", changeId: CHANGE_ID } as const,
      baseCommitId: "base",
      headCommitId: "head",
      files: [...files],
      changedLineCount: 10,
    },
  ];
  return {
    id,
    capturedAt,
    operationId: "operation",
    orderedChangeIds: [CHANGE_ID],
    changes: [
      {
        changeId: CHANGE_ID,
        commitId: "head",
        parentCommitId: "base",
        description: "Test change",
      },
    ],
    baseCommitId: "base",
    headCommitId: "head",
    views,
  };
}

function metadataFile(
  fileId: string,
  status: FileStatus,
  kind: Exclude<FileKind, "text">,
  summary: FileSummary,
): FileManifestEntry {
  return {
    fileId,
    status,
    kind,
    originalPath: `old/${fileId}.dat`,
    currentPath: `new/${fileId}.dat`,
    originalContent: null,
    modifiedContent: null,
    patch: null,
    hunks: [],
    addedLines: 0,
    deletedLines: 0,
    summary,
  };
}

function store(
  contents: Map<string, Buffer>,
  value: Buffer | null,
): BlobReference | null {
  if (value === null) {
    return null;
  }
  const reference = referenceFor(value);
  contents.set(reference.sha256, Buffer.from(value));
  return reference;
}

function referenceFor(value: string | Buffer): BlobReference {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    byteLength: buffer.byteLength,
    encoding: "gzip",
  };
}

function currentSnapshot(record: ReviewRecord): Snapshot {
  const value = record.snapshots.find(
    ({ id }) => id === record.review.currentSnapshotId,
  );
  if (value === undefined) {
    throw new Error("Missing current snapshot.");
  }
  return value;
}
