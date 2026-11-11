import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import type { Env } from "../src/types";

// Workers have this and Node does not.
Object.assign(crypto.subtle, {
  timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b)),
});

const env: Env = { BOX_API_KEY: "box_test", MCP_TOKEN: "secret" };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const call = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`https://box.test${path}`, init) as never, env, ctx);

const rpc = (method: string, id: number, params: unknown = {}) => ({
  method: "POST",
  headers: {
    Authorization: "Bearer secret",
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
});

/** The MCP handler may answer as JSON or as one server-sent event. */
async function result(res: Response) {
  const body = await res.text();
  return JSON.parse(body.match(/^data: (.*)$/m)?.[1] ?? body);
}

/** Runs one tool with fetch stubbed, and returns its reply and the request it sent to Box. */
async function tool(name: string, args: unknown, boxReply: unknown) {
  const realFetch = globalThis.fetch;
  let sent: Request | undefined;
  globalThis.fetch = (async (input: RequestInfo, opts?: RequestInit) => {
    sent = new Request(input, opts);
    return new Response(JSON.stringify(boxReply));
  }) as typeof fetch;
  const reply = await result(await call("/mcp", rpc("tools/call", 9, { name, arguments: args })));
  globalThis.fetch = realFetch;
  return { reply: reply.result, sent: sent! };
}

// Health shows only whether settings exist, never their values.
const health = await (await call("/health")).text();
assert.match(health, /"boxConfigured": true/);
assert.ok(!health.includes("box_test"));

// The MCP endpoint needs the token.
assert.equal((await call("/mcp", { method: "POST", body: "{}" })).status, 401);
assert.equal(
  (await call("/mcp", { method: "POST", headers: { Authorization: "Bearer wrong" }, body: "{}" })).status,
  401
);

// With the token, every tool is listed.
const init = rpc("initialize", 1, {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "test", version: "0" },
});
assert.equal((await result(await call("/mcp", init))).result.serverInfo.name, "box-mcp");

const { result: list } = await result(await call("/mcp", rpc("tools/list", 2)));
assert.deepEqual(list.tools.map((t: { name: string }) => t.name).sort(), [
  "box_create", "box_exec", "box_get", "box_list", "box_pause", "box_read_file",
  "box_resume", "box_write_file", "job_start", "job_status",
]);

// box_list sends the Box key to the US API.
const boxes = await tool("box_list", {}, [{ id: "b1", status: "idle" }]);
assert.match(boxes.reply.content[0].text, /b1/);
assert.equal(boxes.sent.url, "https://us-east-1.box.upstash.com/v2/box");
assert.equal(boxes.sent.headers.get("Authorization"), "Bearer box_test");

// Secrets the Box API returns never reach the caller.
const leaky = await tool("box_list", {}, [
  { id: "b1", env_vars: { KEY: "hidden-env" }, mcp_servers: [{ name: "m", headers: { Authorization: "Bearer hidden-token" } }] },
]);
assert.match(leaky.reply.content[0].text, /"name": "m"/);
assert.ok(!leaky.reply.content[0].text.includes("hidden"));

// job_start hands the command to the box and returns a job id.
const job = await tool("job_start", { box_id: "b1", command: "npm run render" }, { exit_code: 0 });
assert.equal(job.sent.url, "https://us-east-1.box.upstash.com/v2/box/b1/exec");
assert.ok(((await job.sent.json()) as { command: string[] }).command.includes("npm run render"));
assert.match(JSON.parse(job.reply.content[0].text).job_id, /^[0-9a-f-]{36}$/);

// A job that cannot start is reported as an error.
const stuck = await tool("job_start", { box_id: "b1", command: "x" }, { exit_code: 1, error: "disk full" });
assert.equal(stuck.reply.isError, true);
assert.match(stuck.reply.content[0].text, /disk full/);

console.log("worker tests passed");
process.exit(0);
