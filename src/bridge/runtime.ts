import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  closeCommentsInputSchema,
  connectWorkspaceInputSchema,
  readCommentsInputSchema,
  readReviewMetadataInputSchema,
  replyCommentInputSchema,
} from "../mcp/schemas";
import {
  createMcpReviewToolHandlers,
  type McpReviewToolHandlers,
} from "../mcp/tools";
import {
  createMcpToolSessionContext,
  type McpToolSessionContext,
} from "../mcp/toolContext";
import type { ReviewService } from "../review";
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_VERSION,
  bridgeCloseSessionSchema,
  bridgeRegisterResultSchema,
  bridgeToolCallSchema,
  type BridgeRegistration,
  type BridgeToolCall,
} from "./protocol";
import { BridgeRpcError, BridgeRpcPeer } from "./rpcPeer";

export type BridgeRuntimeStatus =
  | { readonly state: "disabled" }
  | { readonly state: "disconnected" }
  | { readonly state: "connecting" }
  | {
      readonly state: "registered";
      readonly sessionCount: number;
    }
  | { readonly state: "error"; readonly message: string };

export interface BridgeRuntimePolicy {
  readonly eligible: boolean;
  readonly enabled: boolean;
}

export interface BridgeRuntimeLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface BridgeRuntimeOptions extends BridgeRuntimePolicy {
  readonly service?: ReviewService;
  readonly executablePath: string;
  readonly endpoint: string;
  readonly logger?: BridgeRuntimeLogger;
  readonly connect?: (endpoint: string) => Promise<Socket>;
  readonly launchDaemon?: (
    executablePath: string,
    endpoint: string,
  ) => Promise<void>;
}

const CONNECT_TIMEOUT_MS = 5_000;
const CONNECT_RETRY_MS = 50;
const RECONNECT_MAX_MS = 30_000;

export class BridgeRuntime {
  readonly #service: ReviewService | undefined;
  readonly #executablePath: string;
  readonly #endpoint: string;
  readonly #logger: BridgeRuntimeLogger | undefined;
  readonly #connect: (endpoint: string) => Promise<Socket>;
  readonly #launchDaemon: (
    executablePath: string,
    endpoint: string,
  ) => Promise<void>;
  readonly #instanceId = randomUUID();
  readonly #sessions = new Map<string, McpToolSessionContext>();
  #policy: BridgeRuntimePolicy;
  #status: BridgeRuntimeStatus;
  #peer: BridgeRpcPeer | undefined;
  #operation = Promise.resolve();
  #reconnectTimer: NodeJS.Timeout | undefined;
  #reconnectDelayMs = 500;
  #disposed = false;
  #stopping = false;

  public constructor(options: BridgeRuntimeOptions) {
    this.#service = options.service;
    this.#executablePath = options.executablePath;
    this.#endpoint = options.endpoint;
    this.#logger = options.logger;
    this.#connect = options.connect ?? connectSocket;
    this.#launchDaemon = options.launchDaemon ?? launchDaemon;
    this.#policy = {
      eligible: options.eligible,
      enabled: options.enabled,
    };
    this.#status = this.#shouldRun()
      ? { state: "disconnected" }
      : { state: "disabled" };
  }

  public get status(): BridgeRuntimeStatus {
    return this.#status.state === "registered"
      ? { state: "registered", sessionCount: this.#sessions.size }
      : this.#status;
  }

  public start(): Promise<void> {
    return this.#enqueue(async () => {
      if (
        this.#disposed ||
        !this.#shouldRun() ||
        (this.#peer !== undefined && !this.#peer.closed)
      ) {
        this.#status = this.#shouldRun()
          ? this.#status
          : { state: "disabled" };
        return;
      }
      await this.#connectAndRegister();
    });
  }

  public restart(): Promise<void> {
    return this.#enqueue(async () => {
      this.#stopConnection();
      if (this.#disposed || !this.#shouldRun()) {
        this.#status = { state: "disabled" };
        return;
      }
      await this.#connectAndRegister();
    });
  }

  public configure(policy: BridgeRuntimePolicy): Promise<void> {
    return this.#enqueue(async () => {
      this.#policy = {
        eligible: policy.eligible,
        enabled: policy.enabled,
      };
      if (this.#disposed || !this.#shouldRun()) {
        this.#stopConnection();
        this.#status = { state: "disabled" };
        return;
      }
      if (this.#peer === undefined || this.#peer.closed) {
        await this.#connectAndRegister();
      }
    });
  }

  public dispose(): Promise<void> {
    return this.#enqueue(() => {
      this.#disposed = true;
      this.#stopConnection();
      this.#status = { state: "disconnected" };
      return Promise.resolve();
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #shouldRun(): boolean {
    return (
      this.#policy.eligible &&
      this.#policy.enabled &&
      this.#service !== undefined
    );
  }

  async #connectAndRegister(): Promise<void> {
    const service = this.#service;
    if (service === undefined) {
      this.#status = { state: "disabled" };
      return;
    }
    this.#status = { state: "connecting" };
    try {
      const socket = await this.#connectOrLaunch();
      const peer = new BridgeRpcPeer(
        socket,
        async (method, params) => this.#handleRequest(method, params),
        (error) => {
          this.#handleDisconnect(peer, error);
        },
      );
      this.#peer = peer;
      const registration: BridgeRegistration = {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        bridgeVersion: BRIDGE_VERSION,
        instanceId: this.#instanceId,
        canonicalWorkspaceRoot: service.canonicalRepositoryRoot,
        repositoryFingerprint: service.storageKey,
        platform: platform(),
      };
      bridgeRegisterResultSchema.parse(
        await peer.request("register_workspace", registration),
      );
      this.#reconnectDelayMs = 500;
      this.#status = { state: "registered", sessionCount: 0 };
      this.#logger?.info("The workspace is registered with the InReview bridge.");
    } catch (error) {
      this.#stopConnection();
      this.#status = {
        state: "error",
        message: bridgeErrorMessage(error),
      };
      this.#logger?.error("Could not register with the InReview bridge");
      if (!isPermanentBridgeError(error)) {
        this.#scheduleReconnect();
      }
    }
  }

  async #connectOrLaunch(): Promise<Socket> {
    try {
      return await this.#connect(this.#endpoint);
    } catch {
      await this.#launchDaemon(this.#executablePath, this.#endpoint);
    }
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.#connect(this.#endpoint);
      } catch (error) {
        lastError = error;
        await delay(CONNECT_RETRY_MS);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("The InReview bridge daemon did not start.");
  }

  async #handleRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "call_tool") {
      const call = bridgeToolCallSchema.parse(params);
      return this.#callTool(call);
    }
    if (method === "close_session") {
      const { sessionId } = bridgeCloseSessionSchema.parse(params);
      this.#sessions.get(sessionId)?.dispose();
      this.#sessions.delete(sessionId);
      return {};
    }
    throw new BridgeRpcError(
      "UNKNOWN_METHOD",
      "The bridge requested an unsupported extension operation.",
    );
  }

  async #callTool(call: BridgeToolCall): Promise<CallToolResult> {
    const service = this.#service;
    if (service === undefined) {
      throw new BridgeRpcError(
        "WORKSPACE_UNAVAILABLE",
        "The workspace review service is unavailable.",
      );
    }
    let session = this.#sessions.get(call.sessionId);
    if (session === undefined) {
      session = createMcpToolSessionContext();
      this.#sessions.set(call.sessionId, session);
    }
    const handlers = createMcpReviewToolHandlers({ service, session });
    return dispatchTool(handlers, call);
  }

  #handleDisconnect(peer: BridgeRpcPeer, error: Error): void {
    if (this.#peer !== peer || this.#stopping || this.#disposed) {
      return;
    }
    this.#peer = undefined;
    this.#disposeSessions();
    this.#status = {
      state: "error",
      message: "The InReview bridge connection closed.",
    };
    this.#logger?.error("The InReview bridge connection closed", error);
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (
      this.#disposed ||
      !this.#shouldRun() ||
      this.#reconnectTimer !== undefined
    ) {
      return;
    }
    const delayMs = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(
      this.#reconnectDelayMs * 2,
      RECONNECT_MAX_MS,
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.start();
    }, delayMs);
  }

  #stopConnection(): void {
    this.#stopping = true;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    const peer = this.#peer;
    this.#peer = undefined;
    peer?.close();
    this.#disposeSessions();
    this.#stopping = false;
  }

  #disposeSessions(): void {
    for (const session of this.#sessions.values()) {
      session.dispose();
    }
    this.#sessions.clear();
  }
}

