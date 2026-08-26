import type * as vscode from "vscode";

import type {
  CommentMessage,
  CommentThread as PersistedCommentThread,
  ReviewRecord,
} from "../domain/comments";
import type {
  FileManifestEntry,
  LineRange,
  Snapshot,
  ViewIdentity,
} from "../domain/review";
import { viewIdentityKey } from "../domain/review";
import {
  CommentConflictError,
  StaleCommentError,
  type ReviewService,
} from "../review";
import type { RevealFileRequest } from "./activeReviewTree";
import type { RevealCommentRequest } from "./commentsTree";
import type { NativeDiffService } from "./nativeDiffService";
import {
  InvalidVirtualDocumentUriError,
  type VirtualDocumentIdentity,
  VirtualDocumentUriCodec,
} from "./virtualDocumentProvider";

export const COMMENT_CONTROLLER_ID = "inreview";
export const COMMENT_COMMANDS = {
  submit: "inreview.submitComment",
  edit: "inreview.editComment",
  save: "inreview.saveComment",
  cancelEdit: "inreview.cancelCommentEdit",
  delete: "inreview.deleteComment",
} as const;

export interface CommentDocumentTarget {
  readonly record: ReviewRecord;
  readonly snapshot: Snapshot;
  readonly file: FileManifestEntry;
}

export interface CommentPlacement {
  readonly thread: PersistedCommentThread;
  readonly line: number;
  readonly fileLevel: boolean;
  readonly historical: boolean;
}

export interface CommentVscodeApi {
  readonly comments: Pick<typeof vscode.comments, "createCommentController">;
  readonly workspace: Pick<
    typeof vscode.workspace,
    "textDocuments" | "onDidOpenTextDocument" | "onDidCloseTextDocument"
  >;
  readonly window: Pick<
    typeof vscode.window,
    | "visibleTextEditors"
    | "activeTextEditor"
    | "onDidChangeVisibleTextEditors"
    | "showInputBox"
  >;
  readonly Uri: typeof vscode.Uri;
  readonly Range: typeof vscode.Range;
  readonly Selection: typeof vscode.Selection;
  readonly CommentMode: typeof vscode.CommentMode;
  readonly CommentThreadCollapsibleState: typeof vscode.CommentThreadCollapsibleState;
  readonly CommentThreadState: typeof vscode.CommentThreadState;
  readonly TextEditorRevealType: typeof vscode.TextEditorRevealType;
}

export interface CommentControllerOptions {
  readonly service: ReviewService;
  readonly nativeDiff: Pick<NativeDiffService, "revealFile">;
  readonly signingKey: string | Uint8Array;
  readonly vscode: CommentVscodeApi;
  readonly logError?: (message: string, error: unknown) => void;
}

interface ThreadMetadata {
  readonly value: PersistedCommentThread;
}

interface MessageMetadata {
  readonly thread: PersistedCommentThread;
  readonly message: CommentMessage;
}

interface ThreadReference {
  readonly reviewId: string;
  readonly commentId: string;
}

export class InReviewCommentController implements vscode.Disposable {
  readonly #service: ReviewService;
  readonly #nativeDiff: Pick<NativeDiffService, "revealFile">;
  readonly #vscode: CommentVscodeApi;
  readonly #codec: VirtualDocumentUriCodec;
  readonly #logError: (message: string, error: unknown) => void;
  readonly #controller: vscode.CommentController;
  readonly #disposables: vscode.Disposable[];
  readonly #threadMetadata = new WeakMap<vscode.CommentThread, ThreadMetadata>();
  readonly #messageMetadata = new WeakMap<vscode.Comment, MessageMetadata>();
  readonly #editBodies = new WeakMap<vscode.Comment, string>();
  #threads: vscode.CommentThread[] = [];
  #refreshQueued = false;
  #refreshPromise: Promise<void> = Promise.resolve();
  #disposed = false;

