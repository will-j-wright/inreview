import type { ReviewService } from "../review/reviewService";
import { createReviewMcpSessionFactory } from "./serverFactory";
import {
  createMcpToolSessionContext,
  type McpToolSessionContext,
} from "./toolContext";
import {
  createMcpTransportServer,
  type McpTransportServer,
  type McpTransportServerOptions,
} from "./transportServer";

export type McpRuntimeStatus =
  | { readonly state: "disabled" }
  | { readonly state: "stopped" }
  | { readonly state: "starting" }
  | {
      readonly state: "running";
      readonly endpoint: string;
      readonly port: number;
      readonly sessionCount: number;
    }
  | { readonly state: "error"; readonly message: string };

export interface McpRuntimePolicy {
  readonly eligible: boolean;
  readonly enabled: boolean;
  readonly configuredPort?: number;
}

export interface McpRuntimeLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

type TransportFactory = (
  options: McpTransportServerOptions<McpToolSessionContext>,
) => Promise<McpTransportServer<McpToolSessionContext>>;

export interface McpRuntimeOptions extends McpRuntimePolicy {
  readonly service?: ReviewService;
  readonly logger?: McpRuntimeLogger;
  readonly transportFactory?: TransportFactory;
}

const START_ERROR = "The MCP server could not start.";
const MCP_PORT_RANGE_START = 41_000;
const MCP_PORT_RANGE_SIZE = 8_000;
const UINT32_RANGE_SIZE = 0x1_0000_0000n;

/**
 * Maps the first 32 fingerprint bits uniformly onto ports 41000-48999.
 * This fixed range stays below the Windows dynamic port range, which starts at 49152.
 */
export function deterministicMcpPort(repositoryFingerprint: string): number {
  if (!/^[0-9a-f]{64}$/iu.test(repositoryFingerprint)) {
    throw new Error(
      "The repository fingerprint must be a 64-character SHA-256 hexadecimal value.",
    );
  }
  const prefix = BigInt(`0x${repositoryFingerprint.slice(0, 8)}`);
  const offset =
    (prefix * BigInt(MCP_PORT_RANGE_SIZE)) / UINT32_RANGE_SIZE;
  return MCP_PORT_RANGE_START + Number(offset);
}

export class McpRuntime {
  readonly #service: ReviewService | undefined;
  readonly #logger: McpRuntimeLogger | undefined;
  readonly #transportFactory: TransportFactory;
  #policy: McpRuntimePolicy;
  #status: McpRuntimeStatus;
  #server: McpTransportServer<McpToolSessionContext> | undefined;
  #operation = Promise.resolve();
  #disposed = false;

  public constructor(options: McpRuntimeOptions) {
    this.#service = options.service;
    this.#logger = options.logger;
    this.#transportFactory =
      options.transportFactory ?? createMcpTransportServer;
    this.#policy = policy(options);
    this.#status = this.#shouldRun() ? { state: "stopped" } : { state: "disabled" };
  }

  public get status(): McpRuntimeStatus {
    if (this.#status.state === "running") {
      return {
        ...this.#status,
        sessionCount: this.#server?.sessionCount ?? 0,
      };
    }
    return this.#status;
  }

  public start(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#disposed || !this.#shouldRun() || this.#server !== undefined) {
        this.#status = this.#shouldRun()
          ? this.#status
          : { state: "disabled" };
        return;
      }
      await this.#startServer();
    });
  }

  public stop(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#stopServer();
      this.#status = this.#shouldRun()
        ? { state: "stopped" }
        : { state: "disabled" };
    });
  }

  public restart(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#stopServer();
      if (this.#disposed || !this.#shouldRun()) {
        this.#status = { state: "disabled" };
        return;
      }
      await this.#startServer();
    });
  }

  public configure(next: McpRuntimePolicy): Promise<void> {
    return this.#enqueue(async () => {
      const previousPort = this.#policy.configuredPort;
      this.#policy = policy(next);
      if (this.#disposed || !this.#shouldRun()) {
        await this.#stopServer();
        this.#status = { state: "disabled" };
        return;
      }
      if (
        this.#server !== undefined &&
        previousPort === this.#policy.configuredPort
      ) {
        return;
      }
      await this.#stopServer();
      await this.#startServer();
    });
  }

  public dispose(): Promise<void> {
    return this.#enqueue(async () => {
      this.#disposed = true;
      await this.#stopServer();
      this.#status = { state: "stopped" };
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

  async #startServer(): Promise<void> {
    const service = this.#service;
    if (service === undefined) {
      this.#status = { state: "disabled" };
      return;
    }
    this.#status = { state: "starting" };
    const requestedPort =
      this.#policy.configuredPort ?? deterministicMcpPort(service.storageKey);
    try {
      this.#server = await this.#createTransport(requestedPort);
    } catch (error) {
      this.#failStart(error, requestedPort);
      return;
    }
    const address = this.#server.address;
    if (address === undefined) {
      await this.#stopServer();
      this.#failStart(
        new Error("The MCP transport did not report an address."),
        requestedPort,
      );
      return;
    }
    this.#status = {
      state: "running",
      endpoint: address.endpoint.href,
      port: address.port,
      sessionCount: 0,
    };
    this.#logger?.info(`The MCP server is running on loopback port ${String(address.port)}.`);
  }

  async #createTransport(
    port: number,
  ): Promise<McpTransportServer<McpToolSessionContext>> {
    const service = this.#service;
    if (service === undefined) {
      throw new Error("The review service is unavailable.");
    }
    return this.#transportFactory({
      port,
      createApplicationContext: createMcpToolSessionContext,
      serverFactory: createReviewMcpSessionFactory(service),
    });
  }

  async #stopServer(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      await server.close().catch((error: unknown) => {
        void error;
        this.#logger?.error("Could not stop the MCP server");
      });
    }
  }

  #failStart(error: unknown, requestedPort: number): void {
    this.#status = {
      state: "error",
      message: startErrorMessage(error, requestedPort),
    };
    this.#logger?.error("Could not start the MCP server");
  }
}

function policy(value: McpRuntimePolicy): McpRuntimePolicy {
  return {
    eligible: value.eligible,
    enabled: value.enabled,
    ...(value.configuredPort === undefined
      ? {}
      : { configuredPort: value.configuredPort }),
  };
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EADDRINUSE"
  );
}

function startErrorMessage(
  error: unknown,
  requestedPort: number,
): string {
  if (isAddressInUse(error)) {
    return `The MCP port ${String(requestedPort)} is already in use. Set inreview.mcp.port to an available fixed port, then rerun Copy Copilot CLI MCP Setup.`;
  }
  if (!(error instanceof Error) || error.message.trim().length === 0) {
    return START_ERROR;
  }
  const detail = error.message.replaceAll(/\r?\n/gu, " ").trim().slice(0, 300);
  return `${START_ERROR} ${detail}`;
}
