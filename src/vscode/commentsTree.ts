import type { CommentThread, ReviewRecord } from "../domain/comments";
import {
  ReviewTreeSource,
  type ReviewTreeItem,
  type TreeState,
  stateItem,
} from "./treeTypes";

export interface CommentQuery {
  getActiveReviewOrUndefined(): Promise<ReviewRecord | undefined>;
}

export interface RevealCommentRequest {
  readonly reviewId: string;
  readonly commentId: string;
  readonly snapshotId: string;
  readonly outdated: boolean;
  readonly readOnly: boolean;
}

export class CommentsTree extends ReviewTreeSource {
  public constructor(
    private readonly query: CommentQuery | undefined,
    private readonly state: TreeState,
  ) {
    super();
  }

  public async getRoots(): Promise<readonly ReviewTreeItem[]> {
    if (this.state.kind !== "ready") {
      return [stateItem(this.state)];
    }
    const record = await this.query?.getActiveReviewOrUndefined();
    if (record === undefined) {
      return [
        {
          id: "comments:empty",
          label: "No active review comments",
          contextValue: "inreview.comments.empty",
          icon: "comment-discussion",
          collapsible: "none",
        },
      ];
    }
    return buildCommentGroups(record);
  }
}

export function buildCommentGroups(
  record: ReviewRecord,
): readonly ReviewTreeItem[] {
  const groups = [
    {
      key: "open-current",
      label: "Open Current",
      threads: record.threads.filter(
        ({ state, currentness }) =>
          state === "open" && currentness === "current",
      ),
    },
    {
      key: "open-outdated",
      label: "Open Outdated",
      threads: record.threads.filter(
        ({ state, currentness }) =>
          state === "open" && currentness === "outdated",
      ),
    },
    {
      key: "resolved",
      label: "Resolved",
      threads: record.threads.filter(({ state }) => state === "resolved"),
    },
  ] as const;
  return groups.map(({ key, label, threads }) => ({
    id: `comments:${key}`,
    label,
    description: String(threads.length),
    contextValue: `inreview.comments.${key}`,
    icon:
      key === "resolved"
        ? "pass"
        : key === "open-outdated"
          ? "history"
          : "comment",
    collapsible: threads.length === 0 ? "collapsed" : "expanded",
    children:
      threads.length === 0
        ? [
            {
              id: `comments:${key}:empty`,
              label: "None",
              contextValue: "inreview.comment.empty",
              icon: "circle-outline",
              collapsible: "none",
            },
          ]
        : threads.map((thread) => buildThreadItem(record, thread)),
  }));
}

function buildThreadItem(
  record: ReviewRecord,
  thread: CommentThread,
): ReviewTreeItem {
  const path =
    thread.projection?.path ??
    thread.anchor.currentPath ??
    thread.anchor.originalPath ??
    "Unknown file";
  const line =
    thread.projection?.target.kind === "line"
      ? thread.projection.target.line
      : thread.anchor.target.kind === "line"
        ? thread.anchor.target.line
        : undefined;
  const firstMessage = thread.messages[0];
  const preview = firstMessage?.body.replaceAll(/\s+/gu, " ").trim() ?? "";
  return {
    id: `comment:${thread.commentId}`,
    label:
      thread.anchor.target.kind === "file"
        ? `File comment — ${path}`
        : `${path}:${String(line)}`,
    description: preview.length > 80 ? `${preview.slice(0, 77)}…` : preview,
    tooltip: thread.messages
      .map(({ displayName, body }) => `${displayName}: ${body}`)
      .join("\n\n"),
    contextValue:
      thread.state === "resolved"
        ? "inreview.comment.resolved"
        : thread.currentness === "outdated"
          ? "inreview.comment.open.outdated"
          : "inreview.comment.open.current",
    icon:
      thread.state === "resolved"
        ? "pass"
        : thread.currentness === "outdated"
          ? "history"
          : "comment",
    collapsible: "none",
    command: {
      command: "inreview.revealComment",
      title: "Reveal Comment",
      arguments: [
        {
          reviewId: record.review.id,
          commentId: thread.commentId,
          snapshotId:
            thread.projection?.snapshotId ?? thread.anchor.snapshotId,
          outdated: thread.currentness === "outdated",
          readOnly: false,
        } satisfies RevealCommentRequest,
      ],
    },
  };
}
