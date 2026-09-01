import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { parseReviewRecord } from "../../src/domain/comments";
import { DomainError } from "../../src/domain/errors";
import { viewIdentityKey } from "../../src/domain/review";
import { makeReviewRecord } from "./storageFixtures";

describe("domain models", () => {
  it("distinguishes combined and per-change view identities", () => {
    expect(viewIdentityKey({ mode: "combined" })).toBe("combined");
    expect(viewIdentityKey({ mode: "per-change", changeId: "change-a" })).toBe(
      "change:change-a",
    );
  });

  it("rejects cross-review and stale-count thread data", () => {
    const fingerprint = "a".repeat(64);
    const record = makeReviewRecord(fingerprint);
    const invalid = structuredClone(record);
    const thread = invalid.threads[0];
    if (thread === undefined) {
      throw new Error("The fixture must contain a thread.");
    }
    thread.reviewId = randomUUID();

    expect(() => parseReviewRecord(invalid)).toThrow(DomainError);

    const staleCounts = structuredClone(record);
    staleCounts.review.counts.open = 0;
    expect(() => parseReviewRecord(staleCounts)).toThrow(
      "The review comment counts are stale.",
    );
  });

  it("rejects malformed persisted values at runtime", () => {
    expect(() => parseReviewRecord({ review: null })).toThrow(
      "The review record is invalid.",
    );
  });

  it("validates persisted comment sides while accepting legacy new-side anchors", () => {
    const record = makeReviewRecord("a".repeat(64));
    expect(() => parseReviewRecord(record)).not.toThrow();

    const oldWithoutPath = structuredClone(record);
    const oldAnchor = oldWithoutPath.threads[0]?.anchor;
    if (oldAnchor === undefined) {
      throw new Error("The fixture must contain an anchor.");
    }
    oldAnchor.side = "old";
    expect(() => parseReviewRecord(oldWithoutPath)).toThrow(DomainError);

    const newWithoutPath = structuredClone(record);
    const newAnchor = newWithoutPath.threads[0]?.anchor;
    if (newAnchor === undefined) {
      throw new Error("The fixture must contain an anchor.");
    }
    newAnchor.currentPath = null;
    expect(() => parseReviewRecord(newWithoutPath)).toThrow(DomainError);

    const sidedFile = structuredClone(record);
    const fileAnchor = sidedFile.threads[0]?.anchor;
    if (fileAnchor === undefined) {
      throw new Error("The fixture must contain an anchor.");
    }
    fileAnchor.target = { kind: "file" };
    fileAnchor.targetText = null;
    fileAnchor.storedHunk = null;
    fileAnchor.fullFileContext = null;
    fileAnchor.side = "new";
    expect(() => parseReviewRecord(sidedFile)).toThrow(DomainError);
  });
});
