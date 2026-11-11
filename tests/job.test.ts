import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJob, readJobCommand, startJobCommand } from "../src/box";

const dir = mkdtempSync(join(tmpdir(), "box-jobs-")).replaceAll("\\", "/");
const sh = ([cmd, ...args]: string[]) => execFileSync(cmd, args, { encoding: "utf8" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function finished(id: string) {
  for (let i = 0; i < 50; i++) {
    const job = parseJob(sh(readJobCommand(id, dir)));
    if (job.status !== "running") return job;
    await sleep(100);
  }
  throw new Error(`job ${id} never finished`);
}

// A command with quotes and $ reaches the job unchanged.
sh(startJobCommand("ok", `echo "it's $((1 + 1))"`, dir));
const ok = await finished("ok");
assert.equal(ok.status, "succeeded");
assert.equal(ok.exit_code, 0);
assert.match(ok.log, /it's 2/);

// A failing command reports its exit code and keeps its output.
sh(startJobCommand("bad", "echo broke; exit 7", dir));
const bad = await finished("bad");
assert.equal(bad.status, "failed");
assert.equal(bad.exit_code, 7);
assert.match(bad.log, /broke/);

// A slow job reads as running, and a retried start does not launch a second copy.
sh(startJobCommand("slow", `sleep 1; echo ran >> "${dir}/count"`, dir));
assert.equal(parseJob(sh(readJobCommand("slow", dir))).status, "running");
sh(startJobCommand("slow", `sleep 1; echo ran >> "${dir}/count"`, dir));
assert.equal((await finished("slow")).status, "succeeded");
await sleep(1200);
assert.equal(readFileSync(`${dir}/count`, "utf8").trim(), "ran");

assert.equal(parseJob(sh(readJobCommand("nope", dir))).status, "missing");
assert.throws(() => parseJob("Unauthorized"), /Unexpected job state/);

console.log("job tests passed");
