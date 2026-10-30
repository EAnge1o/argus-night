import { test } from "node:test";
import assert from "node:assert/strict";
import { majorityQuotaSleeping } from "../src/commands/run.js";

test("parallel: 配额雪崩判定 — ≥半数 worker 休眠即告警", () => {
  const mk = (n: number, sleeping: number) =>
    Array.from({ length: n }, (_, i) => ({ sleeping: i < sleeping ? "quota" : undefined }));

  // 单 worker 模式不告警
  assert.equal(majorityQuotaSleeping(mk(1, 1), 1), false);
  // 2 个 worker：1 个睡 = 一半，告警
  assert.equal(majorityQuotaSleeping(mk(2, 1), 2), true);
  // 3 个 worker：1 个睡不够，2 个睡才够
  assert.equal(majorityQuotaSleeping(mk(3, 1), 3), false);
  assert.equal(majorityQuotaSleeping(mk(3, 2), 3), true);
  // 4 个 worker：半数即告警
  assert.equal(majorityQuotaSleeping(mk(4, 2), 4), true);
  // 都醒着
  assert.equal(majorityQuotaSleeping(mk(4, 0), 4), false);
});
