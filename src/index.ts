import { createMcpHandler } from "agents/mcp/server";
import { createMcpServer } from "./mcp";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/health") {
      return json({
        status: "ok",
        boxConfigured: Boolean(env.BOX_API_KEY),
        mcpTokenConfigured: Boolean(env.MCP_TOKEN),
      });
    }

    if (pathname !== "/mcp") return new Response("Not Found", { status: 404 });

    // CORS preflights pass through to the MCP handler.
    if (request.method !== "OPTIONS" && !(await isAuthorized(request, env))) {
      return json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="box-mcp"' });
    }
    return createMcpHandler(() => createMcpServer(env), { route: "/mcp" })(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  if (!env.MCP_TOKEN) return false; // fail closed if the secret is missing
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return false;
  // Compare fixed-length digests so the comparison is constant-time regardless of input length.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(token)),
    crypto.subtle.digest("SHA-256", enc.encode(env.MCP_TOKEN)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
