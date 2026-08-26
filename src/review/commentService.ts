import { randomUUID } from "node:crypto";

import {
  parseReviewRecord,
  type CommentMessage,
  type CommentTarget,
  type CommentThread,
  type ReviewRecord,
} from "../domain/comments";
import type {
  FileManifestEntry,
  Snapshot,
  ViewIdentity,
} from "../domain/review";
import { viewIdentityKey } from "../domain/review";
import { StorageError } from "../domain/errors";
import type { ReviewStore } from "../storage/reviewStore";
import { runRepositoryMutation } from "./mutationQueue";
import {
  fileContextFingerprint,
  lineContextFingerprint,
} from "./commentProjection";

export const COMMENT_BODY_MAX_LENGTH = 65_536;
export const COMMENT_BATCH_MAX_SIZE = 100;
export const COMMENT_QUERY_DEFAULT_LIMIT = 50;
export const COMMENT_QUERY_MAX_LIMIT = 100;

export type CommentServiceErrorCode =
  | "not-found"
  | "stale"
  | "immutable"
  | "invalid-anchor"
  | "invalid-author"
  | "duplicate"
  | "conflict";

export class CommentServiceError extends Error {
  public constructor(
    public readonly code: CommentServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class CommentNotFoundError extends CommentServiceError {
  public constructor(
    public readonly entity: "active-review" | "review" | "thread" | "message",
    public readonly id: string,
    options?: ErrorOptions,
  ) {
    super("not-found", `${entityLabel(entity)} ${id} does not exist.`, options);
  }
}

export class StaleCommentError extends CommentServiceError {
  public constructor(message: string) {
    super("stale", message);
  }
}

export class ImmutableCommentError extends CommentServiceError {
  public constructor(message: string) {
    super("immutable", message);
  }
}

export class InvalidCommentAnchorError extends CommentServiceError {
  public constructor(message: string) {
    super("invalid-anchor", message);
  }
}

export class InvalidCommentAuthorError extends CommentServiceError {
  public constructor(message: string) {
    super("invalid-author", message);
  }
}

export class DuplicateCommentError extends CommentServiceError {
  public constructor(message: string) {
    super("duplicate", message);
  }
}

export class CommentConflictError extends CommentServiceError {
  public constructor(message: string) {
    super("conflict", message);
  }
}

export interface CommentServiceOptions {
  readonly store: ReviewStore;
  readonly clock?: () => Date;
  readonly uuid?: () => string;
}

export interface CreateCommentInput {
  readonly reviewId: string;
  readonly snapshotId: string;
  readonly view: ViewIdentity;
  readonly fileId: string;
  readonly target: CommentTarget;
  readonly side?: "new" | "old";
  readonly body: string;
  readonly displayName: string;
  readonly expectedCurrentSnapshotId?: string;
}

export interface HumanReplyInput {
  readonly reviewId: string;
  readonly commentId: string;
  readonly body: string;
  readonly displayName: string;
  readonly expectedUpdatedAt?: string;
}

export interface AgentReplyInput {
  readonly reviewId: string;
  readonly commentId: string;
  readonly body: string;
  readonly expectedUpdatedAt?: string;
}

export interface EditCommentMessageInput {
  readonly reviewId: string;
  readonly commentId: string;
  readonly messageId: string;
  readonly body: string;
  readonly expectedUpdatedAt?: string;
}

export interface DeleteCommentMessageInput {
  readonly reviewId: string;
  readonly commentId: string;
  readonly messageId: string;
  readonly expectedUpdatedAt?: string;
}

export interface ChangeThreadStateInput {
  readonly reviewId: string;
  readonly commentId: string;
  readonly expectedUpdatedAt?: string;
}

export interface AgentResolutionInput extends ChangeThreadStateInput {
  readonly note?: string;
}

export interface AgentBatchResolution {
  readonly commentId: string;
  readonly note?: string;
  readonly expectedUpdatedAt?: string;
}

export interface AgentBatchResolutionInput {
  readonly reviewId: string;
  readonly items: readonly AgentBatchResolution[];
}

export type CommentQueryStatus = "unresolved" | "resolved" | "all";

export interface CommentQuery {
  readonly status?: CommentQueryStatus;
  readonly outdated?: boolean;
  readonly file?: string;
  readonly ids?: readonly string[];
  readonly cursor?: string;
  readonly limit?: number;
}

export interface HistoryCommentQuery extends CommentQuery {
  readonly reviewIds?: readonly string[];
}

export interface CommentPage {
  readonly items: readonly CommentThread[];
  readonly nextCursor: string | null;
}

export type CommentChangeType =
  | "created"
  | "replied"
  | "edited"
  | "deleted"
  | "resolved"
  | "reopened";

export interface CommentChangeEvent {
  readonly type: CommentChangeType;
  readonly repositoryFingerprint: string;
  readonly reviewId: string;
  readonly commentIds: readonly string[];
}

export interface CommentSubscription {
  dispose(): void;
}

interface MutationResult<T> {
  readonly record: ReviewRecord;
  readonly value: T;
  readonly commentIds: readonly string[];
}

export class CommentService {
  readonly #store: ReviewStore;
  readonly #clock: () => Date;
  readonly #uuid: () => string;
  readonly #listeners = new Set<(event: CommentChangeEvent) => void>();

  public constructor(options: CommentServiceOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? (() => new Date());
    this.#uuid = options.uuid ?? randomUUID;
  }

  public subscribe(
    listener: (event: CommentChangeEvent) => void,
  ): CommentSubscription {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  public async createThread(
    input: CreateCommentInput,
  ): Promise<CommentThread> {
    const body = validateBody(input.body);
    const displayName = validateHumanName(input.displayName);
    return this.commit(input.reviewId, "created", (record, timestamp) => {
      assertCurrentSnapshot(record, input.expectedCurrentSnapshotId);
      if (record.review.currentSnapshotId !== input.snapshotId) {
        throw new StaleCommentError(
          "A new thread must target the current review snapshot.",
        );
      }
      const snapshot = findSnapshot(record, input.snapshotId);
      const file = findFile(snapshot, input.view, input.fileId);
      if (
        (input.target.kind === "line" && input.side === "old") ||
        (input.target.kind === "file" && input.side !== undefined)
      ) {
        throw new InvalidCommentAnchorError(
          "Comments can target file entries or lines on the new side only.",
        );
      }
      const commentId = this.nextUniqueId(allIds(record));
      const messageId = this.nextUniqueId(new Set([...allIds(record), commentId]));
      const anchor = buildAnchor(record, snapshot, input.view, file, input.target);
      const path = file.currentPath ?? file.originalPath;
      if (path === null) {
        throw new InvalidCommentAnchorError("The target file has no path.");
      }
      const thread: CommentThread = {
        commentId,
        reviewId: record.review.id,
        anchor,
        projection: {
          snapshotId: snapshot.id,
          view: copyView(input.view),
          path,
          target: copyTarget(input.target),
        },
        state: "open",
        currentness: "current",
        createdAt: timestamp,
        updatedAt: timestamp,
        resolvedAt: null,
        messages: [
          {
            id: messageId,
            author: "user",
            displayName,
            body,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      };
      const next = withThreads(record, [...record.threads, thread], timestamp);
      return { record: next, value: thread, commentIds: [commentId] };
    });
  }

  public async reply(
    input: HumanReplyInput,
  ): Promise<CommentMessage> {
    const body = validateBody(input.body);
    const displayName = validateHumanName(input.displayName);
    return this.addReply(
      input.reviewId,
      input.commentId,
      body,
      "user",
      displayName,
      input.expectedUpdatedAt,
    );
  }

  public async replyAsAgent(
    input: AgentReplyInput,
  ): Promise<CommentMessage> {
    return this.addReply(
      input.reviewId,
      input.commentId,
      validateBody(input.body),
      "agent",
      "Agent",
      input.expectedUpdatedAt,
    );
  }

  public async editMessage(
    input: EditCommentMessageInput,
  ): Promise<CommentMessage> {
    const body = validateBody(input.body);
    return this.commit(input.reviewId, "edited", (record, timestamp) => {
      const { thread, index } = requireThread(record, input.commentId);
      assertExpectedThread(thread, input.expectedUpdatedAt);
      const messageIndex = thread.messages.findIndex(
        ({ id }) => id === input.messageId,
      );
      const message = thread.messages[messageIndex];
      if (message === undefined) {
        throw new CommentNotFoundError("message", input.messageId);
      }
      if (message.author === "agent") {
        throw new ImmutableCommentError("Agent messages cannot be edited.");
      }
      const edited: CommentMessage = { ...message, body, updatedAt: timestamp };
      const messages = [...thread.messages];
      messages[messageIndex] = edited;
      const updated = { ...thread, messages, updatedAt: timestamp };
      return {
        record: replaceThread(record, index, updated, timestamp),
        value: edited,
        commentIds: [thread.commentId],
      };
    });
  }

  public async deleteMessage(
    input: DeleteCommentMessageInput,
  ): Promise<{ readonly threadRemoved: boolean }> {
    return this.commit<{ readonly threadRemoved: boolean }>(
      input.reviewId,
      "deleted",
      (record, timestamp) => {
        const { thread, index } = requireThread(record, input.commentId);
        assertExpectedThread(thread, input.expectedUpdatedAt);
        const message = thread.messages.find(({ id }) => id === input.messageId);
        if (message === undefined) {
          throw new CommentNotFoundError("message", input.messageId);
        }
        if (message.author === "agent") {
          throw new ImmutableCommentError("Agent messages cannot be deleted.");
        }
        const messages = thread.messages.filter(
          ({ id }) => id !== input.messageId,
        );
        if (messages.length === 0) {
          return {
            record: withThreads(
              record,
              record.threads.filter(
                ({ commentId }) => commentId !== thread.commentId,
              ),
              timestamp,
            ),
            value: { threadRemoved: true },
            commentIds: [thread.commentId],
          };
        }
        const updated = { ...thread, messages, updatedAt: timestamp };
        return {
          record: replaceThread(record, index, updated, timestamp),
          value: { threadRemoved: false },
          commentIds: [thread.commentId],
        };
      },
    );
  }

  public async resolve(
    input: ChangeThreadStateInput,
  ): Promise<CommentThread> {
    return this.changeState(input, "resolved");
  }

  public async reopen(
    input: ChangeThreadStateInput,
  ): Promise<CommentThread> {
    return this.changeState(input, "open");
  }

  public async resolveAsAgent(
    input: AgentResolutionInput,
  ): Promise<CommentThread> {
    const [thread] = await this.resolveBatchAsAgent({
      reviewId: input.reviewId,
      items: [
        {
          commentId: input.commentId,
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.expectedUpdatedAt === undefined
            ? {}
            : { expectedUpdatedAt: input.expectedUpdatedAt }),
        },
      ],
    });
    if (thread === undefined) {
      throw new CommentConflictError("The thread resolution did not complete.");
    }
    return thread;
  }

  public async resolveBatchAsAgent(
    input: AgentBatchResolutionInput,
  ): Promise<readonly CommentThread[]> {
    validateBatch(input.items);
    const notes = input.items.map(({ note }) =>
      note === undefined ? undefined : validateBody(note),
    );
    return this.commit(input.reviewId, "resolved", async (record, timestamp) => {
      const missingIds = input.items
        .map(({ commentId }) => commentId)
        .filter(
          (commentId) =>
            !record.threads.some((thread) => thread.commentId === commentId),
        );
      if (missingIds.length > 0) {
        const otherRecords = await this.#store.listReviews();
        const outOfReview = missingIds.find((commentId) =>
          otherRecords.some(
            (candidate) =>
              candidate.review.id !== record.review.id &&
              candidate.threads.some((thread) => thread.commentId === commentId),
          ),
        );
        if (outOfReview !== undefined) {
          throw new CommentConflictError(
            `Thread ${outOfReview} belongs to a different review.`,
          );
        }
        throw new CommentNotFoundError("thread", missingIds[0] ?? "unknown");
      }
      const requests = input.items.map((item, requestIndex) => {
        const found = requireThread(record, item.commentId);
        assertExpectedThread(found.thread, item.expectedUpdatedAt);
        if (found.thread.state === "resolved") {
          throw new CommentConflictError(
            `Thread ${item.commentId} is already resolved.`,
          );
        }
        return { ...found, note: notes[requestIndex] };
      });
      const ids = allIds(record);
      const nextThreads = [...record.threads];
      const resolved = requests.map(({ thread, index, note }) => {
        let messages = [...thread.messages];
        if (note !== undefined) {
          const messageId = this.nextUniqueId(ids);
          ids.add(messageId);
          messages = [
            ...messages,
            {
              id: messageId,
              author: "agent" as const,
              displayName: "Agent",
              body: note,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ];
        }
        const updated: CommentThread = {
          ...thread,
          messages,
          state: "resolved",
          resolvedAt: timestamp,
          updatedAt: timestamp,
        };
        nextThreads[index] = updated;
        return updated;
      });
      return {
        record: withThreads(record, nextThreads, timestamp),
        value: resolved,
        commentIds: resolved.map(({ commentId }) => commentId),
      };
    });
  }

  public async queryActiveThreads(
    query: CommentQuery = {},
  ): Promise<CommentPage> {
    const active = await this.#store.getActiveReview();
    if (active === undefined) {
      throw new CommentNotFoundError("active-review", "active");
    }
    return pageThreads(active.threads, query);
  }

  public async queryReviewThreads(
    reviewId: string,
    query: CommentQuery = {},
  ): Promise<CommentPage> {
    const record = await this.getReview(reviewId);
    return pageThreads(record.threads, query);
  }

  public async queryHistoryThreads(
    query: HistoryCommentQuery = {},
  ): Promise<CommentPage> {
    const reviewIds =
      query.reviewIds === undefined
        ? undefined
        : validateDistinctIds(query.reviewIds, "review filter");
    const records = (await this.#store.listReviews()).filter(
      ({ review }) =>
        review.state === "archived" &&
        (reviewIds === undefined || reviewIds.has(review.id)),
    );
    return pageThreads(
      records.flatMap(({ threads }) => threads),
      query,
    );
  }

  private async addReply(
    reviewId: string,
    commentId: string,
    body: string,
    author: "user" | "agent",
    displayName: string,
    expectedUpdatedAt: string | undefined,
  ): Promise<CommentMessage> {
    return this.commit(reviewId, "replied", (record, timestamp) => {
      const { thread, index } = requireThread(record, commentId);
      assertExpectedThread(thread, expectedUpdatedAt);
      if (thread.state === "resolved") {
        throw new CommentConflictError(
          `Thread ${commentId} is resolved and cannot receive replies.`,
        );
      }
      const message: CommentMessage = {
        id: this.nextUniqueId(allIds(record)),
        author,
        displayName,
        body,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const updated = {
        ...thread,
        messages: [...thread.messages, message],
        updatedAt: timestamp,
      };
      return {
        record: replaceThread(record, index, updated, timestamp),
        value: message,
        commentIds: [commentId],
      };
    });
  }

  private async changeState(
    input: ChangeThreadStateInput,
    state: "open" | "resolved",
  ): Promise<CommentThread> {
    return this.commit(
      input.reviewId,
      state === "open" ? "reopened" : "resolved",
      (record, timestamp) => {
        const { thread, index } = requireThread(record, input.commentId);
        assertExpectedThread(thread, input.expectedUpdatedAt);
        if (thread.state === state) {
          throw new CommentConflictError(
            `Thread ${thread.commentId} is already ${state}.`,
          );
        }
        const updated: CommentThread = {
          ...thread,
          state,
          resolvedAt: state === "resolved" ? timestamp : null,
          updatedAt: timestamp,
        };
        return {
          record: replaceThread(record, index, updated, timestamp),
          value: updated,
          commentIds: [thread.commentId],
        };
      },
    );
  }

  private async commit<T>(
    reviewId: string,
    type: CommentChangeType,
    mutate: (
      record: ReviewRecord,
      timestamp: string,
    ) => MutationResult<T> | Promise<MutationResult<T>>,
  ): Promise<T> {
    return runRepositoryMutation(this.#store.fingerprint, async () => {
      let result: MutationResult<T> | undefined;
      try {
        await this.#store.updateReview(reviewId, async (record) => {
          assertMutable(record);
          result = await mutate(record, this.#clock().toISOString());
          return result.record;
        });
      } catch (error) {
        if (error instanceof StorageError && error.code === "NOT_FOUND") {
          throw new CommentNotFoundError("review", reviewId, { cause: error });
        }
        throw error;
      }
      if (result === undefined) {
        throw new CommentConflictError("The comment mutation did not complete.");
      }
      this.emit({
        type,
        repositoryFingerprint: this.#store.fingerprint,
        reviewId,
        commentIds: [...result.commentIds],
      });
      return structuredClone(result.value);
    });
  }

  private nextUniqueId(existing: ReadonlySet<string>): string {
    const id = this.#uuid();
    if (!UUID_PATTERN.test(id)) {
      throw new CommentConflictError("The UUID provider returned an invalid ID.");
    }
    if (existing.has(id)) {
      throw new DuplicateCommentError(`Generated ID ${id} is already in use.`);
    }
    return id;
  }

  private async getReview(reviewId: string): Promise<ReviewRecord> {
    try {
      return await this.#store.getReview(reviewId);
    } catch (error) {
      if (error instanceof StorageError && error.code === "NOT_FOUND") {
        throw new CommentNotFoundError("review", reviewId, { cause: error });
      }
      throw error;
    }
  }

  private emit(event: CommentChangeEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Persistence has completed, so a listener cannot roll back this change.
      }
    }
  }
}

function buildAnchor(
  record: ReviewRecord,
  snapshot: Snapshot,
  view: ViewIdentity,
  file: FileManifestEntry,
  target: CommentTarget,
): CommentThread["anchor"] {
  if (target.kind === "file") {
    return {
      reviewId: record.review.id,
      snapshotId: snapshot.id,
      view: copyView(view),
      fileId: file.fileId,
      target: { kind: "file" },
      originalPath: file.originalPath,
      currentPath: file.currentPath,
      fileStatus: file.status,
      targetText: null,
      storedHunk: null,
      contextFingerprint: fileContextFingerprint(
        record.review.id,
        snapshot.id,
        view,
        file,
      ),
    };
  }
  if (file.kind !== "text" || file.currentPath === null || file.status === "deleted") {
    throw new InvalidCommentAnchorError(
      "Line threads require a text file with a new side.",
    );
  }
  const matches = file.hunks.flatMap((hunk) =>
    hunk.lines
      .map((line, index) => ({ hunk, line, index }))
      .filter(
        ({ line }) =>
          line.newLine === target.line &&
          (line.kind === "addition" || line.kind === "context"),
      ),
  );
  if (matches.length !== 1) {
    throw new InvalidCommentAnchorError(
      "The line is not an added or unchanged-context line in a displayed hunk.",
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw new InvalidCommentAnchorError("The line anchor is invalid.");
  }
  return {
    reviewId: record.review.id,
    snapshotId: snapshot.id,
    view: copyView(view),
    fileId: file.fileId,
    target: { kind: "line", line: target.line },
    originalPath: file.originalPath,
    currentPath: file.currentPath,
    fileStatus: file.status,
    targetText: match.line.content,
    storedHunk: structuredClone(match.hunk),
    contextFingerprint: lineContextFingerprint(match.hunk, match.index),
  };
}

function findSnapshot(record: ReviewRecord, snapshotId: string): Snapshot {
  const snapshot = record.snapshots.find(({ id }) => id === snapshotId);
  if (snapshot === undefined) {
    throw new InvalidCommentAnchorError(
      `Snapshot ${snapshotId} is not part of the review.`,
    );
  }
  return snapshot;
}

function findFile(
  snapshot: Snapshot,
  identity: ViewIdentity,
  fileId: string,
): FileManifestEntry {
  const view = snapshot.views.find(
    (candidate) =>
      viewIdentityKey(candidate.identity) === viewIdentityKey(identity),
  );
  if (view === undefined) {
    throw new InvalidCommentAnchorError("The requested review view does not exist.");
  }
  const files = view.files.filter((file) => file.fileId === fileId);
  if (files.length !== 1 || files[0] === undefined) {
    throw new InvalidCommentAnchorError(
      `File ${fileId} is not unique in the requested review view.`,
    );
  }
  return files[0];
}

function assertMutable(record: ReviewRecord): void {
  if (record.review.state !== "active") {
    throw new CommentConflictError(
      `Review ${record.review.id} is archived and read-only.`,
    );
  }
}

function assertCurrentSnapshot(
  record: ReviewRecord,
  expectedSnapshotId: string | undefined,
): void {
  if (
    expectedSnapshotId !== undefined &&
    record.review.currentSnapshotId !== expectedSnapshotId
  ) {
    throw new StaleCommentError("The review snapshot changed before the mutation.");
  }
}

function assertExpectedThread(
  thread: CommentThread,
  expectedUpdatedAt: string | undefined,
): void {
  if (
    expectedUpdatedAt !== undefined &&
    thread.updatedAt !== expectedUpdatedAt
  ) {
    throw new StaleCommentError(
      `Thread ${thread.commentId} changed before the mutation.`,
    );
  }
}

function requireThread(
  record: ReviewRecord,
  commentId: string,
): { readonly thread: CommentThread; readonly index: number } {
  const index = record.threads.findIndex((thread) => thread.commentId === commentId);
  const thread = record.threads[index];
  if (thread === undefined) {
    throw new CommentNotFoundError("thread", commentId);
  }
  return { thread, index };
}

function replaceThread(
  record: ReviewRecord,
  index: number,
  thread: CommentThread,
  timestamp: string,
): ReviewRecord {
  const threads = [...record.threads];
  threads[index] = thread;
  return withThreads(record, threads, timestamp);
}

function withThreads(
  record: ReviewRecord,
  threads: readonly CommentThread[],
  timestamp: string,
): ReviewRecord {
  return parseReviewRecord({
    ...record,
    review: {
      ...record.review,
      updatedAt: timestamp,
      counts: countThreads(threads),
    },
    threads,
  });
}

function countThreads(threads: readonly CommentThread[]): {
  readonly open: number;
  readonly outdated: number;
  readonly resolved: number;
} {
  return {
    open: threads.filter(
      ({ state, currentness }) => state === "open" && currentness === "current",
    ).length,
    outdated: threads.filter(
      ({ state, currentness }) => state === "open" && currentness === "outdated",
    ).length,
    resolved: threads.filter(({ state }) => state === "resolved").length,
  };
}

function validateBody(body: string): string {
  if (
    body.length === 0 ||
    body.trim().length === 0 ||
    body.length > COMMENT_BODY_MAX_LENGTH
  ) {
    throw new CommentConflictError(
      `A comment body must contain 1 to ${String(COMMENT_BODY_MAX_LENGTH)} characters.`,
    );
  }
  if (hasDisallowedPlainText(body)) {
    throw new CommentConflictError(
      "A comment body can contain plain text, tabs, and line breaks only.",
    );
  }
  return body;
}

function validateHumanName(displayName: string): string {
  const normalized = displayName.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    hasDisallowedPlainText(normalized) ||
    normalized === "Agent"
  ) {
    throw new InvalidCommentAuthorError(
      'A human author needs a valid name other than "Agent".',
    );
  }
  return normalized;
}

function validateBatch(items: readonly AgentBatchResolution[]): void {
  if (items.length === 0 || items.length > COMMENT_BATCH_MAX_SIZE) {
    throw new CommentConflictError(
      `A resolution batch must contain 1 to ${String(COMMENT_BATCH_MAX_SIZE)} threads.`,
    );
  }
  validateDistinctIds(
    items.map(({ commentId }) => commentId),
    "resolution batch",
  );
}

function validateDistinctIds(
  ids: readonly string[],
  description: string,
): ReadonlySet<string> {
  if (ids.length > COMMENT_BATCH_MAX_SIZE) {
    throw new CommentConflictError(
      `The ${description} exceeds the limit of ${String(COMMENT_BATCH_MAX_SIZE)} IDs.`,
    );
  }
  const distinct = new Set(ids);
  if (distinct.size !== ids.length) {
    throw new DuplicateCommentError(
      `The ${description} contains a duplicate ID.`,
    );
  }
  return distinct;
}

function pageThreads(
  input: readonly CommentThread[],
  query: CommentQuery,
): CommentPage {
  const limit = query.limit ?? COMMENT_QUERY_DEFAULT_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > COMMENT_QUERY_MAX_LIMIT
  ) {
    throw new CommentConflictError(
      `A query limit must be between 1 and ${String(COMMENT_QUERY_MAX_LIMIT)}.`,
    );
  }
  const ids =
    query.ids === undefined
      ? undefined
      : validateDistinctIds(query.ids, "comment filter");
  const status = query.status ?? "unresolved";
  let threads = input
    .filter((thread) => {
      if (status !== "all" && (thread.state === "resolved") !== (status === "resolved")) {
        return false;
      }
      if (
        query.outdated !== undefined &&
        (thread.currentness === "outdated") !== query.outdated
      ) {
        return false;
      }
      if (ids !== undefined && !ids.has(thread.commentId)) {
        return false;
      }
      return query.file === undefined || threadMatchesFile(thread, query.file);
    })
    .sort(compareThreads);
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(query.cursor);
    threads = threads.filter((thread) => threadKey(thread) > cursor);
  }
  const items = threads.slice(0, limit);
  const lastItem = items.at(-1);
  const nextCursor =
    threads.length > limit && lastItem !== undefined
      ? encodeCursor(threadKey(lastItem))
      : null;
  return {
    items: structuredClone(items),
    nextCursor,
  };
}