  public constructor(options: CommentControllerOptions) {
    this.#service = options.service;
    this.#nativeDiff = options.nativeDiff;
    this.#vscode = options.vscode;
    this.#logError = options.logError ?? (() => undefined);
    this.#codec = new VirtualDocumentUriCodec(
      options.signingKey,
      options.vscode.Uri,
    );
    this.#controller = options.vscode.comments.createCommentController(
      COMMENT_CONTROLLER_ID,
      "InReview",
    );
    this.#controller.options = {
      prompt: "Reply to this InReview thread",
      placeHolder: "Enter plain text",
    };
    this.#controller.commentingRangeProvider = {
      provideCommentingRanges: async (document, token) => {
        if (token.isCancellationRequested) {
          return [];
        }
        const identity = this.decode(document.uri);
        if (identity === undefined) {
          return [];
        }
        let record: ReviewRecord;
        try {
          record = await this.#service.getReview(identity.reviewId);
        } catch {
          return [];
        }
        return commentableRanges(record, identity)
          .filter(({ end }) => end <= document.lineCount)
          .map(
            ({ start, end }) =>
              new this.#vscode.Range(
                start - 1,
                0,
                end - 1,
                document.lineAt(end - 1).range.end.character,
              ),
          );
      },
    };
    this.#disposables = [
      this.#controller,
      options.vscode.workspace.onDidOpenTextDocument(() => {
        void this.refresh();
      }),
      options.vscode.workspace.onDidCloseTextDocument(() => {
        void this.refresh();
      }),
      options.vscode.window.onDidChangeVisibleTextEditors(() => {
        void this.refresh();
      }),
      this.#service.subscribe(() => {
        void this.refresh();
      }),
      this.#service.commentService.subscribe(() => {
        void this.refresh();
      }),
    ];
    void this.refresh();
  }

  public get controller(): vscode.CommentController {
    return this.#controller;
  }

  public async submit(value: unknown): Promise<void> {
    const reply = asCommentReply(value);
    if (reply === undefined) {
      throw new TypeError("Select an InReview comment editor and try again.");
    }
    const body = reply.text;
    const existing = this.#threadMetadata.get(reply.thread);
    if (existing !== undefined) {
      await this.#service.commentService.reply({
        reviewId: existing.value.reviewId,
        commentId: existing.value.commentId,
        body,
        displayName: "You",
        expectedUpdatedAt: existing.value.updatedAt,
      });
      await this.refresh();
      return;
    }

    const identity = this.#codec.decode(reply.thread.uri);
    const record = await this.#service.getReview(identity.reviewId);
    const target = resolveCommentDocument(record, identity);
    if (target === undefined) {
      throw new TypeError("This document cannot receive an InReview comment.");
    }
    const line = reply.thread.range.end.line + 1;
    await this.#service.commentService.createThread({
      reviewId: identity.reviewId,
      snapshotId: identity.snapshotId,
      view: identity.view,
      fileId: identity.fileId,
      target: { kind: "line", line },
      side: "new",
      body,
      displayName: "You",
      expectedCurrentSnapshotId: record.review.currentSnapshotId,
    });
    reply.thread.dispose();
    await this.refresh();
  }

  public edit(value: unknown): void {
    const comment = asComment(value);
    if (comment === undefined || this.#messageMetadata.get(comment) === undefined) {
      throw new TypeError("Select an editable InReview comment and try again.");
    }
    if (typeof comment.body !== "string") {
      throw new TypeError("Only plain-text InReview comments can be edited.");
    }
    this.#editBodies.set(comment, comment.body);
    comment.mode = this.#vscode.CommentMode.Editing;
    comment.contextValue = "inreview.comment.user.editing";
  }

  public async save(value: unknown): Promise<void> {
    const comment = asComment(value);
    const metadata =
      comment === undefined ? undefined : this.#messageMetadata.get(comment);
    if (
      comment === undefined ||
      metadata === undefined ||
      typeof comment.body !== "string"
    ) {
      throw new TypeError("Select an edited InReview comment and try again.");
    }
    await this.#service.commentService.editMessage({
      reviewId: metadata.thread.reviewId,
      commentId: metadata.thread.commentId,
      messageId: metadata.message.id,
      body: comment.body,
      expectedUpdatedAt: metadata.thread.updatedAt,
    });
    await this.refresh();
  }

  public cancelEdit(value: unknown): void {
    const comment = asComment(value);
    if (comment === undefined) {
      return;
    }
    const original = this.#editBodies.get(comment);
    if (original !== undefined) {
      comment.body = original;
    }
    comment.mode = this.#vscode.CommentMode.Preview;
    comment.contextValue = "inreview.comment.user";
    this.#editBodies.delete(comment);
  }

  public async delete(value: unknown): Promise<void> {
    const comment = asComment(value);
    const metadata =
      comment === undefined ? undefined : this.#messageMetadata.get(comment);
    if (metadata === undefined) {
      throw new TypeError("Select a removable InReview comment and try again.");
    }
    await this.#service.commentService.deleteMessage({
      reviewId: metadata.thread.reviewId,
      commentId: metadata.thread.commentId,
      messageId: metadata.message.id,
      expectedUpdatedAt: metadata.thread.updatedAt,
    });
    await this.refresh();
  }

  public async addFileComment(...values: readonly unknown[]): Promise<void> {
    const request = this.fileRequestFrom(values);
    if (request === undefined) {
      throw new TypeError("Open or select an InReview file and try again.");
    }
    const record = await this.#service.getReview(request.reviewId);
    const resolved = resolveFileRequest(record, request);
    if (resolved === undefined) {
      throw new TypeError("The selected InReview file no longer exists.");
    }
    if (record.review.state !== "active") {
      throw new CommentConflictError(
        `Review ${record.review.id} is archived and read-only.`,
      );
    }
    if (request.snapshotId !== record.review.currentSnapshotId) {
      throw new StaleCommentError(
        "File comments must target the current review snapshot.",
      );
    }
    const body = await this.#vscode.window.showInputBox({
      title: "Add File Comment",
      prompt: "Enter a plain-text comment for the whole file.",
      placeHolder: "This comment is not tied to a source line.",
      validateInput: (input) =>
        input.trim().length === 0 ? "Enter a comment." : undefined,
    });
    if (body === undefined) {
      return;
    }
    await this.#service.commentService.createThread({
      reviewId: request.reviewId,
      snapshotId: request.snapshotId,
      view: request.view,
      fileId: request.fileId,
      target: { kind: "file" },
      body,
      displayName: "You",
      expectedCurrentSnapshotId: record.review.currentSnapshotId,
    });
    await this.refresh();
  }

  public async resolve(value: unknown): Promise<void> {
    const thread = await this.findThread(value);
    await this.#service.commentService.resolve({
      reviewId: thread.reviewId,
      commentId: thread.commentId,
      expectedUpdatedAt: thread.updatedAt,
    });
    await this.refresh();
  }

  public async reopen(value: unknown): Promise<void> {
    const thread = await this.findThread(value);
    await this.#service.commentService.reopen({
      reviewId: thread.reviewId,
      commentId: thread.commentId,
      expectedUpdatedAt: thread.updatedAt,
    });
    await this.refresh();
  }

  public async revealComment(value: unknown): Promise<void> {
    const reference = commentReference(value);
    if (reference === undefined) {
      throw new TypeError("Select an InReview comment and try again.");
    }
    const record = await this.#service.getReview(reference.reviewId);
    const thread = record.threads.find(
      ({ commentId }) => commentId === reference.commentId,
    );
    if (thread === undefined) {
      throw new TypeError("The selected InReview comment no longer exists.");
    }
    const target = revealTarget(record, thread);
    if (target === undefined) {
      throw new TypeError("The comment's stored file snapshot is unavailable.");
    }
    await this.#nativeDiff.revealFile(target.request);
    if (target.line === undefined) {
      return;
    }
    await Promise.resolve();
    const uri = this.#codec.encode(target.modifiedIdentity);
    const editor = this.#vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === uri.toString(),
    );
    if (editor === undefined || target.line > editor.document.lineCount) {
      return;
    }
    const line = target.line - 1;
    const range = new this.#vscode.Range(
      line,
      0,
      line,
      editor.document.lineAt(line).range.end.character,
    );
    editor.selection = new this.#vscode.Selection(range.start, range.end);
    editor.revealRange(range, this.#vscode.TextEditorRevealType.InCenter);
  }

  public refresh(): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve();
    }
    this.#refreshQueued = true;
    this.#refreshPromise = this.#refreshPromise
      .catch((error: unknown) => {
        this.#logError("Could not refresh inline comments", error);
      })
      .then(async () => {
        while (this.#refreshQueued && !this.#disposed) {
          this.#refreshQueued = false;
          await this.rebuild();
        }
      })
      .catch((error: unknown) => {
        this.#logError("Could not refresh inline comments", error);
      });
    return this.#refreshPromise;
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.disposeThreads();
    for (const disposable of [...this.#disposables].reverse()) {
      disposable.dispose();
    }
  }

  private async rebuild(): Promise<void> {
    const desired: {
      readonly document: vscode.TextDocument;
      readonly placement: CommentPlacement;
      readonly record: ReviewRecord;
    }[] = [];
    const records = new Map<string, ReviewRecord | undefined>();
    const seen = new Set<string>();
    for (const document of this.#vscode.workspace.textDocuments) {
      const identity = this.decode(document.uri);
      if (identity?.side !== "modified") {
        continue;
      }
      let record = records.get(identity.reviewId);
      if (!records.has(identity.reviewId)) {
        try {
          record = await this.#service.getReview(identity.reviewId);
        } catch {
          record = undefined;
        }
        records.set(identity.reviewId, record);
      }
      if (record === undefined) {
        continue;
      }
      for (const placement of commentPlacements(record, identity)) {
        const key = `${document.uri.toString()}\0${placement.thread.commentId}`;
        if (!seen.has(key)) {
          seen.add(key);
          desired.push({ document, placement, record });
        }
      }
    }

    this.disposeThreads();
    if (this.#disposed) {
      return;
    }
    const next: vscode.CommentThread[] = [];
    for (const { document, placement, record } of desired) {
      if (placement.line > document.lineCount) {
        continue;
      }
      const line = placement.line - 1;
      const endCharacter = document.lineAt(line).range.end.character;
      const range = new this.#vscode.Range(line, 0, line, endCharacter);
      const comments = placement.thread.messages.map((message) =>
        this.renderMessage(placement.thread, message, record),
      );
      const rendered = this.#controller.createCommentThread(
        document.uri,
        range,
        comments,
      );
      rendered.collapsibleState =
        this.#vscode.CommentThreadCollapsibleState.Expanded;
      rendered.canReply =
        record.review.state === "active" && placement.thread.state === "open";
      rendered.state =
        placement.thread.state === "resolved"
          ? this.#vscode.CommentThreadState.Resolved
          : this.#vscode.CommentThreadState.Unresolved;
      rendered.contextValue = threadContext(placement, record);
      rendered.label = threadLabel(placement);
      this.#threadMetadata.set(rendered, { value: placement.thread });
      next.push(rendered);
    }
    this.#threads = next;
  }

  private renderMessage(
    thread: PersistedCommentThread,
    message: CommentMessage,
    record: ReviewRecord,
  ): vscode.Comment {
    const editable = record.review.state === "active" && message.author === "user";
    const rendered: vscode.Comment = {
      body: message.body,
      mode: this.#vscode.CommentMode.Preview,
      author: { name: message.author === "agent" ? "Agent" : "You" },
      contextValue: editable
        ? "inreview.comment.user"
        : message.author === "agent"
          ? "inreview.comment.agent"
          : "inreview.comment.user.readOnly",
      timestamp: new Date(message.updatedAt),
      ...(message.updatedAt === message.createdAt ? {} : { label: "Edited" }),
    };
    this.#messageMetadata.set(rendered, { thread, message });
    return rendered;
  }

  private decode(uri: vscode.Uri): VirtualDocumentIdentity | undefined {
    try {
      return this.#codec.decode(uri);
    } catch (error) {
      if (error instanceof InvalidVirtualDocumentUriError) {
        return undefined;
      }
      throw error;
    }
  }

  private fileRequestFrom(
    values: readonly unknown[],
  ): RevealFileRequest | undefined {
    for (const value of values) {
      const uri = asUri(value);
      if (uri !== undefined) {
        const identity = this.decode(uri);
        if (identity !== undefined) {
          return requestFromIdentity(identity);
        }
      }
      const direct = asRevealFileRequest(value);
      if (direct !== undefined) {
        return direct;
      }
      if (isRecord(value)) {
        const nested = asRevealFileRequest(
          asArray(value.command)?.[0] ??
            asArray(asRecord(value.command)?.arguments)?.[0],
        );
        if (nested !== undefined) {
          return nested;
        }
      }
    }
    return undefined;
  }

  private async findThread(value: unknown): Promise<PersistedCommentThread> {
    if (isCommentThread(value)) {
      const metadata = this.#threadMetadata.get(value);
      if (metadata !== undefined) {
        return metadata.value;
      }
    }
    const reference = commentReference(value);
    if (reference === undefined) {
      throw new TypeError("Select an InReview comment and try again.");
    }
    const record = await this.#service.getReview(reference.reviewId);
    const thread = record.threads.find(
      ({ commentId }) => commentId === reference.commentId,
    );
    if (thread === undefined) {
      throw new TypeError("The selected InReview comment no longer exists.");
    }
    return thread;
  }

  private disposeThreads(): void {
    for (const thread of this.#threads) {
      thread.dispose();
    }
    this.#threads = [];
  }
}

