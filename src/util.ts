import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";

export class ArgusError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
    this.name = "ArgusError";
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Format a duration in ms as `1h 04m 09s` (or `42s` when short). */
export function fmtDur(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  if (h > 0) return `${h}h ${pad(m)}m ${pad(sec)}s`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

export function fmtClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtCountdown(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

/** Full-jitter-ish delay: between 50% and 100% of the nominal delay. */
export function withJitter(ms: number): number {
  return Math.floor(ms * (0.5 + Math.random() * 0.5));
}

export function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…";
}

/** Parse `HH:MM` into the next occurrence of that wall-clock time. */
export function nextWallClock(hhmm: string, now = new Date()): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new ArgusError(`无法解析时间 "${hhmm}"，期望格式 HH:MM，例如 07:00`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new ArgusError(`时间 "${hhmm}" 超出范围`);
  const target = new Date(now);
  target.setHours(h, min, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target;
}

export interface ResolvedCommand {
  file: string;
  needsCmdWrap: boolean;
}

/**
 * Resolve a command name to an executable file. On Windows, npm global CLIs
 * ship as `.cmd` shims which Node refuses to spawn directly (EINVAL), so we
 * rank candidates: .cmd/.bat (wrapped with cmd.exe) → .exe → anything else.
 */
export function resolveCommand(cmd: string): ResolvedCommand {
  if (pathIsFile(cmd)) {
    return { file: cmd, needsCmdWrap: /\.(cmd|bat)$/i.test(cmd) };
  }
  if (process.platform === "win32") {
    try {
      const out = execFileSync("where", [cmd], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const candidates = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const rank = (p: string) =>
        /\.(cmd|bat)$/i.test(p) ? 0 : /\.exe$/i.test(p) ? 1 : 2;
      candidates.sort((a, b) => rank(a) - rank(b));
      if (candidates[0]) {
        const file = candidates[0];
        return { file, needsCmdWrap: /\.(cmd|bat)$/i.test(file) };
      }
    } catch {
      /* fall through */
    }
  } else {
    try {
      const out = execFileSync("which", [cmd], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const file = out.trim().split(/\r?\n/)[0];
      if (file) return { file, needsCmdWrap: false };
    } catch {
      /* fall through */
    }
  }
  return { file: cmd, needsCmdWrap: false };
}

function pathIsFile(p: string): boolean {
  try {
    const stat = fsStatSync(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

import { statSync as fsStatSync } from "node:fs";

/**
 * Kill a child process and everything it spawned. Agents shell out
 * constantly, so a bare child.kill() leaves grandchildren running.
 */
export async function killTree(child: ChildProcess, graceMs = 8000): Promise<void> {
  const pid = child.pid;
  if (pid == null || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
      await Promise.race([
        new Promise<void>((resolve) => killer.on("close", () => resolve())),
        sleep(graceMs),
      ]);
    } catch {
      /* ignore */
    }
    child.kill("SIGKILL");
    return;
  }
  // POSIX: the child was spawned detached, so -pid targets its process group.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) return;
    await sleep(200);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Incremental line splitter that tolerates \n, \r\n and bare \r (spinners). */
export class LineSplitter {
  private buf = "";
  constructor(private onLine: (line: string) => void) {}
  push(chunk: string): void {
    this.buf += chunk;
    // Split on \n or a lone \r (progress spinners redraw lines with \r).
    const parts = this.buf.split(/\r\n|\n|\r/);
    this.buf = parts.pop() ?? "";
    for (const line of parts) this.onLine(line);
  }
  flush(): void {
    if (this.buf) {
      this.onLine(this.buf);
      this.buf = "";
    }
  }
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}
