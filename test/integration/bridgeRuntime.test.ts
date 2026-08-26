import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { BridgeRuntime } from "../../src/bridge";
import type { ReviewRecord } from "../../src/domain/comments";
import type { ReviewReadSession, ReviewRepository } from "../../src/review/types";
import { ReviewService } from "../../src/review/reviewService";
import { ReviewStore } from "../../src/storage";
import { makeReviewRecord } from "../unit/storageFixtures";

const workRoot = path.resolve(".test-work", "native-bridge");
const executable = path.resolve(
  "bridge",
  "target",
  "debug",
  process.platform === "win32" ? "inreview-bridge.exe" : "inreview-bridge",
);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

describe("native MCP bridge", () => {
  it("routes isolated stdio sessions to two registered extension workspaces", async () => {
    const testRoot = path.join(workRoot, randomUUID());
    await mkdir(testRoot, { recursive: true });
    cleanups.push(async () => rm(testRoot, { recursive: true, force: true }));
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\inreview-test-${randomUUID()}`
        : path.join(testRoot, "bridge.sock");
    const daemon = startDaemon(endpoint);
    cleanups.push(async () => stopProcess(daemon));
    await waitForEndpoint(endpoint);

    const first = await createHarness(testRoot, "first");
    const second = await createHarness(testRoot, "second");
    const firstRuntime = runtimeFor(first.service, endpoint);
    const secondRuntime = runtimeFor(second.service, endpoint);
    await firstRuntime.start();
    await secondRuntime.start();
    expect(firstRuntime.status.state).toBe("registered");
    expect(secondRuntime.status.state).toBe("registered");

    const duplicate = runtimeFor(first.service, endpoint);
    await duplicate.start();
    expect(duplicate.status.state).toBe("error");
    if (duplicate.status.state !== "error") {
      throw new Error("The duplicate workspace registration did not fail.");
    }
    expect(duplicate.status.message).toContain("already registered");

    const firstClient = await connectClient(endpoint);
    const secondClient = await connectClient(endpoint);
    expect((await firstClient.client.listTools()).tools.map(({ name }) => name)).toEqual([
      "list_workspaces",
      "connect_workspace",
      "read_review_metadata",
      "read_comments",
      "reply_comment",
      "close_comments",
    ]);

    expect(
      structured(
        await firstClient.client.callTool({
          name: "list_workspaces",
          arguments: {},
        }),
      ),
    ).toEqual({
      status: "success",
      workspaces: [
        { canonicalRoot: first.repositoryRoot, platform: currentPlatform() },
        { canonicalRoot: second.repositoryRoot, platform: currentPlatform() },
      ],
    });

    expect(
      structured(
        await secondClient.client.callTool({
          name: "read_review_metadata",
          arguments: {},
        }),
      ),
    ).toMatchObject({
      status: "error",
      error: { code: "NOT_CONNECTED" },
    });

    expect(
      structured(
        await firstClient.client.callTool({
          name: "connect_workspace",
          arguments: { workspace_root: first.repositoryRoot },
        }),
      ),
    ).toMatchObject({
      status: "connected",
      activeReview: { reviewId: first.record.review.id },
    });
    expect(
      structured(
        await secondClient.client.callTool({
          name: "connect_workspace",
          arguments: { workspace_root: second.repositoryRoot },
        }),
      ),
    ).toMatchObject({
      status: "connected",
      activeReview: { reviewId: second.record.review.id },
    });

    const firstMetadata = structured(
      await firstClient.client.callTool({
        name: "read_review_metadata",
        arguments: {},
      }),
    );
    const secondMetadata = structured(
      await secondClient.client.callTool({
        name: "read_review_metadata",
        arguments: {},
      }),
    );
    expect(firstMetadata).toMatchObject({
      status: "success",
      review: { reviewId: first.record.review.id },
    });
    expect(secondMetadata).toMatchObject({
      status: "success",
      review: { reviewId: second.record.review.id },
    });

    await firstRuntime.dispose();
    expect(
      structured(
        await firstClient.client.callTool({
          name: "read_comments",
          arguments: {},
        }),
      ),
    ).toMatchObject({
      status: "error",
      error: {
        code: "STALE_CONNECTION",
        reconnectRequired: true,
      },
    });

    await Promise.all([
      firstClient.client.close(),
      secondClient.client.close(),
      secondRuntime.dispose(),
      duplicate.dispose(),
    ]);
  });
});

interface Harness {
  readonly store: ReviewStore;
  readonly service: ReviewService;
  readonly record: ReviewRecord;
  readonly repositoryRoot: string;
}

async function createHarness(root: string, name: string): Promise<Harness> {
  const storageRoot = path.join(root, `${name}-storage`);
  const repositoryRoot = path.join(root, `${name}-repository`);
  await mkdir(storageRoot, { recursive: true });
  await mkdir(repositoryRoot, { recursive: true });
  const store = await ReviewStore.open({
    storageRoot,
    canonicalRepositoryRoot: repositoryRoot,
    environment: "bridge-test",
  });
  const record = makeReviewRecord(store.fingerprint);
  await store.putReview(record);
  const service = new ReviewService({
    canonicalRepositoryRoot: repositoryRoot,
    environment: "bridge-test",
    store,
    repository: new UnusedRepository(repositoryRoot),
  });
  cleanups.push(async () => {
    await service.close();
    await store.close();
  });
  return { store, service, record, repositoryRoot };
}

class UnusedRepository implements ReviewRepository {
  public constructor(public readonly repository: string) {}

  public async openReadSession(): Promise<ReviewReadSession> {
    return Promise.reject(
      new Error("The bridge integration test does not capture snapshots."),
    );
  }
}

function runtimeFor(
  service: ReviewService,
  endpoint: string,
): BridgeRuntime {
  const runtime = new BridgeRuntime({
    service,
    endpoint,
    executablePath: executable,
    eligible: true,
    enabled: true,
    launchDaemon: () => Promise.resolve(),
  });
  cleanups.push(async () => runtime.dispose());
  return runtime;
}

function startDaemon(endpoint: string): ChildProcess {
  return spawn(executable, ["daemon", "--endpoint", endpoint], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
}

async function connectClient(endpoint: string) {
  const transport = new StdioClientTransport({
    command: executable,
    args: ["mcp", "--endpoint", endpoint],
    stderr: "pipe",
  });
  const client = new Client({
    name: "inreview-bridge-test",
    version: "1.0.0",
  });
  await client.connect(transport);
  return { client, transport };
}

async function waitForEndpoint(endpoint: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await canConnect(endpoint)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The native bridge daemon did not start.");
}

function canConnect(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(endpoint);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    child.kill();
  });
}

function structured(result: unknown): object {
  if (
    typeof result === "object" &&
    result !== null &&
    "structuredContent" in result &&
    typeof result.structuredContent === "object" &&
    result.structuredContent !== null
  ) {
    return result.structuredContent;
  }
  throw new Error("The MCP tool returned no structured content.");
}

function currentPlatform(): "win32" | "linux" | "darwin" {
  if (
    process.platform === "win32" ||
    process.platform === "linux" ||
    process.platform === "darwin"
  ) {
    return process.platform;
  }
  throw new Error(`Unsupported test platform: ${process.platform}`);
}