async function dispatchTool(
  handlers: McpReviewToolHandlers,
  call: BridgeToolCall,
): Promise<CallToolResult> {
  switch (call.name) {
    case "connect_workspace":
      return handlers.connectWorkspace(
        connectWorkspaceInputSchema.parse(call.arguments),
      );
    case "read_review_metadata":
      return handlers.readReviewMetadata(
        readReviewMetadataInputSchema.parse(call.arguments),
      );
    case "read_comments":
      return handlers.readComments(readCommentsInputSchema.parse(call.arguments));
    case "reply_comment":
      return handlers.replyComment(replyCommentInputSchema.parse(call.arguments));
    case "close_comments":
      return handlers.closeComments(closeCommentsInputSchema.parse(call.arguments));
  }
}

function connectSocket(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function launchDaemon(
  executablePath: string,
  endpoint: string,
): Promise<void> {
  const child = spawn(
    executablePath,
    ["daemon", "--endpoint", endpoint],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
  return Promise.resolve();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function platform(): BridgeRegistration["platform"] {
  if (
    process.platform !== "win32" &&
    process.platform !== "linux" &&
    process.platform !== "darwin"
  ) {
    throw new Error("The InReview bridge does not support this platform.");
  }
  return process.platform;
}

function bridgeErrorMessage(error: unknown): string {
  if (error instanceof BridgeRpcError) {
    if (error.code === "DUPLICATE_WORKSPACE") {
      return "Another VS Code window already registered this workspace with the InReview bridge.";
    }
    if (error.code === "INCOMPATIBLE_PROTOCOL") {
      return "The installed InReview bridge is incompatible with this extension.";
    }
  }
  return "The extension could not connect to the InReview bridge.";
}

function isPermanentBridgeError(error: unknown): boolean {
  return (
    error instanceof BridgeRpcError &&
    (error.code === "DUPLICATE_WORKSPACE" ||
      error.code === "DUPLICATE_INSTANCE" ||
      error.code === "INCOMPATIBLE_PROTOCOL")
  );
}
