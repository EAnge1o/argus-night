import { test } from "node:test";
import assert from "node:assert/strict";
import { Backoff, HeartbeatWatchdog } from "../src/backoff.js";

test("Backoff: 指数增长、封顶、带抖动", () => {
  const b = new Backoff(1000, 10_000, 2);
  const d1 = b.recordFailure(); // 1s × jitter(0.5–1)
  assert.ok(d1 >= 500 && d1 <= 1000, `d1=${d1}`);
  const d2 = b.recordFailure(); // 2s
  assert.ok(d2 >= 1000 && d2 <= 2000, `d2=${d2}`);
  b.recordFailure();
  b.recordFailure();
  b.recordFailure();
  const dcap = b.recordFailure(); // 名义 16s→ 封顶 10s
  assert.ok(dcap >= 5000 && dcap <= 10_000, `dcap=${dcap}`);
});

test("Backoff: 成功重置连败计数", () => {
  const b = new Backoff(1000, 8000, 2);
  b.recordFailure();
  b.recordFailure();
  assert.equal(b.consecutiveFailures, 2);
  b.recordSuccess();
  assert.equal(b.consecutiveFailures, 0);
  const d = b.recordFailure();
  assert.ok(d >= 500 && d <= 1000);
});

test("HeartbeatWatchdog: poke 续命、超时报 hung", () => {
  let now = 0;
  const wd = new HeartbeatWatchdog(10_000, () => now);
  assert.equal(wd.check(), "ok");
  now = 9_999;
  assert.equal(wd.check(), "ok");
  now = 10_000;
  assert.equal(wd.check(), "hung");
  wd.poke(); // now 仍是 10_000
  assert.equal(wd.check(), "ok");
  now = 20_000;
  assert.equal(wd.check(), "hung");
});
