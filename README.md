<div align="center">

[![CI](https://github.com/EAnge1o/argus-night/actions/workflows/ci.yml/badge.svg)](https://github.com/EAnge1o/argus-night/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.17-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![zero dependencies](https://img.shields.io/badge/runtime%20deps-0-orange)](package.json)

# 🌙 Argus — coding agent 守夜人

**整晚无人值守地驱动 Claude Code / Codex 等编码 agent：
配额到点自动续跑 · 指数退避抗击 API 繁忙 · 心跳看门狗清理卡死进程 · 天亮交一份晨报。**

*Zero runtime dependencies · Node ≥ 18 · Windows / macOS / Linux*

</div>

---

## English TL;DR

Argus is a night watchman for coding-agent CLIs. You give it a markdown checklist (or a single prompt); it runs your agent (Claude Code, Codex, or any custom CLI) task by task until dawn. When the agent hits a subscription usage limit, Argus sleeps until the reset time and resumes the *same session*. When the API is busy (429/529/overload), it backs off exponentially. When the agent hangs, a heartbeat watchdog (stdout + filesystem activity) kills the whole process tree and restarts with session resume. You wake up to a morning report: what was done, what crashed, how long it napped, what it cost.

```bash
npx argus-night init      # scaffold config + TODO.md
npx argus-night doctor    # pre-flight check
npx argus-night run --until 07:00 --wrap-up
```

---

## 为什么需要 Argus

把 coding agent 放一整夜，真正会杀死它的只有四件事——而现有开源方案各管一段，没有一个高星项目把三件事以上做全（我们核对过 Ralph 循环器、claude-auto-resume、unsnooze、Claude Squad、vibe-kanban、LiteLLM、claude-code-router 的实际机制）：

| 方案 | API 繁忙退避 | 超时看门狗 | 会话续跑 | 任务断点 |
|---|---|---|---|---|
| Ralph 风格 Bash 循环 | ✗（固定间隔） | ✗ | 部分（git 当断点） | 部分 |
| claude-auto-resume / unsnooze | ✗（仅定时等待） | ✗ | ✓ | ✗ |
| Claude Squad / vibe-kanban / happy | ✗ | 部分（不自动处置） | 部分 | 部分 |
| LiteLLM / claude-code-router 网关 | ✓ | ✗（仅请求级） | ✗ | ✗ |
| **Argus** | **✓ 指数退避 + 抖动** | **✓ 双通道心跳 + 整树清理** | **✓ 配额到点续跑同会话** | **✓ 清单打勾 + journal** |

Argus 的设计立场：**不重造网关**（LiteLLM / claude-code-router 依然可以叠在前面用），而是把网关管不到的三层补齐——进程层、会话层、任务层。

## 30 秒上手

```bash
# 1. 在你的项目目录里生成配置和任务清单
npx argus-night init

# 2. 编辑 TODO.md，把今晚的活写成可独立验证的小步
#    每完成一条 argus 会自动打勾，失败的不打勾留给下次

# 3. 守夜前体检（检查 CLI、git、配置、看门狗参数）
npx argus-night doctor          # 加 --probe 会真实调用一次 agent 验证参数

# 4. 预演：只打印将要执行的命令，不启动 agent
npx argus-night run --dry-run

# 5. 开守。干到早上 7 点，收工前让 agent 提交代码写总结
npx argus-night run --until 07:00 --wrap-up
```

单条任务模式（不走清单）：

```bash
npx argus-night run --prompt "把 src 下所有 any 类型修掉并跑通测试" --max-cost 10
```

## 四道防线（工作原理）

```
┌────────────────────────── argus run ──────────────────────────┐
│                                                               │
│   TODO.md ──逐条──▶ AgentRunner ──spawn──▶ claude / codex /…  │
│        ▲                  │  ▲                │               │
│        │打勾               │  │心跳(stdout+fs) │stdin 提示词    │
│        │                  ▼  │                ▼               │
│   [x] done            ① 哨兵 Sentinel ──── 输出逐行分类        │
│   [ ] failed                │    │    │                      │
│                     配额quota │    │ 429/529                │
│                             ▼    │    ▼                      │
│                    ② 睡到重置点  │ ③ 指数退避 30s→30min       │
│                    同会话续跑 ◀──┘    │                        │
│                                      ▼                        │
│              ④ 看门狗：N 分钟无活动 → taskkill /T 整树清理      │
│                     → 原会话续跑 2 次 → 全新会话 2 次 → 放弃    │
│                                                               │
│   收工：到点 / 超时 / 花费上限 / 重启上限                        │
│        → （可选）wrap-up 收尾指令 → 晨报 .argus/reports/        │
└───────────────────────────────────────────────────────────────┘
```

**① 哨兵（sentinel）**：逐行分类 agent 输出。`usage limit / weekly limit / 5-hour limit` → 配额；`429 / 529 / overloaded / 503` → API 繁忙；`no conversation found` → 会话丢失；`unknown option` → 配置错误（立即中止并提示，避免整晚空转）。`quota.extraPatterns` 可加自己的正则。

**② 配额续跑**：从输出里解析重置时间——`resets in 2h 15m`、`try again in 4:32`、`resets at 3am` 都认；解析不出就按 5 小时窗兜底。睡到点后**带原会话续跑**（claude `--resume <id>`，codex `exec resume --last`），上下文一点不丢。睡的时间不会越过收工点。

**③ 指数退避**：API 繁忙 / 崩溃从 30s 起步翻倍到 30min 封顶，带 50%–100% 随机抖动防雪崩；任务成功即重置。连续崩溃超限自动放弃该任务。

**④ 看门狗**：两条心跳通道——stdout 任何字节 + 仓库文件系统活动（agent 在写文件当然算活着）。`idleTimeoutMinutes` 无任何活动才判定卡死：Windows 用 `taskkill /T /F`、POSIX 用进程组信号，把 agent 拉起的整个子进程树清干净，然后先续原会话、再换新会话、最后放弃并记入晨报。

**断点层**：`.argus/journal-*.jsonl` 记录每一次 spawn / 杀进程 / 配额等待 / 退避 / 成本；TODO.md 本身就是断点——完成打勾、失败留白，下次 `argus run` 自动接着干。

## 命令参考

| 命令 | 作用 |
|---|---|
| `argus init [--force]` | 生成带注释的 `argus.config.jsonc` + 示例 `TODO.md` + `.gitignore` |
| `argus run [选项]` | 开始夜间值守（别名 `night`） |
| `argus status [--follow]` | 另一个终端 / SSH 里看实时状态和最近事件 |
| `argus report [--rebuild]` | 打印最近一次晨报 |
| `argus doctor [--probe]` | 守夜前体检；`--probe` 真实调用一次 agent 验证整条链路 |

`run` 常用选项：`--task <file>`、`--prompt <text>`、`--agent claude|codex|custom`、`--until HH:MM`、`--max-hours <n>`、`--max-cost <usd>`、`--max-restarts <n>`、`--idle-minutes <n>`、`--wrap-up`、`--dry-run`、`--verbose`、`--no-fs-heartbeat`。

## 配置

`argus init` 生成的 `argus.config.jsonc` 每一项都有中文注释。要点：

- **`agent`**：`claude`（默认，stream-json 捕获 session_id / 成本 / 结果）、`codex`（exec --json）、或 `custom`（任意 CLI：`command` + `args` + `resumeArgs`（支持 `{sessionId}` 占位符）+ `promptVia`）。任何输出 claude 风格 `{"type":"result"}` 的 CLI 都能自动记账。
- **收工条件**：`stop.until`（到点）、`stop.maxHours`、`stop.maxCostUsd`（claude 适配器自动累计 `total_cost_usd`）、`stop.maxRestarts`，任一满足即安全收工。
- **通知**：`notify.webhookUrl` 支持 Slack / Discord / 飞书(lark) 格式，配额休息、任务成败、晨报都会推。
- **误杀防护**：`claude.streamHeartbeat`（默认开，用 `--include-partial-messages` 拿到思考期流式心跳）；文件系统心跳兜底。两者都关时建议把 `idleTimeoutMinutes` 调到 20 以上。

## 安全须知（务必读）

- Claude 适配器默认加 `--dangerously-skip-permissions`——这是无人值守的必要条件，但也意味着 agent 可以不经确认执行任何命令。**建议在容器 / 虚拟机里跑**。
- **git 是真正的安全网**：开守前确保仓库干净。`git.autoCommit: true` 可让每个任务完成后自动提交，晨报会列出今夜全部提交。
- `--max-cost` 用真实美元计费兜底（claude 适配器）；`--until` 保证天亮一定停。
- Ctrl+C 一次优雅收尾（等当前进程退出、写晨报），两次强制退出。

## 平台支持

| | Windows | macOS | Linux |
|---|---|---|---|
| 进程树清理 | `taskkill /T /F` ✓ | 进程组信号 ✓ | 进程组信号 ✓ |
| npm 全局 CLI 定位 | 自动解析 `.cmd` ✓ | `which` ✓ | `which` ✓ |
| 文件系统心跳 | `fs.watch recursive` ✓ | ✓ | 浅层降级（stdout 心跳兜底） |
| 提示词传递 | 默认走 **stdin**，彻底绕开 `cmd.exe` 引号地狱 ✓ | ✓ | ✓ |

## 开发与测试

```bash
npm install
npm test        # 26 个测试：单元 + 端到端
```

端到端测试用 `test/fixtures/fake-agent.mjs` 模拟真实 agent 的全部死法，逐条验证：配额触发→睡眠→同会话续跑→打勾→晨报；挂死→看门狗整树清理（断言父子进程确实死亡）；429→退避→续跑；永久失败→按策略跳过不阻塞后续任务。架构细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## Roadmap

- [ ] `argus tui` 全屏仪表盘
- [ ] 多 agent 并行（每个任务一个 worktree，Claude Squad 风格）
- [ ] Codex 适配器的成本解析（codex --json 成本字段稳定后）
- [ ] 晨报推送邮件 / Telegram
- [ ] 配额日历：按历史消耗预测今晚能跑几个任务

## License

MIT
