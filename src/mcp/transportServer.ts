import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import {
  isValidMcpSessionId,
  McpSessionManager,
  type McpSessionContext,
  type McpSessionFactory,
  type TimerProvider,
  SessionCapacityError,
} from "./sessionManager";

const LISTEN_ADDRESS = "127.0.0.1";
const MCP_PATH = "/mcp";

export interface McpTransportServerOptions<
  TApplicationContext extends object = Record<string, unknown>,
> {
  readonly port: number;
  readonly serverFactory: McpSessionFactory<TApplicationContext>;
  readonly createApplicationContext?: () => TApplicationContext;
  readonly allowedOrigins?: readonly string[];
  readonly maximumSessions?: number;
  readonly sessionIdleTimeoutMs?: number;
  readonly maximumBodyBytes?: number;
  readonly headersTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly keepAliveTimeoutMs?: number;
  readonly now?: () => number;
  readonly timers?: TimerProvider;
  readonly randomId?: () => string;
}

export interface McpTransportServerAddress {
  readonly address: typeof LISTEN_ADDRESS;
  readonly port: number;
  readonly endpoint: URL;
}

class BodyTooLargeError extends Error {}
class InvalidJsonError extends Error {}

const countRawHeader = (request: IncomingMessage, name: string): number => {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      count += 1;
    }
  }
  return count;
};

const sendJson = (
  response: ServerResponse,
  status: number,
  message: string,
  extraHeaders?: Readonly<Record<string, string>>,
): void => {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
};

const hasExplicitPort = (value: string, expectedPort: number): boolean => {
  const match = value.startsWith("[")
    ? /^\[[^\]]+\]:(\d+)$/u.exec(value)
    : /^[^:]+:(\d+)$/u.exec(value);
  return match?.[1] === String(expectedPort);
};

