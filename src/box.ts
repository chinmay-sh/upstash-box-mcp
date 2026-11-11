import type { Env } from "./types";

const BOX_URL = "https://us-east-1.box.upstash.com";
export const JOBS_DIR = "/workspace/home/.jobs";

export type ExecResult = { exit_code: number; output?: string; error?: string };
export type JobState = {
  status: "running" | "succeeded" | "failed" | "missing";
  exit_code?: number;
  log: string;
};

export async function boxApi<T>(
  env: Env,
  path: string,
  { method = "GET", body, timeoutMs = 30_000 }: { method?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<T> {
  const res = await fetch(`${BOX_URL}/v2/${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.BOX_API_KEY}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Box API ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export function boxExec(env: Env, boxId: string, command: string[], folder?: string, timeoutMs = 120_000) {
  return boxApi<ExecResult>(env, `box/${boxId}/exec`, {
    method: "POST",
    body: folder ? { command, folder } : { command },
    timeoutMs,
  });
}

// Values reach both scripts as shell arguments, so a job's command needs no quoting.
// mkdir fails if the job exists, so a retried start cannot launch a second copy.
// The exit file is renamed into place so a check never reads it half written.
const START_JOB = `
d="$1/$2"
mkdir -p "$1"
mkdir "$d" 2>/dev/null || exit 0
printf %s "$3" > "$d/command"
( nohup sh -c 'sh "$1/command" > "$1/log" 2>&1; echo $? > "$1/exit.tmp"; mv "$1/exit.tmp" "$1/exit"' sh "$d" </dev/null >/dev/null 2>&1 & )
`;

const READ_JOB = `
d="$1/$2"
[ -d "$d" ] || { echo missing; exit 0; }
cat "$d/exit" 2>/dev/null || echo running
tail -c 4000 "$d/log" 2>/dev/null
`;

export const startJobCommand = (jobId: string, command: string, jobsDir = JOBS_DIR) => [
  "sh", "-c", START_JOB, "sh", jobsDir, jobId, command,
];

export const readJobCommand = (jobId: string, jobsDir = JOBS_DIR) => ["sh", "-c", READ_JOB, "sh", jobsDir, jobId];

export function parseJob(output: string): JobState {
  const [first, ...rest] = output.split("\n");
  const log = rest.join("\n");
  const state = first.trim();
  if (state === "running" || state === "missing") return { status: state, log };
  if (!/^\d+$/.test(state)) throw new Error(`Unexpected job state: ${first.slice(0, 200)}`);
  const exit_code = Number(state);
  return { status: exit_code === 0 ? "succeeded" : "failed", exit_code, log };
}
