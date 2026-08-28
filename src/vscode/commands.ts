import type { ReviewRecord } from "../domain/comments";
import { JjNoNewChangesError, JjSelectionError } from "../jj/errors";
import { LargeDiffConfirmationRequiredError } from "../review/errors";
import type {
  RefreshReviewResult,
  IncludeNewChangesResult,
  ReviewSelectionCandidate,
  ReviewSelectionPreview,
  ReviewService,
  ReviewStartSession,
  StartReviewResult,
} from "../review";
import type { RevealFileRequest } from "./activeReviewTree";
import type { RevealCommentRequest } from "./commentsTree";
import { mapUserFacingError } from "./errors";

const LAST_CHANGE_COUNT_KEY = "inreview.review.lastChangeCount";
const DISPLAY_MODE_KEY = "inreview.review.displayMode";
const INITIAL_HISTORY_COUNT = 50;
const MAX_HISTORY_COUNT = 200;

export interface CommandQuickPickItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly alwaysShow?: boolean;
}

export interface CommandUi {
  showInputBox(options: {
    readonly title: string;
    readonly prompt: string;
    readonly value: string;
    readonly validateInput: (value: string) => string | undefined;
  }): Promise<string | undefined>;
  showQuickPick(
    items: readonly string[],
    options: { readonly title: string; readonly placeHolder?: string },
  ): Promise<string | undefined>;
  showItemQuickPick(
    items: readonly CommandQuickPickItem[],
    options: { readonly title: string; readonly placeHolder?: string },
  ): Promise<string | undefined>;
  showInformationMessage(message: string): Promise<unknown>;
  showWarningMessage(message: string): Promise<unknown>;
  showErrorMessage(message: string): Promise<unknown>;
}

export interface WorkspacePreferenceStore {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface LaterCommandDelegates {
  revealFile?(request: RevealFileRequest): Promise<void> | void;
  revealComment?(request: RevealCommentRequest): Promise<void> | void;
  addFileComment?(...args: readonly unknown[]): Promise<void> | void;
  resolveComment?(...args: readonly unknown[]): Promise<void> | void;
  reopenComment?(...args: readonly unknown[]): Promise<void> | void;
  submitComment?(...args: readonly unknown[]): Promise<void> | void;
  editComment?(...args: readonly unknown[]): Promise<void> | void;
  saveComment?(...args: readonly unknown[]): Promise<void> | void;
  cancelCommentEdit?(...args: readonly unknown[]): Promise<void> | void;
  deleteComment?(...args: readonly unknown[]): Promise<void> | void;
  copyCopilotCliMcpSetup?(): Promise<void> | void;
  showMcpServerStatus?(): Promise<void> | void;
}

export interface CommandControllerOptions {
  readonly service: ReviewCommandService | undefined;
  readonly ui: CommandUi;
  readonly workspaceState: WorkspacePreferenceStore;
  readonly defaultChangeCount: number;
  readonly delegates?: LaterCommandDelegates;
  readonly onModeChanged: () => void;
  readonly logError: (message: string, error: unknown) => void;
  readonly unavailableReason?: string;
}

export class ReviewCommandController {
  #startingReview = false;

  public constructor(private readonly options: CommandControllerOptions) {}

  public get displayMode(): "combined" | "per-change" {
    return this.options.workspaceState.get<"combined" | "per-change">(
      DISPLAY_MODE_KEY,
      "combined",
    ) === "per-change"
      ? "per-change"
      : "combined";
  }

