import {
  JjAmbiguousChangeError,
  JjConflictError,
  JjMergeError,
  JjNoNewChangesError,
  JjSelectionError,
  JjStaleSelectionError,
} from "./errors";
import type { JjCommit, ReviewSelection } from "./types";

export function buildLastSelection(
  operationId: string,
  requestedCount: number,
  records: readonly JjCommit[],
): ReviewSelection {
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 1) {
    throw new JjSelectionError("The requested change count must be positive.");
  }

  const nonRoot = records.filter((record) => !record.root);
  if (nonRoot.length === 0) {
    throw new JjSelectionError("No non-root changes are available at @.");
  }
  const merge = nonRoot.find((record) => record.parentCommitIds.length !== 1);
  if (merge !== undefined) {
    throw new JjMergeError(merge.changeId);
  }
  if (nonRoot.length > requestedCount) {
    throw new JjSelectionError(
      "jj returned more ancestors than the requested depth.",
    );
  }
  if (
    nonRoot.filter((record) => record.currentWorkingCopy).length !== 1 ||
    nonRoot.at(-1)?.currentWorkingCopy !== true
  ) {
    throw new JjSelectionError(
      "The selected stack does not end at the current working copy.",
    );
  }

  validateCommits(nonRoot, false);
  return makeSelection(
    operationId,
    requestedCount,
    nonRoot,
    nonRoot.length < requestedCount && records.some((record) => record.root),
  );
}

export function buildRefreshSelection(
  operationId: string,
  storedChangeIds: readonly string[],
  records: readonly JjCommit[],
): ReviewSelection {
  if (storedChangeIds.length === 0) {
    throw new JjSelectionError("A refresh requires at least one change ID.");
  }
  if (new Set(storedChangeIds).size !== storedChangeIds.length) {
    throw new JjSelectionError("Stored change IDs must be unique.");
  }
  if (records.length !== storedChangeIds.length) {
    throw new JjStaleSelectionError(
      "One or more selected changes are missing, abandoned, or divergent.",
    );
  }

  const returnedIds = records.map((record) => record.changeId);
  if (
    returnedIds.some(
      (changeId, index) => changeId !== storedChangeIds[index],
    )
  ) {
    throw new JjStaleSelectionError(
      "The selected changes no longer have the same order.",
    );
  }

  validateCommits(records, true);
  return makeSelection(
    operationId,
    storedChangeIds.length,
    records,
    false,
  );
}

export function buildExtendedSelection(
  operationId: string,
  current: ReviewSelection,
  records: readonly JjCommit[],
  requireCurrentWorkingCopy = true,
): ReviewSelection {
  for (const [index, commit] of current.commits.entries()) {
    const candidate = records[index];
    if (
      candidate?.changeId !== commit.changeId ||
      candidate.commitId !== commit.commitId
    ) {
      throw new JjSelectionError(
        "The current working copy is not a direct descendant of the active review head.",
      );
    }
  }
  if (records.length === current.commits.length) {
    throw new JjNoNewChangesError();
  }
  if (
    requireCurrentWorkingCopy &&
    (records.filter((record) => record.currentWorkingCopy).length !== 1 ||
      records.at(-1)?.currentWorkingCopy !== true)
  ) {
    throw new JjSelectionError(
      "The expanded review must end at the current working copy.",
    );
  }
  validateCommits(records, false);
  return makeSelection(
    operationId,
    records.length,
    records,
    false,
  );
}

export function buildRangeSelection(
  operationId: string,
  records: readonly JjCommit[],
): ReviewSelection {
  validateCommits(records, false);
  return makeSelection(
    operationId,
    records.length,
    records,
    false,
  );
}

export function buildRevsetSelection(
  operationId: string,
  records: readonly JjCommit[],
  resultLimit: number,
): ReviewSelection {
  if (!Number.isSafeInteger(resultLimit) || resultLimit < 1) {
    throw new JjSelectionError("The revset result limit must be positive.");
  }
  if (records.length > resultLimit) {
    throw new JjSelectionError(
      `The revset selects more than ${String(resultLimit)} changes.`,
    );
  }
  return buildRangeSelection(operationId, records);
}

function validateCommits(
  commits: readonly JjCommit[],
  refreshing: boolean,
): void {
  const seenChanges = new Set<string>();
  for (const [index, commit] of commits.entries()) {
    if (commit.root) {
      throwSelection(refreshing, "The selected stack contains the root commit.");
    }
    if (commit.divergent || seenChanges.has(commit.changeId)) {
      throw new JjAmbiguousChangeError(commit.changeId);
    }
    seenChanges.add(commit.changeId);
    if (commit.conflict) {
      throw new JjConflictError(commit.changeId);
    }
    if (commit.parentCommitIds.length !== 1) {
      throw new JjMergeError(commit.changeId);
    }
    if (
      index > 0 &&
      commit.parentCommitIds[0] !== commits[index - 1]?.commitId
    ) {
      throwSelection(
        refreshing,
        "The selected changes no longer form a contiguous stack.",
      );
    }
  }
}

function throwSelection(refreshing: boolean, message: string): never {
  if (refreshing) {
    throw new JjStaleSelectionError(message);
  }
  throw new JjSelectionError(message);
}

function makeSelection(
  operationId: string,
  requestedCount: number,
  commits: readonly JjCommit[],
  truncatedAtRoot: boolean,
): ReviewSelection {
  const oldest = commits[0];
  const newest = commits.at(-1);
  if (oldest === undefined || newest === undefined) {
    throw new JjSelectionError("The selected stack is empty.");
  }
  const baseCommitId = oldest.parentCommitIds[0];
  if (baseCommitId === undefined) {
    throw new JjMergeError(oldest.changeId);
  }
  return {
    operationId,
    requestedCount,
    actualCount: commits.length,
    truncatedAtRoot,
    commits: [...commits],
    changeIds: commits.map((commit) => commit.changeId),
    commitIds: commits.map((commit) => commit.commitId),
    baseCommitId,
    headCommitId: newest.commitId,
  };
}
