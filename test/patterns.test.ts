import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, parseResetHint, resolveWakeTime, parseRelativeDuration } from "../src/patterns.js";

test("classify: 订阅配额 → quota", () => {
  assert.equal(classify("Claude AI usage limit reached. Your limit will reset at 3pm.").type, "quota");
  assert.equal(classify("You have hit your weekly limit").type, "quota");
  assert.equal(classify("5-hour limit reached ∙ resets at 2:00 PM").type, "quota");
});

test("classify: API 繁忙 → api_busy", () => {
  assert.equal(classify("API Error: 429 too many requests").type, "api_busy");
  assert.equal(classify("overloaded_error from upstream").type, "api_busy");
  assert.equal(classify("503 service unavailable").type, "api_busy");
});

test("classify: 配置错误与普通输出", () => {
  assert.equal(classify("error: unknown option '--stream'").type, "config_error");
  assert.equal(classify("step 3 done, all tests pass").type, "none");
});

test("parseRelativeDuration: 中英文常见写法", () => {
  assert.equal(parseRelativeDuration("resets in 2h 15m"), 2 * 3600 + 15 * 60);
  assert.equal(parseRelativeDuration("try again in 90 minutes"), 90 * 60);
  assert.equal(parseRelativeDuration("wait 30s"), 30);
  assert.equal(parseRelativeDuration("no duration here"), null);
});

test("parseResetHint: 相对时长优先", () => {
  const hint = parseResetHint("usage limit reached, resets in 2h 15m");
  assert.deepEqual(hint, { kind: "relative", seconds: 8100 });
});

test("parseResetHint: h:mm 时长", () => {
  const hint = parseResetHint("try again in 4:32");
  assert.deepEqual(hint, { kind: "relative", seconds: 4 * 3600 + 32 * 60 });
});

test("parseResetHint: 绝对时钟 am/pm", () => {
  const now = new Date("2026-10-30T20:00:00");
  const hint = parseResetHint("resets at 3am", now);
  assert.equal(hint?.kind, "clock");
  if (hint?.kind === "clock") {
    assert.equal(hint.date.getHours(), 3);
    assert.equal(hint.date.getDate(), 31); // 已过当天 3 点 → 次日
  }
});

test("parseResetHint: 无提示返回 null", () => {
  assert.equal(parseResetHint("all good here"), null);
});

test("resolveWakeTime: 用 maxSleep 封顶", () => {
  const now = new Date("2026-10-30T23:00:00");
  const wake = resolveWakeTime({ kind: "relative", seconds: 10 * 3600 }, 3600_000, now);
  assert.equal(wake.getTime() - now.getTime(), 3600_000);
});

test("resolveWakeTime: 无提示时回退 5 小时并封顶", () => {
  const now = new Date("2026-10-30T23:00:00");
  const wake = resolveWakeTime(null, 600_000, now);
  assert.equal(wake.getTime() - now.getTime(), 600_000);
});
