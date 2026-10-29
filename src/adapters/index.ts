import type { ArgusConfig, PromptVia } from "../config.js";
import { resolveCommand, ArgusError } from "../util.js";

export type RunMode = "fresh" | "resume";

export interface SpawnPlan {
  file: string;
  args: string[];
  promptVia: PromptVia;
  needsCmdWrap: boolean;
}

export interface LineCapture {
  sessionId?: string;
  costUsd?: number;
  turns?: number;
}

export interface AdapterFinal {
  success: boolean | null;
  costUsd: number | null;
}

export interface AgentAdapter {
  readonly name: string;
  readonly supportsResume: boolean;
  plan(opts: { mode: RunMode; sessionId: string | null; prompt: string }): SpawnPlan;
  parseLine(line: string): LineCapture | null;
  finalize(exitCode: number): AdapterFinal;
}

function claudePermissionArgs(cfg: ArgusConfig): string[] {
  if (cfg.permissions === "bypass") return ["--dangerously-skip-permissions"];
  if (cfg.permissions === "acceptEdits") return ["--permission-mode", "acceptEdits"];
  return [];
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name = "claude";
  readonly supportsResume = true;
  private sessionId: string | null = null;
  private costUsd: number | null = null;
  private turns: number | null = null;
  private sawResult = false;
  private isError = false;

  constructor(private cfg: ArgusConfig) {}

  plan({ mode, sessionId, prompt }: { mode: RunMode; sessionId: string | null; prompt: string }): SpawnPlan {
    const resolved = resolveCommand("claude");
    const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];
    if (this.cfg.claude.streamHeartbeat) args.push("--include-partial-messages");
    args.push(...claudePermissionArgs(this.cfg), ...this.cfg.claude.extraArgs);
    if (mode === "resume") args.push(sessionId ? "--resume" : "--continue");
    if (sessionId && mode === "resume") args.push(sessionId);
    return { file: resolved.file, args, promptVia: "stdin", needsCmdWrap: resolved.needsCmdWrap };
  }

  parseLine(line: string): LineCapture | null {
    const s = line.trim();
    if (!s.startsWith("{")) return null;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
    const type = obj["type"];
    if (type === "system" && obj["subtype"] === "init" && typeof obj["session_id"] === "string") {
      this.sessionId = obj["session_id"];
      return { sessionId: this.sessionId };
    }
    if (type === "result") {
      this.sawResult = true;
      this.isError = obj["is_error"] === true;
      if (typeof obj["session_id"] === "string") this.sessionId = obj["session_id"];
      if (typeof obj["total_cost_usd"] === "number") this.costUsd = obj["total_cost_usd"];
      if (typeof obj["num_turns"] === "number") this.turns = obj["num_turns"];
      return { sessionId: this.sessionId ?? undefined, costUsd: this.costUsd ?? undefined, turns: this.turns ?? undefined };
    }
    return null;
  }

  finalize(exitCode: number): AdapterFinal {
    if (this.sawResult) {
      return { success: !this.isError, costUsd: this.costUsd };
    }
    return { success: exitCode === 0 ? null : false, costUsd: this.costUsd };
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";
  get supportsResume(): boolean {
    return this.cfg.codex.resumeMode !== "none";
  }
  private sessionId: string | null = null;

  constructor(private cfg: ArgusConfig) {}

  plan({ prompt }: { mode: RunMode; sessionId: string | null; prompt: string }): SpawnPlan {
    const resolved = resolveCommand("codex");
    const sandbox = this.cfg.codex.bypass ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--full-auto"];
    const args: string[] = ["exec", ...sandbox, "--json", "--skip-git-repo-check", ...this.cfg.codex.extraArgs];
    return { file: resolved.file, args, promptVia: this.cfg.codex.promptVia, needsCmdWrap: resolved.needsCmdWrap };
  }

  planResume({ sessionId, prompt }: { mode: RunMode; sessionId: string | null; prompt: string }): SpawnPlan {
    const base = this.plan({ mode: "fresh", sessionId, prompt });
    if (this.cfg.codex.resumeMode === "exec-resume-last") {
      // codex exec resume --last continues the most recent session.
      base.args = ["exec", "resume", "--last", ...base.args.slice(1)];
    }
    return base;
  }

  parseLine(line: string): LineCapture | null {
    const s = line.trim();
    if (!s.startsWith("{")) return null;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
    if (obj["type"] === "thread.started" && typeof obj["thread_id"] === "string") {
      this.sessionId = obj["thread_id"];
      return { sessionId: this.sessionId };
    }
    return null;
  }

  finalize(exitCode: number): AdapterFinal {
    return { success: exitCode === 0, costUsd: null };
  }
}

export class CustomAdapter implements AgentAdapter {
  readonly name = "custom";
  readonly supportsResume: boolean;
  // Tolerant claude-style result parsing so any CLI that emits
  // {"type":"result",...} gets cost/session/error tracking for free.
  private sawResult = false;
  private isError = false;
  private costUsd: number | null = null;
  private lastSessionId: string | null = null;

  constructor(private cfg: ArgusConfig) {
    this.supportsResume = cfg.custom.resumeArgs.length > 0;
  }

  plan({ mode, sessionId }: { mode: RunMode; sessionId: string | null; prompt: string }): SpawnPlan {
    const cmd = this.cfg.custom.command;
    if (!cmd.trim()) throw new ArgusError("custom.command 未配置");
    const resolved = resolveCommand(cmd);
    let args = [...this.cfg.custom.args];
    if (mode === "resume" && this.cfg.custom.resumeArgs.length > 0) {
      args = this.cfg.custom.resumeArgs.map((a) => a.replace("{sessionId}", sessionId ?? ""));
    }
    return { file: resolved.file, args, promptVia: this.cfg.custom.promptVia, needsCmdWrap: resolved.needsCmdWrap };
  }

  parseLine(line: string): LineCapture | null {
    const s = line.trim();
    if (!s.startsWith("{")) return null;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
    if (obj["type"] !== "result") return null;
    this.sawResult = true;
    this.isError = obj["is_error"] === true;
    if (typeof obj["total_cost_usd"] === "number") this.costUsd = obj["total_cost_usd"];
    if (typeof obj["session_id"] === "string") this.lastSessionId = obj["session_id"];
    return { sessionId: this.lastSessionId ?? undefined, costUsd: this.costUsd ?? undefined };
  }

  finalize(exitCode: number): AdapterFinal {
    if (this.sawResult) return { success: !this.isError, costUsd: this.costUsd };
    return { success: exitCode === 0, costUsd: this.costUsd };
  }
}

export function getAdapter(cfg: ArgusConfig): AgentAdapter {
  if (cfg.agent === "claude") return new ClaudeAdapter(cfg);
  if (cfg.agent === "codex") return new CodexAdapter(cfg);
  return new CustomAdapter(cfg);
}

/** Resume-aware plan dispatch shared by the runner. */
export function planFor(
  adapter: AgentAdapter,
  opts: { mode: RunMode; sessionId: string | null; prompt: string },
): SpawnPlan {
  if (adapter instanceof CodexAdapter && opts.mode === "resume") {
    return adapter.planResume(opts);
  }
  return adapter.plan(opts);
}
