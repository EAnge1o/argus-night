import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTaskList, remainingTasks, markTaskLine, sampleTaskFile } from "../src/tasks.js";
import { stripJsonComments, parseConfigText, loadConfig, validateConfig } from "../src/config.js";

test("tasks: 解析各种勾选列表写法", () => {
  const md = [
    "# 清单",
    "- [ ] 任务A",
    "* [x] 任务B",
    "+ [ ] 任务C",
    "1. [X] 任务D",
    "10. [ ] 任务E",
    "- 普通列表项不算任务",
    "  - [ ] 缩进任务F",
  ].join("\n");
  const items = parseTaskList(md);
  assert.equal(items.length, 6);
  assert.deepEqual(items.map((i) => i.done), [false, true, false, true, false, false]);
  assert.equal(remainingTasks(md).length, 4);
});

test("tasks: markTaskLine 精准打勾且不动别行", () => {
  const md = "- [ ] 甲\n- [ ] 乙\n- [ ] 丙";
  const items = parseTaskList(md);
  const after = markTaskLine(md, items[1].line, "x");
  assert.equal(after, "- [ ] 甲\n- [x] 乙\n- [ ] 丙");
});

test("tasks: 样例清单可直接解析", () => {
  const items = remainingTasks(sampleTaskFile());
  assert.ok(items.length >= 3);
});

test("config: JSONC 注释与尾逗号、字符串里的注释符", () => {
  const stripped = stripJsonComments(`{
    // 行注释
    "a": "http://x//not-a-comment", /* 块注释 */
    "b": [1, 2,],
  }`);
  const parsed = JSON.parse(stripped);
  assert.equal(parsed.a, "http://x//not-a-comment");
  assert.deepEqual(parsed.b, [1, 2]);
});

test("config: 解析 + 默认值合并 + 校验", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argus-cfg-"));
  fs.writeFileSync(
    path.join(dir, "argus.config.jsonc"),
    `{ "agent": "codex", "idleTimeoutMinutes": 20, }`,
  );
  const { config } = loadConfig(dir);
  assert.equal(config.agent, "codex");
  assert.equal(config.idleTimeoutMinutes, 20);
  assert.equal(config.backoff.baseSeconds, 30); // 默认值保留
  assert.equal(config.taskFile, "TODO.md");
});

test("config: 非法值给出人话错误", () => {
  assert.throws(() => validateConfig({ ...loadConfigNoFile(), agent: "gpt4" } as never), /agent/);
  assert.throws(() => validateConfig({ ...loadConfigNoFile(), stop: { ...loadConfigNoFile().stop, until: "7点" } } as never), /until/);
});

function loadConfigNoFile() {
  const { config } = loadConfig(process.cwd());
  return config;
}

test("config: parseConfigText 拒绝非对象", () => {
  assert.throws(() => parseConfigText("[1,2]", "x.jsonc"), /对象/);
});
