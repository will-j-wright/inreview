import path from "node:path";

import type { McpRuntimeStatus } from "./runtime";

export const COPILOT_ALLOWED_TOOLS = [
  "connect_workspace",
  "read_review_metadata",
  "read_comments",
  "reply_comment",
  "close_comments",
] as const;

const COMMAND_CHOICE = "Copilot CLI command";
const JSON_CHOICE = "~/.copilot/mcp-config.json fragment";
const START_ACTION = "Start MCP Server";
const OPEN_OUTPUT_ACTION = "Open InReview Output";

export interface CopilotSetupRuntime {
  readonly status: McpRuntimeStatus;
  restart(): Promise<void>;
  markSetupCopied(): void;
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
  showWarningMessage(
    message: string,
    options: { readonly modal: boolean; readonly detail?: string },
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
  readonly canonicalRepositoryRoot?: string;
  readonly repositoryFingerprint?: string;
  readonly isWsl: boolean;
}

export class CopilotSetupController {
  public constructor(
    private readonly options: CopilotSetupControllerOptions,
  ) {}

  public async copySetup(): Promise<void> {
    if (!this.requireEligible() || !(await this.ensureRunning())) {
      return;
    }
    const choice = await this.options.ui.showQuickPick(
      [COMMAND_CHOICE, JSON_CHOICE],
      {
        title: "Copy Copilot CLI MCP Setup",
        placeHolder: "Choose a user-managed Copilot CLI setup format.",
      },
    );
    if (choice !== COMMAND_CHOICE && choice !== JSON_CHOICE) {
      return;
    }

    const status = this.options.runtime.status;
    if (status.state !== "running") {
      await this.options.ui.showErrorMessage(
        "The MCP server stopped before setup could be copied. Start it and try again.",
      );
      return;
    }
    const identity = this.repositoryIdentity();
    try {
      const value =
        choice === COMMAND_CHOICE
          ? buildCopilotMcpCommand(identity.serverName, status.endpoint)
          : buildCopilotMcpConfig(identity.serverName, status.endpoint);
      await this.options.ui.writeClipboard(value);
    } catch {
      await this.options.ui.showErrorMessage(
        "InReview could not copy the Copilot CLI MCP setup.",
      );
      return;
    }
    this.options.runtime.markSetupCopied();
    await this.options.ui.showInformationMessage(
      this.options.isWsl
        ? "Copied. Use this setup with Copilot CLI in this same WSL distribution while this VS Code window and MCP server are running."
        : "Copied. Use this setup with Copilot CLI in this same local environment while this VS Code window and MCP server are running.",
    );
  }

  public async showStatus(): Promise<void> {
    const identity = this.repositoryIdentityOrUndefined();
    const status = this.options.runtime.status;
    const lines = [
      `MCP enabled: ${status.state === "disabled" ? "No" : "Yes"}`,
      `State: ${status.state}`,
      `Endpoint: ${status.state === "running" ? status.endpoint : "not running"}`,
      `Connected sessions: ${status.state === "running" ? String(status.sessionCount) : "0"}`,
      `Repository: ${identity?.repositoryName ?? "unavailable"}`,
      `Server name: ${identity?.serverName ?? "unavailable"}`,
      `Repository identity: ${identity?.shortFingerprint ?? "unavailable"}`,
    ];
    if (status.state === "running" && status.setupUpdateRequired) {
      lines.push("Action required: Copy the Copilot CLI MCP setup again.");
    } else if (status.state === "error") {
      lines.push(`Error: ${status.message}`);
    } else if (status.state === "stopped") {
      lines.push("Action required: Start the MCP server.");
    } else if (status.state === "disabled") {
      lines.push(
        this.options.eligible
          ? "Action required: Enable InReview: MCP Enabled."
          : `Action required: ${this.options.unavailableReason ?? "Open one trusted local jj workspace."}`,
      );
    }

    const actions =
      status.state === "stopped" || status.state === "error"
        ? [START_ACTION, OPEN_OUTPUT_ACTION]
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
    } else if (selection === START_ACTION && (await this.ensureRunning(false))) {
      await this.options.ui.showInformationMessage(
        "The InReview MCP server is running.",
      );
    }
  }

