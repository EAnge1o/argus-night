import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../src/config.js";
import { ClaudeAdapter, CodexAdapter, CustomAdapter } from "../src/adapters/index.js";
import { resolveCommand } from "../src/util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function feed(adapter: { parseLine: (l: string) => unknown }, lines: string[]): void {
  for (const l of lines) adapter.parseLine(l);
}

test("ClaudeAdapter: 从录制好的 stream-json 样本解析 session/成本/结果", () => {
  const adapter = new ClaudeAdapter(DEFAULT_CONFIG);
  const sample = fs
    .readFileSync(path.join(__dirname, "..", "..", "test", "fixtures", "claude-stream-sample.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().startsWith("{"));
  feed(adapter, sample);
  assert.equal(adapter.finalize(0).success, true);
  assert.equal(adapter.finalize(0).costUsd, 0.1234);
  // init 行就要抓到 session_id（watchdog 杀掉后 --resume 依赖它）
  const fresh = new ClaudeAdapter(DEFAULT_CONFIG);
  fresh.parseLine(sample[0]);
  assert.equal(fresh.finalize(0).success, null); // 还没到 result 行
});

test("ClaudeAdapter: result is_error → 判定失败", () => {
  const adapter = new ClaudeAdapter(DEFAULT_CONFIG);
  adapter.parseLine('{"type":"result","subtype":"error","is_error":true,"session_id":"s","total_cost_usd":0.5}');
  assert.equal(adapter.finalize(0).success, false);
  assert.equal(adapter.finalize(0).costUsd, 0.5);
});

test("ClaudeAdapter: allowlist 权限档位 → --allowedTools 且不 bypass", () => {
  const cfg = { ...DEFAULT_CONFIG, permissions: "allowlist" as const, claude: { ...DEFAULT_CONFIG.claude, allowedTools: ["Read", "Edit", "Bash(git *)"] } };
  const plan = new ClaudeAdapter(cfg).plan({ mode: "fresh", sessionId: null, prompt: "x" });
  const joined = plan.args.join(" ");
  assert.match(joined, /--allowedTools Read,Edit,Bash\(git \*\)/);
  assert.doesNotMatch(joined, /dangerously-skip-permissions/);
});

test("ClaudeAdapter: resume 优先用捕获的 session id，否则 --continue", () => {
  const a = new ClaudeAdapter(DEFAULT_CONFIG).plan({ mode: "resume", sessionId: "s-9", prompt: "x" });
  assert.deepEqual(a.args.filter((x) => ["--resume", "s-9", "--continue"].includes(x)), ["--resume", "s-9"]);
  const b = new ClaudeAdapter(DEFAULT_CONFIG).plan({ mode: "resume", sessionId: null, prompt: "x" });
  assert.ok(b.args.includes("--continue"));
});

test("CodexAdapter: thread_id 捕获 + exec resume --last 计划", () => {
  const cfg = { ...DEFAULT_CONFIG };
  const adapter = new CodexAdapter(cfg);
  adapter.parseLine('{"type":"thread.started","thread_id":"th_9"}');
  assert.equal(adapter.parseLine('{"type":"turn.completed","usage":{}}'), null);
  const fresh = adapter.plan({ mode: "fresh", sessionId: null, prompt: "x" });
  assert.ok(fresh.args.includes("--json"));
  const resumed = (adapter as unknown as { planResume: (o: unknown) => { args: string[] } }).planResume({
    mode: "resume",
    sessionId: "th_9",
    prompt: "x",
  });
  assert.deepEqual(resumed.args.slice(0, 3), ["exec", "resume", "--last"]);
});

test("CustomAdapter: 解析 claude 风格 result 行并记账", () => {
  const cfg = { ...DEFAULT_CONFIG, custom: { command: "node", args: ["x.mjs"], promptVia: "stdin" as const, resumeArgs: ["x.mjs"] } };
  const adapter = new CustomAdapter(cfg);
  adapter.parseLine('{"type":"result","is_error":false,"total_cost_usd":0.01,"session_id":"cs1"}');
  assert.equal(adapter.finalize(0).costUsd, 0.01);
  assert.equal(adapter.supportsResume, true);
});

/* ---------- 真机旗标校验：CLI 装了才跑，防版本漂移 ---------- */

function cliInstalled(cmd: string): boolean {
  const r = resolveCommand(cmd);
  try {
    fs.accessSync(r.file);
    return true;
  } catch {
    return false;
  }
}

function help(cmd: string, args: string[]): string {
  const r = resolveCommand(cmd);
  try {
    return r.needsCmdWrap
      ? execFileSync("cmd.exe", ["/d", "/s", "/c", r.file, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 })
      : execFileSync(r.file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
  } catch (e) {
    return String(e);
  }
}

test("真机校验: claude --help 仍支持 argus 使用的全部旗标", { skip: !cliInstalled("claude") }, () => {
  const out = help("claude", ["--help"]);
  for (const flag of ["--output-format", "--include-partial-messages", "--dangerously-skip-permissions", "--allowedTools", "--resume", "--continue"]) {
    assert.ok(out.includes(flag), `claude --help 缺少旗标 ${flag}（版本漂移，需更新适配器）`);
  }
});

test("真机校验: codex exec --help 仍支持 argus 使用的全部旗标", { skip: !cliInstalled("codex") }, () => {
  const out = help("codex", ["exec", "--help"]);
  for (const flag of ["--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"]) {
    assert.ok(out.includes(flag), `codex exec --help 缺少旗标 ${flag}（版本漂移，需更新适配器）`);
  }
});
