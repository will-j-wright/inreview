import * as vscode from "vscode";

import {
  BridgeRuntime,
  installBridge,
  type InstalledBridge,
} from "./bridge";
import { commandDefinitions } from "./commands";
import { readSettings, type InReviewSettings } from "./config/settings";
import { selectExtensionApi } from "./extensionApi";
import { discoverWorkspaceRepository, JjClient } from "./jj";
import {
  CopilotSetupController,
} from "./mcp";
import { ReviewService } from "./review";
import { BlobStore } from "./storage";
import { ActiveReviewTree } from "./vscode/activeReviewTree";
import {
  ReviewCommandController,
  type LaterCommandDelegates,
} from "./vscode/commands";
import {
  COMMENT_COMMANDS,
  InReviewCommentController,
} from "./vscode/commentController";
import { CommentsTree } from "./vscode/commentsTree";
import { mapUserFacingError } from "./vscode/errors";
import { HistoryTree } from "./vscode/historyTree";
import { InReviewLogger } from "./vscode/logging";
import { NativeDiffService } from "./vscode/nativeDiffService";
import { VscodeTreeAdapter } from "./vscode/treeAdapter";
import type { TreeState } from "./vscode/treeTypes";

const internalCommandIds = [
  "inreview.revealFile",
  "inreview.revealComment",
  COMMENT_COMMANDS.submit,
  COMMENT_COMMANDS.edit,
  COMMENT_COMMANDS.save,
  COMMENT_COMMANDS.cancelEdit,
  COMMENT_COMMANDS.delete,
] as const;

const laterDelegates: LaterCommandDelegates = {};
let activeService: ReviewService | undefined;
let activeLogger: InReviewLogger | undefined;
let activeNativeDiffService: NativeDiffService | undefined;
let activeCommentController: InReviewCommentController | undefined;
let activeBridgeRuntime: BridgeRuntime | undefined;

export interface ExtensionReviewPorts {
  readonly service: ReviewService;
  readonly canonicalRepositoryRoot: string;
  readonly environmentKey: string;
  readonly globalStorageUri: vscode.Uri;
}

export interface InReviewExtensionApi {
  getExtensionReviewPorts(): ExtensionReviewPorts | undefined;
  getBridgeRuntime(): BridgeRuntime | undefined;
  getCommentController(): vscode.CommentController | undefined;
  getActivationStatus(): string;
  registerLaterCommandDelegates(
    delegates: LaterCommandDelegates,
  ): vscode.Disposable;
}

let activePorts: ExtensionReviewPorts | undefined;
let activationStatus = "InReview has not activated.";

function getExtensionReviewPorts(): ExtensionReviewPorts | undefined {
  return activePorts;
}

function getBridgeRuntime(): BridgeRuntime | undefined {
  return activeBridgeRuntime;
}

