import type { NextFunction, Request, Response } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AuthStore } from "./store.js";
import type { Logger } from "../logger/index.js";

export interface BearerAuthDeps {
  store: AuthStore;
  /** Kept for compatibility with the single-workspace bridge. */
  workspaceId?: string;
  authorizedWorkspaceIds?: readonly string[];
  getBaseUrl: (req: Request) => string;
  logger: Logger;
}

/**
 * Bearer-token guard for /mcp.
 * - missing/invalid/expired token  -> 401 (+ WWW-Authenticate with resource metadata)
 * - valid token with no authorized registered workspace -> 403
 */
export function bearerAuth(deps: BearerAuthDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const challenge = (error: string, description: string): string =>
      `Bearer realm="c2c", error="${error}", error_description="${description}", ` +
      `resource_metadata="${deps.getBaseUrl(req)}/.well-known/oauth-protected-resource/mcp"`;

    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith("bearer ")) {
      res
        .status(401)
        .set("WWW-Authenticate", challenge("invalid_token", "Missing bearer token"))
        .json({ error: "unauthorized", error_description: "Authentication required" });
      return;
    }
    const token = header.slice(7).trim();
    const verdict = deps.store.verifyAccessToken(token);
    if (!verdict.ok) {
      deps.logger.warn(`Rejected MCP request: token ${verdict.reason}`);
      res
        .status(401)
        .set("WWW-Authenticate", challenge("invalid_token", `Token ${verdict.reason}`))
        .json({ error: "unauthorized", error_description: `Token ${verdict.reason}` });
      return;
    }
    const registeredWorkspaceIds = new Set(
      deps.authorizedWorkspaceIds ?? (deps.workspaceId ? [deps.workspaceId] : deps.store.authorizedWorkspaceIds)
    );
    const tokenWorkspaceIds = Array.isArray(verdict.record.workspaceIds)
      ? verdict.record.workspaceIds
      : verdict.record.workspaceId
        ? [verdict.record.workspaceId]
        : [];
    const authorizedWorkspaceIds = tokenWorkspaceIds.filter((id) => registeredWorkspaceIds.has(id));
    if (authorizedWorkspaceIds.length === 0) {
      deps.logger.warn("Rejected MCP request: token bound to a different workspace");
      res.status(403).json({
        error: "forbidden",
        error_description: "This token is not authorized for any registered workspace",
      });
      return;
    }
    const authInfo: AuthInfo = {
      token,
      clientId: verdict.record.clientId,
      scopes: verdict.record.scopes,
      expiresAt: Math.floor(verdict.record.expiresAt / 1000),
      // Preserve the token's primary workspace binding for legacy single-
      // workspace callers. Multi-workspace operations still accept an
      // explicit workspace_id (or resolve by task/session/output ownership).
      extra: {
        authorizedWorkspaceIds,
        defaultWorkspaceId: authorizedWorkspaceIds[0],
      },
    };
    (req as Request & { auth?: AuthInfo }).auth = authInfo;
    next();
  };
}
