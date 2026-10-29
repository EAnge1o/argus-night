import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
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

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/** 把临时项目变成带一次提交的干净 git 仓库（并行模式的前提）。 */
function gitInitProject(p: Project): void {
  fs.writeFileSync(path.join(p.root, ".gitignore"), ".argus/\nnode_modules/\n");
  git(p.root, ["init", "-b", "main"]);
  // 写进仓库本地配置：CI runner 没有全局 git 身份，而并行模式会校验它
  git(p.root, ["config", "user.name", "test"]);
  git(p.root, ["config", "user.email", "test@test.local"]);
  git(p.root, ["add", "-A"]);
  git(p.root, ["commit", "-m", "init"]);
}

test("e2e 并行: 2 worker × 4 任务，worktree 隔离、自动合并、配额不阻塞其他 worker", { timeout: 240_000 }, async () => {
  cleanFakeState();
  const p = makeProject(
    ["[p] task one", "[p] task two", "[quota] p task three", "[p] task four"],
    { parallel: { workers: 2, merge: "auto" } },
  );
  gitInitProject(p);
  const { code, out } = await runCli(p.root, ["--verbose"]);
  assert.equal(code, 0, `退出码非 0\n${out}`);
  assert.match(out, /并行模式/);

  // 4 个任务全部完成并勾选
  const md = fs.readFileSync(p.todoPath, "utf8");
  for (const t of ["task one", "task two", "p task three", "task four"]) {
    assert.match(md, new RegExp(`\\[x\\] .*${t.replace(/[[\]]/g, "\\$&")}`));
  }
  // 每个 worker 的成果文件都通过 merge 回到了主工作区
  const fakeOut = path.join(p.root, "fake-out");
  assert.ok(fs.existsSync(fakeOut), "fake-out 目录应已合并回主仓库");
  assert.equal(fs.readdirSync(fakeOut).length, 4, "4 个任务的产出都应在主仓库");

  // 配额等待只挡住自己的 worker，其他 worker 继续干活
  assert.match(journalText(p.root), /"type":"quota_wait"/);
  assert.match(journalText(p.root), /"type":"merge_ok"/);
  // worktree 已清理，分支已删除
  const wtList = git(p.root, ["worktree", "list"]).trim();
  assert.equal(wtList.split("\n").length, 1, `应只剩主工作区:\n${wtList}`);
  const branches = git(p.root, ["branch", "--list", "argus/*"]).trim();
  assert.equal(branches, "", `worker 分支应已删除: ${branches}`);
});

test("e2e 并行: 同文件冲突 → 任务算成功、分支保留待人工、运行不中断", { timeout: 240_000 }, async () => {
  cleanFakeState();
  const p = makeProject(["[clash] A edits collide", "[clash] B edits collide"], {
    parallel: { workers: 2, merge: "auto" },
  });
  gitInitProject(p);
  const { code, out } = await runCli(p.root, []);
  assert.equal(code, 0, `退出码非 0\n${out}`);

  const j = journalText(p.root);
  assert.match(j, /"type":"merge_conflict"/, "两个任务改同一文件，应出现一次合并冲突");
  assert.match(j, /"type":"merge_ok"/, "先完成的那个应成功合并");
  // 任务本身都成功了（成果在分支上），TODO 全部打勾
  const md = fs.readFileSync(p.todoPath, "utf8");
  assert.match(md, /\[x\] \[clash\] A/);
  assert.match(md, /\[x\] \[clash\] B/);
  // 冲突分支和 worktree 被保留
  const branches = git(p.root, ["branch", "--list", "argus/*"]).trim();
  assert.notEqual(branches, "", "冲突分支应保留");
  // 晨报包含待人工合并区块
  const reportsDir = path.join(p.root, ".argus", "reports");
  const report = fs.readFileSync(path.join(reportsDir, fs.readdirSync(reportsDir)[0]), "utf8");
  assert.match(report, /待人工合并/);
});

test("e2e 并行: 脏工作区直接拒绝启动", { timeout: 120_000 }, async () => {
  cleanFakeState();
  const p = makeProject(["[p] whatever"], { parallel: { workers: 2, merge: "auto" } });
  gitInitProject(p);
  // 制造 tracked 脏文件
  fs.writeFileSync(path.join(p.root, "dirty.txt"), "uncommitted\n");
  git(p.root, ["add", "dirty.txt"]);
  const { code, out } = await runCli(p.root, []);
  assert.equal(code, 1, `应拒绝启动\n${out}`);
  assert.match(out, /工作区干净/);
  assert.doesNotMatch(fs.readFileSync(p.todoPath, "utf8"), /\[x\]/);
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
