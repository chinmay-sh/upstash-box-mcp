import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { boxApi, boxExec, parseJob, readJobCommand, startJobCommand } from "./box";
import type { Env } from "./types";

const boxId = z.string().regex(/^[A-Za-z0-9._-]+$/).describe("The box ID (its name works too)");
const jobId = z.string().regex(/^[A-Za-z0-9-]+$/).describe("The job_id returned by job_start");

// The Box API returns these in full, including the auth tokens of a box's MCP servers.
const SECRET_FIELDS = new Set(["headers", "attach_headers", "env_vars"]);

function text(data: unknown, isError = false) {
  const t = typeof data === "string" ? data : JSON.stringify(data, (k, v) => (SECRET_FIELDS.has(k) ? undefined : v), 2);
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

/** Builds a fresh MCP server per request (required by the stateless `createMcpHandler`). */
export function createMcpServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "box-mcp", version: "1.0.0" },
    {
      instructions:
        "Controls Upstash Boxes, which are cloud containers with a shell. Use box_exec for commands that finish " +
        "within 2 minutes. Use job_start for anything longer, such as a video render, then check it with job_status.",
    }
  );

  server.registerTool(
    "box_list",
    {
      description: "List the active boxes with their IDs, names and status.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => text(await boxApi(env, "box"))
  );

  server.registerTool(
    "box_get",
    {
      description: "Get one box's details and status.",
      inputSchema: z.object({ box_id: boxId }),
      annotations: { readOnlyHint: true },
    },
    async ({ box_id }) => text(await boxApi(env, `box/${box_id}`))
  );

  server.registerTool(
    "box_create",
    {
      description: "Create a box. The free plan only offers the small size, which is the default.",
      inputSchema: z.object({
        name: z.string().optional().describe("Display name"),
        runtime: z.string().optional().describe("Runtime image, e.g. node or python (default node)"),
        size: z.enum(["small", "medium", "large"]).optional(),
        env_vars: z.record(z.string(), z.string()).optional().describe("Environment variables inside the box"),
      }),
    },
    async (args) => text(await boxApi(env, "box", { method: "POST", body: args }))
  );

  for (const action of ["pause", "resume"] as const) {
    server.registerTool(
      `box_${action}`,
      {
        description: `${action === "pause" ? "Pause" : "Resume"} a box. Its files are kept while paused.`,
        inputSchema: z.object({ box_id: boxId }),
      },
      async ({ box_id }) => {
        await boxApi(env, `box/${box_id}/${action}`, { method: "POST" });
        return text(`Box ${box_id}: ${action} requested`);
      }
    );
  }

  server.registerTool(
    "box_exec",
    {
      description:
        "Run a shell command in a box and wait for it, up to 2 minutes. A paused box is resumed first. Each call " +
        "is a fresh shell, so pass folder instead of using cd. If the wait runs out the command keeps running in " +
        "the box, so do not retry it. Use job_start for anything longer.",
      inputSchema: z.object({
        box_id: boxId,
        command: z.array(z.string()).min(1).describe("Command as an array, e.g. ['bash', '-c', 'ls -la']"),
        folder: z.string().optional().describe("Working directory (default /workspace/home)"),
      }),
    },
    async ({ box_id, command, folder }) => {
      const res = await boxExec(env, box_id, command, folder);
      return text(res, res.exit_code !== 0);
    }
  );

  server.registerTool(
    "box_read_file",
    {
      description: "Read a text file from inside a box. Relative paths start at /workspace/home.",
      inputSchema: z.object({ box_id: boxId, path: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    async ({ box_id, path }) => {
      const query = new URLSearchParams({ path });
      return text((await boxApi<{ content?: string }>(env, `box/${box_id}/files/read?${query}`)).content ?? "");
    }
  );

  server.registerTool(
    "box_write_file",
    {
      description: "Create or overwrite a text file inside a box. Relative paths start at /workspace/home.",
      inputSchema: z.object({ box_id: boxId, path: z.string().min(1), content: z.string() }),
    },
    async ({ box_id, path, content }) => {
      await boxApi(env, `box/${box_id}/files/write`, { method: "POST", body: { path, content } });
      return text(`Wrote ${content.length} characters to ${path}`);
    }
  );

  server.registerTool(
    "job_start",
    {
      description:
        "Start a long command in a box and return at once with a job_id. It keeps running in the box after this " +
        "call ends. Use job_status to check it.",
      inputSchema: z.object({
        box_id: boxId,
        command: z.string().min(1).describe("Shell command, e.g. 'npm run render'"),
        folder: z.string().optional().describe("Working directory (default /workspace/home)"),
      }),
    },
    // shortcut: nothing watches a job, so a free box may idle-pause after an hour; add a poller if renders run longer.
    async ({ box_id, command, folder }) => {
      const job_id = crypto.randomUUID();
      const res = await boxExec(env, box_id, startJobCommand(job_id, command), folder);
      if (res.exit_code !== 0) return text(`Could not start job: ${res.error || res.output}`, true);
      return text({ job_id, box_id, status: "started" });
    }
  );

  server.registerTool(
    "job_status",
    {
      description: "Check a job: running, succeeded, failed or missing, with the end of its log.",
      inputSchema: z.object({ box_id: boxId, job_id: jobId }),
      annotations: { readOnlyHint: true },
    },
    async ({ box_id, job_id }) => {
      const res = await boxExec(env, box_id, readJobCommand(job_id));
      return text(parseJob(res.output ?? ""));
    }
  );

  return server;
}
