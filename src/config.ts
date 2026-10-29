import fs from "node:fs";
import path from "node:path";
import { ArgusError } from "./util.js";

export type AgentKind = "claude" | "codex" | "custom";
export type PromptVia = "stdin" | "arg";

export interface ArgusConfig {
  agent: AgentKind;
  taskFile: string;
  permissions: "bypass" | "acceptEdits" | "default";
  idleTimeoutMinutes: number;
  backoff: {
    baseSeconds: number;
    maxSeconds: number;
    factor: number;
    maxConsecutiveCrashes: number;
  };
  hang: { resumeTries: number; freshTries: number };
  quota: { maxSleepMinutes: number; extraPatterns: string[] };
  stop: {
    until: string | null;
    maxHours: number;
    maxCostUsd: number | null;
    maxRestarts: number;
  };
  onTaskFail: "retry-then-next" | "skip" | "abort";
  taskRetries: number;
  git: { autoCommit: boolean; commitMessagePrefix: string };
  fsHeartbeat: boolean;
  fsHeartbeatExclude: string[];
  wrapUp: boolean;
  wrapUpPrompt: string;
  notify: {
    webhookUrl: string;
    format: "slack" | "discord" | "lark" | "raw";
    events: string[];
  };
  claude: { extraArgs: string[]; streamHeartbeat: boolean };
  codex: {
    extraArgs: string[];
    promptVia: PromptVia;
    bypass: boolean;
    resumeMode: "exec-resume-last" | "none";
  };
  custom: {
    command: string;
    args: string[];
    promptVia: PromptVia;
    resumeArgs: string[];
  };
}

export const DEFAULT_CONFIG: ArgusConfig = {
  agent: "claude",
  taskFile: "TODO.md",
  permissions: "bypass",
  idleTimeoutMinutes: 15,
  backoff: {
    baseSeconds: 30,
    maxSeconds: 1800,
    factor: 2,
    maxConsecutiveCrashes: 5,
  },
  hang: { resumeTries: 2, freshTries: 2 },
  quota: { maxSleepMinutes: 360, extraPatterns: [] },
  stop: { until: null, maxHours: 12, maxCostUsd: null, maxRestarts: 200 },
  onTaskFail: "retry-then-next",
  taskRetries: 2,
  git: { autoCommit: false, commitMessagePrefix: "argus:" },
  fsHeartbeat: true,
  fsHeartbeatExclude: [],
  wrapUp: false,
  wrapUpPrompt:
    "夜间值守结束：请收尾当前工作——完成手头修改、运行测试、用 git 提交全部变更，并写一段简短的进展总结。",
  notify: { webhookUrl: "", format: "slack", events: ["quota", "task_done", "task_failed", "run_end"] },
  claude: { extraArgs: [], streamHeartbeat: true },
  codex: {
    extraArgs: [],
    promptVia: "stdin",
    bypass: true,
    resumeMode: "exec-resume-last",
  },
  custom: { command: "", args: [], promptVia: "stdin", resumeArgs: [] },
};

/** Strip // and /* *\/ comments plus trailing commas from JSONC text. */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        if (i + 1 < n) {
          out += text[i + 1];
          i += 2;
          continue;
        }
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // Tolerate trailing commas: `,` followed only by whitespace + } or ]
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    if (isPlainObject(v) && isPlainObject(cur)) {
      out[k] = deepMerge(cur, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

function expect(
  cond: boolean,
  message: string,
  hint?: string,
): asserts cond {
  if (!cond) throw new ArgusError(message, hint);
}

export function validateConfig(cfg: ArgusConfig): void {
  expect(
    ["claude", "codex", "custom"].includes(cfg.agent),
    `agent 必须是 claude / codex / custom，当前为 "${cfg.agent}"`,
  );
  expect(cfg.agent !== "custom" || cfg.custom.command.trim() !== "",
    "agent 为 custom 时必须配置 custom.command");
  expect(
    Number.isFinite(cfg.idleTimeoutMinutes) && cfg.idleTimeoutMinutes >= 0.1,
    "idleTimeoutMinutes 必须 >= 0.1（看门狗依赖它判断卡死）",
  );
  expect(cfg.taskRetries >= 0, "taskRetries 必须 >= 0");
  expect(
    cfg.onTaskFail === "retry-then-next" ||
      cfg.onTaskFail === "skip" ||
      cfg.onTaskFail === "abort",
    `onTaskFail 必须是 retry-then-next / skip / abort，当前为 "${cfg.onTaskFail}"`,
  );
  expect(
    cfg.stop.until === null || /^\d{1,2}:\d{2}$/.test(cfg.stop.until),
    `stop.until 需为 HH:MM 或 null，当前为 "${cfg.stop.until}"`,
  );
  expect(
    cfg.notify.format === "slack" ||
      cfg.notify.format === "discord" ||
      cfg.notify.format === "lark" ||
      cfg.notify.format === "raw",
    `notify.format 必须是 slack / discord / lark / raw，当前为 "${cfg.notify.format}"`,
  );
  for (const p of cfg.quota.extraPatterns) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(p, "i");
    } catch (e) {
      throw new ArgusError(`quota.extraPatterns 中的正则无法编译: "${p}"`, String(e));
    }
  }
}