  public async startReview(): Promise<void> {
    const service = this.requireService();
    if (service === undefined) {
      return;
    }
    if (this.#startingReview) {
      await this.options.ui.showInformationMessage(
        "A Start Review selection is already open.",
      );
      return;
    }
    this.#startingReview = true;
    try {
      const active = await service.getActiveReviewOrUndefined();
      let activeReviewIdToArchive: string | undefined;
      if (active !== undefined) {
        const choice = await this.options.ui.showQuickPick(
          ["Archive Current Review", "Cancel"],
          {
            title: "An active review already exists",
            placeHolder: "Archive the active review before starting a new one?",
          },
        );
        if (choice !== "Archive Current Review") {
          return;
        }
        activeReviewIdToArchive = active.review.id;
      }
      const method = await this.options.ui.showQuickPick(
        [
          "Choose Range",
          "Current Stack (Last X)",
          "Advanced: Enter jj Revset",
        ],
        {
          title: "Start Review",
          placeHolder: "Choose which jj changes to review.",
        },
      );
      if (method === undefined) {
        return;
      }
      const session = await service.beginStartReview();
      let result: StartReviewResult | undefined;
      while (result === undefined) {
        const preview =
          method === "Choose Range"
            ? await this.chooseRangeSelection(session)
            : method === "Current Stack (Last X)"
              ? await this.chooseLastSelection(session)
              : await this.chooseRevsetSelection(session);
        if (preview === undefined) {
          return;
        }
        const confirmation = await this.confirmSelectionPreview(preview);
        if (confirmation === "cancel") {
          return;
        }
        if (confirmation === "back") {
          continue;
        }
        result = await this.startWithLargeDiffPrompt(
          session,
          preview,
          activeReviewIdToArchive,
        );
        if (result === undefined) {
          return;
        }
      }
      if (result.truncatedAtRoot) {
        await this.options.ui.showInformationMessage(
          `The repository has only ${String(result.actualChangeCount)} eligible ancestor changes. InReview included all of them.`,
        );
      }
    } catch (error) {
      await this.reportError("Could not start the review", error);
    } finally {
      this.#startingReview = false;
    }
  }

  public async refreshReview(): Promise<void> {
    const service = this.requireService();
    if (service === undefined) {
      return;
    }
    try {
      let result: RefreshReviewResult;
      try {
        result = await service.refreshReview();
      } catch (error) {
        if (!(error instanceof LargeDiffConfirmationRequiredError)) {
          throw error;
        }
        if (!(await this.confirmLargeDiff(error.changedLineCount))) {
          return;
        }
        result = await service.refreshReview({ confirmLargeDiff: true });
      }
      if (!result.changed) {
        await this.options.ui.showInformationMessage(
          "The active review is already current. No snapshot was created.",
        );
      }
    } catch (error) {
      await this.reportError("Could not refresh the review", error);
    }
  }

  public async includeNewChanges(): Promise<void> {
    const service = this.requireService();
    if (service === undefined) {
      return;
    }
    try {
      let result: IncludeNewChangesResult;
      try {
        result = await service.includeNewChanges();
      } catch (error) {
        if (!(error instanceof LargeDiffConfirmationRequiredError)) {
          throw error;
        }
        if (!(await this.confirmLargeDiff(error.changedLineCount))) {
          return;
        }
        result = await service.includeNewChanges({ confirmLargeDiff: true });
      }
      await this.options.ui.showInformationMessage(
        `Included ${String(result.addedChangeCount)} new ${result.addedChangeCount === 1 ? "change" : "changes"} in the active review.`,
      );
    } catch (error) {
      if (error instanceof JjNoNewChangesError) {
        await this.options.ui.showInformationMessage(error.message);
        return;
      }
      await this.reportError("Could not include new changes", error);
    }
  }

  public async archiveReview(): Promise<void> {
    await this.run("Could not archive the review", async (service) => {
      await service.archiveActiveReview();
    });
  }

  public async restoreArchivedReview(value?: unknown): Promise<void> {
    const reviewId = reviewIdFromArgument(value);
    if (reviewId === undefined) {
      await this.options.ui.showInformationMessage(
        "Select an archived review in History, then run Restore Archived Review.",
      );
      return;
    }
    await this.run("Could not restore the review", async (service) => {
      const active = await service.getActiveReviewOrUndefined();
      if (active === undefined) {
        await service.restoreReview(reviewId);
        return;
      }
      const choice = await this.options.ui.showQuickPick(
        ["Archive Current and Restore", "Cancel"],
        {
          title: "An active review already exists",
          placeHolder: "Archive it and restore the selected review?",
        },
      );
      if (choice === "Archive Current and Restore") {
        await service.archiveActiveAndRestoreReview(reviewId, {
          expectedCurrentSnapshotId: active.review.currentSnapshotId,
        });
      }
    });
  }

  public async renameReview(): Promise<void> {
    await this.run("Could not rename the review", async (service) => {
      const active = await service.getActiveReview();
      const value = await this.options.ui.showInputBox({
        title: "Rename Review",
        prompt: "Enter a new name for the active review.",
        value: active.review.name,
        validateInput: (name) =>
          name.trim().length === 0
            ? "Enter a review name."
            : name.trim().length > 512
              ? "Use no more than 512 characters."
              : undefined,
      });
      if (value !== undefined) {
        await service.renameActiveReview(value, {
          expectedCurrentSnapshotId: active.review.currentSnapshotId,
        });
      }
    });
  }

