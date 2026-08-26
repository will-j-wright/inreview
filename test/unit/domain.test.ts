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
});
