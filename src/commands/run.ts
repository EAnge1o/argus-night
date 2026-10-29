import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, validateConfig, type ArgusConfig } from "../config.js";
import { Journal, type TaskState } from "../journal.js";
import { Logger } from "../log.js";
import { Notifier } from "../notify.js";
import { AgentRunner, adapterCommandExists } from "../runner.js";
import { markTaskLine, parseTaskList, remainingTasks } from "../tasks.js";
import { writeReport } from "../report.js";
import { ArgusError, fmtDur, nextWallClock, truncate } from "../util.js";

export interface RunFlags {
  agent?: string;
  task?: string;
  prompt?: string;
  until?: string;
  maxHours?: string;
  maxCost?: string;
  maxRestarts?: string;
  idleMinutes?: string;
  verbose?: boolean;
  dryRun?: boolean;
  wrapUp?: boolean;
  noFsHeartbeat?: boolean;
  config?: string;
}

function applyOverrides(base: ArgusConfig, flags: RunFlags): ArgusConfig {
  const cfg: ArgusConfig = structuredClone(base);
  if (flags.agent) cfg.agent = flags.agent as ArgusConfig["agent"];
  if (flags.task) cfg.taskFile = flags.task;
  if (flags.idleMinutes) {
    const v = Number(flags.idleMinutes);
    if (!Number.isFinite(v) || v < 0.1) throw new ArgusError("--idle-minutes 必须 >= 0.1");
    cfg.idleTimeoutMinutes = v;
  }
  if (flags.until) {
    if (flags.until.toLowerCase() === "never") cfg.stop.until = null;
    else cfg.stop.until = flags.until;
  }
  if (flags.maxHours) {
    const v = Number(flags.maxHours);
    if (!Number.isFinite(v) || v <= 0) throw new ArgusError("--max-hours 必须 > 0");
    cfg.stop.maxHours = v;
  }
  if (flags.maxCost) {
    const v = Number(flags.maxCost);
    if (!Number.isFinite(v) || v <= 0) throw new ArgusError("--max-cost 必须 > 0（美元）");
    cfg.stop.maxCostUsd = v;
  }
  if (flags.maxRestarts) {
    const v = Number(flags.maxRestarts);
    if (!Number.isFinite(v) || v < 0) throw new ArgusError("--max-restarts 必须 >= 0");
    cfg.stop.maxRestarts = v;
  }
  if (flags.wrapUp !== undefined) cfg.wrapUp = flags.wrapUp;
  if (flags.noFsHeartbeat) cfg.fsHeartbeat = false;
  validateConfig(cfg);
  return cfg;
}

