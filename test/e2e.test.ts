import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "src", "cli.js");
// fixture 是纯 .mjs，不参与 tsc 编译，直接引用源码目录
const FAKE = path.join(__dirname, "..", "..", "test", "fixtures", "fake-agent.mjs");

/** fake-agent 的状态标记文件都在系统 tmp 目录，每个用例前清掉。 */
function cleanFakeState(): void {
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (f.startsWith("argus-fake-")) {
      try {
        fs.rmSync(path.join(os.tmpdir(), f), { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

interface Project {
  root: string;
  todoPath: string;
}

function makeProject(tasks: string[], configOverrides: Record<string, unknown> = {}): Project {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "argus-e2e-"));
  const base = {
    agent: "custom",
    custom: { command: "node", args: [FAKE], promptVia: "stdin", resumeArgs: [FAKE] },
    backoff: { baseSeconds: 1, maxSeconds: 2, factor: 2, maxConsecutiveCrashes: 5 },
    idleTimeoutMinutes: 30,
    onTaskFail: "skip",
    taskRetries: 0,
    fsHeartbeat: false,
    quota: { maxSleepMinutes: 2, extraPatterns: [] },
    stop: { until: null, maxHours: 1, maxCostUsd: null, maxRestarts: 200 },
    notify: { webhookUrl: "", format: "slack", events: [] },
    wrapUp: false,
    ...configOverrides,
  };
  fs.writeFileSync(path.join(root, "argus.config.jsonc"), JSON.stringify(base, null, 2));
  fs.writeFileSync(
    path.join(root, "TODO.md"),
    "# 测试清单\n" + tasks.map((t) => `- [ ] ${t}`).join("\n") + "\n",
  );
  return { root, todoPath: path.join(root, "TODO.md") };
}

function runCli(root: string, args: string[], timeoutMs = 180_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "run", ...args], { cwd: root });
    let out = "";
    p.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    p.stderr.on("data", (c: Buffer) => (out += c.toString("utf8")));
    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

function journalText(root: string): string {
  const dir = path.join(root, ".argus");
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("journal-") && f.endsWith(".jsonl"));
  assert.ok(files.length >= 1, "journal 应该存在");
  return fs.readFileSync(path.join(dir, files[0]), "utf8");
}

function reportsDirHas(root: string): boolean {
  const dir = path.join(root, ".argus", "reports");
  return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".md"));
}

test("e2e: 配额触发 → 睡到重置 → 同会话续跑 → 完成 + 打勾 + 晨报", async () => {
  cleanFakeState();
  const p = makeProject(["Do the [quota] thing tonight"]);
  const { code, out } = await runCli(p.root, ["--verbose"]);
  assert.equal(code, 0, `退出码非 0\n${out}`);
  assert.match(out, /配额/);
  const md = fs.readFileSync(p.todoPath, "utf8");
  assert.match(md, /\[x\] Do the \[quota\] thing tonight/);
  const j = journalText(p.root);
  assert.match(j, /"type":"quota_wait"/);
  assert.match(j, /"type":"task_done"/);
  assert.ok(reportsDirHas(p.root), "晨报应生成");
});

test("e2e: 看门狗杀掉挂死进程树 → 续跑成功", async () => {
  cleanFakeState();
  const p = makeProject(["[hang] spin forever"]);
  const { code, out } = await runCli(p.root, ["--idle-minutes", "0.1"]);
  assert.equal(code, 0, `退出码非 0\n${out}`);
  assert.match(out, /看门狗/);
  assert.match(journalText(p.root), /"type":"watchdog_kill"/);
  // fake agent 在挂死时记录了 pid；断言父子进程都已被杀干净
  const pidFiles = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("argus-fake-pids-"));
  assert.ok(pidFiles.length >= 1, "fake agent 应记录 pid 文件");
  const pids = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), pidFiles[0]), "utf8")) as {
    parent: number;
    child: number;
  };
  await new Promise((r) => setTimeout(r, 800));
  for (const pid of [pids.parent, pids.child]) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `进程 ${pid} 应已被看门狗整树清理`);
  }
  assert.match(fs.readFileSync(p.todoPath, "utf8"), /\[x\] \[hang\] spin forever/);
});

test("e2e: 429 API 繁忙 → 指数退避 → 续跑成功", async () => {
  cleanFakeState();
  const p = makeProject(["[crash] flaky api"]);
  const { code, out } = await runCli(p.root, []);
  assert.equal(code, 0, `退出码非 0\n${out}`);
  assert.match(journalText(p.root), /"type":"api_busy_backoff"/);
  assert.match(fs.readFileSync(p.todoPath, "utf8"), /\[x\] \[crash\] flaky api/);
});

test("e2e: 永远失败的任务按 onTaskFail=skip 跳过，后续任务照常完成", async () => {
  cleanFakeState();
  const p = makeProject(["[fail] hopeless", "normal [ok] task"]);
  const { code, out } = await runCli(p.root, []);
  assert.equal(code, 0, `退出码非 0\n${out}`);
  const md = fs.readFileSync(p.todoPath, "utf8");
  assert.match(md, /\[ \] \[fail\] hopeless/); // 失败的不打勾，留给下次
  assert.match(md, /\[x\] normal \[ok\] task/);
  assert.match(journalText(p.root), /"type":"task_failed"/);
});

test("e2e: dry-run 只打印计划不启动 agent", async () => {
  cleanFakeState();
  const p = makeProject(["[quota] never runs"]);
  const { code, out } = await runCli(p.root, ["--dry-run"]);
  assert.equal(code, 0);
  assert.match(out, /dry-run/);
  assert.match(out, /node/);
  assert.doesNotMatch(fs.readFileSync(p.todoPath, "utf8"), /\[x\]/);
  const j = journalText(p.root);
  assert.doesNotMatch(j, /"type":"spawn"/);
});

test("e2e: --prompt 单条任务模式 + 花费入账", async () => {
  cleanFakeState();
  const p = makeProject(["should be ignored"]);
  const { code, out } = await runCli(p.root, ["--prompt", "[quota] single mission"]);
  assert.equal(code, 0, `退出码非 0\n${out}`);
  const j = journalText(p.root);
  assert.match(j, /"type":"quota_wait"/);
  assert.match(j, /0\.0123/); // fake agent 的 cost 汇总进 journal
  // 清单文件没被动过
  assert.doesNotMatch(fs.readFileSync(p.todoPath, "utf8"), /\[x\]/);
});