function registerLaterCommandDelegates(
  delegates: LaterCommandDelegates,
): vscode.Disposable {
  const previous = new Map<keyof LaterCommandDelegates, unknown>();
  for (const key of Object.keys(delegates) as (keyof LaterCommandDelegates)[]) {
    previous.set(key, Reflect.get(laterDelegates, key));
    Reflect.set(laterDelegates, key, Reflect.get(delegates, key));
  }
  return {
    dispose: () => {
      for (const [key, value] of previous) {
        if (value === undefined) {
          Reflect.deleteProperty(laterDelegates, key);
        } else {
          Reflect.set(laterDelegates, key, value);
        }
      }
    },
  };
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<InReviewExtensionApi | undefined> {
  const settings = readSettings(vscode.workspace.workspaceFolders?.[0]?.uri);
  const logger = new InReviewLogger(settings.logLevel);
  activeLogger = logger;
  logger.info(
    `InReview activated in a ${vscode.workspace.isTrusted ? "trusted" : "restricted"} workspace.`,
  );

  const localDisposables: vscode.Disposable[] = [logger];
  let initialization: Initialization;
  try {
    try {
      initialization = await initializeWorkspace(context, settings, logger);
    } catch (error) {
      const mapped = mapUserFacingError(error);
      logger.error("Could not initialize this workspace", error);
      await vscode.window.showErrorMessage(
        `InReview is unavailable: ${mapped.message}`,
      );
      initialization = unavailable(mapped.message);
    }
    activeService = initialization.service;
    activationStatus = initialization.reason;
    if (initialization.service !== undefined) {
      activePorts = {
        service: initialization.service,
        canonicalRepositoryRoot:
          initialization.service.canonicalRepositoryRoot,
        environmentKey: initialization.service.environment,
        globalStorageUri: context.globalStorageUri,
      };
    }

    const bridgeEligible =
      vscode.workspace.isTrusted &&
      initialization.service !== undefined;
    let installedBridge: InstalledBridge | undefined;
    let bridgeInstallError: string | undefined;
    if (bridgeEligible) {
      try {
        installedBridge = await installBridge(context);
      } catch (error) {
        void error;
        logger.error("Could not install the InReview bridge");
        bridgeInstallError =
          "The native InReview bridge could not be installed.";
      }
    }
    const bridgeRuntime = new BridgeRuntime({
      eligible: bridgeEligible && installedBridge !== undefined,
      enabled: settings.mcpEnabled,
      ...(initialization.service === undefined
        ? {}
        : { service: initialization.service }),
      executablePath: installedBridge?.executablePath ?? "",
      endpoint: installedBridge?.endpoint ?? "",
      logger,
    });
    activeBridgeRuntime = bridgeRuntime;
    await bridgeRuntime.start();
    const configurationSubscription =
      vscode.workspace.onDidChangeConfiguration((event) => {
        const resource = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!event.affectsConfiguration("inreview.mcp", resource)) {
          return;
        }
        const updated = readSettings(resource);
        void bridgeRuntime
          .configure({
            eligible:
              vscode.workspace.isTrusted &&
              initialization.service !== undefined &&
              installedBridge !== undefined,
            enabled: updated.mcpEnabled,
          });
      });
    localDisposables.push(configurationSubscription, {
      dispose: () => {
        void bridgeRuntime.dispose();
      },
    });
    const copilotSetup = new CopilotSetupController({
      runtime: bridgeRuntime,
      ui: {
        showQuickPick: async (items, options) =>
          vscode.window.showQuickPick(items, options),
        showInformationMessage: async (message, ...actions) =>
          vscode.window.showInformationMessage(message, ...actions),
        showErrorMessage: async (message, ...actions) =>
          vscode.window.showErrorMessage(message, ...actions),
        writeClipboard: async (text) => vscode.env.clipboard.writeText(text),
        showOutput: () => {
          logger.show();
        },
      },
      eligible: bridgeEligible && installedBridge !== undefined,
      unavailableReason:
        bridgeInstallError ?? initialization.reason,
      ...(installedBridge === undefined
        ? {}
        : { launcherPath: installedBridge.launcherPath }),
    });
    localDisposables.push(
      registerLaterCommandDelegates({
        copyCopilotCliMcpSetup: async () => copilotSetup.copySetup(),
        showMcpServerStatus: async () => copilotSetup.showStatus(),
      }),
    );

    let getDisplayMode = (): "combined" | "per-change" => "combined";
    const activeTree = new ActiveReviewTree({
      query: initialization.service,
      state: initialization.state,
      getDisplayMode: () => getDisplayMode(),
    });
    const commentsTree = new CommentsTree(
      initialization.service,
      initialization.state,
    );
    const historyTree = new HistoryTree(
      initialization.service,
      initialization.state,
    );
    const commandController = new ReviewCommandController({
      service: initialization.service,
      ui: vscodeUi,
      workspaceState: context.workspaceState,
      defaultChangeCount: settings.defaultChangeCount,
      delegates: laterDelegates,
      onModeChanged: () => {
        activeTree.refresh();
      },
      logError: (message, error) => {
        logger.error(message, error);
      },
      unavailableReason: initialization.reason,
    });
    getDisplayMode = () => commandController.displayMode;

    for (const [viewId, source] of [
      ["inreview.activeReview", activeTree],
      ["inreview.comments", commentsTree],
      ["inreview.history", historyTree],
    ] as const) {
      const adapter = new VscodeTreeAdapter(source);
      localDisposables.push(
        adapter,
        vscode.window.registerTreeDataProvider(viewId, adapter),
      );
    }

    if (initialization.service !== undefined) {
      const signingKey = `inreview-native-diff-v1:${initialization.service.storageKey}`;
      const nativeDiffService = new NativeDiffService({
        reviews: initialization.service,
        blobs: new BlobStore(
          vscode.Uri.joinPath(
            context.globalStorageUri,
            initialization.service.storageKey,
            "blobs",
          ).fsPath,
        ),
        signingKey,
        vscode,
      });
      activeNativeDiffService = nativeDiffService;
      const commentController = new InReviewCommentController({
        service: initialization.service,
        nativeDiff: nativeDiffService,
        signingKey,
        vscode,
        logError: (message, error) => {
          logger.error(message, error);
        },
      });
      activeCommentController = commentController;
      localDisposables.push(
        nativeDiffService,
        commentController,
        registerLaterCommandDelegates({
          revealFile: async (request) => nativeDiffService.revealFile(request),
          revealComment: async (request) =>
            commentController.revealComment(request),
          addFileComment: async (...args) =>
            commentController.addFileComment(...args),
          resolveComment: async (...args) =>
            commentController.resolve(args[0]),
          reopenComment: async (...args) =>
            commentController.reopen(args[0]),
          submitComment: async (...args) =>
            commentController.submit(args[0]),
          editComment: (...args) => {
            commentController.edit(args[0]);
          },
          saveComment: async (...args) => commentController.save(args[0]),
          cancelCommentEdit: (...args) => {
            commentController.cancelEdit(args[0]);
          },
          deleteComment: async (...args) =>
            commentController.delete(args[0]),
        }),
      );
      localDisposables.push(
        initialization.service.subscribe(() => {
          activeTree.refresh();
          commentsTree.refresh();
          historyTree.refresh();
        }),
        initialization.service.commentService.subscribe(() => {
          activeTree.refresh();
          commentsTree.refresh();
        }),
        {
          dispose: () => {
            void initialization.service?.close();
          },
        },
      );
    }

    registerCommands(commandController, localDisposables);
    context.subscriptions.push(...localDisposables);
    logger.info(initialization.reason);
    return selectExtensionApi(
      context.extensionMode === vscode.ExtensionMode.Production,
      {
      getExtensionReviewPorts: () => getExtensionReviewPorts(),
      getBridgeRuntime: () => getBridgeRuntime(),
      getCommentController: () => activeCommentController?.controller,
      getActivationStatus: () => activationStatus,
      registerLaterCommandDelegates: (delegates) =>
        registerLaterCommandDelegates(delegates),
      },
    );
  } catch (error) {
    await activeService?.close().catch(() => undefined);
    activeService = undefined;
    activePorts = undefined;
    activeNativeDiffService = undefined;
    activeCommentController = undefined;
    await activeBridgeRuntime?.dispose().catch(() => undefined);
    activeBridgeRuntime = undefined;
    activationStatus = "InReview is deactivated.";
    for (const disposable of localDisposables.reverse()) {
      disposable.dispose();
    }
    activeLogger = undefined;
    const mapped = mapUserFacingError(error);
    await vscode.window.showErrorMessage(`InReview could not activate: ${mapped.message}`);
    throw error;
  }
}

