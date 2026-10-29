#!/usr/bin/env node
import { cmdRun, type RunFlags } from "./commands/run.js";
import { cmdStatus } from "./commands/status.js";
import { cmdReport } from "./commands/report.js";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdInit } from "./commands/init.js";
import { ArgusError } from "./util.js";

export const VERSION = "1.0.0";

const USAGE = `
🌙 Argus — coding agent 守夜人 v${VERSION}

整晚无人值守地驱动 Claude Code / Codex 等 agent CLI：
配额到点自动续跑 · 指数退避抗击 API 繁忙 · 心跳看门狗杀卡死进程 · 晨报总结一夜。

用法:
  argus run [选项]          开始夜间值守（子命令 night 为别名）
  argus status [--follow]   查看值守状态（另一终端 / 远程）
  argus report [--rebuild]  打印最近一次晨报
  argus doctor [--probe]    守夜前体检（--probe 会真实调用一次 agent）
  argus init [--force]      生成配置模板 + 示例任务清单

run 选项:
  --task <file>        任务清单（markdown 勾选列表，默认 TODO.md）
  --prompt <text>      单条任务模式（不走清单）
  --agent <name>       claude | codex | custom（默认取配置）
  --until <HH:MM>      干到几点收工，如 --until 07:00
  --max-hours <n>      最长值守时长（小时）
  --max-cost <usd>     花费上限（美元，claude 适配器）
  --max-restarts <n>   重启次数上限
  --idle-minutes <n>   看门狗无活动阈值（分钟）
  --wrap-up            收工前让 agent 提交代码并写总结
  --dry-run            只打印将执行的命令，不真正启动
  --verbose            透传 agent 全部输出
  --no-fs-heartbeat    关闭文件系统心跳
  --config <file>      指定配置文件路径

示例:
  argus run --until 07:00 --wrap-up
  argus run --prompt "把 src 下所有 any 类型修掉并跑通测试" --max-cost 10
  argus run --agent codex --until 06:30
  argus init && argus run --dry-run
`;

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { command: string | null; flags: Flags } {
  const flags: Flags = {};
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      flags.help = true;
      continue;
    }
    if (a === "--version" || a === "-v") {
      flags.version = true;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && key !== "help") {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (command == null) command = a;
  }
  return { command, flags };
}

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function bool(flags: Flags, key: string): boolean | undefined {
  const v = flags[key];
  return typeof v === "boolean" ? v : undefined;
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const root = process.cwd();

  if (flags.version) {
    console.log(`argus v${VERSION}`);
    return 0;
  }
  if (!command || flags.help || command === "help") {
    console.log(USAGE);
    return 0;
  }

  switch (command) {
    case "run":
    case "night": {
      const runFlags: RunFlags = {
        agent: str(flags, "agent"),
        task: str(flags, "task"),
        prompt: str(flags, "prompt"),
        until: str(flags, "until"),
        maxHours: str(flags, "max-hours"),
        maxCost: str(flags, "max-cost"),
        maxRestarts: str(flags, "max-restarts"),
        idleMinutes: str(flags, "idle-minutes"),
        verbose: bool(flags, "verbose") === true,
        dryRun: bool(flags, "dry-run") === true,
        wrapUp: bool(flags, "wrap-up"),
        noFsHeartbeat: bool(flags, "no-fs-heartbeat") === true,
        config: str(flags, "config"),
      };
      return await cmdRun(root, runFlags);
    }
    case "status":
      return await cmdStatus(root, { follow: bool(flags, "follow") === true });
    case "report":
      return cmdReport(root, { rebuild: bool(flags, "rebuild") === true });
    case "doctor":
      return await cmdDoctor(root, { probe: bool(flags, "probe") === true });
    case "init":
      return cmdInit(root, { force: bool(flags, "force") === true });
    default:
      console.error(`未知命令: ${command}\n`);
      console.log(USAGE);
      return 1;
  }
}

process.on("unhandledRejection", (reason) => {
  if (reason instanceof ArgusError) {
    console.error(`\n✗ ${reason.message}`);
    if (reason.hint) console.error(`  ↳ ${reason.hint}`);
    process.exit(1);
  }
  console.error("\n✗ 未处理的错误:", reason);
  process.exit(1);
});

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    if (e instanceof ArgusError) {
      console.error(`\n✗ ${e.message}`);
      if (e.hint) console.error(`  ↳ ${e.hint}`);
    } else {
      console.error("\n✗ 未处理的错误:", e);
    }
    process.exitCode = 1;
  });
