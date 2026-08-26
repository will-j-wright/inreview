import { describe, expect, it } from "vitest";

import {
  JjAmbiguousChangeError,
  JjClient,
  JjCommandError,
  JjConflictError,
  JjInvalidOutputError,
  JjInvalidRepositoryError,
  JjMergeError,
  JjSelectionError,
  JjStaleSelectionError,
  JjUnsupportedVersionError,
  exactRootFileset,
  type JjCommandExecutor,
  type ProcessRequest,
  type ProcessResult,
} from "../../src/jj";
import { DIFF_FILE_JSON_TEMPLATE } from "../../src/jj/jjTemplates";

const OPERATION_ID = "a".repeat(128);
const ROOT_COMMIT_ID = "0".repeat(40);
const OPERATION = {
  id: OPERATION_ID,
  parentIds: ["b".repeat(128)],
  description: "snapshot working copy",
  timestamp: "2026-08-25T00:00:00Z",
  snapshot: true,
  root: false,
};

class FakeExecutor implements JjCommandExecutor {
  public readonly requests: ProcessRequest[] = [];
  private readonly results: (ProcessResult | Error)[];

  public constructor(...results: (ProcessResult | Error)[]) {
    this.results = results;
  }

  public execute(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    const result = this.results.shift();
    if (result === undefined) {
      return Promise.reject(new Error("No fake result was queued."));
    }
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    return Promise.resolve(result);
  }
}

