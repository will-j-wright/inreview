import { describe, expect, it, vi } from "vitest";

import { JjNoNewChangesError } from "../../src/jj/errors";
import { LargeDiffConfirmationRequiredError } from "../../src/review";
import {
  ActiveReviewTree,
  buildActiveReviewItem,
  type DisplayMode,
} from "../../src/vscode/activeReviewTree";
import { buildCommentGroups } from "../../src/vscode/commentsTree";
import {
  ReviewCommandController,
  type CommandUi,
  type ReviewCommandService,
  type WorkspacePreferenceStore,
} from "../../src/vscode/commands";
import type {
  ReviewSelectionPreview,
  ReviewStartSession,
} from "../../src/review";
import { buildHistoryReviewItem } from "../../src/vscode/historyTree";
import { makeReviewRecord } from "./storageFixtures";

const fingerprint = "a".repeat(64);

describe("review tree models", () => {
  it("stays inert and useful in a restricted workspace", async () => {
    const tree = new ActiveReviewTree({
      query: undefined,
      state: {
        kind: "restricted",
        message: "Trust this workspace to run jj.",
      },
      getDisplayMode: () => "combined",
    });

    await expect(tree.getRoots()).resolves.toEqual([
      expect.objectContaining({
        label: "Restricted Workspace",
        contextValue: "inreview.state.restricted",
        icon: "lock",
      }),
    ]);
  });

  it.each<DisplayMode>(["combined", "per-change"])(
    "builds the active review in %s mode with stable actions",
    (mode) => {
      const record = makeReviewRecord(fingerprint);
      const root = buildActiveReviewItem(record, mode);
      const fileGroups =
        root.children?.filter(({ contextValue }) =>
          contextValue.startsWith("inreview.files."),
        ) ?? [];

      expect(root.contextValue).toBe("inreview.review.active");
      expect(root.description).toContain("1 open");
      expect(fileGroups).toHaveLength(1);
      expect(fileGroups[0]?.children?.[0]).toMatchObject({
        label: "file.txt",
        contextValue: "inreview.file.added.text",
        command: {
          command: "inreview.revealFile",
        },
      });
      expect(fileGroups[0]?.children?.[0]?.description).toContain(
        mode === "combined" ? "1 comments" : "text",
      );
    },
  );

  it("groups current, outdated, and resolved comments", () => {
    const record = makeReviewRecord(fingerprint);
    const groups = buildCommentGroups(record);

    expect(groups.map(({ label, description }) => [label, description])).toEqual([
      ["Open Current", "1"],
      ["Open Outdated", "0"],
      ["Resolved", "0"],
    ]);
    expect(groups[0]?.children?.[0]?.command).toMatchObject({
      command: "inreview.revealComment",
    });
  });

  it("shows archived metadata and read-only file requests", () => {
    const record = makeReviewRecord(fingerprint, { state: "archived" });
    const root = buildHistoryReviewItem(record);
    const request =
      root.children?.[0]?.children?.[0]?.command?.arguments?.[0];

    expect(root.contextValue).toBe("inreview.review.archived");
    expect(request).toMatchObject({ reviewId: record.review.id, readOnly: true });
  });
});