export function resolveCommentDocument(
  record: ReviewRecord,
  identity: VirtualDocumentIdentity,
): CommentDocumentTarget | undefined {
  if (
    identity.side !== "modified" ||
    record.review.state !== "active" ||
    identity.snapshotId !== record.review.currentSnapshotId
  ) {
    return undefined;
  }
  const snapshot = record.snapshots.find(({ id }) => id === identity.snapshotId);
  const view = snapshot?.views.find(
    ({ identity: candidate }) =>
      viewIdentityKey(candidate) === viewIdentityKey(identity.view),
  );
  const file = view?.files.find(({ fileId }) => fileId === identity.fileId);
  if (
    snapshot === undefined ||
    file?.kind !== "text" ||
    file.status === "deleted" ||
    file.currentPath !== identity.repositoryPath
  ) {
    return undefined;
  }
  return { record, snapshot, file };
}

export function commentableRanges(
  record: ReviewRecord,
  identity: VirtualDocumentIdentity,
): readonly LineRange[] {
  const target = resolveCommentDocument(record, identity);
  if (target === undefined) {
    return [];
  }
  return (
    target.file.commentableRanges ??
    rangesFromHunks(target.file)
  ).filter(({ start, end }) => start > 0 && end >= start);
}

export function commentPlacements(
  record: ReviewRecord,
  identity: VirtualDocumentIdentity,
): readonly CommentPlacement[] {
  if (identity.side !== "modified") {
    return [];
  }
  return record.threads.flatMap((thread) => {
    const location =
      thread.currentness === "current" && thread.projection !== null
        ? {
            snapshotId: thread.projection.snapshotId,
            view: thread.projection.view,
            path: thread.projection.path,
            target: thread.projection.target,
            historical: false,
          }
        : {
            snapshotId: thread.anchor.snapshotId,
            view: thread.anchor.view,
            path: thread.anchor.currentPath ?? thread.anchor.originalPath,
            target: thread.anchor.target,
            historical: true,
          };
    if (
      location.path === null ||
      location.snapshotId !== identity.snapshotId ||
      viewIdentityKey(location.view) !== viewIdentityKey(identity.view) ||
      location.path !== identity.repositoryPath
    ) {
      return [];
    }
    const snapshot = record.snapshots.find(({ id }) => id === location.snapshotId);
    const view = snapshot?.views.find(
      ({ identity: candidate }) =>
        viewIdentityKey(candidate) === viewIdentityKey(identity.view),
    );
    const file = view?.files.find(({ fileId }) => fileId === identity.fileId);
    if (file === undefined || !matchesThreadFile(thread, file, location.historical)) {
      return [];
    }
    return [
      {
        thread,
        line: location.target.kind === "line" ? location.target.line : 1,
        fileLevel: location.target.kind === "file",
        historical: location.historical,
      },
    ];
  });
}