const hasExpectedHost = (value: string, expectedPort: number): boolean => {
  try {
    const url = new URL(`http://${value}`);
    return (
      hasExplicitPort(value, expectedPort) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
};

const isAllowedOrigin = (
  origin: string,
  expectedPort: number,
  allowedOrigins: ReadonlySet<string>,
): boolean => {
  if (allowedOrigins.has(origin)) {
    return true;
  }
  try {
    const url = new URL(origin);
    const authority = origin.slice("http://".length);
    return (
      url.protocol === "http:" &&
      origin.startsWith("http://") &&
      hasExplicitPort(authority, expectedPort) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
};

const readJsonBody = async (
  request: IncomingMessage,
  maximumBytes: number,
): Promise<unknown> => {
  const contentLength = request.headers["content-length"];
  if (
    contentLength !== undefined &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumBytes)
  ) {
    request.resume();
    throw new BodyTooLargeError();
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.byteLength;
    if (size > maximumBytes) {
      request.resume();
      throw new BodyTooLargeError();
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } catch {
    throw new InvalidJsonError();
  }
};

export class McpTransportServer<
  TApplicationContext extends object = Record<string, unknown>,
> {
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #maximumBodyBytes: number;
  readonly #httpServer;
  readonly #sessions: McpSessionManager<TApplicationContext>;
  #address: McpTransportServerAddress | undefined;
  #starting: Promise<McpTransportServerAddress> | undefined;
  #closing: Promise<void> | undefined;

  public constructor(options: McpTransportServerOptions<TApplicationContext>) {
    if (
      !Number.isSafeInteger(options.port) ||
      options.port < 0 ||
      options.port > 65_535
    ) {
      throw new RangeError("port must be an integer from 0 through 65535.");
    }
    this.#allowedOrigins = new Set(options.allowedOrigins ?? []);
    this.#maximumBodyBytes = options.maximumBodyBytes ?? 1024 * 1024;
    if (
      !Number.isSafeInteger(this.#maximumBodyBytes) ||
      this.#maximumBodyBytes < 1
    ) {
      throw new RangeError("maximumBodyBytes must be a positive integer.");
    }

    this.#sessions = new McpSessionManager({
      maximumSessions: options.maximumSessions ?? 16,
      idleTimeoutMs: options.sessionIdleTimeoutMs ?? 30 * 60 * 1000,
      serverFactory: options.serverFactory,
      ...(options.createApplicationContext === undefined
        ? {}
        : { createApplicationContext: options.createApplicationContext }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.timers === undefined ? {} : { timers: options.timers }),
      ...(options.randomId === undefined ? {} : { randomId: options.randomId }),
    });

    this.#httpServer = createServer((request, response) => {
      void this.#handleRequest(request, response).catch(() => {
        sendJson(response, 500, "Internal server error.");
      });
    });
    this.#httpServer.headersTimeout = options.headersTimeoutMs ?? 10_000;
    this.#httpServer.requestTimeout = options.requestTimeoutMs ?? 30_000;
    this.#httpServer.keepAliveTimeout = options.keepAliveTimeoutMs ?? 5_000;
    this.#httpServer.maxHeadersCount = 64;

    this.#starting = new Promise<McpTransportServerAddress>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.#httpServer.off("error", onError);
        const address = this.#httpServer.address() as AddressInfo;
        this.#address = {
          address: LISTEN_ADDRESS,
          port: address.port,
          endpoint: new URL(`http://${LISTEN_ADDRESS}:${String(address.port)}${MCP_PATH}`),
        };
        resolve(this.#address);
      };
      this.#httpServer.once("error", onError);
      this.#httpServer.once("listening", onListening);
      this.#httpServer.listen(options.port, LISTEN_ADDRESS);
    }).catch(async (error: unknown) => {
      await this.#sessions.close();
      throw error;
    });
  }

  public get address(): McpTransportServerAddress | undefined {
    return this.#address;
  }

  public async started(): Promise<McpTransportServerAddress> {
    if (this.#starting === undefined) {
      throw new Error("The MCP transport server is not available.");
    }
    return this.#starting;
  }

  public async close(): Promise<void> {
    if (this.#closing !== undefined) {
      return this.#closing;
    }
    this.#closing = (async () => {
      await this.#starting?.catch(() => undefined);
      await this.#sessions.close();
      await new Promise<void>((resolve, reject) => {
        if (!this.#httpServer.listening) {
          resolve();
          return;
        }
        this.#httpServer.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
        this.#httpServer.closeAllConnections();
      });
      this.#address = undefined;
      this.#starting = undefined;
    })();
    return this.#closing;
  }

  public get sessionCount(): number {
    return this.#sessions.size;
  }

  async #handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const address = this.#address;
    if (address === undefined || this.#closing !== undefined) {
      sendJson(response, 503, "Service unavailable.");
      return;
    }

    let requestUrl: URL;
    try {
      requestUrl = new URL(
        request.url ?? "",
        `http://${LISTEN_ADDRESS}:${String(address.port)}`,
      );
    } catch {
      sendJson(response, 404, "Not found.");
      return;
    }
    if (
      request.url?.startsWith("/") !== true ||
      request.url.startsWith("//") ||
      requestUrl.pathname !== MCP_PATH ||
      requestUrl.search !== "" ||
      requestUrl.hash !== ""
    ) {
      sendJson(response, 404, "Not found.");
      return;
    }

    if (
      countRawHeader(request, "host") !== 1 ||
      request.headers.host === undefined ||
      !hasExpectedHost(request.headers.host, address.port)
    ) {
      sendJson(response, 403, "Forbidden.");
      return;
    }
    const origin = request.headers.origin;
    if (
      origin !== undefined &&
      (countRawHeader(request, "origin") !== 1 ||
        !isAllowedOrigin(origin, address.port, this.#allowedOrigins))
    ) {
      sendJson(response, 403, "Forbidden.");
      return;
    }
    if (
      request.method !== "GET" &&
      request.method !== "POST" &&
      request.method !== "DELETE"
    ) {
      sendJson(response, 405, "Method not allowed.", {
        Allow: "GET, POST, DELETE",
      });
      return;
    }

    let parsedBody: unknown;
    if (request.method === "POST") {
      const accept = request.headers.accept;
      if (
        accept === undefined ||
        !accept.includes("application/json") ||
        !accept.includes("text/event-stream")
      ) {
        sendJson(response, 406, "Not acceptable.");
        return;
      }
      const contentType = request.headers["content-type"];
      if (
        contentType === undefined ||
        contentType.split(";", 1)[0]?.trim().toLowerCase() !==
          "application/json"
      ) {
        sendJson(response, 415, "Unsupported media type.");
        return;
      }
      try {
        parsedBody = await readJsonBody(request, this.#maximumBodyBytes);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendJson(response, 413, "Request body too large.");
        } else {
          sendJson(response, 400, "Invalid JSON request.");
        }
        return;
      }
    }

    const sessionHeaders = request.headers["mcp-session-id"];
    if (
      Array.isArray(sessionHeaders) ||
      countRawHeader(request, "mcp-session-id") > 1
    ) {
      sendJson(response, 404, "Session not found.");
      return;
    }

    if (sessionHeaders === undefined) {
      if (request.method !== "POST" || !isInitializeRequest(parsedBody)) {
        sendJson(response, 400, "Mcp-Session-Id header is required.");
        return;
      }
      let pending;
      try {
        pending = await this.#sessions.createPending();
      } catch (error) {
        if (error instanceof SessionCapacityError) {
          sendJson(response, 429, "Too many MCP sessions.");
          return;
        }
        throw error;
      }
      try {
        await pending.transport.handleRequest(request, response, parsedBody);
      } finally {
        if (!this.#sessions.isEstablished(pending)) {
          await this.#sessions.discardPending(pending);
        }
      }
      return;
    }

    if (!isValidMcpSessionId(sessionHeaders)) {
      sendJson(response, 404, "Session not found.");
      return;
    }
    const session = this.#sessions.get(sessionHeaders);
    if (session === undefined) {
      sendJson(response, 404, "Session not found.");
      return;
    }
    await session.transport.handleRequest(request, response, parsedBody);
    if (request.method === "DELETE") {
      await this.#sessions.delete(session);
    }
  }
}

export const createMcpTransportServer = async <
  TApplicationContext extends object = Record<string, unknown>,
>(
  options: McpTransportServerOptions<TApplicationContext>,
): Promise<McpTransportServer<TApplicationContext>> => {
  const server = new McpTransportServer(options);
  try {
    await server.started();
    return server;
  } catch (error) {
    await server.close();
    throw error;
  }
};

export type { McpSessionContext };
