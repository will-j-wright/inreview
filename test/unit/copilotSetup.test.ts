import { describe, expect, it, vi } from "vitest";

import type { BridgeRuntimeStatus } from "../../src/bridge";
import {
  COPILOT_ALLOWED_TOOLS,
  CopilotSetupController,
  buildCopilotMcpCommand,
  buildCopilotMcpConfig,
  type CopilotSetupRuntime,
  type CopilotSetupUi,
} from "../../src/mcp";

const launcherPath = "/home/user/.inreview/bridge/inreview-bridge";
const forbiddenSetupText = /authorization|header|token|secret/iu;

describe("Copilot CLI bridge setup serialization", () => {
  it("creates one stable native stdio command", () => {
    const command = buildCopilotMcpCommand(launcherPath);
    if (process.platform === "win32") {
      expect(command).toContain("cmd.exe");
      expect(command).toContain(`"/d" "/s" "/c" "${launcherPath}"`);
    } else {
      expect(command).toBe(
        `copilot mcp add --tools "list_workspaces,connect_workspace,read_review_metadata,read_comments,reply_comment,close_comments" inreview -- '${launcherPath}'`,
      );
    }
    expect(command).not.toMatch(forbiddenSetupText);
    expect(command).not.toMatch(/--transport http|127\.0\.0\.1|:\d{2,5}/u);
  });

  it("creates native stdio JSON with exactly six allowed tools", () => {
    const config = buildCopilotMcpConfig(launcherPath);
    const parsed = JSON.parse(config) as {
      mcpServers: {
        inreview: {
          type: string;
          command: string;
          args: string[];
          tools: string[];
        };
      };
    };
    expect(parsed.mcpServers.inreview).toMatchObject({
      type: "stdio",
      tools: [...COPILOT_ALLOWED_TOOLS],
    });
    if (process.platform === "win32") {
      expect(parsed.mcpServers.inreview.command).toMatch(/cmd\.exe$/iu);
      expect(parsed.mcpServers.inreview.args).toEqual([
        "/d",
        "/s",
        "/c",
        launcherPath,
      ]);
    } else {
      expect(parsed.mcpServers.inreview).toMatchObject({
        command: launcherPath,
        args: [],
      });
    }
    expect(config).not.toMatch(forbiddenSetupText);
  });

  it("rejects invalid launcher paths", () => {
    expect(() => buildCopilotMcpCommand("bad\u0000path")).toThrow(
      "launcher path",
    );
  });
});

describe("Copilot CLI bridge setup commands", () => {
  it("copies setup once without requiring a running workspace session", async () => {
    const runtime = new FakeRuntime({ state: "disconnected" });
    const ui = new FakeUi();
    ui.quickPickResults.push("Copilot CLI command");

    await createController(runtime, ui).copySetup();

    expect(ui.clipboard).toHaveLength(1);
    expect(ui.clipboard[0]).toContain(" inreview -- ");
    expect(ui.information.at(-1)).toContain("once");
  });

  it("does nothing when the format choice is cancelled", async () => {
    const ui = new FakeUi();
    await createController(
      new FakeRuntime({ state: "registered", sessionCount: 0 }),
      ui,
    ).copySetup();
    expect(ui.clipboard).toHaveLength(0);
  });

  it("reports unavailable bridge installation", async () => {
    const ui = new FakeUi();
    const controller = new CopilotSetupController({
      runtime: new FakeRuntime({ state: "disabled" }),
      ui,
      eligible: false,
      unavailableReason: "Bridge installation failed.",
    });

    await controller.copySetup();

    expect(ui.errors).toEqual(["Bridge installation failed."]);
  });

  it("shows bridge state and reconnects after an error", async () => {
    const runtime = new FakeRuntime({
      state: "error",
      message: "The bridge disconnected.",
    });
    runtime.restartResult = { state: "registered", sessionCount: 0 };
    const ui = new FakeUi();
    ui.errorResults.push("Reconnect Bridge");

    await createController(runtime, ui).showStatus();

    expect(runtime.restart).toHaveBeenCalledOnce();
    expect(ui.errors.join("\n")).toContain("State: error");
    expect(ui.information.at(-1)).toContain("registered");
  });
});

class FakeRuntime implements CopilotSetupRuntime {
  public restartResult: BridgeRuntimeStatus | undefined;
  public readonly restart = vi.fn(() => {
    if (this.restartResult !== undefined) {
      this.currentStatus = this.restartResult;
    }
    return Promise.resolve();
  });

  public constructor(private currentStatus: BridgeRuntimeStatus) {}

  public get status(): BridgeRuntimeStatus {
    return this.currentStatus;
  }
}

class FakeUi implements CopilotSetupUi {
  public readonly quickPickResults: (string | undefined)[] = [];
  public readonly errorResults: (string | undefined)[] = [];
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

function createController(
  runtime: CopilotSetupRuntime,
  ui: CopilotSetupUi,
): CopilotSetupController {
  return new CopilotSetupController({
    runtime,
    ui,
    eligible: true,
    launcherPath,
  });
}
