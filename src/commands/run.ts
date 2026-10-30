import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, validateConfig, type ArgusConfig } from "../config.js";
import { Journal, type TaskState } from "../journal.js";
import { Logger } from "../log.js";
import { Notifier } from "../notify.js";
import { AgentRunner, adapterCommandExists } from "../runner.js";
import { markTaskLine, parseTaskList, remainingTasks, type TaskItem } from "../tasks.js";
import { writeReport } from "../report.js";
import { WorktreeManager, type Worktree } from "../worktree.js";
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
  parallel?: string;
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
  if (flags.parallel) {
    const v = Number(flags.parallel);
    if (!Number.isInteger(v) || v < 1 || v > 8) throw new ArgusError("--parallel 必须是 1–8 的整数");
    cfg.parallel.workers = v;
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

interface ScopeDeps {
  root: string;
  cfg: ArgusConfig;
  journal: Journal;
  log: Logger;
  notify: Notifier;
  stopAt: Date | null;
  interrupted: () => boolean;
  dryRun: boolean;
  fileTasks: { text: string; line: number }[];
  activeRunners: AgentRunner[];
  /** set to true when onTaskFail=abort should stop every worker */
  abort: { requested: boolean };
  stopReason: { value: string };
  done: { count: number };
  failed: { count: number };
}

/** 并行配额雪崩：过半 worker 在配额休眠（total ≥ 2 才有意义）。 */
export function majorityQuotaSleeping(
  statuses: { sleeping?: string }[],
  total: number,
): boolean {
  if (total < 2) return false;
  const asleep = statuses.filter((s) => s.sleeping === "quota").length;
  return asleep >= Math.ceil(total / 2);
}

function setStopReason(box: { value: string }, reason: string): void {
  // First reason wins; the default "全部任务完成" is replaced by whatever ends the run.
  if (box.value === "全部任务完成") box.value = reason;
}

function stopChecks(deps: ScopeDeps, cfg: ArgusConfig): string | null {
  if (deps.interrupted()) return "手动中断";
  if (deps.abort.requested) return "任务失败（onTaskFail=abort）";
  if (deps.stopAt && Date.now() >= deps.stopAt.getTime()) return "到达收工时间";
  if (cfg.stop.maxCostUsd != null && deps.journal.totals.costUsd >= cfg.stop.maxCostUsd) return "花费达到上限";
  if (cfg.stop.maxRestarts > 0 && deps.journal.totals.restarts >= cfg.stop.maxRestarts) return "重启次数达到上限";
  return null;
}

/** Make a runner for a given working directory and register it for SIGINT kills. */
function makeRunner(
  deps: ScopeDeps,
  cwd: string,
  workerId: number | undefined,
  dryRun: boolean,
  quotaSleepHook?: (asleep: boolean) => void,
): AgentRunner {
  const runner = new AgentRunner({
    cfg: deps.cfg,
    journal: deps.journal,
    log: deps.log,
    notify: deps.notify,
    dryRun,
    stopAt: deps.stopAt,
    onInterrupted: deps.interrupted,
    cwd,
    workerId,
    quotaSleepHook,
  });
  deps.activeRunners.push(runner);
  return runner;
}

async function finishTaskRound(
  deps: ScopeDeps,
  taskText: string,
  st: TaskState,
  runner: AgentRunner,
): Promise<{ kind: "success" | "failed" | "stop_time"; reason?: string; attempts: number; sessionId: string | null; costUsd: number | null }> {
  const { cfg, journal, log, notify } = deps;
  let outcome = await runner.runTask(taskText, st);
  let round = 0;
  while (outcome.kind === "failed" && cfg.onTaskFail === "retry-then-next" && round < cfg.taskRetries) {
    round += 1;
    log.warn(`任务失败，整任务重试（第 ${round}/${cfg.taskRetries} 轮，使用全新会话）…`);
    journal.updateTask(taskText, { sessionId: null });
    st.sessionId = null;
    outcome = await runner.runTask(taskText, st);
  }
  if (outcome.kind === "stop_time") return { kind: "stop_time", attempts: 0, sessionId: null, costUsd: null };
  if (outcome.kind === "success") {
    journal.append("task_done", {
      task: taskText,
      attempts: outcome.attempts,
      costUsd: outcome.costUsd,
      ...(runner.workerId != null ? { worker: runner.workerId } : {}),
    });
    return { kind: "success", attempts: outcome.attempts, sessionId: outcome.sessionId, costUsd: outcome.costUsd };
  }
  journal.append("task_failed", { task: taskText, reason: outcome.reason });
  journal.updateTask(taskText, { status: "failed", lastError: outcome.reason });
  return { kind: "failed", reason: outcome.reason, attempts: outcome.attempts, sessionId: null, costUsd: null };
}

function markTodoDone(root: string, taskFile: string, taskText: string, log: Logger): void {
  const taskPath = path.join(root, taskFile);
  try {
    const md = fs.readFileSync(taskPath, "utf8");
    const item: TaskItem | undefined = parseTaskList(md).find((t) => t.text === taskText && !t.done);
    if (!item) {
      log.debug(`任务清单中未找到可勾选行: ${truncate(taskText, 40)}`);
      return;
    }
    fs.writeFileSync(taskPath, markTaskLine(md, item.line, "x"));
  } catch {
    /* task file is the checkpoint, but never crash the run over it */
  }
}

/* ------------------------------------------------------------------ */
/* Sequential scope (workers = 1) — original behavior, unchanged       */
/* ------------------------------------------------------------------ */

async function runSequential(deps: ScopeDeps, prompt: string | undefined): Promise<void> {
  const { cfg, journal, log, notify, root } = deps;
  const runner = makeRunner(deps, root, undefined, Boolean(deps.dryRun));
  const tasks: { text: string; line?: number }[] = prompt ? [{ text: prompt }] : deps.fileTasks;

  if (deps.dryRun) {
    log.event("[dry-run] 只打印计划，不会真的启动 agent");
    for (const t of tasks) {
      log.info(`→ ${truncate(t.text, 70)}`);
      log.info(`   ${runner.describePlan(t.text, "fresh", null)}`);
    }
    return;
  }

  for (const [idx, task] of tasks.entries()) {
    const stop = stopChecks(deps, cfg);
    if (stop) {
      setStopReason(deps.stopReason, stop);
      return;
    }

    journal.setCurrentTask(task.text);
    log.event(`▶ 任务 ${idx + 1}/${tasks.length}: ${truncate(task.text, 90)}`);
    const st: TaskState = journal.taskState(task.text);
    const res = await finishTaskRound(deps, task.text, st, runner);

    if (res.kind === "stop_time") {
      setStopReason(deps.stopReason, deps.interrupted() ? "手动中断" : "到达收工时间");
      return;
    }
    if (res.kind === "success") {
      deps.done.count += 1;
      log.event(`✅ 完成: ${truncate(task.text, 80)}`);
      notify.send("task_done", "✅ 任务完成", truncate(task.text, 80));
      if (task.line != null) markTodoDone(root, cfg.taskFile, task.text, log);
      gitAutoCommit(root, cfg, task.text, log);
    } else {
      deps.failed.count += 1;
      log.error(`✗ 任务失败: ${truncate(task.text, 70)} — ${res.reason}`);
      notify.send("task_failed", "❌ 任务失败", `${truncate(task.text, 70)}\n${res.reason}`);
      if (cfg.onTaskFail === "abort") {
        deps.abort.requested = true;
        setStopReason(deps.stopReason, "任务失败（onTaskFail=abort）");
        return;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Parallel scope — N workers, one git worktree each                   */
/* ------------------------------------------------------------------ */

async function runParallel(deps: ScopeDeps): Promise<void> {
  const { cfg, journal, log, notify, root } = deps;
  const manager = new WorktreeManager(root);
  manager.assertParallelReady();
  const workerCount = cfg.parallel.workers;

  log.event(
    `🔀 并行模式：${workerCount} 个 worker × 独立 worktree · 合并策略 ${cfg.parallel.merge === "auto" ? "auto（成功即合并）" : "leave（全部留分支待审查）"}`,
  );

  // Dedupe by text (duplicate checklist lines would be claimed twice).
  const seen = new Set<string>();
  const queue = deps.fileTasks.filter((t) => (seen.has(t.text) ? false : (seen.add(t.text), true)));

  const worktrees: Worktree[] = [];
  for (let i = 0; i < workerCount; i++) {
    worktrees.push(manager.create(i, deps.journal.runId));
  }

  const workerStatus: { id: number; task: string | null; sleeping?: string }[] = worktrees.map((wt) => ({
    id: wt.id,
    task: null,
  }));
  const publishWorkers = () => journal.setStatusExtra({ workers: workerStatus.map((w) => ({ ...w })) });
  const avalanche = { warned: false };

  const workerLoop = async (wt: Worktree): Promise<void> => {
    const runner = makeRunner(deps, wt.path, wt.id, false, (asleep: boolean) => {
      workerStatus[wt.id].sleeping = asleep ? "quota" : undefined;
      publishWorkers();
      if (asleep && !avalanche.warned && majorityQuotaSleeping(workerStatus, workerCount)) {
        avalanche.warned = true;
        const asleepCount = workerStatus.filter((w) => w.sleeping === "quota").length;
        log.warn(`⚠ 并行配额雪崩：${asleepCount}/${workerCount} 个 worker 在配额休眠，实际并行度下降`);
        notify.send("quota", "😴 并行配额雪崩", `${asleepCount}/${workerCount} 个 worker 因配额休眠，今晚实际并行度下降。`);
      }
    });
    const label = `w${wt.id}`;

    for (;;) {
      const stop = stopChecks(deps, cfg);
      if (stop) {
        setStopReason(deps.stopReason, stop);
        return;
      }
      const task = queue.shift();
      if (!task) return;
      workerStatus[wt.id].task = truncate(task.text, 40);
      publishWorkers();
      journal.append("task_claim", { task: task.text, worker: wt.id });
      log.event(`▶ [${label}] ${truncate(task.text, 84)}`);
      const st: TaskState = journal.taskState(task.text);
      const res = await finishTaskRound(deps, task.text, st, runner);
      workerStatus[wt.id].task = null;
      publishWorkers();

      if (res.kind === "stop_time") {
        setStopReason(deps.stopReason, deps.interrupted() ? "手动中断" : "到达收工时间");
        return;
      }
      if (res.kind === "success") {
        deps.done.count += 1;
        log.event(`✅ [${label}] 完成: ${truncate(task.text, 74)}`);
        notify.send("task_done", "✅ 任务完成", `[${label}] ${truncate(task.text, 80)}`);
        // Tick the checklist first and commit it, so the merge never meets a dirty main.
        markTodoDone(root, cfg.taskFile, task.text, log);
        if (cfg.parallel.merge === "auto") {
          try {
            manager.commitWork(wt, `${cfg.git.commitMessagePrefix} ${task.text}`);
            manager.commitCheckpoints(`${cfg.git.commitMessagePrefix} ✓ ${truncate(task.text, 50)}`);
            const merged = manager.mergeToMain(wt);
            if (merged === "merged") {
              journal.append("merge_ok", { task: task.text, branch: wt.branch });
            } else {
              journal.append("merge_conflict", { task: task.text, branch: wt.branch, path: wt.path });
              log.warn(`⚠ [${label}] 合并冲突：成果在分支 ${wt.branch}（worktree: ${wt.path}），留给早上人工处理`);
            }
          } catch (e) {
            journal.append("merge_error", { task: task.text, branch: wt.branch, error: String(e) });
            log.warn(`⚠ [${label}] 合并失败（成果保留在分支 ${wt.branch}）: ${truncate(String(e), 100)}`);
          }
        }
      } else {
        deps.failed.count += 1;
        log.error(`✗ [${label}] 任务失败: ${truncate(task.text, 70)} — ${res.reason}`);
        notify.send("task_failed", "❌ 任务失败", `[${label}] ${truncate(task.text, 70)}\n${res.reason}`);
        if (cfg.onTaskFail === "abort") {
          deps.abort.requested = true;
          setStopReason(deps.stopReason, "任务失败（onTaskFail=abort）");
          return;
        }
      }
    }
  };

  try {
    await Promise.all(worktrees.map((wt) => workerLoop(wt)));
  } finally {
    const leftover = manager.cleanupAll(worktrees);
    if (leftover.length) {
      log.warn(`📦 ${leftover.length} 个未合并的 worker 分支已保留：`);
      for (const wt of leftover) {
        log.warn(`   ${wt.branch} → ${wt.path}`);
      }
      journal.setStatusExtra({ leftoverBranches: leftover.map((wt) => wt.branch) });
    }
  }
}

/* ------------------------------------------------------------------ */
/* cmdRun — shared setup, scope dispatch, wrap-up, report              */
/* ------------------------------------------------------------------ */

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
  log.info(
    `agent: ${cfg.agent} · 任务清单: ${flags.prompt ? "（单条任务模式）" : cfg.taskFile} · worker: ${cfg.parallel.workers}`,
  );
  log.info(`收工条件: ${deadlines.length ? deadlines.join(" · ") : "全部任务完成"}`);
  if (cfg.permissions === "allowlist") {
    log.info(`安全档位 allowlist：agent 仅允许 ${cfg.claude.allowedTools.length} 类白名单工具（${cfg.claude.allowedTools.join(", ").slice(0, 120)}），其余调用一律拒绝`);
  } else if (cfg.permissions === "bypass" && cfg.agent === "claude") {
    log.warn("已启用 --dangerously-skip-permissions：agent 可以不经确认执行任何命令。建议在容器/虚拟机中运行，并确保 git 仓库干净可回滚。");
  }
  if (cfg.parallel.workers > 1 && cfg.permissions === "bypass") {
    log.warn(`并行 ×${cfg.parallel.workers}：${cfg.parallel.workers} 个 agent 同时持有人 jar 权限在工作，确认任务清单里没有会互相踩踏的任务。`);
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
  let fileTasks: { text: string; line: number }[] = [];
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
    fileTasks = remainingTasks(md).map((t) => ({ text: t.text, line: t.line }));
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

  if (cfg.parallel.workers > 1 && flags.prompt) {
    log.close();
    throw new ArgusError(
      "--prompt 单条任务模式不支持并行（只有一条任务，没有队列可分）",
      "把任务写进 TODO.md 清单后用 argus run --parallel N",
    );
  }

  const interrupted = { flag: false };
  const deps: ScopeDeps = {
    root,
    cfg,
    journal,
    log,
    notify,
    stopAt,
    interrupted: () => interrupted.flag,
    dryRun: Boolean(flags.dryRun),
    fileTasks,
    activeRunners: [],
    abort: { requested: false },
    stopReason: { value: "全部任务完成" },
    done: { count: 0 },
    failed: { count: 0 },
  };

  const onSigint = () => {
    if (!interrupted.flag) {
      interrupted.flag = true;
      log.warn("收到 Ctrl+C：正在优雅收尾，等待当前进程退出（再按一次强制退出）…");
      for (const r of deps.activeRunners) r.killCurrent();
    } else {
      log.error("强制退出");
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);

  const statusTimer = setInterval(() => {
    const t = journal.totals;
    log.setStatus(
      `🌙 值守中 · ✅${deps.done.count}/${fileTasks.length || 1} · 重启 ${t.restarts} · 看门狗 ${t.hangKills} · 配额等待 ${fmtDur(t.quotaSleepMs)}${t.costUsd > 0 ? ` · $${t.costUsd.toFixed(2)}` : ""}`,
    );
    journal.setStatusExtra({ progress: `${deps.done.count}/${fileTasks.length || 1}` });
  }, 5000);

  try {
    if (cfg.parallel.workers > 1 && !flags.prompt) {
      if (flags.dryRun) {
        log.event("[dry-run] 并行模式预演：将创建 " + cfg.parallel.workers + " 个 worktree");
        const probeRunner = makeRunner(deps, root, undefined, true);
        for (const t of fileTasks) {
          log.info(`→ ${truncate(t.text, 70)}`);
          log.info(`   ${probeRunner.describePlan(t.text, "fresh", null)}`);
        }
      } else {
        await runParallel(deps);
      }
    } else {
      await runSequential(deps, flags.prompt);
    }

    // Wrap-up: let the agent land the plane before dawn (always in the main checkout).
    if (cfg.wrapUp && deps.done.count + deps.failed.count > 0 && !flags.dryRun && !interrupted.flag) {
      log.event("🛬 收工指令：让 agent 提交代码并总结");
      const wrapRunner = makeRunner(deps, root, undefined, false);
      const wrapSt = journal.taskState("(wrap-up)");
      const wrapOutcome = await wrapRunner.runTask(cfg.wrapUpPrompt, wrapSt);
      if (wrapOutcome.kind === "success") {
        journal.append("task_done", { task: "(wrap-up)" });
        gitAutoCommit(root, cfg, "wrap-up", log);
      }
    }
  } finally {
    clearInterval(statusTimer);
    process.removeListener("SIGINT", onSigint);
    journal.finish();
    const reportPath = writeReport(root, cfg, journal, { stopReason: deps.stopReason.value, startCommit });
    log.setStatus(null);
    log.event(`📜 值守结束：${deps.stopReason.value} · ✅${deps.done.count} ❌${deps.failed.count}`);
    log.info(`📄 晨报已生成: ${reportPath}`);
    notify.send(
      "run_end",
      "📜 Argus 值守结束",
      `${deps.stopReason.value}\n完成 ${deps.done.count} · 失败 ${deps.failed.count} · 重启 ${journal.totals.restarts} · 配额等待 ${fmtDur(journal.totals.quotaSleepMs)}${journal.totals.costUsd > 0 ? ` · 花费 $${journal.totals.costUsd.toFixed(2)}` : ""}\n晨报: ${reportPath}`,
    );
    log.close();
  }
  return deps.failed.count > 0 && cfg.onTaskFail === "abort" ? 1 : 0;
}
