import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { StorageError } from "../../src/domain/errors";
import {
  RepositoryMutationReentrancyError,
  runRepositoryMutation,
} from "../../src/review/mutationQueue";
import {
  CURRENT_SCHEMA_VERSION,
  migrateAndParseIndex,
} from "../../src/storage/migrations";
import { atomicWriteFile } from "../../src/storage/atomicFile";
import { RepositoryLock } from "../../src/storage/repositoryLock";
import {
  repositoryFingerprint,
  ReviewStore,
} from "../../src/storage/reviewStore";
import { makeReviewRecord } from "./storageFixtures";

const workRoot = path.resolve(".test-work", "domain-storage");
const usedDirectories = new Set<string>();

async function makeStorageDirectory(): Promise<string> {
  const directory = path.join(workRoot, randomUUID());
  usedDirectories.add(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

afterEach(async () => {
  await Promise.all(
    [...usedDirectories].map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
  usedDirectories.clear();
});

describe("repository fingerprint", () => {
  it("is stable across Windows case and trailing separators and includes environment", () => {
    const first = repositoryFingerprint({
      canonicalRepositoryRoot: "C:\\Work\\Repo\\",
      environment: "local",
      platform: "win32",
    });

    const second = repositoryFingerprint({
      canonicalRepositoryRoot: "c:\\work\\repo",
      environment: "local",
      platform: "win32",
    });

    const wsl = repositoryFingerprint({
      canonicalRepositoryRoot: "c:\\work\\repo",
      environment: "wsl",
      platform: "win32",
    });

    expect(first).toBe(second);
    expect(first).not.toBe(wsl);
  });
});

describe("repository mutation queue", () => {
  it("rejects a nested same-repository mutation without hanging", async () => {
    const nested = runRepositoryMutation("repository-a", () =>
      runRepositoryMutation("repository-a", () =>
        Promise.resolve("unreachable"),
      ),
    );
    const bounded = Promise.race([
      nested,
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error("nested mutation hung"));
        }, 100);
      }),
    ]);
    await expect(bounded).rejects.toBeInstanceOf(
      RepositoryMutationReentrancyError,
    );
  });

  it("continues to serialize independent callers for one repository", async () => {
    const order: string[] = [];
    const first = runRepositoryMutation("repository-b", async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("first-end");
    });
    const second = runRepositoryMutation("repository-b", () => {
      order.push("second");
      return Promise.resolve();
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});

describe("review store", () => {
  it("round trips records and deduplicates validated compressed blobs", async () => {
    const root = await makeStorageDirectory();
    const store = await ReviewStore.open({
      storageRoot: root,
      canonicalRepositoryRoot: "C:\\repo",
      environment: "test",
    });
    try {
      const first = await store.blobs.put(Buffer.from("same content"));
      const second = await store.blobs.put(Buffer.from("same content"));
      expect(second).toEqual(first);

      const record = makeReviewRecord(store.fingerprint, { content: first });
      await store.putReview(record);
      expect(await store.getActiveReview()).toEqual(record);
      expect(
        (await readdir(path.join(store.directory, "blobs"))).filter((name) =>
          name.endsWith(".gz"),
        ),
      ).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("validates blob hashes and persisted JSON", async () => {
    const root = await makeStorageDirectory();
    const store = await ReviewStore.open({
      storageRoot: root,
      canonicalRepositoryRoot: "C:\\repo-corrupt",
      environment: "test",
    });
    const reference = await store.blobs.put(Buffer.from("valid"));
    await writeFile(
      path.join(store.directory, "blobs", `${reference.sha256}.gz`),
      Buffer.from("not gzip"),
    );
    await expect(store.blobs.get(reference)).rejects.toMatchObject({
      code: "CORRUPT_DATA",
    });

    const recordContent = await store.blobs.put(Buffer.from("record"));
    const record = makeReviewRecord(store.fingerprint, { content: recordContent });
    await store.putReview(record);
    const index = JSON.parse(
      await readFile(path.join(store.directory, "index.json"), "utf8"),
    ) as { reviews: { manifestFile: string }[] };
    const manifestFile = index.reviews[0]?.manifestFile;
    if (manifestFile === undefined) {
      throw new Error("The stored review must have an index entry.");
    }
    await writeFile(
      path.join(store.directory, "reviews", manifestFile),
      "{invalid",
    );
    await expect(store.getActiveReview()).rejects.toMatchObject({
      code: "CORRUPT_DATA",
    });
    await store.close();
  });

  it("keeps the previous manifest visible when the index commit fails", async () => {
    const root = await makeStorageDirectory();
    let failNextIndex = false;
    const store = await ReviewStore.open({
      storageRoot: root,
      canonicalRepositoryRoot: "C:\\repo-atomic",
      environment: "test",
      faultInjector: (point) => {
        if (point === "before-index-rename" && failNextIndex) {
          failNextIndex = false;
          throw new Error("simulated index failure");
        }
      },
    });

    try {
      const content = await store.blobs.put(Buffer.from("atomic"));
      const record = makeReviewRecord(store.fingerprint, {
        name: "Before",
        content,
      });
      await store.putReview(record);
      const update = structuredClone(record);
      update.review.name = "After";
      update.review.updatedAt = "2026-01-02T00:00:00.000Z";
      failNextIndex = true;

      await expect(store.putReview(update)).rejects.toThrow("simulated index failure");
      expect((await store.getActiveReview())?.review.name).toBe("Before");
    } finally {
      await store.close();
    }
  });

  it("keeps a complete record when index directory sync reports an uncertain commit", async () => {
    const root = await makeStorageDirectory();
    let directorySyncs = 0;
    let failIndexSync = false;
    const options = {
      storageRoot: root,
      canonicalRepositoryRoot: "C:\\repo-index-sync",
      environment: "test",
      faultInjector: (point: Parameters<typeof atomicWriteFile>[2]) => {
        if (point === "before-directory-sync" && failIndexSync) {
          directorySyncs += 1;
          if (directorySyncs === 2) {
            throw new Error("index directory sync failed");
          }
        }
      },
    };
    const store = await ReviewStore.open(options);
    const content = await store.blobs.put(Buffer.from("durable content"));
    const record = makeReviewRecord(store.fingerprint, { content });
    failIndexSync = true;
    await expect(store.putReview(record)).rejects.toThrow(
      "index directory sync failed",
    );
    expect(await store.getActiveReview()).toEqual(record);
    await store.close();

    const reopened = await ReviewStore.open({
      storageRoot: root,
      canonicalRepositoryRoot: options.canonicalRepositoryRoot,
      environment: options.environment,
    });
    try {
      expect(await reopened.getActiveReview()).toEqual(record);
    } finally {
      await reopened.close();
    }
  });

  it("keeps only the newest configured archived reviews", async () => {
    const root = await makeStorageDirectory();
    const store = await ReviewStore.open({
      storageRoot: root,
      canonicalRepositoryRoot: "C:\\repo-retention",
      environment: "test",
      archiveRetention: 2,
    });
    try {
      const content = await store.blobs.put(Buffer.from("retained"));
      for (let day = 1; day <= 3; day += 1) {
        const timestamp = `2026-01-0${String(day)}T00:00:00.000Z`;
        await store.putReview(
          makeReviewRecord(store.fingerprint, {
            state: "archived",
            timestamp,
            name: `Archive ${String(day)}`,
            content,
          }),
        );
      }
      const names = (await store.listReviews()).map(({ review }) => review.name);
      expect(names).toHaveLength(2);
      expect(names).toEqual(expect.arrayContaining(["Archive 2", "Archive 3"]));
    } finally {
      await store.close();
    }
  });

  it("garbage collects blobs only after their final review is deleted", async () => {
    const root = await makeStorageDirectory();
    const store = await ReviewStore.open({
      storageRoot: root,
      canonicalRepositoryRoot: "C:\\repo-gc",
      environment: "test",
    });
    try {
      const shared = await store.blobs.put(Buffer.from("shared"));
      const orphan = await store.blobs.put(Buffer.from("orphan"));
      const first = makeReviewRecord(store.fingerprint, {
        state: "archived",
        content: shared,
      });
      const second = makeReviewRecord(store.fingerprint, {
        state: "archived",
        content: shared,
      });
      await store.putReview(first);
      await store.putReview(second);
      await expect(store.blobs.get(orphan)).rejects.toMatchObject({ code: "NOT_FOUND" });

      await store.deleteReview(first.review.id);
      await expect(store.blobs.get(shared)).resolves.toEqual(Buffer.from("shared"));
      await store.deleteReview(second.review.id);
      await expect(store.blobs.get(shared)).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await store.close();
    }
  });

  it("keeps prepared blobs pinned through the manifest commit and queued GC", async () => {
    const root = await makeStorageDirectory();
    const store = await ReviewStore.open({
      storageRoot: root,
      canonicalRepositoryRoot: "C:\\repo-prepared-gc",
      environment: "test",
    });
    const content = Buffer.from("new prepared content");
    const reference = {
      sha256: createHash("sha256").update(content).digest("hex"),
      byteLength: content.byteLength,
      encoding: "gzip" as const,
    };
    const staged = deferred();
    const continueCommit = deferred();
    try {
      const commit = store.commitPreparedReviews(
        async (blobs) => {
          await blobs.put(content);
          staged.resolve();
          await continueCommit.promise;
        },
        [makeReviewRecord(store.fingerprint, { content: reference })],
      );
      await staged.promise;
      const gc = store.garbageCollect();
      continueCommit.resolve();
      await Promise.all([commit, gc]);

      await expect(store.blobs.get(reference)).resolves.toEqual(content);
      await expect(store.getActiveReview()).resolves.toBeDefined();
    } finally {
      continueCommit.resolve();
      await store.close();
    }
  });

  it("serializes a comment-like update with a prepared snapshot commit", async () => {
    const root = await makeStorageDirectory();
    const store = await ReviewStore.open({
      storageRoot: root,
      canonicalRepositoryRoot: "C:\\repo-prepared-update",
      environment: "test",
    });
    const originalContent = await store.blobs.put(Buffer.from("original"));
    const original = makeReviewRecord(store.fingerprint, {
      content: originalContent,
    });
    await store.putReview(original);
    const nextContent = Buffer.from("next");
    const nextReference = {
      sha256: createHash("sha256").update(nextContent).digest("hex"),
      byteLength: nextContent.byteLength,
      encoding: "gzip" as const,
    };
    const staged = deferred();
    const continueCommit = deferred();
    const nextSnapshotId = randomUUID();
    try {
      const commit = store.commitPreparedReviews(
        async (blobs) => {
          await blobs.put(nextContent);
          staged.resolve();
          await continueCommit.promise;
        },
        async (context) => {
          const latest = await context.getReview(original.review.id);
          const snapshot = structuredClone(latest.snapshots[0]);
          if (snapshot === undefined) {
            throw new Error("The original snapshot is missing.");
          }
          snapshot.id = nextSnapshotId;
          snapshot.capturedAt = "2026-01-02T00:00:00.000Z";
          const file = snapshot.views[0]?.files[0];
          if (file === undefined) {
            throw new Error("The snapshot file is missing.");
          }
          file.modifiedContent = nextReference;
          return [
            {
              ...latest,
              review: {
                ...latest.review,
                updatedAt: snapshot.capturedAt,
                currentSnapshotId: nextSnapshotId,
                snapshotIds: [...latest.review.snapshotIds, nextSnapshotId],
              },
              snapshots: [...latest.snapshots, snapshot],
            },
          ];
        },
      );
      await staged.promise;
      const commentUpdate = store.updateReview(original.review.id, (latest) => ({
        ...latest,
        review: {
          ...latest.review,
          name: "Comment update survived",
        },
      }));
      continueCommit.resolve();
      await Promise.all([commit, commentUpdate]);

      const result = await store.getReview(original.review.id);
      expect(result.review.currentSnapshotId).toBe(nextSnapshotId);
      expect(result.review.name).toBe("Comment update survived");
      expect(result.snapshots).toHaveLength(2);
    } finally {
      continueCommit.resolve();
      await store.close();
    }
  });

  it.each(["missing", "corrupt"] as const)(
    "isolates one %s manifest and reports active-review recovery",
    async (failure) => {
      const root = await makeStorageDirectory();
      const options = {
        storageRoot: root,
        canonicalRepositoryRoot: `C:\\repo-isolation-${failure}`,
        environment: "test",
      };
      const first = await ReviewStore.open(options);
      const content = await first.blobs.put(Buffer.from("shared healthy content"));
      const healthy = makeReviewRecord(first.fingerprint, {
        state: "archived",
        content,
      });
      const broken = makeReviewRecord(first.fingerprint, { content });
      await first.putReviews([healthy, broken]);
      const index = JSON.parse(
        await readFile(path.join(first.directory, "index.json"), "utf8"),
      ) as { reviews: { reviewId: string; manifestFile: string }[] };
      const brokenEntry = index.reviews.find(
        ({ reviewId }) => reviewId === broken.review.id,
      );
      if (brokenEntry === undefined) {
        throw new Error("The broken review index entry is missing.");
      }
      const manifestPath = path.join(
        first.directory,
        "reviews",
        brokenEntry.manifestFile,
      );
      await first.close();
      if (failure === "missing") {
        await unlink(manifestPath);
      } else {
        await writeFile(manifestPath, "{invalid");
      }

      const reopened = await ReviewStore.open(options);
      try {
        expect((await reopened.listReviews()).map(({ review }) => review.id)).toEqual([
          healthy.review.id,
        ]);
        expect(await reopened.getActiveReview()).toBeUndefined();
        expect(reopened.recoveryDiagnostics).toMatchObject([
          {
            reviewId: broken.review.id,
            wasActive: true,
            reason:
              failure === "missing"
                ? "missing-manifest"
                : "corrupt-manifest",
          },
        ]);
      } finally {
        await reopened.close();
      }
    },
  );

  it("orders retention by timestamp epochs instead of offset text", async () => {
    const root = await makeStorageDirectory();
    const store = await ReviewStore.open({
      storageRoot: root,
      canonicalRepositoryRoot: "C:\\repo-retention-offset",
      environment: "test",
      archiveRetention: 1,
    });
    try {
      const content = await store.blobs.put(Buffer.from("retained"));
      await store.putReview(
        makeReviewRecord(store.fingerprint, {
          state: "archived",
          timestamp: "2026-01-01T12:00:00.000+10:00",
          name: "Older instant",
          content,
        }),
      );
      await store.putReview(
        makeReviewRecord(store.fingerprint, {
          state: "archived",
          timestamp: "2026-01-01T03:00:00.000+00:00",
          name: "Newer instant",
          content,
        }),
      );
      expect((await store.listReviews())[0]?.review.name).toBe("Newer instant");
    } finally {
      await store.close();
    }
  });

  it("marks the store closed when lock release reports ownership loss", async () => {
    const root = await makeStorageDirectory();
    const store = await ReviewStore.open({
      storageRoot: root,
      canonicalRepositoryRoot: "C:\\repo-close-loss",
      environment: "test",
    });
    await writeFile(path.join(store.directory, "writer.lock"), "{}");
    await expect(store.close()).rejects.toMatchObject({ code: "LOCK_NOT_OWNED" });
    await expect(store.getActiveReview()).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("surfaces parent-directory sync failures after the atomic rename", async () => {
    const root = await makeStorageDirectory();
    const destination = path.join(root, "atomic.json");
    await expect(
      atomicWriteFile(destination, "complete", "before-index-rename", (point) => {
        if (point === "before-directory-sync") {
          throw new Error("directory sync failed");
        }
      }),
    ).rejects.toMatchObject({ code: "IO_ERROR", path: destination });
    await expect(readFile(destination, "utf8")).resolves.toBe("complete");
  });
});

describe("repository lock", () => {
  it("refreshes its lease on the heartbeat interval and stops on release", async () => {
    const root = await makeStorageDirectory();
    let now = new Date("2026-08-25T20:00:00.000Z");
    const lock = await RepositoryLock.acquire(root, {
      now: () => now,
      heartbeatIntervalMilliseconds: 5,
    });
    now = new Date("2026-08-25T20:00:01.000Z");
    await expect
      .poll(() => lock.getStatus().heartbeatAt, { timeout: 1_000 })
      .toBe(now.toISOString());
    await lock.release();
    expect(lock.getStatus().state).toBe("released");
  });

  it("rejects a second live writer and recovers a dead same-host writer", async () => {
    const root = await makeStorageDirectory();
    const first = await RepositoryLock.acquire(root, {
      hostname: "test-host",
      pid: 101,
      processIsAlive: () => true,
    });
    await expect(
      RepositoryLock.acquire(root, {
        hostname: "test-host",
        pid: 102,
        processIsAlive: () => true,
      }),
    ).rejects.toMatchObject({ code: "LOCK_HELD" });
    await first.release();

    await RepositoryLock.acquire(root, {
      hostname: "test-host",
      pid: 201,
      processIsAlive: () => false,
    });
    const recovered = await RepositoryLock.acquire(root, {
      hostname: "test-host",
      pid: 202,
      processIsAlive: () => false,
    });
    await recovered.release();
  });

  it("does not delete a recent malformed lock", async () => {
    const root = await makeStorageDirectory();
    await writeFile(path.join(root, "writer.lock"), "broken");
    await expect(
      RepositoryLock.acquire(root, {
        staleMalformedLockMilliseconds: 60_000,
      }),
    ).rejects.toMatchObject({ code: "LOCK_HELD" });
  });

  it("keeps an actively heartbeating lock and recovers a stale reused PID", async () => {
    const root = await makeStorageDirectory();
    let now = new Date("2026-08-25T20:00:00.000Z");
    let identity = "process-a";
    const first = await RepositoryLock.acquire(root, {
      hostname: "test-host",
      pid: 301,
      now: () => now,
      processIsAlive: () => true,
      processIdentity: () => identity,
      heartbeatIntervalMilliseconds: 0,
      leaseMilliseconds: 1_000,
    });
    now = new Date("2026-08-25T20:00:00.900Z");
    await first.refreshLease();
    now = new Date("2026-08-25T20:00:01.500Z");
    await expect(
      RepositoryLock.acquire(root, {
        hostname: "test-host",
        pid: 302,
        now: () => now,
        processIsAlive: () => true,
        processIdentity: () => identity,
        heartbeatIntervalMilliseconds: 0,
        leaseMilliseconds: 1_000,
      }),
    ).rejects.toMatchObject({ code: "LOCK_HELD" });

    now = new Date("2026-08-25T20:00:02.100Z");
    identity = "reused-process";
    const recovered = await RepositoryLock.acquire(root, {
      hostname: "test-host",
      pid: 302,
      now: () => now,
      processIsAlive: () => true,
      processIdentity: () => identity,
      heartbeatIntervalMilliseconds: 0,
      leaseMilliseconds: 1_000,
    });
    expect(recovered.getStatus().state).toBe("held");
    await recovered.release();
  });

  it("recovers a malformed lock after its configured stale age", async () => {
    const root = await makeStorageDirectory();
    const lockPath = path.join(root, "writer.lock");
    await writeFile(lockPath, "broken");
    const old = new Date("2026-08-24T20:00:00.000Z");
    await utimes(lockPath, old, old);
    const recovered = await RepositoryLock.acquire(root, {
      now: () => new Date("2026-08-25T20:00:00.000Z"),
      staleMalformedLockMilliseconds: 1_000,
      heartbeatIntervalMilliseconds: 0,
    });
    await recovered.release();
  });
});

describe("manifest migrations", () => {
  it("runs the explicit base migration and rejects future schemas", () => {
    const migrated = migrateAndParseIndex({
      schemaVersion: 0,
      activeReviewId: null,
      reviews: [],
    });

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(() =>
      migrateAndParseIndex({
        format: "inreview-index",
        schemaVersion: CURRENT_SCHEMA_VERSION + 1,
        activeReviewId: null,
        reviews: [],
      }),
    ).toThrow(StorageError);
  });
});

function deferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolvePromise();
    },
  };
}
