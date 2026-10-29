import fs from "node:fs";
import path from "node:path";
import { fmtClock, truncate } from "./util.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "event";

const LEVEL_TAG: Record<LogLevel, string> = {
  debug: "·",
  info: "▸",
  warn: "⚠",
  error: "✗",
  event: "◆",
};

/**
 * Console + file logger with an optional single-line live status bar.
 * The status bar is redrawn in place on TTYs; log lines always win: the bar
 * is cleared before a line is written and redrawn after it.
 */
export class Logger {
  private statusText: string | null = null;
  private fd: number | null = null;
  private isTty = Boolean(process.stdout.isTTY);
  private columns = process.stdout.columns ?? 100;
  verbose = false;

  constructor(private fileLogPath?: string | null) {
    if (fileLogPath) {
      try {
        fs.mkdirSync(path.dirname(fileLogPath), { recursive: true });
        this.fd = fs.openSync(fileLogPath, "a");
      } catch {
        this.fd = null;
      }
    }
    const onResize = () => {
      this.columns = process.stdout.columns ?? 100;
    };
    process.stdout.on?.("resize", onResize);
  }

  setStatus(text: string | null): void {
    this.statusText = text;
    this.renderStatus();
  }

  private renderStatus(): void {
    if (!this.isTty) return;
    if (this.statusText == null) return;
    const line = ` ${this.statusText}`;
    process.stdout.write(`\r\x1b[K${truncate(line, this.columns - 1)}`);
  }

  private clearStatus(): void {
    if (this.isTty && this.statusText != null) {
      process.stdout.write("\r\x1b[K");
    }
  }

  log(level: LogLevel, msg: string): void {
    const line = `${fmtClock(new Date())} ${LEVEL_TAG[level]} ${msg}`;
    if (level === "debug" && !this.verbose) {
      this.mirror(line);
      return;
    }
    this.clearStatus();
    process.stdout.write(line + "\n");
    this.mirror(line);
    this.renderStatus();
  }

  /** Echo raw agent output when --verbose is set. */
  raw(line: string): void {
    this.mirror(`      │ ${line}`);
    if (this.verbose) {
      this.clearStatus();
      process.stdout.write(`      │ ${truncate(line, this.columns - 4)}\n`);
      this.renderStatus();
    }
  }

  info(msg: string): void {
    this.log("info", msg);
  }
  warn(msg: string): void {
    this.log("warn", msg);
  }
  error(msg: string): void {
    this.log("error", msg);
  }
  event(msg: string): void {
    this.log("event", msg);
  }
  debug(msg: string): void {
    this.log("debug", msg);
  }

  private mirror(line: string): void {
    if (this.fd == null) return;
    try {
      fs.writeSync(this.fd, line + "\n");
    } catch {
      /* log file is best-effort */
    }
  }

  close(): void {
    if (this.fd != null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
    this.setStatus(null);
  }
}