function ok(stdout: string | Buffer): ProcessResult {
  return {
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    exitCode: 0,
  };
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function commit(
  sequence: number,
  parentCommitId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const letter = String.fromCharCode("k".charCodeAt(0) + sequence);
  return {
    changeId: letter.repeat(32),
    normalChangeId: sequence.toString(16).padStart(32, "0"),
    commitId: sequence.toString(16).padStart(40, "0"),
    parentCommitIds: [parentCommitId],
    description: `change ${String(sequence)}\nbody\n`,
    subject: `change ${String(sequence)}`,
    conflict: false,
    divergent: false,
    root: false,
    currentWorkingCopy: false,
    ...overrides,
  };
}

function clientWithSession(
  ...results: (ProcessResult | Error)[]
): { client: JjClient; executor: FakeExecutor } {
  const executor = new FakeExecutor(
    ok("jj 0.44.0-af45d57\n"),
    ok(jsonLine(OPERATION)),
    ...results,
  );
  return {
    client: new JjClient("C:\\repo with spaces", {
      executable: "configured-jj",
      executor,
    }),
    executor,
  };
}

describe("JjClient", () => {
  it("discovers a suffixed 0.44 version and snapshots once before fixed-operation reads", async () => {
    const first = commit(1, ROOT_COMMIT_ID, { currentWorkingCopy: true });
    const { client, executor } = clientWithSession(ok(jsonLine(first)));

    const session = await client.openReadSession();
    const selection = await session.selectLast(1);

    expect(selection.changeIds).toEqual([first.changeId]);
    expect(selection.baseCommitId).toBe(ROOT_COMMIT_ID);
    expect(executor.requests[0]?.args).toEqual(["--version"]);
    expect(executor.requests[1]?.args).not.toContain("--at-operation");
    expect(executor.requests[2]?.args).toContain(OPERATION_ID);
    expect(executor.requests[2]?.args).toContain("ancestors(@, 1)");
    expect(executor.requests.every((request) => request.executable === "configured-jj")).toBe(true);
    expect(executor.requests[1]?.args).toContain("--no-pager");
    expect(executor.requests[1]?.args).toContain("never");
  });

  it("rejects jj versions older than 0.44", async () => {
    const executor = new FakeExecutor(ok("jj 0.43.9\n"));
    const client = new JjClient("C:\\repo", { executor });

    await expect(client.checkCapabilities()).rejects.toMatchObject({
      constructor: JjUnsupportedVersionError,
      supportedRange: "jj 0.44 or later",
    });
  });

  it("accepts future minor versions and development suffixes", async () => {
    const executor = new FakeExecutor(ok("jj 0.99.0-dev.1\n"));
    const client = new JjClient("C:\\repo", { executor });

    await expect(client.checkCapabilities()).resolves.toMatchObject({
      version: { major: 0, minor: 99, patch: 0 },
    });
  });

  it("maps an initial repository command failure to an invalid repository", async () => {
    const { client } = clientWithSession();
    const executor = new FakeExecutor(
      ok("jj 0.44.0\n"),
      new Error("not a repository"),
    );
    const directClient = new JjClient("C:\\missing", { executor });

    await expect(directClient.openReadSession()).rejects.toThrow(
      "not a repository",
    );

    const commandFailure = new (await import("../../src/jj")).JjCommandError(
      "jj",
      [],
      1,
      "There is no jj repo",
    );
    const mapped = new JjClient("C:\\missing", {
      executor: new FakeExecutor(ok("jj 0.44.0\n"), commandFailure),
    });
    await expect(mapped.openReadSession()).rejects.toBeInstanceOf(
      JjInvalidRepositoryError,
    );
    expect(client.repository).toContain("repo with spaces");
  });

  it("does not mask a repository command failure as a non-repository folder", async () => {
    const commandFailure = new JjCommandError(
      "jj",
      ["root"],
      1,
      "Error: Failed to load the repository configuration",
    );
    const client = new JjClient("C:\\repo", {
      executor: new FakeExecutor(ok("jj 0.44.0\n"), commandFailure),
    });

    await expect(client.resolveRepositoryRoot()).rejects.toBe(commandFailure);
  });

  it("rejects malformed machine-readable output", async () => {
    const executor = new FakeExecutor(ok("jj 0.44.0\n"), ok("not-json\n"));
    const client = new JjClient("C:\\repo", { executor });

    await expect(client.openReadSession()).rejects.toBeInstanceOf(
      JjInvalidOutputError,
    );
  });

  it("selects a contiguous stack oldest-to-newest and reports root truncation", async () => {
    const first = commit(1, ROOT_COMMIT_ID);
    const second = commit(2, first.commitId as string, {
      currentWorkingCopy: true,
    });
    const root = {
      ...commit(0, ""),
      changeId: "z".repeat(32),
      commitId: ROOT_COMMIT_ID,
      parentCommitIds: [],
      root: true,
    };
    const { client } = clientWithSession(
      ok([jsonLine(root), jsonLine(first), jsonLine(second)].join("")),
    );

    const selection = await (await client.openReadSession()).selectLast(5);

    expect(selection.actualCount).toBe(2);
    expect(selection.truncatedAtRoot).toBe(true);
    expect(selection.commitIds).toEqual([first.commitId, second.commitId]);
    expect(selection.headCommitId).toBe(second.commitId);
  });

  it.each([
    ["merge", { parentCommitIds: [ROOT_COMMIT_ID, "f".repeat(40)] }, JjMergeError],
    ["conflict", { conflict: true }, JjConflictError],
    ["divergence", { divergent: true }, JjAmbiguousChangeError],
  ])("rejects a %s in Last X", async (_name, overrides, errorType) => {
    const record = commit(1, ROOT_COMMIT_ID, {
      currentWorkingCopy: true,
      ...overrides,
    });
    const { client } = clientWithSession(ok(jsonLine(record)));

    await expect(
      (await client.openReadSession()).selectLast(1),
    ).rejects.toBeInstanceOf(errorType);
  });

  it("rejects non-contiguous Last X results", async () => {
    const first = commit(1, ROOT_COMMIT_ID);
    const second = commit(2, "f".repeat(40), { currentWorkingCopy: true });
    const { client } = clientWithSession(
      ok(jsonLine(first) + jsonLine(second)),
    );

    await expect(
      (await client.openReadSession()).selectLast(2),
    ).rejects.toBeInstanceOf(JjSelectionError);
  });

  it("reports a returned merge before the generic ancestor-count error", async () => {
    const merge = commit(1, ROOT_COMMIT_ID, {
      parentCommitIds: [ROOT_COMMIT_ID, "f".repeat(40)],
      currentWorkingCopy: true,
    });
    const extraParent = commit(2, ROOT_COMMIT_ID);
    const { client } = clientWithSession(
      ok(jsonLine(extraParent) + jsonLine(merge)),
    );

    await expect(
      (await client.openReadSession()).selectLast(1),
    ).rejects.toBeInstanceOf(JjMergeError);
  });

  it("resolves full stable change IDs without consulting @", async () => {
    const first = commit(1, ROOT_COMMIT_ID);
    const second = commit(2, first.commitId as string);
    const { client, executor } = clientWithSession(
      ok(jsonLine(first) + jsonLine(second)),
    );
    const session = await client.openReadSession();

    const selection = await session.resolveSelection([
      first.changeId as string,
      second.changeId as string,
    ]);

    expect(selection.commitIds).toEqual([first.commitId, second.commitId]);
    const revset = executor.requests[2]?.args.join(" ") ?? "";
    expect(revset).toContain(`change_id("${String(first.changeId)}")`);
    expect(revset).not.toContain("@");
  });

  it("rejects missing, reordered, and duplicate refresh results as stale", async () => {
    const first = commit(1, ROOT_COMMIT_ID);
    const second = commit(2, first.commitId as string);
    const ids = [first.changeId as string, second.changeId as string];

    const missing = clientWithSession(ok(jsonLine(first))).client;
    await expect(
      (await missing.openReadSession()).resolveSelection(ids),
    ).rejects.toBeInstanceOf(JjStaleSelectionError);

    const reordered = clientWithSession(
      ok(jsonLine(second) + jsonLine(first)),
    ).client;
    await expect(
      (await reordered.openReadSession()).resolveSelection(ids),
    ).rejects.toBeInstanceOf(JjStaleSelectionError);
  });

  it("constructs explicit diff, list, and binary file reads", async () => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    const file = {
      path: "--config=evil;$(touch nope).bin",
      fileType: "file",
      executable: false,
      conflict: false,
    };
    const { client, executor } = clientWithSession(
      ok("diff --git a/a b/a\n"),
      ok(jsonLine(file)),
      ok(bytes),
    );
    const session = await client.openReadSession();
    const from = "1".repeat(40);
    const to = "2".repeat(40);

    await expect(session.diffGit(from, to)).resolves.toEqual(
      Buffer.from("diff --git a/a b/a\n"),
    );
    await expect(session.listFiles(to)).resolves.toEqual([file]);
    await expect(session.readFile(to, file.path)).resolves.toEqual(bytes);

    const fileRequest = executor.requests[4];
    expect(fileRequest?.args).toContain("--");
    expect(fileRequest?.args.at(-1)).toBe(
      'root-file:"--config=evil;$(touch nope).bin"',
    );
    expect(executor.requests[2]?.stdoutLimitBytes).toBeNull();
    expect(executor.requests[2]?.timeoutMs).toBe(5 * 60_000);
  });

  it("reads exact changed-file metadata and scopes file listings", async () => {
    const changed = {
      status: "renamed",
      sourcePath: "old b/name.bin",
      sourceType: "file",
      targetPath: "new b/name.bin",
      targetType: "git-submodule",
    };
    const listed = {
      path: "new b/name.bin",
      fileType: "git-submodule",
      executable: false,
      conflict: false,
    };
    const { client, executor } = clientWithSession(
      ok(jsonLine(changed)),
      ok(jsonLine(listed)),
    );
    const session = await client.openReadSession();
    const from = "1".repeat(40);
    const to = "2".repeat(40);

    await expect(session.listChangedFiles(from, to)).resolves.toEqual([
      {
        status: "renamed",
        originalPath: "old b/name.bin",
        currentPath: "new b/name.bin",
        oldFileType: "file",
        newFileType: "git-submodule",
      },
    ]);
    await expect(
      session.listFiles(to, ["new b/name.bin"]),
    ).resolves.toEqual([listed]);

    expect(executor.requests[2]?.args).toContain(DIFF_FILE_JSON_TEMPLATE);
    expect(executor.requests[3]?.args.at(-1)).toBe(
      'root-file:"new b/name.bin"',
    );
  });
});

describe("exactRootFileset", () => {
  it("quotes fileset metacharacters and normalizes separators", () => {
    expect(exactRootFileset('dir\\a"b(c).txt')).toBe(
      'root-file:"dir/a\\"b(c).txt"',
    );
  });

  it.each(["", "../secret", "a/../secret", "C:\\absolute", "/absolute"])(
    "rejects unsafe path %j",
    (unsafePath) => {
      expect(() => exactRootFileset(unsafePath)).toThrow(TypeError);
    },
  );
});
