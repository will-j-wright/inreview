import { randomBytes } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface McpSessionContext<
  TApplicationContext extends object = Record<string, unknown>,
> {
  readonly sessionId: string;
  readonly createdAt: number;
  readonly applicationContext: TApplicationContext;
}

export interface McpSessionServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export type McpSessionFactory<
  TApplicationContext extends object = Record<string, unknown>,
> = (
  context: McpSessionContext<TApplicationContext>,
) => McpSessionServer | Promise<McpSessionServer>;

export interface TimerProvider {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SessionManagerOptions<
  TApplicationContext extends object = Record<string, unknown>,
> {
  readonly maximumSessions: number;
  readonly idleTimeoutMs: number;
  readonly serverFactory: McpSessionFactory<TApplicationContext>;
  readonly createApplicationContext?: () => TApplicationContext;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly timers?: TimerProvider;
}

export interface ManagedMcpSession<
  TApplicationContext extends object = Record<string, unknown>,
> {
  readonly context: McpSessionContext<TApplicationContext>;
  readonly server: McpSessionServer;
  readonly transport: StreamableHTTPServerTransport;
}

interface SessionRecord<TApplicationContext extends object>
  extends ManagedMcpSession<TApplicationContext> {
  initialized: boolean;
  lastActivityAt: number;
  timer: unknown;
  closing?: Promise<void>;
}

const defaultTimers: TimerProvider = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const defaultRandomId = (): string => randomBytes(32).toString("base64url");
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/u;

export const isValidMcpSessionId = (value: string): boolean =>
  SESSION_ID_PATTERN.test(value);

export class SessionCapacityError extends Error {
  public constructor() {
    super("The MCP session limit has been reached.");
    this.name = "SessionCapacityError";
  }
}

export class McpSessionManager<
  TApplicationContext extends object = Record<string, unknown>,
> {
  readonly #maximumSessions: number;
  readonly #idleTimeoutMs: number;
  readonly #serverFactory: McpSessionFactory<TApplicationContext>;
  readonly #createApplicationContext: () => TApplicationContext;
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #timers: TimerProvider;
  readonly #sessions = new Map<string, SessionRecord<TApplicationContext>>();
  readonly #pending = new Map<string, SessionRecord<TApplicationContext>>();
  readonly #creatingIds = new Set<string>();
  readonly #creationTasks = new Set<Promise<void>>();
  #closed = false;

  public constructor(options: SessionManagerOptions<TApplicationContext>) {
    if (
      !Number.isSafeInteger(options.maximumSessions) ||
      options.maximumSessions < 1
    ) {
      throw new RangeError("maximumSessions must be a positive integer.");
    }
    if (
      !Number.isSafeInteger(options.idleTimeoutMs) ||
      options.idleTimeoutMs < 1
    ) {
      throw new RangeError("idleTimeoutMs must be a positive integer.");
    }

    this.#maximumSessions = options.maximumSessions;
    this.#idleTimeoutMs = options.idleTimeoutMs;
    this.#serverFactory = options.serverFactory;
    this.#createApplicationContext =
      options.createApplicationContext ??
      (() => Object.create(null) as TApplicationContext);
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? defaultRandomId;
    this.#timers = options.timers ?? defaultTimers;
  }

  public get size(): number {
    return this.#sessions.size;
  }

  public async createPending(): Promise<ManagedMcpSession<TApplicationContext>> {
    if (
      this.#closed ||
      this.#sessions.size + this.#pending.size + this.#creatingIds.size >=
        this.#maximumSessions
    ) {
      throw new SessionCapacityError();
    }

    const sessionId = this.#generateUniqueId();
    this.#creatingIds.add(sessionId);
    let completeCreation: (() => void) | undefined;
    const creationTask = new Promise<void>((resolve) => {
      completeCreation = resolve;
    });
    this.#creationTasks.add(creationTask);
    const createdAt = this.#now();
    const context: McpSessionContext<TApplicationContext> = {
      sessionId,
      createdAt,
      applicationContext: this.#createApplicationContext(),
    };
    let record: SessionRecord<TApplicationContext> | undefined;
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => sessionId,
      onsessioninitialized: (initializedId) => {
        if (initializedId !== sessionId || record === undefined) {
          throw new Error("The MCP transport generated an invalid session.");
        }
        this.#establish(record);
      },
    });