  public async deleteArchivedReview(value?: unknown): Promise<void> {
    const reviewId = reviewIdFromArgument(value);
    if (reviewId === undefined) {
      await this.options.ui.showInformationMessage(
        "Select an archived review in History, then run Delete Archived Review.",
      );
      return;
    }
    await this.run("Could not delete the archived review", async (service) => {
      const record = await service.getReview(reviewId);
      const choice = await this.options.ui.showQuickPick(["Delete", "Cancel"], {
        title: `Delete “${record.review.name}”?`,
        placeHolder: "This permanently removes its stored snapshots and comments.",
      });
      if (choice === "Delete") {
        await service.deleteArchivedReview(reviewId);
      }
    });
  }

  public async showCombined(): Promise<void> {
    await this.setDisplayMode("combined");
  }

  public async showPerChange(): Promise<void> {
    await this.setDisplayMode("per-change");
  }

  public async revealFile(value?: unknown): Promise<void> {
    await this.delegate(
      "revealFile",
      "Native diff documents are not available yet.",
      value,
    );
  }

  public async revealComment(value?: unknown): Promise<void> {
    await this.delegate(
      "revealComment",
      "Inline comment reveal is not available yet.",
      value,
    );
  }

  public async laterCommand(
    name:
      | "addFileComment"
      | "resolveComment"
      | "reopenComment"
      | "submitComment"
      | "editComment"
      | "saveComment"
      | "cancelCommentEdit"
      | "deleteComment"
      | "copyCopilotCliMcpSetup"
      | "showMcpServerStatus",
    ...args: readonly unknown[]
  ): Promise<void> {
    const messages: Record<typeof name, string> = {
      addFileComment: "File comments are not available yet.",
      resolveComment: "Comment resolution is not available yet.",
      reopenComment: "Comment reopening is not available yet.",
      submitComment: "Comment submission is not available yet.",
      editComment: "Comment editing is not available yet.",
      saveComment: "Comment editing is not available yet.",
      cancelCommentEdit: "Comment editing is not available yet.",
      deleteComment: "Comment deletion is not available yet.",
      copyCopilotCliMcpSetup: "The MCP bridge is not available yet.",
      showMcpServerStatus: "The MCP bridge is not available yet.",
    };
    await this.delegate(name, messages[name], ...args);
  }

  private async startWithLargeDiffPrompt(
    session: ReviewStartSession,
    preview: ReviewSelectionPreview,
    activeReviewIdToArchive: string | undefined,
  ): Promise<StartReviewResult | undefined> {
    const start = async (confirmLargeDiff: boolean): Promise<StartReviewResult> =>
      session.start(preview, {
        ...(activeReviewIdToArchive === undefined
          ? {}
          : { activeReviewIdToArchive }),
        confirmLargeDiff,
      });
    try {
      return await start(false);
    } catch (error) {
      if (!(error instanceof LargeDiffConfirmationRequiredError)) {
        throw error;
      }
      return (await this.confirmLargeDiff(error.changedLineCount))
        ? start(true)
        : undefined;
    }
  }

  private async chooseLastSelection(
    session: ReviewStartSession,
  ): Promise<ReviewSelectionPreview | undefined> {
    const remembered = this.options.workspaceState.get(
      LAST_CHANGE_COUNT_KEY,
      this.options.defaultChangeCount,
    );
    const input = await this.options.ui.showInputBox({
      title: "Current Stack",
      prompt: "Review the last X jj changes ending at @.",
      value: String(remembered),
      validateInput: validatePositiveInteger,
    });
    if (input === undefined) {
      return undefined;
    }
    const validation = validatePositiveInteger(input);
    if (validation !== undefined) {
      await this.options.ui.showErrorMessage(validation);
      return undefined;
    }
    const count = Number(input.trim());
    await this.options.workspaceState.update(LAST_CHANGE_COUNT_KEY, count);
    return session.selectLast(count);
  }