function threadMatchesFile(thread: CommentThread, file: string): boolean {
  return (
    thread.projection?.path === file ||
    thread.anchor.currentPath === file ||
    thread.anchor.originalPath === file ||
    thread.anchor.fileId === file
  );
}

function compareThreads(left: CommentThread, right: CommentThread): number {
  const leftKey = threadKey(left);
  const rightKey = threadKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function threadKey(thread: CommentThread): string {
  return `${thread.createdAt}\0${thread.reviewId}\0${thread.commentId}`;
}

function encodeCursor(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeCursor(value: string): string {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (decoded.split("\0").length !== 3) {
      throw new Error("invalid cursor");
    }
    return decoded;
  } catch {
    throw new CommentConflictError("The comment cursor is invalid.");
  }
}

function allIds(record: ReviewRecord): Set<string> {
  return new Set(
    record.threads.flatMap((thread) => [
      thread.commentId,
      ...thread.messages.map(({ id }) => id),
    ]),
  );
}

function copyView(view: ViewIdentity): ViewIdentity {
  return view.mode === "combined"
    ? { mode: "combined" }
    : { mode: "per-change", changeId: view.changeId };
}

function copyTarget(target: CommentTarget): CommentTarget {
  return target.kind === "file"
    ? { kind: "file" }
    : { kind: "line", line: target.line };
}

function entityLabel(
  entity: "active-review" | "review" | "thread" | "message",
): string {
  switch (entity) {
    case "active-review":
      return "Active review";
    case "review":
      return "Review";
    case "thread":
      return "Thread";
    case "message":
      return "Message";
  }
}

function hasDisallowedPlainText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x7f ||
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
    ) {
      return true;
    }
  }
  return false;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
