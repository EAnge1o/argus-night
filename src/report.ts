import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ArgusConfig } from "./config.js";
import type { Journal, JournalEvent } from "./journal.js";
import { remainingTasks } from "./tasks.js";
import { fmtDur, truncate } from "./util.js";

export interface ReportInfo {
  stopReason: string;
  startCommit: string | null;
}

function gitLog(root: string, from: string): string[] {
  try {
    const out = execFileSync("git", ["log", "--oneline", `${from}..HEAD`], {
      cwd: root,
      encoding: "utf8",
    });
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

export function writeReport(
  root: string,
  cfg: ArgusConfig,
  journal: Journal,
  info: ReportInfo,
): string {
  const events: JournalEvent[] = journal.events();
  const by = (type: string) => events.filter((e) => e.type === type);

  const taskDone = by("task_done");
  const taskFailed = by("task_failed");
  const watchdogKills = by("watchdog_kill");
  const quotaWaits = by("quota_wait");
  const apiBackoffs = by("api_busy_backoff");
  const crashes = by("crash_backoff");
  const totals = journal.totals;

  const summaries = journal.allTaskStates();

  const lines: string[] = [];
  lines.push(`# 🌙 Argus 夜间值守晨报`);
  lines.push("");
  lines.push(`- **运行 ID**: ${journal.runId}`);
  lines.push(`- **收工原因**: ${info.stopReason}`);
  lines.push(`- **agent**: ${cfg.agent}`);
  lines.push(
    `- **总计**: ✅ ${taskDone.length} 个任务完成 · ❌ ${taskFailed.length} 个失败 · 💥 ${crashes.length} 次崩溃重启 · 🚨 ${watchdogKills.length} 次看门狗介入 · 💤 ${quotaWaits.length} 次配额等待（累计 ${fmtDur(totals.quotaSleepMs)}）`,
  );
  if (totals.costUsd > 0) lines.push(`- **花费**: $${totals.costUsd.toFixed(4)}`);

  if (taskDone.length || taskFailed.length) {
    lines.push("");
    lines.push("## 任务结果");
    lines.push("");
    for (const e of taskDone) {
      lines.push(`- ✅ ${truncate(String(e.task ?? ""), 90)}（尝试 ${e.attempts ?? 1} 次${e.costUsd != null ? `，$${Number(e.costUsd).toFixed(4)}` : ""}）`);
    }
    for (const e of taskFailed) {
      lines.push(`- ❌ ${truncate(String(e.task ?? ""), 90)} — ${truncate(String(e.reason ?? "未知"), 80)}`);
    }
  }

  if (quotaWaits.length) {
    lines.push("");
    lines.push("## 配额等待");
    lines.push("");
    for (const e of quotaWaits) {
      const until = e.until ? new Date(String(e.until)).toLocaleString() : "?";
      lines.push(`- 💤 ${truncate(String(e.task ?? ""), 60)} → 睡到 ${until}（匹配: "${truncate(String(e.matched ?? ""), 50)}"）`);
    }
  }

  if (watchdogKills.length) {
    lines.push("");
    lines.push("## 看门狗记录");
    lines.push("");
    for (const e of watchdogKills) {
      lines.push(`- 🚨 ${truncate(String(e.task ?? ""), 60)}（第 ${e.attempt ?? "?"} 次尝试，无活动超时被终止并续跑）`);
    }
  }

  const mergeConflicts = by("merge_conflict");
  if (mergeConflicts.length) {
    lines.push("");
    lines.push("## 待人工合并（并行模式冲突）");
    lines.push("");
    for (const e of mergeConflicts) {
      lines.push(`- ⚠️ ${truncate(String(e.task ?? ""), 70)} — 分支 \`${e.branch ?? "?"}\`${e.path ? `（worktree: ${e.path}）` : ""}`);
    }
    lines.push("");
    lines.push("> 这些任务的成果已经提交在各自分支上，只是没能自动合并。处理：`git merge <分支名>` 解冲突，或 `git worktree remove` + `git branch -D` 放弃。");
  }

  if (crashes.length) {
    lines.push("");
    lines.push("## 崩溃与退避");
    lines.push("");
    for (const e of crashes.slice(-12)) {
      lines.push(`- 💥 exit=${e.exitCode}，退避 ${fmtDur(Number(e.delayMs ?? 0))}${e.tail ? `，末尾输出: ${truncate(String(e.tail), 90)}` : ""}`);
    }
    if (crashes.length > 12) lines.push(`- …另有 ${crashes.length - 12} 条更早的崩溃记录，见 journal`);
  }

  if (info.startCommit) {
    const commits = gitLog(root, info.startCommit);
    if (commits.length) {
      lines.push("");
      lines.push("## 今夜提交");
      lines.push("");
      for (const c of commits) lines.push(`- ${c}`);
    }
  }

  if (!cfg.agent.includes("prompt")) {
    const taskFile = path.join(root, cfg.taskFile);
    if (fs.existsSync(taskFile)) {
      const rest = remainingTasks(fs.readFileSync(taskFile, "utf8"));
      if (rest.length) {
        lines.push("");
        lines.push("## 遗留任务（下次运行继续）");
        lines.push("");
        for (const t of rest) lines.push(`- [ ] ${t.text}`);
      }
    }
  }

  lines.push("");
  lines.push(`> 由 Argus 生成于 ${new Date().toLocaleString()} · journal: \`.argus/journal-${journal.runId}.jsonl\``);

  const reportsDir = path.join(root, ".argus", "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const out = path.join(reportsDir, `report-${journal.runId}.md`);
  fs.writeFileSync(out, lines.join("\n") + "\n");
  return out;
}