  private async chooseRangeSelection(
    session: ReviewStartSession,
  ): Promise<ReviewSelectionPreview | undefined> {
    let historyCount = INITIAL_HISTORY_COUNT;
    let newestChangeId: string | undefined;
    for (;;) {
      const history = await session.listHistory(historyCount);
      const selectable = history.commits.filter(isSelectableCandidate);
      if (selectable.length === 0) {
        await this.options.ui.showInformationMessage(
          "No conflict-free, single-parent changes are available in this history.",
        );
        return undefined;
      }
      if (newestChangeId === undefined) {
        const items = selectable
          .slice()
          .reverse()
          .map((commit) => candidateItem("newest", commit));
        if (history.hasMore && historyCount < MAX_HISTORY_COUNT) {
          items.push(loadOlderItem());
        }
        const picked = await this.options.ui.showItemQuickPick(items, {
          title: "Newest included change",
          placeHolder: "Search by description or change ID.",
        });
        if (picked === undefined) {
          return undefined;
        }
        if (picked === "load-older") {
          historyCount = Math.min(
            historyCount + INITIAL_HISTORY_COUNT,
            MAX_HISTORY_COUNT,
          );
          continue;
        }
        newestChangeId = picked.slice("newest:".length);
      }

      const newest = history.commits.find(
        ({ changeId }) => changeId === newestChangeId,
      );
      if (newest === undefined) {
        newestChangeId = undefined;
        continue;
      }
      const ancestors = traceSelectableAncestors(newest, history.commits);
      const oldestItems = ancestors.map((commit, index) => ({
        ...candidateItem("oldest", commit),
        label:
          index === 0
            ? `$(check) This change only — ${candidateLabel(commit)}`
            : candidateLabel(commit),
      }));
      if (history.hasMore && historyCount < MAX_HISTORY_COUNT) {
        oldestItems.push(loadOlderItem());
      }
      const oldestPicked = await this.options.ui.showItemQuickPick(oldestItems, {
        title: "Oldest included change",
        placeHolder: "Every change through the selected newest change is included.",
      });
      if (oldestPicked === undefined) {
        return undefined;
      }
      if (oldestPicked === "load-older") {
        historyCount = Math.min(
          historyCount + INITIAL_HISTORY_COUNT,
          MAX_HISTORY_COUNT,
        );
        continue;
      }
      return session.selectRange(
        oldestPicked.slice("oldest:".length),
        newest.changeId,
      );
    }
  }

  private async chooseRevsetSelection(
    session: ReviewStartSession,
  ): Promise<ReviewSelectionPreview | undefined> {
    let value = "";
    for (;;) {
      const input = await this.options.ui.showInputBox({
        title: "Advanced jj Revset",
        prompt: "Enter a revset that resolves to one contiguous single-parent stack.",
        value,
        validateInput: validateRevsetInput,
      });
      if (input === undefined) {
        return undefined;
      }
      const validation = validateRevsetInput(input);
      if (validation !== undefined) {
        await this.options.ui.showErrorMessage(validation);
        value = input;
        continue;
      }
      try {
        return await session.selectRevset(input.trim());
      } catch (error) {
        if (!(error instanceof JjSelectionError)) {
          throw error;
        }
        await this.options.ui.showErrorMessage(error.message);
        value = input;
      }
    }
  }

  private async confirmSelectionPreview(
    preview: ReviewSelectionPreview,
  ): Promise<"start" | "back" | "cancel"> {
    const summary = preview.commits
      .slice(0, 5)
      .map(
        (commit) =>
          `${commit.changeId.slice(0, 8)} ${commit.subject.trim() || "(no description)"}`,
      )
      .join(" -> ") +
      (preview.commits.length > 5
        ? ` -> ... ${String(preview.commits.length - 5)} more`
        : "");
    const choice = await this.options.ui.showQuickPick(
      ["Start Review", "Back", "Cancel"],
      {
        title: `Review ${String(preview.actualChangeCount)} ${preview.actualChangeCount === 1 ? "change" : "changes"}`,
        placeHolder: summary,
      },
    );
    return choice === "Start Review"
      ? "start"
      : choice === "Back"
        ? "back"
        : "cancel";
  }

  private async confirmLargeDiff(changedLineCount: number): Promise<boolean> {
    return (
      (await this.options.ui.showQuickPick(["Continue", "Cancel"], {
        title: "Large review",
        placeHolder: `This review changes ${String(changedLineCount)} lines. Continue?`,
      })) === "Continue"
    );
  }

  private async setDisplayMode(mode: "combined" | "per-change"): Promise<void> {
    if (this.requireService() === undefined) {
      return;
    }
    await this.options.workspaceState.update(DISPLAY_MODE_KEY, mode);
    this.options.onModeChanged();
  }

