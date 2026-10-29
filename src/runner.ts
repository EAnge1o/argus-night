import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { ArgusConfig } from "./config.js";
import type { Journal, TaskState } from "./journal.js";
import type { Logger } from "./log.js";
import type { Notifier } from "./notify.js";
import { classify, parseResetHint, resolveWakeTime, type ResetHint } from "./patterns.js";
import { Backoff, HeartbeatWatchdog } from "./backoff.js";
import { getAdapter, planFor, type RunMode, type SpawnPlan } from "./adapters/index.js";
import { ArgusError, LineSplitter, fmtCountdown, fmtDur, killTree, resolveCommand, sleep, truncate } from "./util.js";

export interface ProcOutcome {
  exitCode: number | null;
  signal: string | null;
  hung: boolean;
  elapsedMs: number;
  quotaHit: { matched: string; hint: ResetHint | null } | null;
  apiBusyCount: number;
  sessionLost: boolean;
  configError: string | null;
  outputTail: string[];
}

export type TaskOutcome =
  | { kind: "success"; sessionId: string | null; costUsd: number | null; attempts: number }
  | { kind: "failed"; reason: string; attempts: number }
  | { kind: "stop_time" };

export interface RunnerDeps {
  cfg: ArgusConfig;
  journal: Journal;
  log: Logger;
  notify: Notifier;
  dryRun: boolean;
  /** Absolute stop deadline (from stop.until / maxHours); the quota nap won't cross it. */
  stopAt: Date | null;
  onInterrupted: () => boolean;
  /** Directory the agent runs in: the main checkout, or this worker's worktree. */
  cwd: string;
  workerId?: number;
}

const DEFAULT_EXCLUDES = [".git", "node_modules", ".argus"];

/**
 * Runs one agent task through the full night-watch state machine:
 * spawn → heartbeat → classify output → quota sleep / api backoff /
 * watchdog kill-and-resume / crash backoff → success or give up.
 */
export class AgentRunner {
  private _adapter: ReturnType<typeof getAdapter> | null = null;
  private currentChild: ChildProcess | null = null;
  private interrupted = false;

  constructor(private d: RunnerDeps) {}

  private get adapter() {
    if (!this._adapter) this._adapter = getAdapter(this.d.cfg);
    return this._adapter;
  }

  get workerId(): number | undefined {
    return this.d.workerId;
  }

  /** Best-effort kill of the live agent process (Ctrl+C path). */
  killCurrent(): void {
    this.interrupted = true;
    const child = this.currentChild;
    if (child) void killTree(child, 5000);
  }

  describePlan(taskText: string, mode: RunMode, sessionId: string | null): string {
    const plan = planFor(this.adapter, { mode, sessionId, prompt: taskText });
    const promptNote = plan.promptVia === "stdin" ? " (prompt → stdin)" : "";
    const cmd = plan.needsCmdWrap ? `cmd /c "${plan.file}" ${plan.args.join(" ")}` : `${plan.file} ${plan.args.join(" ")}`;
    return `${cmd}${promptNote}`;
  }

