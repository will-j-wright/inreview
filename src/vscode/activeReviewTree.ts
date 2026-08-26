import type { ReviewRecord } from "../domain/comments";
import type {
  FileManifestEntry,
  Snapshot,
  ViewIdentity,
  ViewManifest,
} from "../domain/review";
import {
  ReviewTreeSource,
  type ReviewTreeItem,
  type TreeState,
  stateItem,
} from "./treeTypes";

export type DisplayMode = "combined" | "per-change";

export interface ReviewQuery {
  getActiveReviewOrUndefined(): Promise<ReviewRecord | undefined>;
}

export interface ActiveReviewTreeOptions {
  readonly query: ReviewQuery | undefined;
  readonly state: TreeState;
  readonly getDisplayMode: () => DisplayMode;
}

export class ActiveReviewTree extends ReviewTreeSource {
  public constructor(private readonly options: ActiveReviewTreeOptions) {
    super();
  }

  public async getRoots(): Promise<readonly ReviewTreeItem[]> {
    if (this.options.state.kind !== "ready") {
      return [stateItem(this.options.state)];
    }
    const record = await this.options.query?.getActiveReviewOrUndefined();
    return record === undefined
      ? [
          {
            id: "active:empty",
            label: "No active review",
            description: "Start a review of the current jj stack.",
            contextValue: "inreview.active.empty",
            icon: "info",
            collapsible: "none",
            command: {
              command: "inreview.startReview",
              title: "Start Review",
            },
          },
        ]
      : [buildActiveReviewItem(record, this.options.getDisplayMode())];
  }
}

export function buildActiveReviewItem(
  record: ReviewRecord,
  mode: DisplayMode,
): ReviewTreeItem {
  const snapshot = currentSnapshot(record);
  const counts = record.review.counts;
  const countText = `${String(counts.open)} open, ${String(counts.outdated)} outdated, ${String(counts.resolved)} resolved`;
  return {
    id: `review:${record.review.id}`,
    label: record.review.name,
    description: `Active · ${countText}`,
    tooltip: `${record.review.name}\n${countText}`,
    contextValue: "inreview.review.active",
    icon: "git-pull-request",
    collapsible: "expanded",
    children: [
      buildChangesGroup(snapshot),
      {
        id: `snapshot:${snapshot.id}`,
        label: "Current Snapshot",
        description: `Ready · ${mode === "combined" ? "Combined" : "Per-change"} · ${formatTime(snapshot.capturedAt)}`,
        tooltip: `Snapshot ${snapshot.id}\nOperation ${snapshot.operationId}`,
        contextValue: "inreview.snapshot.current",
        icon: "history",
        collapsible: "none",
      },
      ...buildFileGroups(record, snapshot, mode),
    ],
  };
}

function buildChangesGroup(snapshot: Snapshot): ReviewTreeItem {
  return {
    id: `changes:${snapshot.id}`,
    label: "Selected Changes",
    description: String(snapshot.changes.length),
    contextValue: "inreview.changes",
    icon: "git-commit",
    collapsible: "expanded",
    children: snapshot.changes.map((change, index) => ({
      id: `change:${change.changeId}`,
      label: firstNonEmpty(
        change.subject?.trim(),
        change.description.trim(),
        "Untitled change",
      ),
      description: `${String(index + 1)} · ${shortId(change.changeId)}`,
      tooltip: `${change.changeId}\n${change.commitId}`,
      contextValue: "inreview.change",
      icon: "git-commit",
      collapsible: "none",
    })),
  };
}

function buildFileGroups(
  record: ReviewRecord,
  snapshot: Snapshot,
  mode: DisplayMode,
): readonly ReviewTreeItem[] {
  const views =
    mode === "combined"
      ? snapshot.views.filter(({ identity }) => identity.mode === "combined")
      : snapshot.changes.flatMap((change) => {
          const view = snapshot.views.find(
            ({ identity }) =>
              identity.mode === "per-change" &&
              identity.changeId === change.changeId,
          );
          return view === undefined ? [] : [view];
        });
  return views.map((view) => buildViewGroup(record, snapshot, view));
}