  private async run(
    context: string,
    operation: (service: ReviewCommandService) => Promise<void>,
  ): Promise<void> {
    const service = this.requireService();
    if (service === undefined) {
      return;
    }
    try {
      await operation(service);
    } catch (error) {
      await this.reportError(context, error);
    }
  }

  private requireService(): ReviewCommandService | undefined {
    if (this.options.service === undefined) {
      void this.options.ui.showInformationMessage(
        this.options.unavailableReason ?? "InReview is not available in this window.",
      );
    }
    return this.options.service;
  }

  private async delegate(
    name: keyof LaterCommandDelegates,
    unavailable: string,
    ...args: readonly unknown[]
  ): Promise<void> {
    const handler = Reflect.get(this.options.delegates ?? {}, name) as
      | ((...values: readonly unknown[]) => Promise<void> | void)
      | undefined;
    if (handler === undefined) {
      await this.options.ui.showInformationMessage(unavailable);
      return;
    }
    try {
      await handler(...args);
    } catch (error) {
      await this.reportError(`The ${name} command failed`, error);
    }
  }

  private async reportError(context: string, error: unknown): Promise<void> {
    this.options.logError(context, error);
    const mapped = mapUserFacingError(error);
    if (mapped.severity === "information") {
      await this.options.ui.showInformationMessage(mapped.message);
    } else if (mapped.severity === "warning") {
      await this.options.ui.showWarningMessage(mapped.message);
    } else {
      await this.options.ui.showErrorMessage(mapped.message);
    }
  }
}

export function validatePositiveInteger(value: string): string | undefined {
  const normalized = value.trim();
  return /^[1-9]\d*$/u.test(normalized) &&
    Number.isSafeInteger(Number(normalized))
    ? undefined
    : "Enter a positive whole number.";
}

export function validateRevsetInput(value: string): string | undefined {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return "Enter a jj revset.";
  }
  if (normalized.length > 4096 || normalized.includes("\0")) {
    return "Use a jj revset with no more than 4096 characters.";
  }
  return undefined;
}

function isSelectableCandidate(
  candidate: ReviewSelectionCandidate,
): boolean {
  return !candidate.conflict && !candidate.divergent && !candidate.merge;
}

function candidateLabel(candidate: ReviewSelectionCandidate): string {
  return candidate.subject.trim() || "(no description)";
}

function candidateItem(
  prefix: "newest" | "oldest",
  candidate: ReviewSelectionCandidate,
): CommandQuickPickItem {
  return {
    id: `${prefix}:${candidate.changeId}`,
    label: candidate.currentWorkingCopy
      ? `$(circle-filled) ${candidateLabel(candidate)}`
      : candidateLabel(candidate),
    description: candidate.changeId.slice(0, 12),
    ...(candidate.currentWorkingCopy
      ? { detail: "Current working copy (@)" }
      : {}),
  };
}

function loadOlderItem(): CommandQuickPickItem {
  return {
    id: "load-older",
    label: "$(history) Load older changes",
    alwaysShow: true,
  };
}

function traceSelectableAncestors(
  newest: ReviewSelectionCandidate,
  commits: readonly ReviewSelectionCandidate[],
): readonly ReviewSelectionCandidate[] {
  const byCommitId = new Map(commits.map((commit) => [commit.commitId, commit]));
  const result: ReviewSelectionCandidate[] = [];
  let current: ReviewSelectionCandidate | undefined = newest;
  while (current !== undefined && isSelectableCandidate(current)) {
    result.push(current);
    const parentId: string | undefined = current.parentCommitIds[0];
    current = parentId === undefined ? undefined : byCommitId.get(parentId);
  }
  return result;
}

function reviewIdFromArgument(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string"
  ) {
    const prefixes = ["history:", "review:"];
    for (const prefix of prefixes) {
      if (value.id.startsWith(prefix)) {
        return value.id.slice(prefix.length).split(":", 1)[0];
      }
    }
  }
  return undefined;
}

export type ReviewCommandService = Pick<
  ReviewService,
  | "getActiveReviewOrUndefined"
  | "getActiveReview"
  | "beginStartReview"
  | "startReview"
  | "archiveAndStartReview"
  | "refreshReview"
  | "includeNewChanges"
  | "archiveActiveReview"
  | "restoreReview"
  | "archiveActiveAndRestoreReview"
  | "renameActiveReview"
  | "deleteArchivedReview"
  | "getReview"
>;

export type ReviewCommandRecord = ReviewRecord;
