import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";

import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_REQUEST_TIMEOUT_MS,
  bridgeWireMessageSchema,
  type BridgeWireRequest,
} from "./protocol";

export class BridgeRpcError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeRpcError";
  }
}

export type BridgeRequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown>;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class BridgeRpcPeer {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #handler: BridgeRequestHandler;
  #buffer = "";
  #closed = false;

  public constructor(
    private readonly socket: Socket,
    handler: BridgeRequestHandler,
    private readonly onClosed?: (error: Error) => void,
  ) {
    this.#handler = handler;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#receive(chunk);
    });
    socket.on("error", (error) => {
      this.#close(error);
    });
    socket.on("close", () => {
      this.#close(new Error("The InReview bridge connection closed."));
    });
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(
        new BridgeRpcError("BRIDGE_DISCONNECTED", "The InReview bridge is disconnected."),
      );
    }
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new BridgeRpcError(
            "BRIDGE_TIMEOUT",
            "The InReview bridge request timed out.",
          ),
        );
      }, BRIDGE_REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ type: "request", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : new Error("The InReview bridge request failed."),
        );
      }
    });
  }

  public close(): void {
    if (!this.#closed) {
      this.socket.destroy();
      this.#close(new Error("The InReview bridge connection closed."));
    }
  }

  #receive(chunk: string): void {
    if (this.#closed) {
      return;
    }
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > BRIDGE_MAX_MESSAGE_BYTES) {
      this.#close(
        new BridgeRpcError(
          "BRIDGE_MESSAGE_TOO_LARGE",
          "The InReview bridge message exceeded the size limit.",
        ),
      );
      this.socket.destroy();
      return;
    }

    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.#protocolFailure("The InReview bridge sent invalid JSON.");
        return;
      }
      const message = bridgeWireMessageSchema.safeParse(parsed);
      if (!message.success) {
        this.#protocolFailure("The InReview bridge sent an invalid message.");
        return;
      }
      if (message.data.type === "request") {
        void this.#handleRequest(message.data);
      } else {
        const pending = this.#pending.get(message.data.id);
        if (pending === undefined) {
          this.#protocolFailure("The InReview bridge sent an unknown response.");
          return;
        }
        clearTimeout(pending.timer);
        this.#pending.delete(message.data.id);
        if (message.data.ok) {
          pending.resolve(message.data.result);
        } else {
          pending.reject(
            new BridgeRpcError(
              message.data.error.code,
              message.data.error.message,
            ),
          );
        }
      }
    }
  }

  async #handleRequest(request: BridgeWireRequest): Promise<void> {
    try {
      const result = await this.#handler(request.method, request.params);
      this.#send({ type: "response", id: request.id, ok: true, result });
    } catch (error) {
      this.#send({
        type: "response",
        id: request.id,
        ok: false,
        error: {
          code:
            error instanceof BridgeRpcError
              ? error.code
              : "EXTENSION_REQUEST_FAILED",
          message:
            error instanceof BridgeRpcError
              ? error.message
              : "The extension could not complete the bridge request.",
        },
      });
    }
  }

  #send(message: object): void {
    const encoded = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > BRIDGE_MAX_MESSAGE_BYTES) {
      throw new BridgeRpcError(
        "BRIDGE_MESSAGE_TOO_LARGE",
        "The InReview bridge message exceeded the size limit.",
      );
    }
    this.socket.write(encoded);
  }

  #protocolFailure(message: string): void {
    const error = new BridgeRpcError("BRIDGE_PROTOCOL_ERROR", message);
    this.#close(error);
    this.socket.destroy();
  }

  #close(error: Error): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.onClosed?.(error);
  }
}