describe("review command flows", () => {
  it("archives an active review, confirms a large diff, and reports root truncation", async () => {
    const record = makeReviewRecord(fingerprint);
    const service = fakeService(record);
    const preview = selectionPreview();
    const start = vi
      .fn()
      .mockRejectedValueOnce(new LargeDiffConfirmationRequiredError(20_000, 10_000))
      .mockResolvedValueOnce({
        record,
        actualChangeCount: 2,
        truncatedAtRoot: true,
      });
    const session = fakeStartSession(preview, start);
    service.beginStartReview = vi.fn().mockResolvedValue(session);
    const ui = new FakeUi(
      "3",
      [
        "Archive Current Review",
        "Current Stack (Last X)",
        "Start Review",
        "Continue",
      ],
    );
    const state = new FakeState();
    const controller = controllerFor(service, ui, state);

    await controller.startReview();

    expect(start).toHaveBeenNthCalledWith(1, preview, {
      activeReviewIdToArchive: record.review.id,
      confirmLargeDiff: false,
    });
    expect(start).toHaveBeenNthCalledWith(2, preview, {
      activeReviewIdToArchive: record.review.id,
      confirmLargeDiff: true,
    });
    expect(state.get("inreview.review.lastChangeCount", 0)).toBe(3);
    expect(ui.information.at(-1)).toContain("only 2 eligible");
  });

  it("shows no-op feedback and changes only the UI display preference", async () => {
    const record = makeReviewRecord(fingerprint);
    const service = fakeService(record);
    service.refreshReview = vi.fn().mockResolvedValue({
      record,
      changed: false,
    });
    const ui = new FakeUi(undefined, []);
    const state = new FakeState();
    const modeChanged = vi.fn();
    const controller = controllerFor(service, ui, state, modeChanged);

    await controller.refreshReview();
    await controller.showPerChange();

    expect(ui.information).toContain(
      "The active review is already current. No snapshot was created.",
    );
    expect(state.get("inreview.review.displayMode", "combined")).toBe(
      "per-change",
    );
    expect(modeChanged).toHaveBeenCalledOnce();
    expect(service.renameActiveReview).not.toHaveBeenCalled();
  });

  it("includes new changes after large-diff confirmation", async () => {
    const record = makeReviewRecord(fingerprint);
    const service = fakeService(record);
    const first = selectionCandidate("l", "2", "First fix");
    const second = selectionCandidate(
      "m",
      "3",
      "Second fix",
      first.commitId,
    );
    const includeThrough = vi
      .fn()
      .mockRejectedValueOnce(
        new LargeDiffConfirmationRequiredError(20_000, 10_000),
      )
      .mockResolvedValueOnce({ record, addedChangeCount: 2 });
    service.beginIncludeNewChanges = vi.fn().mockResolvedValue({
      operationId: "a".repeat(128),
      candidates: [first, second],
      includeThrough,
    });
    const ui = new FakeUi(undefined, ["Continue"], [second.changeId]);

    await controllerFor(service, ui, new FakeState()).includeNewChanges();

    expect(includeThrough).toHaveBeenNthCalledWith(1, second.changeId);
    expect(includeThrough).toHaveBeenNthCalledWith(2, second.changeId, {
      confirmLargeDiff: true,
    });
    expect(ui.information).toContain(
      "Included 2 new changes in the active review.",
    );
  });

  it("reports an already included working copy as information", async () => {
    const record = makeReviewRecord(fingerprint);
    const service = fakeService(record);
    service.beginIncludeNewChanges = vi
      .fn()
      .mockRejectedValue(new JjNoNewChangesError());
    const ui = new FakeUi(undefined, []);

    await controllerFor(service, ui, new FakeState()).includeNewChanges();

    expect(ui.information).toContain(
      "The current working copy has no new descendant changes to include.",
    );
    expect(ui.errors).toEqual([]);
  });

  it("selects a historical range by newest and oldest included changes", async () => {
    const record = makeReviewRecord(fingerprint);
    const service = fakeService(record);
    service.getActiveReviewOrUndefined = vi.fn().mockResolvedValue(undefined);
    const oldest = selectionCandidate("k", "1", "Oldest");
    const newest = selectionCandidate("l", "2", "Newest", oldest.commitId);
    const preview = selectionPreview("range", [oldest, newest]);
    const selectRange = vi.fn().mockResolvedValue(preview);
    const start = vi.fn().mockResolvedValue({
      record,
      actualChangeCount: 2,
      truncatedAtRoot: false,
    });
    service.beginStartReview = vi.fn().mockResolvedValue({
      operationId: preview.operationId,
      listHistory: vi.fn().mockResolvedValue({
        commits: [oldest, newest],
        requestedCount: 50,
        hasMore: false,
        reachedRoot: true,
      }),
      selectLast: vi.fn(),
      selectRange,
      selectRevset: vi.fn(),
      start,
    } satisfies ReviewStartSession);
    const ui = new FakeUi(
      undefined,
      ["Choose Range", "Start Review"],
      [`newest:${newest.changeId}`, `oldest:${oldest.changeId}`],
    );

    await controllerFor(service, ui, new FakeState()).startReview();

    expect(selectRange).toHaveBeenCalledWith(oldest.changeId, newest.changeId);
    expect(start).toHaveBeenCalledWith(preview, {
      confirmLargeDiff: false,
    });
  });

  it("previews an advanced revset before starting the review", async () => {
    const record = makeReviewRecord(fingerprint);
    const service = fakeService(record);
    service.getActiveReviewOrUndefined = vi.fn().mockResolvedValue(undefined);
    const preview = selectionPreview("revset");
    const selectRevset = vi.fn().mockResolvedValue(preview);
    const start = vi.fn().mockResolvedValue({
      record,
      actualChangeCount: 1,
      truncatedAtRoot: false,
    });
    service.beginStartReview = vi.fn().mockResolvedValue({
      ...fakeStartSession(preview, start),
      selectRevset,
    } satisfies ReviewStartSession);
    const ui = new FakeUi(
      "description(review)",
      ["Advanced: Enter jj Revset", "Start Review"],
    );

    await controllerFor(service, ui, new FakeState()).startReview();

    expect(selectRevset).toHaveBeenCalledWith("description(review)");
    expect(start).toHaveBeenCalledWith(preview, {
      confirmLargeDiff: false,
    });
  });
});

