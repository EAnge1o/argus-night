import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findConfigFile, loadConfig } from "../config.js";
import { getAdapter } from "../adapters/index.js";
import { remainingTasks } from "../tasks.js";
import { resolveCommand, LineSplitter, truncate } from "../util.js";

interface Check {
  name: string;
  ok: boolean;
  fatal: boolean;
  detail: string;
  hint?: string;
}

function runVersion(cmd: string, timeoutMs = 20_000): string | null {
  try {
    const resolved = resolveCommand(cmd);
    if (resolved.needsCmdWrap) {
      return execFileSync("cmd.exe", ["/d", "/s", "/c", resolved.file, "--version"], {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
      }).trim();
    }
    return execFileSync(resolved.file, ["--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/** Launch the real adapter with a tiny prompt to prove the whole path works. */
async function probeAgent(root: string, probeArgs: { file: string; args: string[]; promptVia: string; needsCmdWrap: boolean }): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      if (probeArgs.needsCmdWrap) {
        child = spawn("cmd.exe", ["/d", "/s", "/c", probeArgs.file, ...probeArgs.args], { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } else {
        child = spawn(probeArgs.file, probeArgs.args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      }
    } catch (e) {
      resolve({ ok: false, detail: `启动失败: ${e}` });
      return;
    }
    const split = new LineSplitter((l) => void l);
    let stderrTail = "";
    child.stdout?.on("data", (c: Buffer) => split.push(c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => {
      stderrTail = (stderrTail + c.toString("utf8")).slice(-400);
    });
    if (probeArgs.promptVia === "stdin") {
      child.stdin?.write("Reply with exactly: OK\n");
      child.stdin?.end();
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* ignore */ }
      resolve({ ok: false, detail: "120 秒内未返回（CLI 可能卡在登录或交互提示）" });
    }, 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        detail: code === 0 ? "真实调用成功" : `exit=${code}${stderrTail ? `，stderr 末尾: ${truncate(stderrTail, 160)}` : ""}`,
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: String(e) });
    });
  });
}

export async function cmdDoctor(root: string, flags: { probe?: boolean }): Promise<number> {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node.js >= 18.17",
    ok: major >= 18,
    fatal: true,
    detail: `当前 ${process.versions.node}`,
  });

  try {
    const v = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
    let repo = false;
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "pipe" });
      repo = true;
    } catch { /* not a repo */ }
    checks.push({
      name: "git",
      ok: true,
      fatal: false,
      detail: v + (repo ? "（当前目录是 git 仓库 ✓）" : "（⚠ 当前目录不是 git 仓库，无人值守没有回滚安全网）"),
    });
  } catch {
    checks.push({ name: "git", ok: false, fatal: false, detail: "未安装 git", hint: "强烈建议安装：agent 的每次提交都是断点" });
  }

  const cfgFile = findConfigFile(root);
  let cfg;
  try {
    const loaded = loadConfig(root);
    cfg = loaded.config;
    checks.push({ name: "配置文件", ok: true, fatal: true, detail: cfgFile ? path.basename(cfgFile) : "使用默认配置（未找到 argus.config.jsonc）" });
  } catch (e) {
    checks.push({ name: "配置文件", ok: false, fatal: true, detail: String(e instanceof Error ? e.message : e) });
    printChecks(checks);
    return 1;
  }

  const agentName = cfg.agent === "custom" ? cfg.custom.command : cfg.agent;
  const resolved = resolveCommand(agentName);
  const exists = (() => {
    try {
      fs.accessSync(resolved.file);
      return true;
    } catch {
      return false;
    }
  })();
  if (exists) {
    const v = cfg.agent === "custom" ? "(custom)" : runVersion(agentName);
    checks.push({
      name: `agent CLI (${agentName})`,
      ok: true,
      fatal: true,
      detail: `${resolved.file}${v ? ` · ${truncate(v, 60)}` : ""}`,
    });
  } else {
    checks.push({
      name: `agent CLI (${agentName})`,
      ok: false,
      fatal: true,
      detail: "未找到可执行文件",
      hint: "确认已安装并在 PATH 中（Windows 下 argus 会自动定位 npm 全局安装的 .cmd）",
    });
  }

  const taskPath = path.join(root, cfg.taskFile);
  if (fs.existsSync(taskPath)) {
    const rest = remainingTasks(fs.readFileSync(taskPath, "utf8"));
    checks.push({ name: `任务清单 ${cfg.taskFile}`, ok: true, fatal: false, detail: `剩余 ${rest.length} 个未完成任务` });
  } else {
    checks.push({ name: `任务清单 ${cfg.taskFile}`, ok: false, fatal: false, detail: "不存在", hint: "运行 npx argus-night init 生成示例" });
  }

  if (cfg.agent === "claude" && !cfg.claude.streamHeartbeat && cfg.idleTimeoutMinutes < 20) {
    checks.push({
      name: "看门狗误杀风险",
      ok: false,
      fatal: false,
      detail: "claude.streamHeartbeat 已关闭且 idleTimeoutMinutes < 20：纯思考阶段可能被误判卡死",
      hint: "开启 streamHeartbeat 或将 idleTimeoutMinutes 调到 20 以上",
    });
  } else {
    checks.push({
      name: "看门狗配置",
      ok: true,
      fatal: false,
      detail: `idle ${cfg.idleTimeoutMinutes} 分钟${cfg.fsHeartbeat ? " · 文件系统心跳开" : ""}${cfg.agent === "claude" && cfg.claude.streamHeartbeat ? " · 流式心跳开" : ""}`,
    });
  }

  checks.push({
    name: "webhook 通知",
    ok: true,
    fatal: false,
    detail: cfg.notify.webhookUrl ? `已配置（${cfg.notify.format}）` : "未配置（可选）",
  });

  if (flags.probe && exists && cfg.agent !== "custom") {
    const adapter = getAdapter(cfg);
    const plan = adapter.plan({ mode: "fresh", sessionId: null, prompt: "Reply with exactly: OK" });
    const probe = await probeAgent(root, plan);
    checks.push({
      name: "真实调用探针 (--probe)",
      ok: probe.ok,
      fatal: false,
      detail: probe.detail,
      hint: probe.ok ? undefined : "参数不兼容时，用 claude/codex.extraArgs 调整，或升级 CLI 版本",
    });
  }

  printChecks(checks);
  return checks.some((c) => c.fatal && !c.ok) ? 1 : 0;
}

function printChecks(checks: Check[]): void {
  console.log("\n🩺 argus doctor — 守夜前体检\n");
  for (const c of checks) {
    const icon = c.ok ? "✓" : c.fatal ? "✗" : "⚠";
    console.log(`  ${icon} ${c.name.padEnd(28)} ${c.detail}`);
    if (c.hint) console.log(`      ↳ ${c.hint}`);
  }
  const fatalBad = checks.filter((c) => c.fatal && !c.ok).length;
  console.log(
    fatalBad === 0
      ? "\n  结论：可以放心让它守夜。晚安。🌙"
      : `\n  结论：${fatalBad} 项致命问题必须先解决。`,
  );
}
