import path from "node:path";

import { JjInvalidRepositoryError } from "./errors";

export interface RepositoryRootResolver {
  resolveRepositoryRoot(): Promise<string>;
}

export interface WorkspaceRepository {
  readonly kind: "repository";
  readonly root: string;
}

export interface WorkspaceRepositoryUnavailable {
  readonly kind: "unavailable";
  readonly message: string;
}

export type WorkspaceRepositoryResult =
  | WorkspaceRepository
  | WorkspaceRepositoryUnavailable;

export async function discoverWorkspaceRepository(
  folderPaths: readonly string[],
  createResolver: (folderPath: string) => RepositoryRootResolver,
): Promise<WorkspaceRepositoryResult> {
  const roots: string[] = [];
  for (const folderPath of folderPaths) {
    try {
      const root = await createResolver(folderPath).resolveRepositoryRoot();
      if (!roots.some((candidate) => samePath(candidate, root))) {
        roots.push(root);
      }
    } catch (error) {
      if (error instanceof JjInvalidRepositoryError) {
        continue;
      }
      throw error;
    }
  }

  if (roots.length === 0) {
    return {
      kind: "unavailable",
      message: "Open a folder inside a jj repository.",
    };
  }
  if (roots.length > 1) {
    return {
      kind: "unavailable",
      message:
        "This window contains several jj repositories. Open folders from only one repository.",
    };
  }
  const [root] = roots;
  if (root === undefined) {
    throw new Error("Repository discovery did not retain the resolved root.");
  }
  return { kind: "repository", root };
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left).replace(/[\\/]+$/u, "");
  const normalizedRight = path.resolve(right).replace(/[\\/]+$/u, "");
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") ===
        normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}