  async runTask(taskText: string, st: TaskState): Promise<TaskOutcome> {
    const { cfg, log, journal } = this.d;
    this.lastSessionId = null;
    const backoff = new Backoff(cfg.backoff.baseSeconds * 1000, cfg.backoff.maxSeconds * 1000, cfg.backoff.factor);
    let mode: RunMode = st.sessionId ? "resume" : "fresh";
    let hangResumeLeft = cfg.hang.resumeTries;
    let hangFreshLeft = cfg.hang.freshTries;
    let attempts = 0;

    for (;;) {
      if (this.interrupted || this.d.onInterrupted()) {
        return { kind: "stop_time" };
      }
      attempts += 1;
      st.attempts = attempts;
      journal.updateTask(taskText, { status: "running", attempts });
      journal.append("spawn", { task: taskText, mode, attempt: attempts });
      journal.setPhase("running");

      const outcome = await this.runProcess(taskText, mode, st.sessionId);

      if (outcome.configError) {
        journal.append("config_error", { task: taskText, matched: outcome.configError });
        log.error(`agent 命令参数无法识别（${truncate(outcome.configError, 120)}）`);
        log.error("请检查适配器参数是否与已安装的 CLI 版本匹配，可运行 npx argus-night doctor 排查");
        return { kind: "failed", reason: `config error: ${outcome.configError}`, attempts };
      }

      // Subscription quota: sleep until reset, then resume the SAME session.
      if (outcome.quotaHit) {
        const wake = resolveWakeTime(outcome.quotaHit.hint, cfg.quota.maxSleepMinutes * 60_000);
        journal.append("quota_wait", {
          task: taskText,
          until: wake.toISOString(),
          matched: outcome.quotaHit.matched,
          hint: outcome.quotaHit.hint,
        });
        log.warn(`订阅配额触顶（匹配: "${truncate(outcome.quotaHit.matched, 60)}"），睡到 ${wake.toLocaleTimeString()} 后自动续跑`);
        this.d.notify.send("quota", "🌙 配额休息", `任务「${truncate(taskText, 40)}」进入配额等待，预计 ${wake.toLocaleTimeString()} 恢复`);
        const napStart = Date.now();
        const woke = await this.sleepUntil(wake, "💤 配额休息");
        journal.addQuotaSleep(Date.now() - napStart);
        if (!woke) return { kind: "stop_time" };
        journal.updateTask(taskText, { quotaPauses: st.quotaPauses + 1 });
        mode = "resume";
        continue;
      }

      // API busy (429/529/overload): exponential backoff, then resume.
      if (outcome.apiBusyCount > 0 && !this.wasSuccessfulExit(outcome)) {
        const delay = backoff.recordFailure();
        journal.append("api_busy_backoff", {
          task: taskText,
          delayMs: delay,
          signals: outcome.apiBusyCount,
          exitCode: outcome.exitCode,
        });
        log.warn(`API 繁忙（${outcome.apiBusyCount} 次信号），指数退避 ${fmtDur(delay)} 后续跑同一会话`);
        await this.sleepWithCountdown(delay, "⏳ API 退避");
        mode = st.sessionId ? "resume" : "fresh";
        continue;
      }

      if (outcome.hung) {
        journal.addHangKill();
        journal.bumpRestarts();
        journal.append("watchdog_kill", {
          task: taskText,
          idleMs: cfg.idleTimeoutMinutes * 60_000,
          attempt: attempts,
        });
        journal.updateTask(taskText, { hangKills: st.hangKills + 1 });
        this.d.notify.send("quota", "🚨 看门狗介入", `任务「${truncate(taskText, 40)}」无输出超过 ${cfg.idleTimeoutMinutes} 分钟，已终止进程`);
        log.warn(`看门狗：${cfg.idleTimeoutMinutes} 分钟无任何活动，进程已终止`);
        if (hangResumeLeft > 0 && this.adapter.supportsResume) {
          hangResumeLeft -= 1;
          log.info(`带原会话续跑（第 ${cfg.hang.resumeTries - hangResumeLeft}/${cfg.hang.resumeTries} 次）`);
          mode = "resume";
          continue;
        }
        if (hangFreshLeft > 0) {
          hangFreshLeft -= 1;
          log.info("续跑未恢复，改用全新会话接续任务");
          journal.updateTask(taskText, { sessionId: null });
          st.sessionId = null;
          mode = "fresh";
          continue;
        }
        return { kind: "failed", reason: "反复卡死（看门狗多次介入无效）", attempts };
      }

      if (this.wasSuccessfulExit(outcome)) {
        const fin = this.adapter.finalize(outcome.exitCode ?? 0);
        if (fin.costUsd != null) {
          journal.addCost(fin.costUsd);
          journal.updateTask(taskText, { costUsd: st.costUsd + fin.costUsd });
        }
        backoff.recordSuccess();
        const sessionId = this.lastSessionId ?? st.sessionId;
        journal.updateTask(taskText, { status: "done", sessionId, lastError: null });
        return { kind: "success", sessionId, costUsd: fin.costUsd, attempts };
      }

      // Crash path: exit != 0 or adapter-reported failure.
      const delay = backoff.recordFailure();
      journal.bumpRestarts();
      const tail = outcome.outputTail.slice(-6).join(" | ");
      journal.append("crash_backoff", {
        task: taskText,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        delayMs: delay,
        consecutive: backoff.consecutiveFailures,
        tail: truncate(tail, 300),
      });
      if (outcome.sessionLost) {
        log.warn("会话已丢失（resume 目标不存在），下次改用全新会话");
        st.sessionId = null;
        journal.updateTask(taskText, { sessionId: null });
      }
      if (backoff.consecutiveFailures > cfg.backoff.maxConsecutiveCrashes) {
        return { kind: "failed", reason: `连续崩溃 ${backoff.consecutiveFailures} 次（exit=${outcome.exitCode}）`, attempts };
      }
      log.warn(
        `异常退出（exit=${outcome.exitCode}${outcome.signal ? ` signal=${outcome.signal}` : ""}），${fmtDur(delay)} 后第 ${backoff.consecutiveFailures} 次重启`,
      );
      if (outcome.outputTail.length) log.debug(`末尾输出: ${truncate(tail, 200)}`);
      await this.sleepWithCountdown(delay, "⏳ 崩溃退避");
      mode = st.sessionId ? "resume" : "fresh";
    }
  }

