import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../logger/index.js";
import { safeCause } from "../bridge/control-plane-error.js";

/**
 * Stateless Streamable HTTP handler: a fresh McpServer + transport per POST.
 * This maximizes compatibility with remote MCP clients (including ChatGPT)
 * and avoids cross-request session state on a public endpoint.
 */
export function createMcpHttpHandler(makeServer: () => McpServer, logger: Logger) {
  return async (req: Request, res: Response): Promise<void> => {
    if (req.method === "GET" || req.method === "DELETE") {
      // Stateless mode: no server-initiated streams, no sessions to delete.
      res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. Use POST." },
        id: null,
      });
      return;
    }
    let server: McpServer | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      server = makeServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport?.close().catch(() => undefined);
        void server?.close().catch(() => undefined);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const cause = safeCause(error, "a2c", "mcp_transport");
      logger.error("MCP request handling failed", cause);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: cause.safe_message, data: cause },
          id: typeof req.body?.id === "string" || typeof req.body?.id === "number" ? req.body.id : null,
        });
      }
    }
  };
}