function gitHead(root: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function gitAutoCommit(root: string, cfg: ArgusConfig, taskText: string, log: Logger): void {
  if (!cfg.git.autoCommit) return;
  try {
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync(
      "git",
      ["commit", "-m", `${cfg.git.commitMessagePrefix} ${truncate(taskText, 60)}`],
      { cwd: root },
    );
    log.info("已自动提交本轮改动到 git");
  } catch {
    log.debug("git 自动提交跳过（无改动或无仓库）");
  }
}

export async function cmdRun(root: string, flags: RunFlags): Promise<number> {
  const { config: baseCfg } = loadConfig(root);
  const cfg = applyOverrides(baseCfg, flags);

  const runId = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const journal = new Journal(root, runId);
  const log = new Logger(path.join(root, ".argus", "logs", `run-${runId}.log`));
  log.verbose = Boolean(flags.verbose);
  const notify = new Notifier(cfg, log);

  // Effective stop deadline = min(until wall clock, maxHours).
  let stopAt: Date | null = null;
  const deadlines: string[] = [];
  if (cfg.stop.until) {
    const untilDate = nextWallClock(cfg.stop.until);
    stopAt = untilDate;
    deadlines.push(`到 ${cfg.stop.until}（${untilDate.toLocaleString()}）`);
  }
  if (cfg.stop.maxHours > 0) {
    const maxAt = new Date(Date.now() + cfg.stop.maxHours * 3600_000);
    if (!stopAt || maxAt < stopAt) stopAt = maxAt;
    deadlines.push(`最长 ${cfg.stop.maxHours} 小时`);
  }
  if (cfg.stop.maxCostUsd != null) deadlines.push(`花费上限 $${cfg.stop.maxCostUsd}`);
  if (cfg.stop.maxRestarts > 0) deadlines.push(`重启上限 ${cfg.stop.maxRestarts} 次`);

  log.event(`🌙 Argus 开始夜间值守 — run ${runId}`);
  log.info(`agent: ${cfg.agent} · 任务清单: ${flags.prompt ? "（单条任务模式）" : cfg.taskFile}`);
  log.info(`收工条件: ${deadlines.length ? deadlines.join(" · ") : "全部任务完成"}`);
  if (cfg.permissions === "bypass" && cfg.agent === "claude") {
    log.warn("已启用 --dangerously-skip-permissions：agent 可以不经确认执行任何命令。建议在容器/虚拟机中运行，并确保 git 仓库干净可回滚。");
  }

  // Preflight
  const cmdCheck = adapterCommandExists(cfg);
  if (!cmdCheck.ok && !flags.dryRun) {
    log.close();
    throw new ArgusError(
      `找不到 agent 命令（${cfg.agent === "custom" ? cfg.custom.command : cfg.agent}）`,
      "确认对应 CLI 已安装并在 PATH 中；或运行 npx argus-night doctor 诊断",
    );
  }

  const startCommit = gitHead(root);
  if (!startCommit && !flags.dryRun) {
    log.warn("当前目录不是 git 仓库：整晚无人改动没有回滚安全网，强烈建议 git init 后再跑");
  }

  // Collect tasks
  const fileTasks: { text: string; line: number }[] = [];
  if (flags.prompt) {
    log.info(`单条任务: ${truncate(flags.prompt, 90)}`);
  } else {
    const taskPath = path.join(root, cfg.taskFile);
    if (!fs.existsSync(taskPath)) {
      log.close();
      throw new ArgusError(
        `任务清单 ${cfg.taskFile} 不存在`,
        "运行 npx argus-night init 生成示例，或用 --task 指定其他清单文件",
      );
    }
    const md = fs.readFileSync(taskPath, "utf8");
    fileTasks.push(...remainingTasks(md).map((t) => ({ text: t.text, line: t.line })));
    if (fileTasks.length === 0) {
      log.event("✅ 任务清单里没有未完成事项，无事可守。晚安！");
      journal.finish();
      const reportPath = writeReport(root, cfg, journal, { stopReason: "没有待办任务", startCommit });
      log.info(`晨报: ${reportPath}`);
      log.close();
      return 0;
    }
    log.info(`待执行 ${fileTasks.length} 个任务`);
  }

  let interrupted = false;
  const runner = new AgentRunner({
    cfg,
    journal,
    log,
    notify,
    dryRun: Boolean(flags.dryRun),
    stopAt,
    onInterrupted: () => interrupted,
  });

  process.on("SIGINT", () => {
    if (!interrupted) {
      interrupted = true;
      log.warn("收到 Ctrl+C：正在优雅收尾，等待当前进程退出（再按一次强制退出）…");
      runner.killCurrent();
    } else {
      log.error("强制退出");
      process.exit(130);
    }
  });

  if (flags.dryRun) {
    log.event("[dry-run] 只打印计划，不会真的启动 agent");
    if (flags.prompt) {
      log.info(`→ ${runner.describePlan(flags.prompt, "fresh", null)}`);
    } else {
      for (const t of fileTasks) {
        log.info(`→ ${truncate(t.text, 70)}`);
        log.info(`   ${runner.describePlan(t.text, "fresh", null)}`);
      }
    }
    log.close();
    return 0;
  }

  const totalTasks = flags.prompt ? 1 : fileTasks.length;
  let done = 0;
  let failed = 0;
  let stopReason = "全部任务完成";
  const statusTimer = setInterval(() => {
    const t = journal.totals;
    log.setStatus(
      `🌙 值守中 · ✅${done}/${totalTasks} · 重启 ${t.restarts} · 看门狗 ${t.hangKills} · 配额等待 ${fmtDur(t.quotaSleepMs)}${t.costUsd > 0 ? ` · $${t.costUsd.toFixed(2)}` : ""}`,
    );
    journal.setStatusExtra({ progress: `${done}/${totalTasks}` });
  }, 5000);

  try {
    const tasks: { text: string; line?: number }[] = flags.prompt
      ? [{ text: flags.prompt }]
      : fileTasks;

    for (const [idx, task] of tasks.entries()) {
      // Stop conditions are checked BETWEEN tasks; the running one finishes.
      if (interrupted) {
        stopReason = "手动中断";
        break;
      }
      if (stopAt && Date.now() >= stopAt.getTime()) {
        stopReason = "到达收工时间";
        break;
      }
      if (cfg.stop.maxCostUsd != null && journal.totals.costUsd >= cfg.stop.maxCostUsd) {
        stopReason = "花费达到上限";
        break;
      }
      if (cfg.stop.maxRestarts > 0 && journal.totals.restarts >= cfg.stop.maxRestarts) {
        stopReason = "重启次数达到上限";
        break;
      }

      journal.setCurrentTask(task.text);
      log.event(`▶ 任务 ${idx + 1}/${tasks.length}: ${truncate(task.text, 90)}`);
      const st: TaskState = journal.taskState(task.text);

      let outcome = await runner.runTask(task.text, st);
      // Task-level retry rounds (each round re-enters the restart state machine).
      let round = 0;
      while (outcome.kind === "failed" && cfg.onTaskFail === "retry-then-next" && round < cfg.taskRetries) {
        round += 1;
        log.warn(`任务失败，整任务重试（第 ${round}/${cfg.taskRetries} 轮，使用全新会话）…`);
        journal.updateTask(task.text, { sessionId: null });
        st.sessionId = null;
        outcome = await runner.runTask(task.text, st);
      }

      if (outcome.kind === "stop_time") {
        stopReason = interrupted ? "手动中断" : "到达收工时间";
        break;
      }
      if (outcome.kind === "success") {
        done += 1;
        journal.append("task_done", { task: task.text, attempts: outcome.attempts, costUsd: outcome.costUsd });
        log.event(`✅ 完成: ${truncate(task.text, 80)}`);
        notify.send("task_done", "✅ 任务完成", truncate(task.text, 80));
        if (task.line != null) {
          const taskPath = path.join(root, cfg.taskFile);
          const md = fs.readFileSync(taskPath, "utf8");
          fs.writeFileSync(taskPath, markTaskLine(md, task.line, "x"));
          // Re-map line numbers for subsequent tasks after rewriting the file.
          const refreshed = parseTaskList(fs.readFileSync(taskPath, "utf8"));
          for (const later of tasks.slice(idx + 1)) {
            if (later.line == null) continue;
            const found = refreshed.find((r) => r.text === later.text && !r.done);
            if (found) later.line = found.line;
          }
        }
        gitAutoCommit(root, cfg, task.text, log);
      } else {
        failed += 1;
        journal.append("task_failed", { task: task.text, reason: outcome.reason });
        journal.updateTask(task.text, { status: "failed", lastError: outcome.reason });
        log.error(`✗ 任务失败: ${truncate(task.text, 70)} — ${outcome.reason}`);
        notify.send("task_failed", "❌ 任务失败", `${truncate(task.text, 70)}\n${outcome.reason}`);
        // Task stays unchecked so the next run can retry it.
        if (cfg.onTaskFail === "abort") {
          stopReason = "任务失败（onTaskFail=abort）";
          break;
        }
      }
    }

    // Wrap-up: let the agent land the plane before dawn.
    if (cfg.wrapUp && done + failed > 0 && !interrupted) {
      log.event("🛬 收工指令：让 agent 提交代码并总结");
      const wrapSt = journal.taskState("(wrap-up)");
      const wrapOutcome = await runner.runTask(cfg.wrapUpPrompt, wrapSt);
      if (wrapOutcome.kind === "success") {
        journal.append("task_done", { task: "(wrap-up)" });
        if (cfg.agent !== "custom" || cfg.git.autoCommit) {
          gitAutoCommit(root, cfg, "wrap-up", log);
        }
      }
    }
  } finally {
    clearInterval(statusTimer);
    journal.finish();
    const reportPath = writeReport(root, cfg, journal, { stopReason, startCommit });
    log.setStatus(null);
    log.event(`📜 值守结束：${stopReason} · ✅${done} ❌${failed}`);
    log.info(`📄 晨报已生成: ${reportPath}`);
    notify.send(
      "run_end",
      "📜 Argus 值守结束",
      `${stopReason}\n完成 ${done} · 失败 ${failed} · 重启 ${journal.totals.restarts} · 配额等待 ${fmtDur(journal.totals.quotaSleepMs)}${journal.totals.costUsd > 0 ? ` · 花费 $${journal.totals.costUsd.toFixed(2)}` : ""}\n晨报: ${reportPath}`,
    );
    log.close();
  }
  return failed > 0 && cfg.onTaskFail === "abort" ? 1 : 0;
}
