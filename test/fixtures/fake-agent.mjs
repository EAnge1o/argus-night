#!/usr/bin/env node
/**
 * Fake coding-agent CLI for Argus tests. Behavior is keyed off the prompt:
 *   contains [quota] → first run hits a usage limit (resets in 2s), then succeeds
 *   contains [hang]  → first run spawns a child and hangs forever (watchdog bait)
 *   contains [crash] → first run exits 1 with a 429; then succeeds
 *   contains [fail]  → always exits 1
 *   anything else    → succeeds after brief activity
 * Emits claude-style stream-json so adapter parsing is exercised too.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => run(Buffer.concat(chunks).toString("utf8")));

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

function run(prompt) {
  const hash = crypto.createHash("sha1").update(prompt).digest("hex").slice(0, 10);
  const stateFile = path.join(os.tmpdir(), `argus-fake-${hash}.json`);
  const seen = fs.existsSync(stateFile);
  if (!seen) fs.writeFileSync(stateFile, JSON.stringify({ prompt: prompt.slice(0, 80) }));

  const sessionId = `fake-${process.pid}-${hash}`;
  emit({ type: "system", subtype: "init", session_id: sessionId });
  emit({ type: "assistant", message: `working on: ${prompt.slice(0, 50).replace(/\n/g, " ")}` });

  if (prompt.includes("[hang]") && !seen) {
    // Spawn a grandchild so kill-tree behavior is actually exercised.
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 120000)"], {
      detached: false,
      stdio: "ignore",
    });
    fs.writeFileSync(
      path.join(os.tmpdir(), `argus-fake-pids-${hash}.json`),
      JSON.stringify({ parent: process.pid, child: sleeper.pid, hash }),
    );
    emit({ type: "assistant", message: "thinking forever…" });
    setInterval(() => {}, 60_000); // never emits again → watchdog bait
    return;
  }
  if (prompt.includes("[quota]") && !seen) {
    emit({ type: "assistant", message: "Claude AI usage limit reached. Your limit will reset resets in 2s." });
    emit({ type: "result", subtype: "error_max_turns", is_error: true, session_id: sessionId, num_turns: 1 });
    process.exit(0);
  }
  if (prompt.includes("[crash]") && !seen) {
    emit({ type: "assistant", message: "API Error: 429 too many requests" });
    process.exit(1);
  }
  if (prompt.includes("[fail]")) {
    emit({ type: "result", subtype: "error", is_error: true, session_id: sessionId, num_turns: 1 });
    process.exit(1);
  }

  // Success path: a little activity, then a claude-style result line.
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    emit({ type: "assistant", message: `step ${ticks} done` });
    if (ticks >= 3) {
      clearInterval(timer);
      emit({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: sessionId,
        num_turns: 4,
        total_cost_usd: 0.0123,
      });
      process.exit(0);
    }
  }, 150);
}
