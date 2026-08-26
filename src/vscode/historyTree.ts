import type { ReviewRecord } from "../domain/comments";
import type { Snapshot, ViewManifest } from "../domain/review";
import type { RevealFileRequest } from "./activeReviewTree";
import {
  ReviewTreeSource,
  type ReviewTreeItem,
  type TreeState,
  stateItem,
} from "./treeTypes";

export interface HistoryQuery {
  listHistory(): Promise<readonly ReviewRecord[]>;
}

export class HistoryTree extends ReviewTreeSource {
  public constructor(
    private readonly query: HistoryQuery | undefined,
    private readonly state: TreeState,
  ) {
    super();
  }

  public async getRoots(): Promise<readonly ReviewTreeItem[]> {
    if (this.state.kind !== "ready") {
      return [stateItem(this.state)];
    }
    const records = (await this.query?.listHistory()) ?? [];
    return records.length === 0
      ? [
          {
            id: "history:empty",
            label: "No archived reviews",
            contextValue: "inreview.history.empty",
            icon: "history",
            collapsible: "none",
          },
        ]
      : records.map(buildHistoryReviewItem);
  }
}

export function buildHistoryReviewItem(record: ReviewRecord): ReviewTreeItem {
  const snapshot = currentSnapshot(record);
  const combined = snapshot.views.find(
    ({ identity }) => identity.mode === "combined",
  );
  const counts = record.review.counts;
  return {
    id: `history:${record.review.id}`,
    label: record.review.name,
    description: `${formatTime(record.review.archivedAt ?? record.review.updatedAt)} · ${String(snapshot.changes.length)} changes`,
    tooltip: `${String(counts.open)} open, ${String(counts.outdated)} outdated, ${String(counts.resolved)} resolved`,
    contextValue: "inreview.review.archived",
    icon: "archive",
    collapsible: combined === undefined ? "none" : "collapsed",
    children:
      combined === undefined
        ? []
        : [
            {
              id: `history:${record.review.id}:files`,
              label: "Combined Files",
              description: `${String(combined.files.length)} files`,
              contextValue: "inreview.history.files",
              icon: "files",
              collapsible: "collapsed",
              children: combined.files.map((file) =>
                archivedFile(record, snapshot, combined, file),
              ),
            },
          ],
  };
}

function archivedFile(
  record: ReviewRecord,
  snapshot: Snapshot,
  view: ViewManifest,
  file: ViewManifest["files"][number],
): ReviewTreeItem {
  const path = file.currentPath ?? file.originalPath ?? "Unknown file";
  return {
    id: `history:file:${record.review.id}:${file.fileId}`,
    label: path,
    description: `${file.status} · ${file.kind}`,
    contextValue: `inreview.file.archived.${file.status}.${file.kind}`,
    icon: file.kind === "binary" ? "file-binary" : "diff",
    collapsible: "none",
    command: {
      command: "inreview.revealFile",
      title: "Open Archived Diff",
      arguments: [
        {
          reviewId: record.review.id,
          snapshotId: snapshot.id,
          view: view.identity,
          fileId: file.fileId,
          readOnly: true,
        } satisfies RevealFileRequest,
      ],
    },
  };
}

function currentSnapshot(record: ReviewRecord): Snapshot {
  const snapshot = record.snapshots.find(
    ({ id }) => id === record.review.currentSnapshotId,
  );
  if (snapshot === undefined) {
    throw new Error("The archived review has no current snapshot.");
  }
  return snapshot;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}
