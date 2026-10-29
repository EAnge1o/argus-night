# Changelog

## 1.0.0 (2026-10-30)

首个版本。

- **run**：任务清单（markdown 勾选列表）或单条 prompt 模式；四道防线——输出哨兵、配额到点续跑（同会话）、API 繁忙指数退避（带抖动）、心跳看门狗（stdout + 文件系统双通道，Windows `taskkill /T` / POSIX 进程组整树清理）。
- **断点**：TODO.md 打勾即断点 + `.argus/journal-*.jsonl` 全量事件流水；失败任务不打勾，下次自动接续。
- **收工**：`--until` / `--max-hours` / `--max-cost` / `--max-restarts` 任一满足安全收工；`--wrap-up` 收尾指令。
- **适配器**：claude（stream-json，session/cost/结果捕获）、codex（exec --json）、custom（任意 CLI，`{sessionId}` 模板续跑，claude 风格 result 行自动记账）。
- **周边**：`doctor`（含 `--probe` 真实调用验证）、`status --follow`、`report`、`init`、Slack/Discord/飞书 webhook 通知、晨报（任务结果/看门狗记录/配额等待/今夜提交/遗留任务）。
- 测试：26 个（单元 + fake-agent 端到端，覆盖配额、卡死、崩溃、永久失败、dry-run）。
