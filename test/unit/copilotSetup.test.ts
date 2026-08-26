import { describe, expect, it, vi } from "vitest";

import {
  COPILOT_ALLOWED_TOOLS,
  CopilotSetupController,
  buildCopilotMcpCommand,
  buildCopilotMcpConfig,
  createCopilotServerName,
  type CopilotSetupRuntime,
  type CopilotSetupUi,
  type McpRuntimeStatus,
} from "../../src/mcp";

const endpoint = "http://127.0.0.1:43123/mcp";
const fingerprint = "0123456789abcdef0123456789abcdef";
const serverName = "inreview-my-repo-01234567";
const forbiddenSetupText = /authorization|header|token|secret/iu;

describe("Copilot CLI MCP setup serialization", () => {
  it("creates a bounded repository-specific safe server name", () => {
    expect(createCopilotServerName("My Repo!", fingerprint)).toBe(serverName);
    expect(createCopilotServerName("🔥", fingerprint)).toBe(
      "inreview-repository-01234567",
    );
    const longName = createCopilotServerName("A".repeat(200), fingerprint);
    expect(longName).toMatch(/^inreview-[a-z0-9-]+-01234567$/u);
    expect(longName.length).toBeLessThanOrEqual(64);
  });

  it("creates the exact tokenless official Copilot CLI command", () => {
    const command = buildCopilotMcpCommand(serverName, endpoint);
    expect(command).toBe(
      `copilot mcp add --transport http --tools "connect_workspace,read_review_metadata,read_comments,reply_comment,close_comments" ${serverName} "${endpoint}"`,
    );
    expect(command).not.toMatch(forbiddenSetupText);
  });

  it("creates tokenless JSON with exactly five allowed tools and no headers", () => {
    const config = buildCopilotMcpConfig(serverName, endpoint);
    const parsed = JSON.parse(config) as {
      mcpServers: Record<
        string,
        { type: string; url: string; tools: string[] }
      >;
    };
    expect(parsed).toEqual({
      mcpServers: {
        [serverName]: {
          type: "http",
          url: endpoint,
          tools: [...COPILOT_ALLOWED_TOOLS],
        },
      },
    });
    expect(parsed.mcpServers[serverName]?.tools).toHaveLength(5);
    expect(config).not.toMatch(forbiddenSetupText);
  });

  it("rejects values that could leave the strict loopback endpoint", () => {
    expect(() =>
      buildCopilotMcpCommand(serverName, "http://localhost:43123/mcp"),
    ).toThrow("loopback");
  });
});

describe("Copilot CLI MCP setup commands", () => {
  it("copies after format selection without a warning and gives WSL guidance", async () => {
    const runtime = new FakeRuntime(runningStatus());
    const ui = new FakeUi();
    ui.quickPickResults.push("Copilot CLI command");

    await createController(runtime, ui, true).copySetup();

    expect(ui.warnings).toHaveLength(0);
    expect(ui.clipboard).toHaveLength(1);
    expect(ui.clipboard[0]).not.toMatch(forbiddenSetupText);
    expect(ui.information.at(-1)).toContain("same WSL distribution");
    expect(runtime.markSetupCopied).toHaveBeenCalledOnce();
  });

  it("does nothing when the format choice is cancelled", async () => {
    const ui = new FakeUi();
    await createController(new FakeRuntime(runningStatus()), ui).copySetup();
    expect(ui.clipboard).toHaveLength(0);
    expect(ui.warnings).toHaveLength(0);
  });

  it("offers to restart a stopped server and reports a startup error", async () => {
    const successRuntime = new FakeRuntime({ state: "stopped" });
    successRuntime.restartResult = runningStatus();
    const successUi = new FakeUi();
    successUi.warningResults.push("Start MCP Server");
    await createController(successRuntime, successUi).copySetup();
    expect(successRuntime.restart).toHaveBeenCalledOnce();

    const failureRuntime = new FakeRuntime({ state: "stopped" });
    failureRuntime.restartResult = {
      state: "error",
      message: "Port 4000 is already in use.",
    };
    const failureUi = new FakeUi();
    failureUi.warningResults.push("Start MCP Server");
    await createController(failureRuntime, failureUi).copySetup();
    expect(failureUi.errors.join(" ")).toContain(
      "Port 4000 is already in use.",
    );
    expect(failureUi.clipboard).toHaveLength(0);
  });

  it("shows endpoint, state, sessions, and errors without authentication fields", async () => {
    const ui = new FakeUi();
    ui.errorResults.push("Open InReview Output");
    const runtime = new FakeRuntime({
      state: "error",
      message: "The configured MCP port is already in use.",
    });

    await createController(runtime, ui).showStatus();

    const status = ui.errors.join("\n");
    expect(status).toContain("State: error");
    expect(status).toContain("Endpoint: not running");
    expect(status).toContain("Connected sessions: 0");
    expect(status).toContain("Error:");
    expect(status).not.toMatch(/authentication|authorization|token/iu);
    expect(ui.outputShown).toBe(true);
  });
});

class FakeRuntime implements CopilotSetupRuntime {
  public restartResult: McpRuntimeStatus | undefined;
  public readonly restart = vi.fn(() => {
    if (this.restartResult !== undefined) {
      this.currentStatus = this.restartResult;
    }
    return Promise.resolve();
  });
  public readonly markSetupCopied = vi.fn();

  public constructor(private currentStatus: McpRuntimeStatus) {}

  public get status(): McpRuntimeStatus {
    return this.currentStatus;
  }
}

class FakeUi implements CopilotSetupUi {
  public readonly quickPickResults: (string | undefined)[] = [];
  public readonly warningResults: (string | undefined)[] = [];
  public readonly errorResults: (string | undefined)[] = [];
  public readonly warnings: string[] = [];
  public readonly information: string[] = [];
  public readonly errors: string[] = [];
  public readonly clipboard: string[] = [];
  public outputShown = false;

  public showQuickPick(): Promise<string | undefined> {
    return Promise.resolve(this.quickPickResults.shift());
  }

  public showInformationMessage(message: string): Promise<string | undefined> {
    this.information.push(message);
    return Promise.resolve(undefined);
  }

  public showWarningMessage(message: string): Promise<string | undefined> {
    this.warnings.push(message);
    return Promise.resolve(this.warningResults.shift());
  }

  public showErrorMessage(message: string): Promise<string | undefined> {
    this.errors.push(message);
    return Promise.resolve(this.errorResults.shift());
  }

  public writeClipboard(text: string): Promise<void> {
    this.clipboard.push(text);
    return Promise.resolve();
  }

  public showOutput(): void {
    this.outputShown = true;
  }
}

function runningStatus(): McpRuntimeStatus {
  return {
    state: "running",
    endpoint,
    port: 43123,
    sessionCount: 2,
    setupUpdateRequired: false,
  };
}

function createController(
  runtime: CopilotSetupRuntime,
  ui: CopilotSetupUi,
  isWsl = false,
): CopilotSetupController {
  return new CopilotSetupController({
    runtime,
    ui,
    eligible: true,
    canonicalRepositoryRoot: "C:\\work\\My Repo",
    repositoryFingerprint: fingerprint,
    isWsl,
  });
}
