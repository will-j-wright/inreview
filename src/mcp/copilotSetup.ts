import type { BridgeRuntimeStatus } from "../bridge";

export const COPILOT_ALLOWED_TOOLS = [
  "list_workspaces",
  "connect_workspace",
  "read_review_metadata",
  "read_comments",
  "reply_comment",
  "close_comments",
] as const;

const COMMAND_CHOICE = "Copilot CLI command";
const JSON_CHOICE = "~/.copilot/mcp-config.json fragment";
const RECONNECT_ACTION = "Reconnect Bridge";
const OPEN_OUTPUT_ACTION = "Open InReview Output";

export interface CopilotSetupRuntime {
  readonly status: BridgeRuntimeStatus;
  restart(): Promise<void>;
}

export interface CopilotSetupUi {
  showQuickPick(
    items: readonly string[],
    options: { readonly title: string; readonly placeHolder?: string },
  ): Promise<string | undefined>;
  showInformationMessage(
    message: string,
    ...actions: readonly string[]
  ): Promise<string | undefined>;
  showErrorMessage(
    message: string,
    ...actions: readonly string[]
  ): Promise<string | undefined>;
  writeClipboard(text: string): Promise<void>;
  showOutput(): void;
}

export interface CopilotSetupControllerOptions {
  readonly runtime: CopilotSetupRuntime;
  readonly ui: CopilotSetupUi;
  readonly eligible: boolean;
  readonly unavailableReason?: string;
  readonly launcherPath?: string;
}

export class CopilotSetupController {
  public constructor(
    private readonly options: CopilotSetupControllerOptions,
  ) {}

  public async copySetup(): Promise<void> {
    if (
      !this.options.eligible ||
      this.options.launcherPath === undefined
    ) {
      await this.options.ui.showErrorMessage(
        this.options.unavailableReason ??
          "The InReview bridge is unavailable in this environment.",
      );
      return;
    }
    const choice = await this.options.ui.showQuickPick(
      [COMMAND_CHOICE, JSON_CHOICE],
      {
        title: "Copy InReview MCP Setup",
        placeHolder: "Choose a one-time Copilot CLI setup format.",
      },
    );
    if (choice !== COMMAND_CHOICE && choice !== JSON_CHOICE) {
      return;
    }
    const value =
      choice === COMMAND_CHOICE
        ? buildCopilotMcpCommand(this.options.launcherPath)
        : buildCopilotMcpConfig(this.options.launcherPath);
    try {
      await this.options.ui.writeClipboard(value);
    } catch {
      await this.options.ui.showErrorMessage(
        "InReview could not copy the Copilot CLI MCP setup.",
      );
      return;
    }
    await this.options.ui.showInformationMessage(
      "Copied. Add this MCP server once. It discovers every open workspace registered by InReview.",
    );
  }

  public async showStatus(): Promise<void> {
    const status = this.options.runtime.status;
    const lines = [
      `Bridge enabled: ${status.state === "disabled" ? "No" : "Yes"}`,
      `State: ${status.state}`,
      `Connected MCP sessions: ${status.state === "registered" ? String(status.sessionCount) : "0"}`,
      `Launcher: ${this.options.launcherPath === undefined ? "unavailable" : "installed"}`,
    ];
    if (status.state === "error") {
      lines.push(`Error: ${status.message}`);
    } else if (status.state === "disabled") {
      lines.push(
        `Action required: ${this.options.unavailableReason ?? "Enable InReview MCP in a trusted local workspace."}`,
      );
    }

    const actions =
      status.state === "error" || status.state === "disconnected"
        ? [RECONNECT_ACTION, OPEN_OUTPUT_ACTION]
        : status.state === "disabled"
          ? [OPEN_OUTPUT_ACTION]
          : [];
    const selection =
      status.state === "error"
        ? await this.options.ui.showErrorMessage(lines.join("\n"), ...actions)
        : await this.options.ui.showInformationMessage(
            lines.join("\n"),
            ...actions,
          );
    if (selection === OPEN_OUTPUT_ACTION) {
      this.options.ui.showOutput();
    } else if (selection === RECONNECT_ACTION) {
      await this.options.runtime.restart();
      const next = this.options.runtime.status;
      await this.options.ui.showInformationMessage(
        next.state === "registered"
          ? "The workspace is registered with the InReview bridge."
          : "The workspace could not register with the InReview bridge.",
      );
    }
  }
}

export function buildCopilotMcpCommand(launcherPath: string): string {
  validateLauncherPath(launcherPath);
  const invocation = launcherInvocation(launcherPath);
  return [
    "copilot mcp add",
    `--tools "${COPILOT_ALLOWED_TOOLS.join(",")}"`,
    "inreview",
    "--",
    quoteCommandArgument(invocation.command),
    ...invocation.args.map(quoteCommandArgument),
  ].join(" ");
}

export function buildCopilotMcpConfig(launcherPath: string): string {
  validateLauncherPath(launcherPath);
  const invocation = launcherInvocation(launcherPath);
  return JSON.stringify(
    {
      mcpServers: {
        inreview: {
          type: "stdio",
          command: invocation.command,
          args: invocation.args,
          tools: [...COPILOT_ALLOWED_TOOLS],
        },
      },
    },
    undefined,
    2,
  );
}

function launcherInvocation(launcherPath: string): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return process.platform === "win32"
    ? {
        command: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/s", "/c", launcherPath],
      }
    : { command: launcherPath, args: [] };
}

function validateLauncherPath(launcherPath: string): void {
  if (
    launcherPath.length === 0 ||
    launcherPath.length > 32_768 ||
    hasControlCharacters(launcherPath)
  ) {
    throw new Error("The InReview bridge launcher path is invalid.");
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function quoteCommandArgument(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
