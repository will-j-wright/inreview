import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReviewRecord } from "../../src/domain/comments";
import {
  McpRuntime,
  type McpPreferredPortStore,
  type McpRuntimeStatus,
} from "../../src/mcp";
import type { ReviewReadSession, ReviewRepository } from "../../src/review/types";
import { ReviewService } from "../../src/review/reviewService";
import { ReviewStore } from "../../src/storage";
import { makeReviewRecord } from "./storageFixtures";

const workRoot = path.resolve(".test-work", "mcp-runtime");
const repositoryRoot = path.resolve(".test-work", "mcp-runtime-repository");
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(async (cleanup) => cleanup()));
  vi.restoreAllMocks();
});

describe("MCP runtime", () => {
  it("stays disabled without an eligible enabled review service", async () => {
    const transportFactory = vi.fn(() =>
      Promise.reject(new Error("must not start")),
    );
    const runtime = new McpRuntime({
      eligible: false,
      enabled: true,
      transportFactory,
    });

    await runtime.start();
    expect(runtime.status).toEqual({ state: "disabled" });
    expect(transportFactory).not.toHaveBeenCalled();

    await runtime.configure({ eligible: true, enabled: false });
    expect(runtime.status).toEqual({ state: "disabled" });
    expect(transportFactory).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("does not silently replace an explicitly configured port", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => {
      occupied.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(
      async () =>
        new Promise<void>((resolve) => {
          occupied.close(() => {
            resolve();
          });
        }),
    );
    const address = occupied.address();
    if (address === null || typeof address === "string") {
      throw new Error("The collision fixture did not bind.");
    }

    const harness = await createHarness();
    const runtime = runtimeFor(harness.service, address.port);
    await runtime.start();

    expect(runtime.status).toEqual({
      state: "error",
      message: `The configured MCP port ${String(address.port)} is already in use. Change InReview: MCP Port or stop the process that uses it.`,
    });
    await runtime.dispose();
  });

  it("persists and reuses an automatically assigned repository port", async () => {
    const harness = await createHarness();
    const state = new MemoryPortState();
    const key = `preferred.${harness.service.storageKey}`;
    const first = runtimeWithPortState(harness, state, key);
    await first.start();
    const firstPort = runningPort(first.status);
    expect(state.values.get(key)).toBe(firstPort);
    await first.dispose();

    const second = runtimeWithPortState(harness, state, key);
    await second.start();
    expect(runningPort(second.status)).toBe(firstPort);
    await second.dispose();
  });

  it("reassigns and persists a preferred port after a collision", async () => {
    const harness = await createHarness();
    const state = new MemoryPortState();
    const key = `preferred.${harness.service.storageKey}`;
    const first = runtimeWithPortState(harness, state, key);
    await first.start();
    const oldPort = runningPort(first.status);
    await first.dispose();

    const occupied = createServer();
    await new Promise<void>((resolve) => {
      occupied.listen(oldPort, "127.0.0.1", resolve);
    });
    cleanups.push(
      async () =>
        new Promise<void>((resolve) => {
          occupied.close(() => {
            resolve();
          });
        }),
    );

    const second = runtimeWithPortState(harness, state, key);
    await second.start();
    expect(runningPort(second.status)).not.toBe(oldPort);
    expect(state.values.get(key)).toBe(runningPort(second.status));
    expect(second.status).toMatchObject({
      state: "running",
      setupUpdateRequired: true,
    });
    second.markSetupCopied();
    expect(second.status).toMatchObject({
      state: "running",
      setupUpdateRequired: false,
    });
    await second.dispose();
  });

  it("requires setup recopy when an explicit setting changes the endpoint", async () => {
    const harness = await createHarness();
    const state = new MemoryPortState();
    const key = `preferred.${harness.service.storageKey}`;
    const runtime = runtimeWithPortState(harness, state, key);
    await runtime.start();
    const oldPort = runningPort(runtime.status);

    const reservation = createServer();
    await new Promise<void>((resolve) => {
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const reservedAddress = reservation.address();
    if (reservedAddress === null || typeof reservedAddress === "string") {
      throw new Error("The port reservation did not bind.");
    }
    const newPort = reservedAddress.port;
    await new Promise<void>((resolve) => {
      reservation.close(() => {
        resolve();
      });
    });

    await runtime.configure({
      eligible: true,
      enabled: true,
      configuredPort: newPort,
    });

    expect(runningPort(runtime.status)).toBe(newPort);
    expect(newPort).not.toBe(oldPort);
    expect(runtime.status).toMatchObject({
      setupUpdateRequired: true,
    });
    expect(state.values.get(key)).toBe(newPort);
    await runtime.dispose();
  });

  it("maps startup failure to status without rejecting activation", async () => {
    const harness = await createHarness();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const runtime = new McpRuntime({
      service: harness.service,
      eligible: true,
      enabled: true,
      logger,
      transportFactory: () =>
        Promise.reject(new Error("C:\\private\\storage\\detail")),
    });

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.status).toEqual({
      state: "error",
      message:
        "The MCP server could not start. C:\\private\\storage\\detail",
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private");
    await runtime.dispose();
  });

  it("runs all five tools, isolates sessions, rejects stale bindings, and shuts down", async () => {
    const harness = await createHarness(true);
    const runtime = runtimeFor(harness.service);
    await runtime.start();
    const endpoint = runningEndpoint(runtime.status);
    const first = await connectClient(endpoint);
    const second = await connectClient(endpoint);

    expect((await first.client.listTools()).tools.map(({ name }) => name)).toEqual([
      "connect_workspace",
      "read_review_metadata",
      "read_comments",
      "reply_comment",
      "close_comments",
    ]);
    expect(
      structured(await second.client.callTool({
        name: "read_review_metadata",
        arguments: {},
      })),
    ).toMatchObject({ status: "error", error: { code: "NOT_CONNECTED" } });

    expect(
      structured(await first.client.callTool({
        name: "connect_workspace",
        arguments: { workspace_root: repositoryRoot },
      })),
    ).toMatchObject({
      status: "connected",
      activeReview: { reviewId: harness.record.review.id },
    });
    expect(
      structured(await first.client.callTool({
        name: "read_review_metadata",
        arguments: {},
      })),
    ).toMatchObject({ status: "success" });

    const comments = structured(
      await first.client.callTool({ name: "read_comments", arguments: {} }),
    );
    expect(comments).toMatchObject({ status: "success" });
    const commentId = (
      comments as { comments?: { commentId?: string }[] }
    ).comments?.[0]?.commentId;
    expect(commentId).toBe(harness.record.threads[0]?.commentId);
    if (commentId === undefined) {
      throw new Error("The comment fixture is unavailable.");
    }

    expect(
      structured(await first.client.callTool({
        name: "reply_comment",
        arguments: { comment_id: commentId, body: "Agent reply" },
      })),
    ).toMatchObject({
      status: "success",
      message: { author: "Agent" },
    });
    expect(
      structured(await first.client.callTool({
        name: "close_comments",
        arguments: {
          comments: [
            { comment_id: commentId },
            { comment_id: randomUUID() },
          ],
        },
      })),
    ).toMatchObject({ status: "error", error: { code: "COMMENT_NOT_FOUND" } });
    expect(
      structured(await first.client.callTool({
        name: "close_comments",
        arguments: {
          comments: [{ comment_id: commentId, resolution_note: "Done" }],
        },
      })),
    ).toMatchObject({
      status: "success",
      resolved: [{ commentId, state: "resolved" }],
    });

    await harness.service.archiveActiveReview();
    const replacement = makeReviewRecord(harness.store.fingerprint);
    await harness.store.putReview(replacement);
    expect(
      structured(await first.client.callTool({
        name: "read_comments",
        arguments: {},
      })),
    ).toMatchObject({
      status: "error",
      error: { code: "STALE_CONNECTION", reconnectRequired: true },
    });
    expect(
      structured(await first.client.callTool({
        name: "connect_workspace",
        arguments: { workspace_root: repositoryRoot },
      })),
    ).toMatchObject({
      status: "connected",
      activeReview: { reviewId: replacement.review.id },
    });

    const oldSessionId = first.transport.sessionId;
    expect(oldSessionId).toBeDefined();
    await first.transport.terminateSession();
    await expect(
      fetch(endpoint, {
        method: "POST",
        headers: mcpHeaders(oldSessionId),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      }),
    ).resolves.toMatchObject({ status: 404 });

    await second.transport.terminateSession();
    await Promise.all([first.client.close(), second.client.close()]);
    await runtime.dispose();
    await expect(fetch(endpoint)).rejects.toThrow();
  });

  it("reports no active review through a tokenless SDK session", async () => {
    const harness = await createHarness(false);
    const runtime = runtimeFor(harness.service);
    await runtime.start();
    const connected = await connectClient(runningEndpoint(runtime.status));
    expect(
      structured(await connected.client.callTool({
        name: "connect_workspace",
        arguments: { workspace_root: repositoryRoot },
      })),
    ).toMatchObject({ status: "no_active_review" });
    await connected.transport.terminateSession();
    await connected.client.close();
    await runtime.dispose();
  });
});

class MemoryPortState implements McpPreferredPortStore {
  public readonly values = new Map<string, number>();

  public get(key: string): unknown {
    return this.values.get(key);
  }

  public update(key: string, value: number): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

interface Harness {
  readonly store: ReviewStore;
  readonly service: ReviewService;
  readonly record: ReviewRecord;
}

async function createHarness(withRecord = false): Promise<Harness> {
  const storageRoot = path.join(workRoot, randomUUID());
  await mkdir(storageRoot, { recursive: true });
  await mkdir(repositoryRoot, { recursive: true });
  const store = await ReviewStore.open({
    storageRoot,
    canonicalRepositoryRoot: repositoryRoot,
    environment: "test-environment",
  });
  const record = makeReviewRecord(store.fingerprint);
  if (withRecord) {
    await store.putReview(record);
  }
  const service = new ReviewService({
    canonicalRepositoryRoot: repositoryRoot,
    environment: "test-environment",
    store,
    repository: new UnusedRepository(),
  });
  cleanups.push(async () => {
    await service.close();
    await store.close();
    await rm(storageRoot, { recursive: true, force: true });
  });
  return {
    store,
    service,
    record,
  };
}

class UnusedRepository implements ReviewRepository {
  public readonly repository = repositoryRoot;

  public async openReadSession(): Promise<ReviewReadSession> {
    return Promise.reject(new Error("The MCP test does not capture snapshots."));
  }
}

function runtimeFor(
  service: ReviewService,
  configuredPort?: number,
): McpRuntime {
  const runtime = new McpRuntime({
    service,
    eligible: true,
    enabled: true,
    ...(configuredPort === undefined ? {} : { configuredPort }),
  });
  cleanups.push(async () => runtime.dispose());
  return runtime;
}

function runtimeWithPortState(
  harness: Harness,
  state: McpPreferredPortStore,
  preferredPortKey: string,
): McpRuntime {
  const runtime = new McpRuntime({
    service: harness.service,
    eligible: true,
    enabled: true,
    preferredPortKey,
    preferredPortStore: state,
  });
  cleanups.push(async () => runtime.dispose());
  return runtime;
}

async function connectClient(endpoint: URL) {
  const transport = new StreamableHTTPClientTransport(endpoint);
  const client = new Client({ name: "inreview-test-client", version: "1.0.0" });
  await client.connect(transport as Transport);
  return { client, transport };
}

function runningEndpoint(status: McpRuntimeStatus): URL {
  if (status.state !== "running") {
    throw new Error(`The MCP runtime is ${status.state}.`);
  }
  return new URL(status.endpoint);
}

function runningPort(status: McpRuntimeStatus): number {
  if (status.state !== "running") {
    throw new Error(`The MCP runtime is ${status.state}.`);
  }
  return status.port;
}

function structured(result: unknown): object {
  if (typeof result === "object" && result !== null) {
    if (
      "structuredContent" in result &&
      typeof result.structuredContent === "object" &&
      result.structuredContent !== null
    ) {
      return result.structuredContent;
    }
    if ("content" in result && Array.isArray(result.content)) {
      const content: unknown[] = result.content;
      const text = content.find(
        (item): item is { type: "text"; text: string } =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          "text" in item &&
          item.type === "text" &&
          typeof item.text === "string",
      )?.text;
      if (text !== undefined) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (typeof parsed === "object" && parsed !== null) {
            return parsed;
          }
        } catch {
          throw new Error(text);
        }
      }
    }
  }
  throw new Error("The MCP tool returned no structured content.");
}

function mcpHeaders(
  sessionId: string | undefined,
): Record<string, string> {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...(sessionId === undefined ? {} : { "Mcp-Session-Id": sessionId }),
  };
}
