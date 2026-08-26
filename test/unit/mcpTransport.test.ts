import { createServer, request as httpRequest } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  McpSessionContext,
  McpSessionServer,
  TimerProvider,
} from "../../src/mcp/sessionManager";
import {
  createMcpTransportServer,
  type McpTransportServer,
  type McpTransportServerOptions,
} from "../../src/mcp/transportServer";

interface ApplicationContext {
  workspace?: string;
}

const activeServers = new Set<McpTransportServer<ApplicationContext>>();

const factory = (
  contexts: McpSessionContext<ApplicationContext>[] = [],
  close?: (sessionId: string) => void,
) => (
  context: McpSessionContext<ApplicationContext>,
): McpSessionServer => {
  contexts.push(context);
  const server = new McpServer(
    { name: "transport-test", version: "1.0.0" },
    { capabilities: {} },
  );
  return {
    connect: async (transport) => server.connect(transport),
    close: async () => {
      close?.(context.sessionId);
      await server.close();
    },
  };
};

const start = async (
  overrides: Partial<McpTransportServerOptions<ApplicationContext>> = {},
): Promise<McpTransportServer<ApplicationContext>> => {
  const server = await createMcpTransportServer<ApplicationContext>({
    port: 0,
    maximumSessions: 4,
    sessionIdleTimeoutMs: 60_000,
    maximumBodyBytes: 4096,
    createApplicationContext: () => ({}),
    serverFactory: factory(),
    ...overrides,
  });
  activeServers.add(server);
  return server;
};

const mcpHeaders = (
  sessionId?: string,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  ...(sessionId === undefined
    ? {}
    : {
        "Mcp-Protocol-Version": "2025-11-25",
        "Mcp-Session-Id": sessionId,
      }),
  ...extra,
});

const initialize = async (
  server: McpTransportServer<ApplicationContext>,
): Promise<{ response: Response; sessionId: string }> => {
  const address = await server.started();
  const response = await fetch(address.endpoint, {
    method: "POST",
    headers: mcpHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "transport-test-client", version: "1.0.0" },
      },
    }),
  });
  const sessionId = response.headers.get("mcp-session-id");
  return { response, sessionId: sessionId ?? "" };
};

const rawRequestStatus = async (
  endpoint: URL,
  headers: Record<string, string>,
): Promise<number> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      endpoint,
      { method: "POST", headers },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    request.once("error", reject);
    request.end("{}");
  });

