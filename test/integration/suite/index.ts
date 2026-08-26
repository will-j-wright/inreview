import assert from "node:assert/strict";

import * as vscode from "vscode";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("inreview-local.inreview");

  assert.ok(extension, "The InReview extension is installed in the test host.");
  await waitForActivation(extension);
  assert.equal(extension.isActive, true);

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("inreview.startReview"));
  assert.ok(commands.includes("inreview.showMcpServerStatus"));
  assert.ok(commands.includes("inreview.copyCopilotCliMcpSetup"));
  assert.ok(!commands.includes("inreview.rotateMcpToken"));
  assert.ok(commands.includes("inreview.revealFile"));
  assert.ok(commands.includes("inreview.revealComment"));
  assert.ok(commands.includes("inreview.submitComment"));
  assert.ok(commands.includes("inreview.editComment"));
  assert.ok(commands.includes("inreview.deleteComment"));

  const exportsValue: unknown = extension.exports;
  assert.ok(
    typeof exportsValue === "object" &&
      exportsValue !== null &&
      "getExtensionReviewPorts" in exportsValue,
    "The extension exposes its replaceable integration ports.",
  );
  const extensionApi = exportsValue as {
    getExtensionReviewPorts(): ExtensionPorts | undefined;
    getBridgeRuntime(): {
      readonly status: { readonly state: string };
      restart(): Promise<void>;
    } | undefined;
    getCommentController(): vscode.CommentController | undefined;
    getActivationStatus(): string;
  };
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    assert.equal(extensionApi.getExtensionReviewPorts(), undefined);
    assert.equal(extensionApi.getBridgeRuntime()?.status.state, "disabled");
  } else {
    const ports = extensionApi.getExtensionReviewPorts();
    assert.ok(
      ports,
      `An eligible jj workspace initializes review ports: ${extensionApi.getActivationStatus()}`,
    );
    assert.equal(extensionApi.getBridgeRuntime()?.status.state, "registered");
    const active = await ports.service.getActiveReviewOrUndefined();
    const record =
      active ??
      (await ports.service.startReview({ requestedChangeCount: 1 })).record;
    const snapshot = record.snapshots.find(
      ({ id }) => id === record.review.currentSnapshotId,
    );
    const view = snapshot?.views.find(
      ({ identity }) => identity.mode === "combined",
    );
    const file = view?.files.find(
      ({ kind, commentableRanges }) =>
        kind === "text" && (commentableRanges?.length ?? 0) > 0,
    );
    assert.ok(snapshot && view && file, "The host fixture has a commentable text diff.");
    await vscode.commands.executeCommand("inreview.revealFile", {
      reviewId: record.review.id,
      snapshotId: snapshot.id,
      view: view.identity,
      fileId: file.fileId,
      readOnly: false,
    });
    const modified = vscode.workspace.textDocuments.find(
      ({ uri }) =>
        uri.scheme === "inreview-modified" &&
        uri.path.endsWith(file.currentPath ?? file.originalPath ?? ""),
    );
    assert.ok(modified, "The native modified virtual document opened.");
    const controller = extensionApi.getCommentController();
    assert.ok(controller?.commentingRangeProvider, "The comment controller activated.");
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const ranges =
        await controller.commentingRangeProvider.provideCommentingRanges(
          modified,
          cancellation.token,
        );
      assert.ok(Array.isArray(ranges) && ranges.length > 0);
    } finally {
      cancellation.dispose();
    }
  }
}

async function waitForActivation(
  extension: vscode.Extension<unknown>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!extension.isActive && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    extension.isActive,
    true,
    "InReview activates on startup without opening its view or running a command.",
  );
}

interface ExtensionPorts {
  readonly service: {
    getActiveReviewOrUndefined(): Promise<HostReviewRecord | undefined>;
    startReview(options: {
      readonly requestedChangeCount: number;
    }): Promise<{ readonly record: HostReviewRecord }>;
  };
}

interface HostReviewRecord {
  readonly review: {
    readonly id: string;
    readonly currentSnapshotId: string;
  };
  readonly snapshots: readonly {
    readonly id: string;
    readonly views: readonly {
      readonly identity:
        | { readonly mode: "combined" }
        | { readonly mode: "per-change"; readonly changeId: string };
      readonly files: readonly {
        readonly fileId: string;
        readonly kind: string;
        readonly currentPath: string | null;
        readonly originalPath: string | null;
        readonly commentableRanges?: readonly unknown[];
      }[];
    }[];
  }[];
}