  private wasSuccessfulExit(o: ProcOutcome): boolean {
    if (o.hung) return false;
    if (o.exitCode === 0 && o.configError == null) {
      const fin = this.adapter.finalize(0);
      return fin.success !== false;
    }
    return false;
  }

  private lastSessionId: string | null = null;

  private async runProcess(taskText: string, mode: RunMode, sessionId: string | null): Promise<ProcOutcome> {
    const { cfg, log, journal } = this.d;
    const plan: SpawnPlan = planFor(this.adapter, { mode, sessionId, prompt: taskText });
    const startedAt = Date.now();

    if (this.d.dryRun) {
      log.info(`[dry-run] 将执行: ${this.describePlan(taskText, mode, sessionId)}`);
      return {
        exitCode: 0,
        signal: null,
        hung: false,
        elapsedMs: 0,
        quotaHit: null,
        apiBusyCount: 0,
        sessionLost: false,
        configError: null,
        outputTail: [],
      };
    }

    journal.setStatusExtra({ mode, sessionId, attemptTask: truncate(taskText, 60) });
    log.debug(`${mode === "resume" ? "续跑" : "新会话"} → ${this.describePlan(taskText, mode, sessionId)}`);

    let child: ChildProcess;
    try {
      if (plan.needsCmdWrap) {
        child = spawn("cmd.exe", ["/d", "/s", "/c", plan.file, ...plan.args], {
          cwd: this.d.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } else {
        child = spawn(plan.file, plan.args, {
          cwd: this.d.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        });
      }
    } catch (e) {
      throw new ArgusError(
        `无法启动 agent 命令 "${plan.file}"`,
        `${e}\n提示: 运行 npx argus-night doctor 检查 CLI 是否安装、是否在 PATH 中`,
      );
    }
    this.currentChild = child;

    const watchdog = new HeartbeatWatchdog(cfg.idleTimeoutMinutes * 60_000);
    let hung = false;
    let apiBusyCount = 0;
    let sessionLost = false;
    let configError: string | null = null;
    let quotaHit: { matched: string; hint: ResetHint | null } | null = null;
    const outputTail: string[] = [];

    const handleLine = (source: "stdout" | "stderr") => (rawLine: string) => {
      const line = rawLine.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "").trimEnd();
      if (!line.trim()) return;
      watchdog.poke();
      outputTail.push(line);
      if (outputTail.length > 40) outputTail.shift();
      log.raw(line);

      const sig = classify(line, cfg.quota.extraPatterns);
      if (sig.type === "quota" && !quotaHit) {
        quotaHit = { matched: sig.matched, hint: parseResetHint(line) };
      } else if (sig.type === "api_busy") {
        apiBusyCount += 1;
      } else if (sig.type === "session_lost") {
        sessionLost = true;
      } else if (sig.type === "config_error" && configError == null) {
        configError = line;
      }
      const capture = this.adapter.parseLine(line);
      if (capture?.sessionId) this.lastSessionId = capture.sessionId;
      if (sig.type !== "none") {
        journal.append("output_signal", {
          task: taskText,
          source,
          signal: sig.type,
          matched: sig.matched,
          ...(this.d.workerId != null ? { worker: this.d.workerId } : {}),
        });
      }
    };

    const stdoutSplit = new LineSplitter(handleLine("stdout"));
    const stderrSplit = new LineSplitter(handleLine("stderr"));
    child.stdout?.on("data", (chunk: Buffer) => stdoutSplit.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => stderrSplit.push(chunk.toString("utf8")));

    // Prompt delivery: stdin avoids Windows cmd.exe quoting hell entirely.
    if (plan.promptVia === "stdin") {
      child.stdin?.write(taskText + "\n");
      child.stdin?.end();
    }

    const closeWatcher = cfg.fsHeartbeat ? this.startFsHeartbeat(watchdog) : () => {};

    const watchdogTimer = setInterval(() => {
      if (watchdog.check() === "hung" && !hung) {
        hung = true;
        log.warn(`看门狗：${cfg.idleTimeoutMinutes} 分钟无活动，正在终止 agent 进程树…`);
        void killTree(child);
      }
    }, 5_000);

    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      let settled = false;
      const done = (code: number | null, signal: string | null) => {
        if (!settled) {
          settled = true;
          resolve({ code, signal });
        }
      };
      child.on("close", (code, signal) => done(code, signal));
      child.on("error", () => done(-1, null));
    });

