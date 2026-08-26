import type { ReviewRecord } from "../domain/comments";
import { LargeDiffConfirmationRequiredError } from "../review/errors";
import type {
  RefreshReviewResult,
  ReviewService,
  StartReviewResult,
} from "../review";
import type { RevealFileRequest } from "./activeReviewTree";
import type { RevealCommentRequest } from "./commentsTree";
import { mapUserFacingError } from "./errors";

const LAST_CHANGE_COUNT_KEY = "inreview.review.lastChangeCount";
const DISPLAY_MODE_KEY = "inreview.review.displayMode";

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
    const remembered = this.options.workspaceState.get(
      LAST_CHANGE_COUNT_KEY,
      this.options.defaultChangeCount,
    );
    const input = await this.options.ui.showInputBox({
      title: "Start Review",
      prompt: "Review the last X jj changes.",
      value: String(remembered),
      validateInput: validatePositiveInteger,
    });
    if (input === undefined) {
      return;
    }
    const count = Number(input.trim());
    const validation = validatePositiveInteger(input);
    if (validation !== undefined) {
      await this.options.ui.showErrorMessage(validation);
      return;
    }
    await this.options.workspaceState.update(LAST_CHANGE_COUNT_KEY, count);

    try {
      const active = await service.getActiveReviewOrUndefined();
      let archiveActive = false;
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
        archiveActive = true;
      }
      const result = await this.startWithLargeDiffPrompt(
        service,
        count,
        archiveActive,
      );
      if (result?.truncatedAtRoot === true) {
        await this.options.ui.showInformationMessage(
          `The repository has only ${String(result.actualChangeCount)} eligible ancestor changes. InReview included all of them.`,
        );
      }
    } catch (error) {
      await this.reportError("Could not start the review", error);
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
      copyCopilotCliMcpSetup: "The MCP server is not available yet.",
      showMcpServerStatus: "The MCP server is not available yet.",
    };
    await this.delegate(name, messages[name], ...args);
  }

  private async startWithLargeDiffPrompt(
    service: ReviewCommandService,
    count: number,
    archiveActive: boolean,
  ): Promise<StartReviewResult | undefined> {
    const start = async (confirmLargeDiff: boolean): Promise<StartReviewResult> =>
      archiveActive
        ? service.archiveAndStartReview({
            requestedChangeCount: count,
            confirmLargeDiff,
          })
        : service.startReview({
            requestedChangeCount: count,
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
  | "startReview"
  | "archiveAndStartReview"
  | "refreshReview"
  | "archiveActiveReview"
  | "restoreReview"
  | "archiveActiveAndRestoreReview"
  | "renameActiveReview"
  | "deleteArchivedReview"
  | "getReview"
>;

export type ReviewCommandRecord = ReviewRecord;
