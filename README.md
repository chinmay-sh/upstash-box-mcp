# box-mcp

An MCP server on Cloudflare Workers that controls Upstash Boxes. It holds the Box API key and passes tool calls to the Box API.

## Tools

| Tool | What it does |
|---|---|
| `box_list`, `box_get` | See your boxes |
| `box_create`, `box_pause`, `box_resume` | Manage a box |
| `box_exec` | Run a command and wait, up to 2 minutes |
| `box_read_file`, `box_write_file` | Read or write a text file in a box |
| `job_start` | Start a long command and return at once |
| `job_status` | Check a job and read the end of its log |

Boxes cannot be deleted from here, on purpose. Use the Upstash console.

## Setup

Set each secret once. Each command asks you to paste the value.

```bash
npx wrangler secret put BOX_API_KEY
npx wrangler secret put MCP_TOKEN
```

- `BOX_API_KEY`: the `box_...` key from the Box section of the Upstash console.
- `MCP_TOKEN`: any long random password you make up. Clients send it as `Authorization: Bearer <token>`.

`GET /health` shows which secrets exist, never their values.

## Connecting

The MCP endpoint is `https://<worker>.workers.dev/mcp`, with the header `Authorization: Bearer <MCP_TOKEN>`.

## How jobs work

`job_start` starts the command in the background inside the box. Job files live in `/workspace/home/.jobs/<job_id>/`: `command`, `log` and `exit`. `job_status` reads them.

Nothing watches a job. The docs do not say whether a running job counts as activity, so a free box might idle-pause after an hour.

## Development

```bash
npm test
npm run typecheck
npm run deploy
```