export function parseConfigText(text: string, file: string): Partial<ArgusConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch (e) {
    throw new ArgusError(`配置文件 ${file} 不是合法的 JSON/JSONC`, String(e));
  }
  expect(isPlainObject(parsed), `配置文件 ${file} 顶层必须是对象`);
  return parsed as Partial<ArgusConfig>;
}

export function findConfigFile(root: string): string | null {
  for (const name of ["argus.config.jsonc", "argus.config.json"]) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function loadConfig(root: string): { config: ArgusConfig; file: string | null } {
  const file = findConfigFile(root);
  let partial: Partial<ArgusConfig> = {};
  if (file) {
    const text = fs.readFileSync(file, "utf8");
    partial = parseConfigText(text, path.basename(file));
  }
  const config = deepMerge(DEFAULT_CONFIG, partial as Record<string, unknown>);
  validateConfig(config);
  return { config, file };
}

/** Build a fully-commented starter config for `argus init`. */
export function starterConfigText(): string {
  return `{
  // Argus 守夜人配置。带 // 的注释行可以随意保留或删除。
  // agent: 用哪个 CLI 当夜班工人 → "claude" | "codex" | "custom"
  "agent": "claude",

  // 任务清单：markdown 勾选列表，argus 逐条喂给 agent，完成一条勾掉一条
  "taskFile": "TODO.md",

  // 权限模式（仅 claude 生效）：无人值守通常需要 bypass
  // bypass = --dangerously-skip-permissions, acceptEdits = --permission-mode acceptEdits, default = 不加参数
  "permissions": "bypass",

  // 看门狗：agent 超过这么多分钟没有任何输出 / 文件活动 → 判定卡死，杀掉并续跑
  // 如果关闭 claude.streamHeartbeat，建议调大到 20 以上（纯思考阶段没有流式输出）
  "idleTimeoutMinutes": 15,

  // API 繁忙 / 崩溃的退避策略：30s 起步，每次翻倍，封顶 30 分钟，带随机抖动
  "backoff": { "baseSeconds": 30, "maxSeconds": 1800, "factor": 2, "maxConsecutiveCrashes": 5 },

  // 卡死处理：先带原会话续跑 2 次，再用全新会话接续 2 次，仍卡死则放弃该任务
  "hang": { "resumeTries": 2, "freshTries": 2 },

  // 订阅配额（5 小时窗 / 周限额）触发时：睡到重置点再自动续跑
  "quota": { "maxSleepMinutes": 360, "extraPatterns": [] },

  // 收工条件：到点 / 超时 / 花费上限 / 重启次数上限，任一满足即安全收工并出晨报
  "stop": { "until": null, "maxHours": 12, "maxCostUsd": null, "maxRestarts": 200 },

  // 单个任务连续失败后的策略：retry-then-next（重试后跳过）/ skip / abort
  "onTaskFail": "retry-then-next",
  "taskRetries": 2,

  // 每个任务完成后自动 git commit（强烈建议开着 git，这是无人值守的安全网）
  "git": { "autoCommit": false, "commitMessagePrefix": "argus:" },

  // 文件系统心跳：仓库里有文件变动也算“agent 活着”（防纯思考期误杀的兜底）
  "fsHeartbeat": true,
  "fsHeartbeatExclude": [],

  // 收工前给 agent 发一条收尾指令（提交代码 + 写总结）
  "wrapUp": false,
  "wrapUpPrompt": "夜间值守结束：请收尾当前工作——完成手头修改、运行测试、用 git 提交全部变更，并写一段简短的进展总结。",

  // 通知：留空则不发。format: slack | discord | lark(飞书) | raw
  "notify": { "webhookUrl": "", "format": "slack", "events": ["quota", "task_done", "task_failed", "run_end"] },

  // Claude Code 专属参数
  "claude": { "extraArgs": [], "streamHeartbeat": true },

  // Codex 专属参数。resumeMode: exec-resume-last = codex exec resume --last 续跑上一会话
  "codex": { "extraArgs": [], "promptVia": "stdin", "bypass": true, "resumeMode": "exec-resume-last" },

  // 自定义 agent CLI（任意工具）。resumeArgs 里的 {sessionId} 会被替换
  "custom": { "command": "", "args": [], "promptVia": "stdin", "resumeArgs": [] }
}
`;
}
