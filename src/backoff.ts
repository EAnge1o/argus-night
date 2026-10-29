import { withJitter } from "./util.js";

/**
 * Exponential backoff with jitter for API-busy and crash restarts.
 * Success resets the streak; every failure doubles the delay up to max.
 */
export class Backoff {
  private failures = 0;

  constructor(
    private baseMs: number,
    private maxMs: number,
    private factor = 2,
  ) {}

  recordFailure(): number {
    this.failures += 1;
    return this.nextDelay();
  }

  nextDelay(): number {
    const exponent = Math.max(0, this.failures - 1);
    const nominal = Math.min(this.maxMs, this.baseMs * Math.pow(this.factor, exponent));
    return Math.floor(withJitter(nominal));
  }

  recordSuccess(): void {
    this.failures = 0;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
}

/** Heartbeat tracker: pokes from stdout/fs activity, checks for hangs. */
export class HeartbeatWatchdog {
  private lastActivity: number;

  constructor(
    private idleMs: number,
    private now: () => number = Date.now,
  ) {
    this.lastActivity = now();
  }

  poke(): void {
    this.lastActivity = this.now();
  }

  check(): "ok" | "hung" {
    return this.now() - this.lastActivity >= this.idleMs ? "hung" : "ok";
  }

  get msSinceActivity(): number {
    return this.now() - this.lastActivity;
  }
}