export async function deactivate(): Promise<void> {
  const bridgeRuntime = activeBridgeRuntime;
  activeBridgeRuntime = undefined;
  const service = activeService;
  activeService = undefined;
  activePorts = undefined;
  activeNativeDiffService?.dispose();
  activeNativeDiffService = undefined;
  activeCommentController?.dispose();
  activeCommentController = undefined;
  await bridgeRuntime?.dispose().catch(() => undefined);
  await service?.close().catch((error: unknown) => {
    activeLogger?.error("Could not close the review service", error);
  });
  activeLogger = undefined;
}

interface Initialization {
  readonly state: TreeState;
  readonly service?: ReviewService;
  readonly reason: string;
}

async function initializeWorkspace(
  context: vscode.ExtensionContext,
  settings: InReviewSettings,
  logger: InReviewLogger,
): Promise<Initialization> {
  if (!vscode.workspace.isTrusted) {
    return {
      state: {
        kind: "restricted",
        message:
          "Trust this workspace to run jj and access local review storage.",
      },
      reason:
        "InReview is restricted. Trust this workspace to run jj and write review storage.",
    };
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return unavailable("Open a local folder inside one jj repository.");
  }
  const unsupported = folders.find(({ uri }) => uri.scheme !== "file");
  if (unsupported !== undefined) {
    return unavailable(
      `The workspace folder “${unsupported.name}” uses the unsupported ${unsupported.uri.scheme} scheme. InReview requires local file folders.`,
    );
  }
  const discovery = await discoverWorkspaceRepository(
    folders.map((folder) => folder.uri.fsPath),
    (folderPath) =>
      new JjClient(folderPath, {
        executable: settings.jjPath,
      }),
  );
  if (discovery.kind === "unavailable") {
    return unavailable(discovery.message);
  }
  const canonicalRoot = discovery.root;

  const environmentKey = [
    vscode.env.remoteName ?? "local",
    process.platform,
    process.arch,
  ].join(":");
  logger.debug(`Opening review storage for ${canonicalRoot}.`);
  const service = await ReviewService.create({
    repositoryPath: canonicalRoot,
    environment: environmentKey,
    storageRoot: context.globalStorageUri,
    jj: { executable: settings.jjPath },
    warningLineCount: settings.largeDiffWarningLines,
  });
  return {
    state: { kind: "ready" },
    service,
    reason: `InReview is ready for ${service.canonicalRepositoryRoot}.`,
  };
}

