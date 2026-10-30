# Changelog

## 1.2.0 (2026-10-30)

**真机验证 · 智能配额 · 安全档位 · 自动开守。**

- **真机防漂移验证**：适配器解析测试改用录制的 claude stream-json 样本 fixture；新增"CLI 装了就跑"的 `--help` 旗标校验（自动发现版本漂移）；`ARGUS_REAL_CLI=1 npm test` 可选真机探针（默认跳过不烧配额）。
- **续跑 recap**：反复卡死换新会话时，自动注入上一任进展摘要（journal 事件 + git 工作区状态 + 任务原文），新 agent 不再从零开始猜。`freshSessionRecap` 可关。
- **周配额熔断**：同一任务 120 秒内连续触顶 → 睡眠上限从 maxSleepMinutes 升到 24h → 连续 6 次直接放弃该任务并记录 `quota_giveup`，不再整晚空转。
- **并行配额雪崩告警**：过半 worker 同时进入配额休眠时告警 + webhook 通知；`argus status` 显示每个 worker 的休眠状态。
- **安全档位 allowlist**：`permissions: "allowlist"` + `claude.allowedTools` → `--allowedTools` 白名单，只放行 Read/Edit/受限 Bash 等，其余在无人值守下自动拒绝。bypass 全开不再是唯一选择。
- **`argus schedule`**：Windows 一条命令注册任务计划（schtasks + 启动器脚本，避开 /TR 引号地狱），每天定时开守、晨报进 `.argus/schedule.log`；POSIX 输出 cron 行。`--remove` / `--show` 管理。
- **配置 JSON Schema**：`argus.schema.json`，starter 配置带 `$schema` 引用，编辑器全字段补全。
- **修复**：CustomAdapter 此前只从 result 行抓 session_id，init 行的会话 id 被漏掉 → 中途崩溃后的续跑拿不到凭据、被迫每次换新会话（新测试抓出的真 bug）。
- 测试：29 → 41（39 通过 + 2 按设计跳过）。

## 1.1.0 (2026-10-30)

**并行模式：worktree 隔离的多 agent 夜班。**

- `argus run --parallel N`（或配置 `parallel.workers`，1–8）：N 个 worker 从共享任务队列领任务，各自在独立 git worktree（分支 `argus/<runId>/wN`）里工作。
- `parallel.merge: "auto"`（默认）：任务成功 → worktree 自动提交 → 勾选 TODO.md 并提交 → 合并回主分支 → worker 分支 reset 到最新主干继续领任务（ignored 文件如 node_modules 保留，无需重装依赖）。
- 合并冲突：不硬啃。`git merge --abort`，分支与 worktree 保留，`merge_conflict` 入 journal，晨报新增「待人工合并」区块（含分支名与处理指引）。
- `parallel.merge: "leave"`：全部不合并，分支留给早上人工审查。
- 前置校验：并行要求干净的 git 仓库（tracked 脏文件直接拒绝启动）、至少一次提交、git 提交身份。
- 隔离细节：配额睡眠/看门狗/退避按 worker 独立运作，互不连坐；SIGINT 一次优雅终止全部 worker；journal 事件带 `worker` 字段；`argus status` 显示每个 worker 当前任务；`run` 前置条件与错误信息全部中文人话。
- runner 改造：agent 的 cwd 抽象为 RunnerDeps.cwd（主工作区或 worker worktree），文件系统心跳跟随各 worktree。
- 测试：26 → 29。新增 3 个并行 e2e：4 任务双 worker 全合并、同文件冲突保留分支、脏工作区拒绝。

## 1.0.0 (2026-10-30)

首个版本。

- **run**：任务清单（markdown 勾选列表）或单条 prompt 模式；四道防线——输出哨兵、配额到点续跑（同会话）、API 繁忙指数退避（带抖动）、心跳看门狗（stdout + 文件系统双通道，Windows `taskkill /T` / POSIX 进程组整树清理）。
- **断点**：TODO.md 打勾即断点 + `.argus/journal-*.jsonl` 全量事件流水；失败任务不打勾，下次自动接续。
- **收工**：`--until` / `--max-hours` / `--max-cost` / `--max-restarts` 任一满足安全收工；`--wrap-up` 收尾指令。
- **适配器**：claude（stream-json，session/cost/结果捕获）、codex（exec --json）、custom（任意 CLI，`{sessionId}` 模板续跑，claude 风格 result 行自动记账）。
- **周边**：`doctor`（含 `--probe` 真实调用验证）、`status --follow`、`report`、`init`、Slack/Discord/飞书 webhook 通知、晨报（任务结果/看门狗记录/配额等待/今夜提交/遗留任务）。
- 测试：26 个（单元 + fake-agent 端到端，覆盖配额、卡死、崩溃、永久失败、dry-run）。
