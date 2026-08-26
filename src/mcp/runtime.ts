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
      readonly setupUpdateRequired: boolean;
    }
  | { readonly state: "error"; readonly message: string };

export interface McpRuntimePolicy {
  readonly eligible: boolean;
  readonly enabled: boolean;
  readonly configuredPort?: number;
}

export interface McpPreferredPortStore {
  get(key: string): unknown;
  update(key: string, value: number): Thenable<void>;
}

export interface McpRuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

type TransportFactory = (
  options: McpTransportServerOptions<McpToolSessionContext>,
) => Promise<McpTransportServer<McpToolSessionContext>>;

export interface McpRuntimeOptions extends McpRuntimePolicy {
  readonly service?: ReviewService;
  readonly preferredPortKey?: string;
  readonly preferredPortStore?: McpPreferredPortStore;
  readonly logger?: McpRuntimeLogger;
  readonly transportFactory?: TransportFactory;
}

const START_ERROR = "The MCP server could not start.";

export class McpRuntime {
  readonly #service: ReviewService | undefined;
  readonly #preferredPortKey: string | undefined;
  readonly #preferredPortStore: McpPreferredPortStore | undefined;
  readonly #logger: McpRuntimeLogger | undefined;
  readonly #transportFactory: TransportFactory;
  #policy: McpRuntimePolicy;
  #status: McpRuntimeStatus;
  #server: McpTransportServer<McpToolSessionContext> | undefined;
  #operation = Promise.resolve();
  #disposed = false;
  #setupUpdateRequired = false;

  public constructor(options: McpRuntimeOptions) {
    this.#service = options.service;
    this.#preferredPortKey = options.preferredPortKey;
    this.#preferredPortStore = options.preferredPortStore;
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
        setupUpdateRequired: this.#setupUpdateRequired,
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

  public markSetupCopied(): void {
    this.#setupUpdateRequired = false;
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
    const configuredPort = this.#policy.configuredPort;
    const storedPreferredPort = this.#readPreferredPort();
    const preferredPort =
      configuredPort === undefined ? storedPreferredPort : undefined;
    const requestedPort = configuredPort ?? preferredPort ?? 0;
    let endpointChanged = false;
    try {
      this.#server = await this.#createTransport(requestedPort);
    } catch (error) {
      if (
        configuredPort === undefined &&
        requestedPort !== 0 &&
        isAddressInUse(error)
      ) {
        this.#logger?.warn(
          "The preferred MCP port is unavailable. InReview will assign a new loopback port.",
        );
        endpointChanged = true;
        try {
          this.#server = await this.#createTransport(0);
        } catch (fallbackError) {
          this.#failStart(fallbackError);
          return;
        }
      } else {
        this.#failStart(error);
        return;
      }
    }
    const address = this.#server.address;
    if (address === undefined) {
      await this.#stopServer();
      this.#failStart(
        new Error("The MCP transport did not report an address."),
      );
      return;
    }
    endpointChanged ||=
      storedPreferredPort !== undefined &&
      storedPreferredPort !== address.port;
    if (configuredPort === undefined) {
      try {
        await this.#persistPreferredPort(address.port);
      } catch {
        await this.#stopServer();
        this.#status = {
          state: "error",
          message:
            "The MCP server could not save its assigned port. Check VS Code extension storage and retry.",
        };
        this.#logger?.error("Could not persist the preferred MCP port");
        return;
      }
    } else {
      await this.#persistPreferredPort(configuredPort).catch(() => {
        this.#logger?.warn("Could not remember the configured MCP port.");
      });
    }
    this.#setupUpdateRequired ||= endpointChanged;
    this.#status = {
      state: "running",
      endpoint: address.endpoint.href,
      port: address.port,
      sessionCount: 0,
      setupUpdateRequired: this.#setupUpdateRequired,
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

  #readPreferredPort(): number | undefined {
    if (
      this.#preferredPortKey === undefined ||
      this.#preferredPortStore === undefined
    ) {
      return undefined;
    }
    const value = this.#preferredPortStore.get(this.#preferredPortKey);
    return isPort(value) ? value : undefined;
  }

  async #persistPreferredPort(port: number): Promise<void> {
    if (
      this.#preferredPortKey !== undefined &&
      this.#preferredPortStore !== undefined
    ) {
      await this.#preferredPortStore.update(this.#preferredPortKey, port);
    }
  }

  #failStart(error: unknown): void {
    this.#status = {
      state: "error",
      message: startErrorMessage(error, this.#policy.configuredPort),
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

function isPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 65_535
  );
}

function startErrorMessage(
  error: unknown,
  configuredPort: number | undefined,
): string {
  if (configuredPort !== undefined && isAddressInUse(error)) {
    return `The configured MCP port ${String(configuredPort)} is already in use. Change InReview: MCP Port or stop the process that uses it.`;
  }
  if (!(error instanceof Error) || error.message.trim().length === 0) {
    return START_ERROR;
  }
  const detail = error.message.replaceAll(/\r?\n/gu, " ").trim().slice(0, 300);
  return `${START_ERROR} ${detail}`;
}