function buildViewGroup(
  record: ReviewRecord,
  snapshot: Snapshot,
  view: ViewManifest,
): ReviewTreeItem {
  const viewKey =
    view.identity.mode === "combined"
      ? "combined"
      : `change:${view.identity.changeId}`;
  const changeId =
    view.identity.mode === "per-change" ? view.identity.changeId : undefined;
  const change =
    changeId !== undefined
      ? snapshot.changes.find((candidate) => candidate.changeId === changeId)
      : undefined;
  const label =
    view.identity.mode === "combined"
      ? "Combined Files"
      : firstNonEmpty(
          change?.subject?.trim(),
          change?.description.trim(),
          shortId(changeId ?? ""),
        );
  return {
    id: `files:${snapshot.id}:${viewKey}`,
    label,
    description: `${String(view.files.length)} files · ${String(view.changedLineCount)} changed lines`,
    contextValue:
      view.identity.mode === "combined"
        ? "inreview.files.combined"
        : "inreview.files.perChange",
    icon: "files",
    collapsible: "expanded",
    children:
      view.files.length === 0
        ? [
            {
              id: `files:${snapshot.id}:${viewKey}:empty`,
              label: "No file changes",
              contextValue: "inreview.files.empty",
              icon: "info",
              collapsible: "none",
            },
          ]
        : view.files.map((file) =>
            buildFileItem(record, snapshot, view.identity, file),
          ),
  };
}

function buildFileItem(
  record: ReviewRecord,
  snapshot: Snapshot,
  view: ViewIdentity,
  file: FileManifestEntry,
): ReviewTreeItem {
  const path = file.currentPath ?? file.originalPath ?? "Unknown file";
  const renamed =
    file.originalPath !== null &&
    file.currentPath !== null &&
    file.originalPath !== file.currentPath
      ? `${file.originalPath} → ${file.currentPath}`
      : path;
  const commentCount = record.threads.filter(
    ({ state, projection }) =>
      state === "open" &&
      projection?.snapshotId === snapshot.id &&
      projection.path === path &&
      sameView(projection.view, view),
  ).length;
  return {
    id: `file:${snapshot.id}:${viewKey(view)}:${file.fileId}`,
    label: renamed,
    description: `${statusCode(file.status)} · ${file.kind} · +${String(file.addedLines)} −${String(file.deletedLines)}${commentCount > 0 ? ` · ${String(commentCount)} comments` : ""}`,
    tooltip: `${renamed}\n${file.status}, ${file.kind}\n${String(commentCount)} open comments`,
    contextValue: `inreview.file.${file.status}.${file.kind}`,
    icon: fileIcon(file),
    collapsible: "none",
    command: {
      command: "inreview.revealFile",
      title: "Open Review Diff",
      arguments: [
        {
          reviewId: record.review.id,
          snapshotId: snapshot.id,
          view,
          fileId: file.fileId,
          readOnly: false,
        } satisfies RevealFileRequest,
      ],
    },
  };
}

export interface RevealFileRequest {
  readonly reviewId: string;
  readonly snapshotId: string;
  readonly view: ViewIdentity;
  readonly fileId: string;
  readonly readOnly: boolean;
}

function currentSnapshot(record: ReviewRecord): Snapshot {
  const snapshot = record.snapshots.find(
    ({ id }) => id === record.review.currentSnapshotId,
  );
  if (snapshot === undefined) {
    throw new Error("The active review has no current snapshot.");
  }
  return snapshot;
}

function sameView(left: ViewIdentity, right: ViewIdentity): boolean {
  return viewKey(left) === viewKey(right);
}

function viewKey(view: ViewIdentity): string {
  return view.mode === "combined" ? "combined" : `change:${view.changeId}`;
}

function shortId(value: string): string {
  return value.slice(0, 12);
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

function statusCode(status: FileManifestEntry["status"]): string {
  return { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C" }[
    status
  ];
}

function fileIcon(file: FileManifestEntry): string {
  if (file.kind === "binary") {
    return "file-binary";
  }
  if (file.kind === "symbolic-link") {
    return "link";
  }
  return file.status === "deleted" ? "diff-removed" : "diff";
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  return values.find((value) => value !== undefined && value.length > 0) ?? "";
}
