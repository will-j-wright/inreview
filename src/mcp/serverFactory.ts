import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ReviewService } from "../review/reviewService";
import type { McpSessionFactory } from "./sessionManager";
import type { McpToolSessionContext } from "./toolContext";
import { registerMcpReviewTools } from "./tools";

export const MCP_SERVER_NAME = "inreview";
export const MCP_SERVER_VERSION = "0.0.1";

export function createReviewMcpSessionFactory(
  service: ReviewService,
): McpSessionFactory<McpToolSessionContext> {
  return ({ applicationContext }) => {
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      { capabilities: { tools: {} } },
    );
    registerMcpReviewTools(server, {
      service,
      session: applicationContext,
    });

    let closed = false;
    return {
      connect: async (transport) => server.connect(transport),
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        try {
          await server.close();
        } finally {
          applicationContext.dispose();
        }
      },
    };
  };
}
