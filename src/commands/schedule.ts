import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ArgusError } from "../util.js";

const TASK_NAME = "ArgusNightWatch";

export interface ScheduleFlags {
  at?: string; // 每天几点开守 HH:MM
  until?: string; // 几点收工
  parallel?: string;
  agent?: string;
  task?: string;
  maxCost?: string;
  remove?: boolean;
  show?: boolean;
}

function cliPath(): string {
  // argv[1] = 正在运行的 cli.js；计划任务必须用绝对路径调它
  const p = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (!p || !fs.existsSync(p)) {
    throw new ArgusError("无法定位 argus 自身路径", "请用 node <argus>/dist/src/cli.js schedule 方式运行");
  }
  return p;
}

function buildRunArgs(f: ScheduleFlags): string {
  const parts = ["run", "--until", f.until ?? "07:00"];
  if (f.parallel) parts.push("--parallel", f.parallel);
  if (f.agent) parts.push("--agent", f.agent);
  if (f.task) parts.push("--task", f.task);
  if (f.maxCost) parts.push("--max-cost", f.maxCost);
  return parts.join(" ");
}

function schtasks(args: string[]): string {
  try {
    return execFileSync("schtasks", args, { encoding: "utf8", windowsHide: true });
  } catch (e) {
    throw new ArgusError(`schtasks 执行失败（需要管理员权限吗？）`, String(e));
  }
}

export function cmdSchedule(root: string, f: ScheduleFlags): number {
  const exe = cliPath();

  if (f.show) {
    if (process.platform === "win32") {
      try {
        console.log(schtasks(["/Query", "/TN", TASK_NAME, "/FO", "LIST"]));
      } catch (e) {
        console.log(`没有找到计划任务 ${TASK_NAME}。`);
        return 1;
      }
    } else {
      console.log("POSIX 下请检查 crontab: crontab -l | grep argus");
    }
    return 0;
  }

  if (f.remove) {
    if (process.platform === "win32") {
      try {
        schtasks(["/Delete", "/TN", TASK_NAME, "/F"]);
        console.log(`✓ 已删除计划任务 ${TASK_NAME}`);
      } catch {
        console.log(`计划任务 ${TASK_NAME} 不存在，无需删除。`);
      }
    } else {
      console.log("POSIX 下请手动移除 crontab 中 argus 的那一行。");
    }
    return 0;
  }

  if (!f.at) {
    throw new ArgusError(
      "用法: argus schedule --at 23:00 [--until 07:00] [--parallel 3] [--max-cost 10]；移除用 --remove；查看用 --show",
    );
  }
  if (!/^\d{1,2}:\d{2}$/.test(f.at)) throw new ArgusError(`--at 需要 HH:MM 格式，当前 "${f.at}"`);

  const runArgs = buildRunArgs(f);
  const runId = `每天 ${f.at} 开守 · ${f.until ?? "07:00"} 收工`;

  if (process.platform === "win32") {
    // 写一个启动器脚本，绕开 schtasks /TR 的引号地狱
    const argusDir = path.join(root, ".argus");
    fs.mkdirSync(argusDir, { recursive: true });
    const launcher = path.join(argusDir, "schedule-task.cmd");
    const logFile = path.join(argusDir, "schedule.log");
    fs.writeFileSync(
      launcher,
      [
        "@echo off",
        `cd /d "${root}"`,
        `node "${exe}" ${runArgs} >> "${logFile}" 2>&1`,
        "",
      ].join("\r\n"),
    );
    // 已存在则覆盖（/F）
    schtasks([
      "/Create", "/F",
      "/SC", "DAILY",
      "/ST", f.at,
      "/TN", TASK_NAME,
      "/TR", `"${launcher}"`,
    ]);
    console.log(`\n🌙 已安排自动开守：${runId}`);
    console.log(`   计划任务: ${TASK_NAME}（Windows 任务计划程序里可见）`);
    console.log(`   启动脚本: ${launcher}`);
    console.log(`   运行日志: ${logFile}`);
    console.log(`   实际命令: node "${exe}" ${runArgs}`);
    console.log(`\n   删除: argus schedule --remove · 查看: argus schedule --show\n`);
  } else {
    const logFile = path.join(root, ".argus", "schedule.log");
    const cronLine = `${cronField(f.at)} cd "${root}" && node "${exe}" ${runArgs} >> "${logFile}" 2>&1 # argus-night`;
    console.log(`\n🌙 在 crontab -e 里加入这一行即可每天自动开守：${runId}\n`);
    console.log(`  ${cronLine}\n`);
  }
  return 0;
}

function cronField(hhmm: string): string {
  const [h, m] = hhmm.split(":");
  return `${Number(m)} ${Number(h)} * * *`;
}