const postInitialized = async (
  server: McpTransportServer<ApplicationContext>,
  sessionId: string,
): Promise<Response> => {
  const address = await server.started();
  return fetch(address.endpoint, {
    method: "POST",
    headers: mcpHeaders(sessionId),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
};

afterEach(async () => {
  await Promise.all([...activeServers].map(async (server) => server.close()));
  activeServers.clear();
  vi.restoreAllMocks();
});

describe("MCP Streamable HTTP transport", () => {
  it("binds only to IPv4 loopback and reports its actual ephemeral port", async () => {
    const server = await start();
    const address = await server.started();

    expect(address.address).toBe("127.0.0.1");
    expect(address.port).toBeGreaterThan(0);
    expect(address.endpoint.href).toBe(
      `http://127.0.0.1:${String(address.port)}/mcp`,
    );

    const notFound = await fetch(
      `http://127.0.0.1:${String(address.port)}/other`,
    );
    expect(notFound.status).toBe(404);
  });

  it("runs tokenless initialize, POST, GET, and DELETE session flow", async () => {
    const server = await start();
    const { response, sessionId } = await initialize(server);
    expect(response.status).toBe(200);
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{20,128}$/u);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "transport-test" } },
    });
    expect(server.sessionCount).toBe(1);

    const initialized = await postInitialized(server, sessionId);
    expect(initialized.status).toBe(202);

    const address = await server.started();
    const ping = await fetch(address.endpoint, {
      method: "POST",
      headers: mcpHeaders(sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    expect(ping.status).toBe(200);
    await expect(ping.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: {},
    });

    const stream = await fetch(address.endpoint, {
      headers: mcpHeaders(sessionId),
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();

    const deleted = await fetch(address.endpoint, {
      method: "DELETE",
      headers: mcpHeaders(sessionId),
    });
    expect(deleted.status).toBe(200);
    expect(server.sessionCount).toBe(0);

    const afterDelete = await postInitialized(server, sessionId);
    expect(afterDelete.status).toBe(404);
  });

  it("accepts a valid loopback Host and Origin without authorization", async () => {
    const server = await start();
    const { endpoint, port } = await server.started();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: mcpHeaders(undefined, {
        Origin: `http://127.0.0.1:${String(port)}`,
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "tokenless-test", version: "1.0.0" },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("rejects Host and Origin rebinding while allowing strict origins", async () => {
    const server = await start({ allowedOrigins: ["https://trusted.example"] });
    const { endpoint, port } = await server.started();
    const invoke = async (headers: Record<string, string>): Promise<Response> =>
      fetch(endpoint, {
        method: "POST",
        headers: mcpHeaders(undefined, headers),
        body: "{}",
      });

    expect(
      await rawRequestStatus(endpoint, {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Host: `evil.example:${String(port)}`,
      }),
    ).toBe(403);
    expect(
      await rawRequestStatus(endpoint, {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Host: "127.0.0.1",
      }),
    ).toBe(403);
    expect(
      (await invoke({ Origin: `http://evil.example:${String(port)}` })).status,
    ).toBe(403);
    expect(
      (await invoke({ Origin: `https://127.0.0.1:${String(port)}` })).status,
    ).toBe(403);

    const loopback = await invoke({
      Origin: `http://localhost:${String(port)}`,
    });
    expect(loopback.status).not.toBe(403);
    const allowlisted = await invoke({ Origin: "https://trusted.example" });
    expect(allowlisted.status).not.toBe(403);
  });

  it("limits bodies and rejects unsupported methods deterministically", async () => {
    const server = await start({ maximumBodyBytes: 128 });
    const { endpoint } = await server.started();

    const oversized = await fetch(endpoint, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify({ padding: "x".repeat(256) }),
    });
    expect(oversized.status).toBe(413);

    for (const method of ["PATCH", "PUT", "OPTIONS"]) {
      const response = await fetch(endpoint, {
        method,
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, POST, DELETE");
    }
  });

  it("enforces the session cap and releases capacity on DELETE", async () => {
    const server = await start({ maximumSessions: 1 });
    const first = await initialize(server);
    await first.response.text();

    const second = await initialize(server);
    expect(second.response.status).toBe(429);
    expect(second.sessionId).toBe("");

    const address = await server.started();
    const deleted = await fetch(address.endpoint, {
      method: "DELETE",
      headers: mcpHeaders(first.sessionId),
    });
    expect(deleted.status).toBe(200);

    const replacement = await initialize(server);
    expect(replacement.response.status).toBe(200);
  });

  it("expires idle sessions and closes their MCP servers", async () => {
    let now = 1_000;
    const scheduled = new Map<object, { at: number; callback: () => void }>();
    const timers: TimerProvider = {
      setTimeout: (callback, delayMs) => {
        const handle = {};
        scheduled.set(handle, { at: now + delayMs, callback });
        return handle;
      },
      clearTimeout: (handle) => {
        scheduled.delete(handle as object);
      },
    };
    const closed = vi.fn();
    const server = await start({
      now: () => now,
      timers,
      sessionIdleTimeoutMs: 100,
      serverFactory: factory([], closed),
    });
    const initialized = await initialize(server);
    await initialized.response.text();

    now += 101;
    for (const [handle, timer] of [...scheduled]) {
      if (timer.at <= now) {
        scheduled.delete(handle);
        timer.callback();
      }
    }
    await vi.waitFor(() => {
      expect(server.sessionCount).toBe(0);
      expect(closed).toHaveBeenCalledOnce();
    });
    const expired = await postInitialized(server, initialized.sessionId);
    expect(expired.status).toBe(404);
  });

  it("keeps application context isolated between client sessions", async () => {
    const contexts: McpSessionContext<ApplicationContext>[] = [];
    const server = await start({ serverFactory: factory(contexts) });
    const first = await initialize(server);
    const second = await initialize(server);
    await Promise.all([first.response.text(), second.response.text()]);

    expect(contexts).toHaveLength(2);
    const [firstContext, secondContext] = contexts;
    if (firstContext === undefined || secondContext === undefined) {
      throw new Error("The expected session contexts were not created.");
    }
    firstContext.applicationContext.workspace = "first";
    expect(secondContext.applicationContext.workspace).toBeUndefined();
    expect(firstContext.sessionId).not.toBe(secondContext.sessionId);
  });

  it("rejects malformed, unknown, and fixed session identifiers", async () => {
    const server = await start();
    const { endpoint } = await server.started();
    const invoke = async (sessionId: string): Promise<Response> =>
      fetch(endpoint, {
        method: "POST",
        headers: mcpHeaders(sessionId),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });

    expect((await invoke("not valid!")).status).toBe(404);
    expect((await invoke("A".repeat(43))).status).toBe(404);

    const fixation = await fetch(endpoint, {
      method: "POST",
      headers: mcpHeaders("B".repeat(43)),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "client", version: "1" },
        },
      }),
    });
    expect(fixation.status).toBe(404);
    expect(server.sessionCount).toBe(0);
  });

  it("cleans up after a startup port collision", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => {
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (address === null || typeof address === "string") {
      throw new Error("The test server did not bind.");
    }

    const colliding = new (
      await import("../../src/mcp/transportServer")
    ).McpTransportServer<ApplicationContext>({
      port: address.port,
        serverFactory: factory(),
    });
    await expect(colliding.started()).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    await expect(colliding.close()).resolves.toBeUndefined();
    expect(colliding.address).toBeUndefined();
    await new Promise<void>((resolve, reject) => {
      occupied.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  });

  it("closes all sessions and stops accepting requests on shutdown", async () => {
    const closed = vi.fn();
    const server = await start({ serverFactory: factory([], closed) });
    const one = await initialize(server);
    const two = await initialize(server);
    await Promise.all([one.response.text(), two.response.text()]);
    const { endpoint } = await server.started();

    await server.close();
    activeServers.delete(server);
    expect(closed).toHaveBeenCalledTimes(2);
    expect(server.sessionCount).toBe(0);
    expect(server.address).toBeUndefined();
    await expect(fetch(endpoint)).rejects.toThrow();
  });
});