function rangesFromHunks(file: FileManifestEntry): readonly LineRange[] {
  const lines = new Set<number>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (
        (line.kind === "addition" || line.kind === "context") &&
        line.newLine !== null
      ) {
        lines.add(line.newLine);
      }
    }
  }
  const ranges: { start: number; end: number }[] = [];
  for (const line of [...lines].sort((left, right) => left - right)) {
    const previous = ranges.at(-1);
    if (previous !== undefined && previous.end + 1 === line) {
      previous.end = line;
    } else {
      ranges.push({ start: line, end: line });
    }
  }
  return ranges;
}

function matchesThreadFile(
  thread: PersistedCommentThread,
  file: FileManifestEntry,
  historical: boolean,
): boolean {
  if (historical && thread.anchor.fileId !== undefined) {
    return thread.anchor.fileId === file.fileId;
  }
  const path = historical
    ? thread.anchor.currentPath ?? thread.anchor.originalPath
    : thread.projection?.path;
  return path === file.currentPath || path === file.originalPath;
}

function threadContext(
  placement: CommentPlacement,
  record: ReviewRecord,
): string {
  const mutability = record.review.state === "active" ? "writable" : "readOnly";
  return [
    "inreview.thread",
    placement.thread.state,
    placement.historical ? "outdated" : "current",
    placement.fileLevel ? "file" : "line",
    mutability,
  ].join(".");
}

