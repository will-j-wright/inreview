import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverWorkspaceRepository,
  JjExecutableNotFoundError,
  JjInvalidRepositoryError,
  type RepositoryRootResolver,
} from "../../src/jj";

function resolver(
  results: ReadonlyMap<string, string | Error>,
): (folderPath: string) => RepositoryRootResolver {
  return (folderPath) => ({
    resolveRepositoryRoot: () => {
      const result = results.get(folderPath);
      if (result instanceof Error) {
        return Promise.reject(result);
      }
      if (result === undefined) {
        return Promise.reject(new Error(`No result for ${folderPath}`));
      }
      return Promise.resolve(result);
    },
  });
}

describe("workspace jj repository discovery", () => {
  it("finds one valid repository root", async () => {
    const root = path.resolve("repo");

    await expect(
      discoverWorkspaceRepository(
        [path.join(root, "src")],
        resolver(new Map([[path.join(root, "src"), root]])),
      ),
    ).resolves.toEqual({ kind: "repository", root });
  });

  it("deduplicates nested folders with the same canonical root", async () => {
    const root = path.resolve("repo");
    const first = path.join(root, "src");
    const second = path.join(root, "src", "nested");

    await expect(
      discoverWorkspaceRepository(
        [first, second],
        resolver(
          new Map([
            [first, root],
            [second, root],
          ]),
        ),
      ),
    ).resolves.toEqual({ kind: "repository", root });
  });

  it("accepts one valid repository plus an unrelated folder", async () => {
    const root = path.resolve("repo");
    const valid = path.join(root, "src");
    const unrelated = path.resolve("notes");

    await expect(
      discoverWorkspaceRepository(
        [valid, unrelated],
        resolver(
          new Map<string, string | Error>([
            [valid, root],
            [unrelated, new JjInvalidRepositoryError(unrelated)],
          ]),
        ),
      ),
    ).resolves.toEqual({ kind: "repository", root });
  });

  it("returns an action when no folder is in a jj repository", async () => {
    const first = path.resolve("one");
    const second = path.resolve("two");

    await expect(
      discoverWorkspaceRepository(
        [first, second],
        resolver(
          new Map([
            [first, new JjInvalidRepositoryError(first)],
            [second, new JjInvalidRepositoryError(second)],
          ]),
        ),
      ),
    ).resolves.toEqual({
      kind: "unavailable",
      message: "Open a folder inside a jj repository.",
    });
  });

  it("rejects two distinct jj repositories", async () => {
    const first = path.resolve("one");
    const second = path.resolve("two");

    const result = await discoverWorkspaceRepository(
      [first, second],
      resolver(
        new Map<string, string | Error>([
          [first, first],
          [second, second],
        ]),
      ),
    );

    expect(result.kind).toBe("unavailable");
    expect(result).toHaveProperty(
      "message",
      expect.stringContaining("several jj repositories"),
    );
  });

  it("does not treat a missing executable as an unrelated folder", async () => {
    const folder = path.resolve("repo");
    const error = new JjExecutableNotFoundError("configured-jj");

    await expect(
      discoverWorkspaceRepository(
        [folder],
        resolver(new Map([[folder, error]])),
      ),
    ).rejects.toBe(error);
  });

  it("does not hide another jj failure after a valid repository", async () => {
    const root = path.resolve("repo");
    const broken = path.resolve("broken");
    const error = new Error("jj root failed");

    await expect(
      discoverWorkspaceRepository(
        [root, broken],
        resolver(
            new Map<string, string | Error>([
            [root, root],
            [broken, error],
          ]),
        ),
      ),
    ).rejects.toBe(error);
  });
});
