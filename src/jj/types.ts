export interface JjVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly display: string;
}

export interface JjCapabilities {
  readonly executable: string;
  readonly version: JjVersion;
  readonly coherentOperationReads: true;
  readonly jsonTemplates: true;
  readonly gitFormatDiffs: true;
  readonly binaryFileReads: true;
}

export interface JjOperation {
  readonly id: string;
  readonly parentIds: readonly string[];
  readonly description: string;
  readonly timestamp: string;
  readonly snapshot: boolean;
  readonly root: boolean;
}

export interface JjCommit {
  readonly changeId: string;
  readonly normalChangeId: string;
  readonly commitId: string;
  readonly parentCommitIds: readonly string[];
  readonly description: string;
  readonly subject: string;
  readonly conflict: boolean;
  readonly divergent: boolean;
  readonly root: boolean;
  readonly currentWorkingCopy: boolean;
}

export type JjFileType = string;

export interface JjFile {
  readonly path: string;
  readonly fileType: JjFileType;
  readonly executable: boolean;
  readonly conflict: boolean;
}

export interface JjChangedFile {
  readonly status: "added" | "modified" | "deleted" | "renamed" | "copied";
  readonly originalPath: string | null;
  readonly currentPath: string | null;
  readonly oldFileType: JjFileType | null;
  readonly newFileType: JjFileType | null;
}

export interface JjFileProbe {
  readonly prefix: Buffer;
  readonly byteLength: number;
  readonly containsNul: boolean;
}

export interface ReviewSelection {
  readonly operationId: string;
  readonly requestedCount: number;
  readonly actualCount: number;
  readonly truncatedAtRoot: boolean;
  readonly commits: readonly JjCommit[];
  readonly changeIds: readonly string[];
  readonly commitIds: readonly string[];
  readonly baseCommitId: string;
  readonly headCommitId: string;
}

export interface ReviewHistoryPage {
  readonly commits: readonly JjCommit[];
  readonly requestedCount: number;
  readonly hasMore: boolean;
  readonly reachedRoot: boolean;
}
