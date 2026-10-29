# Argus 架构

## 模块图

```
cli.ts ──命令分发──▶ commands/run.ts（编排器）
                        │
        ┌───────────────┼────────────────────────┐
        ▼               ▼                        ▼
   Journal          AgentRunner ──────────── Notifier
 (.argus/*.jsonl)        │                 (webhook)
        ▲                │
        │           ┌────┴─────┬──────────────┐
        │           ▼          ▼              ▼
   tasks.ts     adapters/    patterns.ts   backoff.ts
 (清单断点)      claude       (哨兵分类)     (退避+看门狗)
                 codex
                 custom
```

## 一次任务尝试的状态机

```
runTask(task)
  └─ 循环（每次 = 一个 agent 进程的生命周期）
       spawn ──▶ 流式输出
                   │  每行 → LineSplitter → classify() + adapter.parseLine()
                   │  心跳: stdout 字节 / fs.watch 活动 → HeartbeatWatchdog.poke()
                   ▼
       进程退出 ──▶ 分派：
         config_error        → 立即放弃该任务（用户必须修参数）
         quota (usage limit) → sleepUntil(重置点) → resume 同会话 → 下一轮
         api_busy (429/529)  → backoff.recordFailure() → 睡 → resume → 下一轮
         watchdog hung       → killTree（整树）→ 原会话续跑 ×hang.resumeTries
                              → 全新会话 ×hang.freshTries → 放弃
         exit 0 + result.ok  → ✅ success（session/cost 入账）
         其他 exit ≠ 0       → 崩溃退避 → resume；连败超限 → 放弃
```

## 关键设计决策

1. **零运行时依赖**。CLI 是 npx 即用的基础设施，供应链要短。全部用 Node 标准库（child_process / fs.watch / fetch / node:test）。代价是没有 TUI 库，用自绘单行状态栏 + `.argus/status.json` 支持跨终端 `argus status --follow` 替代。

2. **提示词走 stdin**。Windows 上 npm 全局 CLI 是 `.cmd`，必须用 `cmd /c` 包一层，而 `cmd.exe` 对含空格/引号参数的转义是重灾区。Argus 把 prompt 全部写进 stdin（claude 原生支持、custom 可配置），argv 里只有纯 flag token，从根上消灭引号问题。

3. **心跳双通道**。纯 stdout 心跳会在 agent 长时间思考时误杀，纯 fs 心跳抓不到"读了很多但没写"的阶段。默认两个都开：claude 适配器加 `--include-partial-messages` 让思考期也有流式字节；fs.watch 捕捉工具调用落盘。任一通道有信号就续命。

4. **journal 是唯一事实源**。晨报不是运行时攒的内存对象，而是从 `.argus/journal-<runid>.jsonl` 重放出来的——进程被硬杀也能出报告。state.json 存每任务的 sessionId（跨看门狗重启的续跑凭据）和累计成本；status.json 是给 `argus status` 读的投影。

5. **配额等待不越过收工点**。订阅配额重置可能在上午 10 点，而 `--until 07:00` 是硬约束：sleepUntil 每秒醒来检查 stopAt，越界即提前唤醒并进入收尾流程，任务保持未勾选留给下次。

6. **失败分级**：config_error（参数不认识）是用户错误，立即中止不烧钱；quota 是正常节奏，睡；api_busy 是暂态，退避；hang 是进程病，杀；task fail 是业务病，按 `onTaskFail` 策略跳过/重试/中止。四种病四种药，不会用重试去修配置错误。

## 并行模式的状态机（v1.1.0）

```
runParallel
  ├─ assertParallelReady(): 干净仓库 + 有提交 + git 身份，否则拒绝启动
  ├─ create() × N: git worktree add -b argus/<runId>/wN  (基于当前 HEAD)
  └─ N × workerLoop（async 并发，单进程内共享 queue/journal/stop 条件）
       循环:
         stopChecks() → 中断/收工点/花费/重启上限 → 退出
         queue.shift() 领任务 → journal.task_claim {worker}
         runTask(task)  ← 同顺序状态机，cwd = worktree
         成功:
           commitWork(wt)            worktree 内提交 agent 产出
           markTodoDone + commitCheckpoints(主区)   勾选并提交，保证 merge 时主区干净
           mergeToMain(wt)           merge 成功 → wt 分支 reset --hard 主分支尖端
                                     （node_modules 等 ignored 文件原地保留）
                                     冲突 → merge --abort，分支/worktree 保留 → merge_conflict
       收尾: cleanupAll → 已合并的 worktree 移除 + 分支 -d；未合并的全部保留待人工
```

设计要点：
- **worktree 不随任务销毁**，合并成功后 reset 到新主干复用——真实项目里重装 node_modules 是不可接受的。
- **勾选先于合并**：TODO.md 的 checkbox 修改先在主区提交，否则 merge 会撞上脏工作区。
- JS 单线程保证了共享队列与 TODO.md 标记没有真并发；agent 进程是真并发，靠 worktree 隔离。
- `merge: "leave"` 时跳过全部合并步骤，worker 只干活，分支留给早上。

## Windows 专项

- `resolveCommand()`：`where` 全量候选按 `.cmd/.bat > .exe > 其他` 排序，避开 npm 生产的 sh 脚本 shim。
- killTree：`taskkill /pid X /T /F`；POSIX 用 `detached: true` + `process.kill(-pgid)`。
- 所有测试在本机 Windows（Git Bash + Node 24）上通过，包括整树清理的孤儿进程断言。