    clearInterval(watchdogTimer);
    closeWatcher();
    stdoutSplit.flush();
    stderrSplit.flush();
    this.currentChild = null;

    return {
      exitCode: exit.code,
      signal: exit.signal,
      hung,
      elapsedMs: Date.now() - startedAt,
      quotaHit,
      apiBusyCount,
      sessionLost,
      configError,
      outputTail,
    };
  }

  private startFsHeartbeat(watchdog: HeartbeatWatchdog): () => void {
    const root = this.d.cwd;
    const excludes = [...DEFAULT_EXCLUDES, ...this.d.cfg.fsHeartbeatExclude];
    let lastPoke = 0;
    try {
      const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        const now = Date.now();
        if (now - lastPoke < 2000) return;
        const rel = filename ? String(filename).replace(/\\/g, "/") : "";
        if (rel && excludes.some((e) => rel === e || rel.startsWith(e + "/"))) return;
        lastPoke = now;
        watchdog.poke();
      });
      watcher.on("error", () => {
        /* watcher dies silently; stdout heartbeat still works */
      });
      return () => {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
      };
    } catch {
      return () => {};
    }
  }

  /** Sleep until a wall-clock deadline with a live countdown; false if the stop deadline cut it short. */
  private async sleepUntil(wake: Date, label: string): Promise<boolean> {
    const { log, journal } = this.d;
    journal.setPhase("quota_sleep");
    for (;;) {
      const remain = wake.getTime() - Date.now();
      if (remain <= 0) {
        log.info("配额重置时间已到，恢复执行");
        return true;
      }
      if (this.d.stopAt && Date.now() + 30_000 >= this.d.stopAt.getTime()) {
        log.warn("到达收工时间，结束配额等待（下次运行会继续）");
        return false;
      }
      if (this.interrupted || this.d.onInterrupted()) return false;
      this.setStatusLine(`${label} ${fmtCountdown(remain)} → ${wake.toLocaleTimeString()}`);
      await sleep(Math.min(1000, remain));
    }
  }

  private async sleepWithCountdown(ms: number, label: string): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.interrupted || this.d.onInterrupted()) return;
      this.setStatusLine(`${label} ${fmtCountdown(deadline - Date.now())}`);
      await sleep(Math.min(1000, deadline - Date.now()));
    }
  }

  private setStatusLine(text: string): void {
    this.d.log.setStatus(`🌙 ${text}`);
    this.d.journal.setStatusExtra({ statusLine: text });
  }
}

export function adapterCommandExists(cfg: ArgusConfig): { ok: boolean; file: string } {
  const name = cfg.agent === "custom" ? cfg.custom.command : cfg.agent;
  if (!name) return { ok: false, file: "" };
  const resolved = resolveCommand(name);
  try {
    fs.accessSync(resolved.file);
    return { ok: true, file: resolved.file };
  } catch {
    return { ok: false, file: resolved.file };
  }
}