function threadLabel(placement: CommentPlacement): string {
  const labels = [
    placement.fileLevel ? "File-level comment (not tied to a source line)" : undefined,
    placement.historical ? "Original snapshot" : undefined,
  ].filter((value): value is string => value !== undefined);
  return labels.join(" · ") || "InReview comment";
}

function revealTarget(
  record: ReviewRecord,
  thread: PersistedCommentThread,
):
  | {
      readonly request: RevealFileRequest;
      readonly modifiedIdentity: VirtualDocumentIdentity;
      readonly line?: number;
    }
  | undefined {
  const current = thread.currentness === "current" && thread.projection !== null;
  const snapshotId = current
    ? thread.projection?.snapshotId
    : thread.anchor.snapshotId;
  const viewIdentity = current ? thread.projection?.view : thread.anchor.view;
  const path = current
    ? thread.projection?.path
    : thread.anchor.currentPath ?? thread.anchor.originalPath;
  const target = current ? thread.projection?.target : thread.anchor.target;
  if (
    snapshotId === undefined ||
    viewIdentity === undefined ||
    path === undefined ||
    path === null ||
    target === undefined
  ) {
    return undefined;
  }
  const snapshot = record.snapshots.find(({ id }) => id === snapshotId);
  const view = snapshot?.views.find(
    ({ identity }) => viewIdentityKey(identity) === viewIdentityKey(viewIdentity),
  );
  const candidates =
    view?.files.filter((file) => {
      const exactHistoricalFile =
        current ||
        thread.anchor.fileId === undefined ||
        thread.anchor.fileId === file.fileId;
      return (
        exactHistoricalFile &&
        (file.currentPath === path || file.originalPath === path)
      );
    }) ?? [];
  const file = candidates.length === 1 ? candidates[0] : undefined;
  const repositoryPath = file?.currentPath ?? file?.originalPath;
  if (file === undefined || repositoryPath === null || repositoryPath === undefined) {
    return undefined;
  }
  return {
    request: {
      reviewId: record.review.id,
      snapshotId,
      view: viewIdentity,
      fileId: file.fileId,
      readOnly: record.review.state === "archived" || !current,
    },
    modifiedIdentity: {
      reviewId: record.review.id,
      snapshotId,
      view: viewIdentity,
      fileId: file.fileId,
      side: "modified",
      repositoryPath,
    },
    ...(target.kind === "line" ? { line: target.line } : {}),
  };
}

