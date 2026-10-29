/**
 * Output sentinel: classify raw agent output into actionable signals and
 * parse quota-reset hints ("resets at 3am", "try again in 2h 15m", "4:32").
 */
export type SignalType =
  | "quota" // subscription usage limit (5h window / weekly) → sleep until reset
  | "api_busy" // 429/529/overloaded/5xx → exponential backoff then resume
  | "session_lost" // resume target vanished → force a fresh session
  | "config_error" // unknown flag / command not found → abort, user must fix
  | "none";

export interface Signal {
  type: SignalType;
  matched: string;
}

export type ResetHint =
  | { kind: "relative"; seconds: number }
  | { kind: "clock"; date: Date };

const QUOTA_RE =
  /(usage limit|weekly limit|5-hour limit|limit (?:has been )?reached|reach(?:ed)? your (?:\w+ )?limit|upgrade to (?:pro|max|continue)|awaiting reset)/i;

const API_BUSY_RE =
  /(overloaded_error|\boverloaded\b|\b429\b|\b529\b|\b503\b|\b502\b|\bbad gateway\b|service unavailable|too many requests|rate.?limit.{0,20}(?:error|exceeded)|temporar(?:ily|y) (?:unavailable|busy)|econnreset|socket hang up|fetch failed|internal server error|api error(?:\d+)?)/i;

const SESSION_LOST_RE =
  /(no conversation found|session (?:not found|expired|no longer exists)|no session found|resume (?:failed|target).{0,30}not found)/i;

const CONFIG_ERROR_RE =
  /(unknown (?:option|command|argument)|unrecognized (?:option|argument)|invalid (?:option|flag|argument)|is not recognized as (?:an internal|a command)|command not found|enoent|cannot find module)/i;

export function classify(text: string, extraQuotaPatterns: string[] = []): Signal {
  for (const p of extraQuotaPatterns) {
    try {
      const m = new RegExp(p, "i").exec(text);
      if (m) return { type: "quota", matched: m[0] };
    } catch {
      /* validated at config load; ignore here */
    }
  }
  let m = CONFIG_ERROR_RE.exec(text);
  if (m) return { type: "config_error", matched: m[0] };
  m = QUOTA_RE.exec(text);
  if (m) return { type: "quota", matched: m[0] };
  m = API_BUSY_RE.exec(text);
  if (m) return { type: "api_busy", matched: m[0] };
  m = SESSION_LOST_RE.exec(text);
  if (m) return { type: "session_lost", matched: m[0] };
  return { type: "none", matched: "" };
}

const REL_UNIT_RE = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minutes|s|sec|secs|seconds)/gi;
const CLOCK_AFTER_HINT_RE =
  /(?:resets?|reset|try again|available again|resets at)\s*(?:at|in|by|after)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
const COLON_DURATION_RE = /(\d{1,2}):(\d{2})\s*(?:h|hr|hours?)?/i;

function unitSeconds(unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("h")) return 3600;
  if (u.startsWith("m")) return 60;
  return 1;
}

/** Parse "1h 20m", "45 minutes", "90s" … into seconds; null if nothing found. */
export function parseRelativeDuration(text: string): number | null {
  let total = 0;
  let found = false;
  for (const m of text.matchAll(REL_UNIT_RE)) {
    total += Number(m[1]) * unitSeconds(m[2]);
    found = true;
  }
  return found ? Math.round(total) : null;
}

/**
 * Find a quota-reset hint in a line of agent output. Preference order:
 * relative duration ("resets in 4h 12m") > h:mm duration ("in 4:32") >
 * wall clock ("resets at 3am", "resets at 15:00").
 */
export function parseResetHint(
  text: string,
  now: Date = new Date(),
): ResetHint | null {
  const lowerHint = text.toLowerCase();
  const idx = lowerHint.search(/reset|try again|available again/);
  const window = idx >= 0 ? text.slice(idx, idx + 120) : text;

  // 1) explicit relative duration near the hint
  const rel = parseRelativeDuration(window);
  if (rel != null && rel > 0 && rel < 14 * 24 * 3600) {
    return { kind: "relative", seconds: rel };
  }

  // 2) h:mm as a duration ("try again in 4:32")
  const colon = COLON_DURATION_RE.exec(window);
  if (colon && window.toLowerCase().includes("in ")) {
    const seconds = Number(colon[1]) * 3600 + Number(colon[2]) * 60;
    if (seconds > 0 && seconds < 24 * 3600) {
      return { kind: "relative", seconds };
    }
  }

  // 3) wall clock ("resets at 3am", "resets at 15:00", "try again at 7")
  const clock = CLOCK_AFTER_HINT_RE.exec(window);
  if (clock) {
    let hour = Number(clock[1]);
    const min = clock[2] ? Number(clock[2]) : 0;
    const ampm = clock[3]?.toLowerCase();
    if (hour >= 1 && hour <= 23 && min <= 59) {
      if (ampm === "pm" && hour < 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;
      const date = new Date(now);
      date.setHours(hour, min, 0, 0);
      if (date.getTime() <= now.getTime() - 60_000) {
        // Reset time already passed: assume next day (weekly limits aside).
        date.setDate(date.getDate() + 1);
      }
      return { kind: "clock", date };
    }
  }

  // 4) a bare relative duration anywhere ("5-hour limit", "2 hours")
  const relAnywhere = parseRelativeDuration(text);
  if (relAnywhere != null && relAnywhere >= 5 * 60) {
    return { kind: "relative", seconds: relAnywhere };
  }
  return null;
}

/** Resolve a hint to an absolute wake-up Date, clamped by maxSleepMs. */
export function resolveWakeTime(
  hint: ResetHint | null,
  maxSleepMs: number,
  now: Date = new Date(),
): Date {
  const fallback = new Date(now.getTime() + Math.min(5 * 3600_000, maxSleepMs));
  if (!hint) return fallback;
  const target =
    hint.kind === "relative"
      ? new Date(now.getTime() + hint.seconds * 1000)
      : hint.date;
  const capped = new Date(
    Math.min(target.getTime(), now.getTime() + maxSleepMs),
  );
  return capped;
}
