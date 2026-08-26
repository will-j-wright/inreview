import { describe, expect, it } from "vitest";

import { commandDefinitions } from "../../src/commands";

describe("command definitions", () => {
  it("uses unique InReview command identifiers", () => {
    const identifiers = commandDefinitions.map(({ id }) => id);

    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(identifiers.every((id) => id.startsWith("inreview."))).toBe(true);
  });
});