function resolveFileRequest(
  record: ReviewRecord,
  request: RevealFileRequest,
): FileManifestEntry | undefined {
  return record.snapshots
    .find(({ id }) => id === request.snapshotId)
    ?.views.find(
      ({ identity }) =>
        viewIdentityKey(identity) === viewIdentityKey(request.view),
    )
    ?.files.find(({ fileId }) => fileId === request.fileId);
}

function requestFromIdentity(
  identity: VirtualDocumentIdentity,
): RevealFileRequest {
  return {
    reviewId: identity.reviewId,
    snapshotId: identity.snapshotId,
    view: identity.view,
    fileId: identity.fileId,
    readOnly: identity.side === "original",
  };
}

function asRevealFileRequest(value: unknown): RevealFileRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const view = asView(value.view);
  return typeof value.reviewId === "string" &&
    typeof value.snapshotId === "string" &&
    typeof value.fileId === "string" &&
    typeof value.readOnly === "boolean" &&
    view !== undefined
    ? {
        reviewId: value.reviewId,
        snapshotId: value.snapshotId,
        view,
        fileId: value.fileId,
        readOnly: value.readOnly,
      }
    : undefined;
}

function commentReference(value: unknown): ThreadReference | undefined {
  if (isRecord(value)) {
    if (
      typeof value.reviewId === "string" &&
      typeof value.commentId === "string"
    ) {
      return { reviewId: value.reviewId, commentId: value.commentId };
    }
    if (typeof value.id === "string" && value.id.startsWith("comment:")) {
      const nested = asRecord(value.command);
      const request = asArray(nested?.arguments)?.[0];
      const fromRequest = commentReference(request);
      if (fromRequest !== undefined) {
        return fromRequest;
      }
    }
  }
  return undefined;
}

function asCommentReply(value: unknown): vscode.CommentReply | undefined {
  return isRecord(value) &&
    typeof value.text === "string" &&
    isCommentThread(value.thread)
    ? (value as unknown as vscode.CommentReply)
    : undefined;
}

function asComment(value: unknown): vscode.Comment | undefined {
  return isRecord(value) && "body" in value && "mode" in value
    ? (value as unknown as vscode.Comment)
    : undefined;
}

function isCommentThread(value: unknown): value is vscode.CommentThread {
  return (
    isRecord(value) &&
    "uri" in value &&
    "range" in value &&
    typeof value.dispose === "function"
  );
}

function asUri(value: unknown): vscode.Uri | undefined {
  return isRecord(value) &&
    typeof value.scheme === "string" &&
    typeof value.authority === "string" &&
    typeof value.path === "string" &&
    typeof value.toString === "function"
    ? (value as unknown as vscode.Uri)
    : undefined;
}

function asView(value: unknown): ViewIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.mode === "combined") {
    return { mode: "combined" };
  }
  return value.mode === "per-change" && typeof value.changeId === "string"
    ? { mode: "per-change", changeId: value.changeId }
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export type { RevealCommentRequest };