function unavailable(message: string): Initialization {
  return {
    state: { kind: "unavailable", message },
    reason: message,
  };
}

function registerCommands(
  controller: ReviewCommandController,
  disposables: vscode.Disposable[],
): void {
  const handlers: Record<string, (...args: unknown[]) => Promise<void>> = {
    "inreview.startReview": async () => controller.startReview(),
    "inreview.refreshReview": async () => controller.refreshReview(),
    "inreview.archiveReview": async () => controller.archiveReview(),
    "inreview.restoreArchivedReview": async (value) =>
      controller.restoreArchivedReview(value),
    "inreview.renameReview": async () => controller.renameReview(),
    "inreview.deleteArchivedReview": async (value) =>
      controller.deleteArchivedReview(value),
    "inreview.showCombinedDiff": async () => controller.showCombined(),
    "inreview.showPerChangeDiffs": async () => controller.showPerChange(),
    "inreview.addFileComment": async (...args) =>
      controller.laterCommand("addFileComment", ...args),
    "inreview.resolveComment": async (...args) =>
      controller.laterCommand("resolveComment", ...args),
    "inreview.reopenComment": async (...args) =>
      controller.laterCommand("reopenComment", ...args),
    [COMMENT_COMMANDS.submit]: async (...args) =>
      controller.laterCommand("submitComment", ...args),
    [COMMENT_COMMANDS.edit]: async (...args) =>
      controller.laterCommand("editComment", ...args),
    [COMMENT_COMMANDS.save]: async (...args) =>
      controller.laterCommand("saveComment", ...args),
    [COMMENT_COMMANDS.cancelEdit]: async (...args) =>
      controller.laterCommand("cancelCommentEdit", ...args),
    [COMMENT_COMMANDS.delete]: async (...args) =>
      controller.laterCommand("deleteComment", ...args),
    "inreview.copyCopilotCliMcpSetup": async () =>
      controller.laterCommand("copyCopilotCliMcpSetup"),
    "inreview.showMcpServerStatus": async () =>
      controller.laterCommand("showMcpServerStatus"),
    "inreview.revealFile": async (value) => controller.revealFile(value),
    "inreview.revealComment": async (value) => controller.revealComment(value),
  };
  for (const { id } of commandDefinitions) {
    const handler = handlers[id];
    if (handler === undefined) {
      throw new Error(`Command ${id} has no handler.`);
    }
    disposables.push(vscode.commands.registerCommand(id, handler));
  }
  for (const id of internalCommandIds) {
    const handler = handlers[id];
    if (handler === undefined) {
      throw new Error(`Command ${id} has no handler.`);
    }
    disposables.push(vscode.commands.registerCommand(id, handler));
  }
}

const vscodeUi = {
  showInputBox: async (
    options: Parameters<typeof vscode.window.showInputBox>[0],
  ): Promise<string | undefined> => vscode.window.showInputBox(options),
  showQuickPick: async (
    items: readonly string[],
    options: vscode.QuickPickOptions,
  ): Promise<string | undefined> => vscode.window.showQuickPick(items, options),
  showInformationMessage: async (message: string): Promise<unknown> =>
    vscode.window.showInformationMessage(message),
  showWarningMessage: async (message: string): Promise<unknown> =>
    vscode.window.showWarningMessage(message),
  showErrorMessage: async (message: string): Promise<unknown> =>
    vscode.window.showErrorMessage(message),
};
