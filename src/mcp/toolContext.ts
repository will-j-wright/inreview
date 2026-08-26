import type { ReviewService } from "../review/reviewService";

export interface McpSessionReviewBinding {
  readonly canonicalWorkspaceRoot: string;
  readonly repositoryFingerprint: string;
  readonly reviewId: string;
  readonly snapshotId: string;
}

/**
 * The transport must create one context for each MCP session.
 */
export interface McpToolSessionContext {
  binding: McpSessionReviewBinding | undefined;
  readonly disposed: boolean;
  dispose(): void;
}

export function createMcpToolSessionContext(): McpToolSessionContext {
  let disposed = false;
  return {
    binding: undefined,
    get disposed() {
      return disposed;
    },
    dispose() {
      disposed = true;
      this.binding = undefined;
    },
  };
}

export interface McpReviewToolDependencies {
  readonly service: ReviewService;
  readonly session: McpToolSessionContext;
}
