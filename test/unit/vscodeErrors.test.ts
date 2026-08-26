import { describe, expect, it } from "vitest";

import {
  JjExecutableNotFoundError,
  JjExecutableSpawnError,
  JjInvalidRepositoryError,
  JjTimeoutError,
  JjUnsupportedVersionError,
} from "../../src/jj";
import { mapUserFacingError } from "../../src/vscode/errors";

describe("jj user-facing diagnostics", () => {
  it("gives configured executable recovery steps", () => {
    const mapped = mapUserFacingError(
      new JjExecutableNotFoundError("C:\\tools\\custom-jj.exe"),
    );

    expect(mapped.message).toContain('"C:\\tools\\custom-jj.exe"');
    expect(mapped.message).toContain("Restart VS Code");
    expect(mapped.message).toContain("inreview.jj.path");
    expect(mapped.message).toContain("absolute path");
    expect(mapped.message).not.toContain("not a readable jj repository");
  });

  it("maps old versions, timeouts, permissions, and invalid repositories distinctly", () => {
    const unsupported = mapUserFacingError(
      new JjUnsupportedVersionError("0.43.0", "jj 0.44 or later"),
    ).message;
    const timeout = mapUserFacingError(new JjTimeoutError(30_000)).message;
    const permission = mapUserFacingError(
      new JjExecutableSpawnError(
        "C:\\tools\\jj.exe",
        "EACCES",
        "permission denied",
      ),
    ).message;
    const repository = mapUserFacingError(
      new JjInvalidRepositoryError("C:\\notes"),
    ).message;

    expect(unsupported).toContain("0.44 or later");
    expect(timeout).toContain("did not finish");
    expect(permission).toContain("does not have permission");
    expect(repository).toContain("not a readable jj repository");
    expect(new Set([unsupported, timeout, permission, repository]).size).toBe(4);
  });
});
