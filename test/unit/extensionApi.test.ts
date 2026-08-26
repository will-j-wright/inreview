import { describe, expect, it } from "vitest";

import { selectExtensionApi } from "../../src/extensionApi";

describe("extension API policy", () => {
  it("exports no review, secret storage, or MCP runtime internals in production", () => {
    const internalApi = {
      getExtensionReviewPorts: () => ({ service: {}, secrets: {} }),
      getBridgeRuntime: () => ({}),
    };

    const productionApi = selectExtensionApi(true, internalApi);

    expect(productionApi).toBeUndefined();
  });

  it("keeps the internal API available outside production for host tests", () => {
    const internalApi = { getActivationStatus: () => "ready" };

    expect(selectExtensionApi(false, internalApi)).toBe(internalApi);
  });
});