  private requireEligible(): boolean {
    if (
      this.options.eligible &&
      this.options.canonicalRepositoryRoot !== undefined &&
      this.options.repositoryFingerprint !== undefined
    ) {
      return true;
    }
    void this.options.ui.showErrorMessage(
      this.options.unavailableReason ??
        "Open one trusted local jj workspace before using the InReview MCP server.",
    );
    return false;
  }

  private async ensureRunning(offer = true): Promise<boolean> {
    let status = this.options.runtime.status;
    if (status.state === "running") {
      return true;
    }
    if (status.state === "disabled") {
      await this.options.ui.showErrorMessage(
        this.options.eligible
          ? "The MCP server is disabled. Enable InReview: MCP Enabled and try again."
          : this.options.unavailableReason ??
              "Open one trusted local jj workspace and try again.",
      );
      return false;
    }
    if (offer) {
      const action = await this.options.ui.showWarningMessage(
        status.state === "error"
          ? status.message
          : "The InReview MCP server is stopped.",
        { modal: true, detail: "Start the local server before copying setup." },
        START_ACTION,
      );
      if (action !== START_ACTION) {
        return false;
      }
    }
    await this.options.runtime.restart();
    status = this.options.runtime.status;
    if (status.state !== "running") {
      await this.options.ui.showErrorMessage(
        status.state === "error"
          ? status.message
          : "The InReview MCP server did not start.",
        OPEN_OUTPUT_ACTION,
      ).then((selection) => {
        if (selection === OPEN_OUTPUT_ACTION) {
          this.options.ui.showOutput();
        }
      });
      return false;
    }
    return true;
  }

  private repositoryIdentity(): RepositoryIdentity {
    const identity = this.repositoryIdentityOrUndefined();
    if (identity === undefined) {
      throw new Error("The repository identity is unavailable.");
    }
    return identity;
  }

  private repositoryIdentityOrUndefined(): RepositoryIdentity | undefined {
    if (
      this.options.canonicalRepositoryRoot === undefined ||
      this.options.repositoryFingerprint === undefined
    ) {
      return undefined;
    }
    const repositoryName =
      path.basename(this.options.canonicalRepositoryRoot) || "repository";
    const shortFingerprint = safeFingerprint(
      this.options.repositoryFingerprint,
    );
    return {
      repositoryName,
      shortFingerprint,
      serverName: createCopilotServerName(
        repositoryName,
        this.options.repositoryFingerprint,
      ),
    };
  }
}

interface RepositoryIdentity {
  readonly repositoryName: string;
  readonly shortFingerprint: string;
  readonly serverName: string;
}

export function createCopilotServerName(
  repositoryBasename: string,
  fingerprint: string,
): string {
  const shortFingerprint = safeFingerprint(fingerprint);
  const maximumBaseLength = 64 - "inreview--".length - shortFingerprint.length;
  const sanitized =
    repositoryBasename
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, maximumBaseLength)
      .replace(/-+$/gu, "") || "repository";
  return `inreview-${sanitized}-${shortFingerprint}`;
}

export function buildCopilotMcpCommand(
  serverName: string,
  endpoint: string,
): string {
  validateSetupInputs(serverName, endpoint);
  return [
    "copilot mcp add --transport http",
    `--tools "${COPILOT_ALLOWED_TOOLS.join(",")}"`,
    serverName,
    `"${endpoint}"`,
  ].join(" ");
}

export function buildCopilotMcpConfig(
  serverName: string,
  endpoint: string,
): string {
  validateSetupInputs(serverName, endpoint);
  return JSON.stringify(
    {
      mcpServers: {
        [serverName]: {
          type: "http",
          url: endpoint,
          tools: [...COPILOT_ALLOWED_TOOLS],
        },
      },
    },
    undefined,
    2,
  );
}

function validateSetupInputs(serverName: string, endpoint: string): void {
  if (!/^inreview-[a-z0-9-]{1,46}-[a-z0-9]{8}$/u.test(serverName)) {
    throw new Error("The Copilot MCP server name is invalid.");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("The MCP endpoint is invalid.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
    url.pathname !== "/mcp" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("The MCP endpoint must be the loopback /mcp endpoint.");
  }
}

function safeFingerprint(fingerprint: string): string {
  const normalized = fingerprint.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (normalized.length < 8) {
    throw new Error("The repository fingerprint is invalid.");
  }
  return normalized.slice(0, 8);
}
