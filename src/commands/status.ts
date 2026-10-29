import fs from "node:fs";
import path from "node:path";
import { Journal } from "../journal.js";
import { fmtDur } from "../util.js";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function cmdStatus(root: string, flags: { follow?: boolean }): Promise<number> {
  const render = (): string[] => {
    const lines: string[] = [];
    const statusPath = path.join(root, ".argus", "status.json");
    if (!fs.existsSync(statusPath)) {
      lines.push("没有找到运行记录。先用 `argus run` 开始一次夜间值守。");
      return lines;
    }
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    const alive = status.pid ? pidAlive(status.pid) : false;
    lines.push(`🌙 Argus ${status.runId ?? "?"} — ${alive ? "运行中" : "已结束"}（phase: ${status.phase ?? "?"}）`);
    if (status.currentTask) lines.push(`当前任务: ${status.currentTask}`);
    if (status.statusLine) lines.push(`状态: ${status.statusLine}`);
    const t = status.totals ?? {};
    lines.push(
      `累计: 花费 $${(t.costUsd ?? 0).toFixed(4)} · 重启 ${t.restarts ?? 0} · 看门狗 ${t.hangKills ?? 0} · 配额等待 ${fmtDur(t.quotaSleepMs ?? 0)}`,
    );
    lines.push(`更新于: ${status.updatedAt ?? "?"}`);
    const journalPath = Journal.latestJournal(root);
    if (journalPath) {
      lines.push("");
      lines.push("最近事件:");
      const evs = fs
        .readFileSync(journalPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .slice(-15);
      for (const l of evs) {
        try {
          const e = JSON.parse(l);
          const extra = Object.entries(e)
            .filter(([k]) => !["ts", "type"].includes(k))
            .slice(0, 3)
            .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
            .join(" ");
          lines.push(`  ${String(e.ts).slice(11, 19)} ${String(e.type).padEnd(16)} ${extra}`);
        } catch {
          /* skip */
        }
      }
    }
    return lines;
  };

  if (!flags.follow) {
    for (const l of render()) console.log(l);
    return 0;
  }
  process.stdout.write("\x1b[2J");
  for (;;) {
    process.stdout.write("\x1b[H\x1b[2J");
    for (const l of render()) console.log(l);
    await new Promise((r) => setTimeout(r, 2000));
  }
};