    let server: McpSessionServer | undefined;
    try {
      server = await this.#serverFactory(context);
      this.#ensureOpen();
      record = {
        context,
        server,
        transport,
        initialized: false,
        lastActivityAt: createdAt,
        timer: undefined,
      };
      this.#pending.set(sessionId, record);
      await server.connect(transport as Transport);
      return record;
    } catch (error) {
      this.#pending.delete(sessionId);
      await Promise.allSettled([
        transport.close(),
        ...(server === undefined ? [] : [server.close()]),
      ]);
      throw error;
    } finally {
      this.#creatingIds.delete(sessionId);
      completeCreation?.();
      this.#creationTasks.delete(creationTask);
    }
  }

  public get(sessionId: string): ManagedMcpSession<TApplicationContext> | undefined {
    const record = this.#sessions.get(sessionId);
    if (record !== undefined) {
      this.#touch(record);
    }
    return record;
  }

  public isEstablished(
    session: ManagedMcpSession<TApplicationContext>,
  ): boolean {
    return this.#sessions.get(session.context.sessionId) === session;
  }

  public async discardPending(
    session: ManagedMcpSession<TApplicationContext>,
  ): Promise<void> {
    const record = session as SessionRecord<TApplicationContext>;
    if (this.#pending.get(record.context.sessionId) === record) {
      this.#pending.delete(record.context.sessionId);
      await this.#dispose(record);
    }
  }

  public async delete(
    session: ManagedMcpSession<TApplicationContext>,
  ): Promise<void> {
    const record = session as SessionRecord<TApplicationContext>;
    this.#sessions.delete(record.context.sessionId);
    this.#pending.delete(record.context.sessionId);
    await this.#dispose(record);
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await Promise.allSettled([...this.#creationTasks]);
    const records = [...this.#sessions.values(), ...this.#pending.values()];
    this.#sessions.clear();
    this.#pending.clear();
    await Promise.allSettled(records.map(async (record) => this.#dispose(record)));
  }

  #generateUniqueId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.#randomId();
      if (
        isValidMcpSessionId(id) &&
        !this.#sessions.has(id) &&
        !this.#pending.has(id) &&
        !this.#creatingIds.has(id)
      ) {
        return id;
      }
    }
    throw new Error("Unable to generate a unique MCP session identifier.");
  }

  #ensureOpen(): void {
    if (this.#closed) {
      throw new Error("The MCP session manager is closed.");
    }
  }

  #establish(record: SessionRecord<TApplicationContext>): void {
    const { sessionId } = record.context;
    if (
      this.#closed ||
      this.#pending.get(sessionId) !== record ||
      this.#sessions.has(sessionId)
    ) {
      throw new Error("Unable to establish the MCP session.");
    }
    this.#pending.delete(sessionId);
    record.initialized = true;
    record.lastActivityAt = this.#now();
    this.#sessions.set(sessionId, record);
    this.#armExpiry(record);
  }

  #touch(record: SessionRecord<TApplicationContext>): void {
    record.lastActivityAt = this.#now();
    this.#armExpiry(record);
  }

  #armExpiry(record: SessionRecord<TApplicationContext>): void {
    if (record.timer !== undefined) {
      this.#timers.clearTimeout(record.timer);
    }
    const elapsed = Math.max(0, this.#now() - record.lastActivityAt);
    record.timer = this.#timers.setTimeout(() => {
      record.timer = undefined;
      if (this.#now() - record.lastActivityAt < this.#idleTimeoutMs) {
        this.#armExpiry(record);
        return;
      }
      this.#sessions.delete(record.context.sessionId);
      void this.#dispose(record).catch(() => undefined);
    }, Math.max(1, this.#idleTimeoutMs - elapsed));
  }

  async #dispose(record: SessionRecord<TApplicationContext>): Promise<void> {
    if (record.closing !== undefined) {
      return record.closing;
    }
    if (record.timer !== undefined) {
      this.#timers.clearTimeout(record.timer);
      record.timer = undefined;
    }
    record.closing = (async () => {
      try {
        await record.server.close();
      } finally {
        await record.transport.close();
      }
    })();
    return record.closing;
  }
}