class FakeState implements WorkspacePreferenceStore {
  readonly #values = new Map<string, unknown>();

  public get<T>(key: string, fallback: T): T {
    return (this.#values.get(key) as T | undefined) ?? fallback;
  }

  public update(key: string, value: unknown): Promise<void> {
    this.#values.set(key, value);
    return Promise.resolve();
  }
}

class FakeUi implements CommandUi {
  public readonly information: string[] = [];
  public readonly warnings: string[] = [];
  public readonly errors: string[] = [];

  public constructor(
    private readonly input: string | undefined,
    private readonly picks: string[],
    private readonly itemPicks: string[] = [],
  ) {}

  public showInputBox(): Promise<string | undefined> {
    return Promise.resolve(this.input);
  }

  public showQuickPick(): Promise<string | undefined> {
    return Promise.resolve(this.picks.shift());
  }

  public showItemQuickPick(): Promise<string | undefined> {
    return Promise.resolve(this.itemPicks.shift());
  }

  public showInformationMessage(message: string): Promise<unknown> {
    this.information.push(message);
    return Promise.resolve(undefined);
  }

  public showWarningMessage(message: string): Promise<unknown> {
    this.warnings.push(message);
    return Promise.resolve(undefined);
  }

  public showErrorMessage(message: string): Promise<unknown> {
    this.errors.push(message);
    return Promise.resolve(undefined);
  }
}

function fakeService(
  record: ReturnType<typeof makeReviewRecord>,
): ReviewCommandService & {
  beginStartReview: ReturnType<typeof vi.fn>;
  refreshReview: ReturnType<typeof vi.fn>;
  renameActiveReview: ReturnType<typeof vi.fn>;
} {
  return {
    getActiveReviewOrUndefined: vi.fn().mockResolvedValue(record),
    getActiveReview: vi.fn().mockResolvedValue(record),
    beginStartReview: vi.fn(),
    beginIncludeNewChanges: vi.fn(),
    startReview: vi.fn(),
    archiveAndStartReview: vi.fn(),
    refreshReview: vi.fn(),
    archiveActiveReview: vi.fn(),
    restoreReview: vi.fn(),
    archiveActiveAndRestoreReview: vi.fn(),
    renameActiveReview: vi.fn(),
    deleteArchivedReview: vi.fn(),
    getReview: vi.fn().mockResolvedValue(record),
  } as ReviewCommandService & {
    beginStartReview: ReturnType<typeof vi.fn>;
    refreshReview: ReturnType<typeof vi.fn>;
    renameActiveReview: ReturnType<typeof vi.fn>;
  };
}

function selectionPreview(
  mode: ReviewSelectionPreview["mode"] = "last-x",
  commits: readonly ReviewSelectionPreview["commits"][number][] = [
    selectionCandidate("k", "1", "Selected change"),
  ],
): ReviewSelectionPreview {
  return {
    mode,
    operationId: "a".repeat(128),
    requestedChangeCount: 3,
    actualChangeCount: commits.length,
    truncatedAtRoot: mode === "last-x",
    commits,
  };
}

function selectionCandidate(
  changeLetter: string,
  commitDigit: string,
  subject: string,
  parentCommitId = "0".repeat(40),
): ReviewSelectionPreview["commits"][number] {
  return {
    changeId: changeLetter.repeat(32),
    commitId: commitDigit.repeat(40),
    parentCommitIds: [parentCommitId],
    normalChangeId: commitDigit.repeat(32),
    subject,
    currentWorkingCopy: false,
    conflict: false,
    divergent: false,
    merge: false,
  };
}

function fakeStartSession(
  preview: ReviewSelectionPreview,
  start = vi.fn().mockResolvedValue({
    record: undefined,
    actualChangeCount: preview.actualChangeCount,
    truncatedAtRoot: preview.truncatedAtRoot,
  }),
): ReviewStartSession & {
  selectLast: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
} {
  return {
    operationId: preview.operationId,
    listHistory: vi.fn(),
    selectLast: vi.fn().mockResolvedValue(preview),
    selectRange: vi.fn().mockResolvedValue(preview),
    selectRevset: vi.fn().mockResolvedValue(preview),
    start,
  };
}

function controllerFor(
  service: ReviewCommandService,
  ui: FakeUi,
  state: FakeState,
  onModeChanged = vi.fn(),
): ReviewCommandController {
  return new ReviewCommandController({
    service,
    ui,
    workspaceState: state,
    defaultChangeCount: 1,
    delegates: {},
    onModeChanged,
    logError: vi.fn(),
  });
}
