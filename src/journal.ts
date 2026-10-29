import fs from "node:fs";
import path from "node:path";

export interface JournalEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}

export interface TaskState {
  status: "pending" | "running" | "done" | "failed" | "skipped";
  attempts: number;
  quotaPauses: number;
  apiPauses: number;
  hangKills: number;
  sessionId: string | null;
  costUsd: number;
  lastError: string | null;
}

export interface ArgusState {
  version: 1;
  runId: string;
  startedAt: string;
  pid: number;
  phase: string;
  tasks: Record<string, TaskState>;
  totals: { costUsd: number; restarts: number; quotaSleepMs: number; hangKills: number };
}

function emptyState(runId: string): ArgusState {
  return {
    version: 1,
    runId,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    phase: "starting",
    tasks: {},
    totals: { costUsd: 0, restarts: 0, quotaSleepMs: 0, hangKills: 0 },
  };
}

/**
 * Append-only journal (.jsonl) + mutable state.json + status.json.
 * The journal is the source of truth for the morning report; state.json is
 * what makes session resume across watchdog kills possible.
 */
export class Journal {
  readonly runId: string;
  readonly dir: string;
  readonly journalPath: string;
  private statePath: string;
  private statusPath: string;
  private state: ArgusState;
  private statusExtra: Record<string, unknown> = {};

  constructor(root: string, runId: string) {
    this.runId = runId;
    this.dir = path.join(root, ".argus");
    const logsDir = path.join(this.dir, "logs");
    const reportsDir = path.join(this.dir, "reports");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(reportsDir, { recursive: true });
    this.journalPath = path.join(this.dir, `journal-${runId}.jsonl`);
    this.statePath = path.join(this.dir, "state.json");
    this.statusPath = path.join(this.dir, "status.json");
    // Adopt prior state if it belongs to a resumed run, else fresh.
    this.state = emptyState(runId);
    this.append("run_start", { runId, pid: process.pid, cwd: root });
  }

  static latestJournal(root: string): string | null {
    const dir = path.join(root, ".argus");
    if (!fs.existsSync(dir)) return null;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("journal-") && f.endsWith(".jsonl"))
      .sort();
    const last = files[files.length - 1];
    return last ? path.join(dir, last) : null;
  }

  append(type: string, fields: Record<string, unknown> = {}): JournalEvent {
    const ev: JournalEvent = { ts: new Date().toISOString(), type, ...fields };
    fs.appendFileSync(this.journalPath, JSON.stringify(ev) + "\n");
    return ev;
  }

  events(): JournalEvent[] {
    if (!fs.existsSync(this.journalPath)) return [];
    const lines = fs.readFileSync(this.journalPath, "utf8").split("\n").filter(Boolean);
    const out: JournalEvent[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip torn line */
      }
    }
    return out;
  }

  taskState(text: string): TaskState {
    if (!this.state.tasks[text]) {
      this.state.tasks[text] = {
        status: "pending",
        attempts: 0,
        quotaPauses: 0,
        apiPauses: 0,
        hangKills: 0,
        sessionId: null,
        costUsd: 0,
        lastError: null,
      };
    }
    return this.state.tasks[text];
  }

  allTaskStates(): Record<string, TaskState> {
    return this.state.tasks;
  }

  updateTask(text: string, patch: Partial<TaskState>): void {
    const st = this.taskState(text);
    Object.assign(st, patch);
    this.saveState();
  }

  addCost(usd: number): void {
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.state.totals.costUsd += usd;
    this.saveState();
  }

  bumpRestarts(): void {
    this.state.totals.restarts += 1;
    this.saveState();
  }

  addQuotaSleep(ms: number): void {
    this.state.totals.quotaSleepMs += ms;
    this.saveState();
  }

  addHangKill(): void {
    this.state.totals.hangKills += 1;
    this.saveState();
  }

  setPhase(phase: string): void {
    this.state.phase = phase;
    this.saveState();
  }

  setStatusExtra(extra: Record<string, unknown>): void {
    this.statusExtra = extra;
    this.writeStatusFile();
  }

  private saveState(): void {
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch {
      /* best effort */
    }
    this.writeStatusFile();
  }

  private writeStatusFile(): void {
    try {
      const status = {
        runId: this.state.runId,
        pid: this.state.pid,
        phase: this.state.phase,
        updatedAt: new Date().toISOString(),
        totals: this.state.totals,
        currentTask: this.currentTaskText,
        ...this.statusExtra,
      };
      fs.writeFileSync(this.statusPath, JSON.stringify(status, null, 2));
    } catch {
      /* best effort */
    }
  }

  private currentTaskText: string | null = null;

  setCurrentTask(text: string | null): void {
    this.currentTaskText = text;
    this.writeStatusFile();
  }

  finish(): void {
    this.append("run_end", { totals: this.state.totals });
    this.setPhase("ended");
  }

  get totals(): ArgusState["totals"] {
    return this.state.totals;
  }
}
