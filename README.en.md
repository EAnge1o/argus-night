<div align="center">

[![CI](https://github.com/EAnge1o/argus-night/actions/workflows/ci.yml/badge.svg)](https://github.com/EAnge1o/argus-night/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/argus-night)](https://www.npmjs.com/package/argus-night)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.17-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![zero dependencies](https://img.shields.io/badge/runtime%20deps-0-orange)](package.json)

# 🌙 Argus — the night watchman for coding agents

**Run Claude Code / Codex (or any coding-agent CLI) unattended all night:
quota-aware session resume · exponential backoff against API busy · heartbeat watchdog that cleans up hung process trees · a morning report when you wake up.**

[中文](README.md) | English

</div>

---

## Why Argus

Four things kill an unattended overnight agent run — and existing open-source projects each cover only a slice (we verified the actual mechanisms of Ralph-style loopers, claude-auto-resume, unsnooze, Claude Squad, vibe-kanban, LiteLLM and claude-code-router):

| Approach | API-busy backoff | Timeout watchdog | Session resume | Task checkpoints |
|---|---|---|---|---|
| Ralph-style Bash loop | ✗ (fixed interval) | ✗ | partial (git as checkpoint) | partial |
| claude-auto-resume / unsnooze | ✗ (timed wait only) | ✗ | ✓ | ✗ |
| Claude Squad / vibe-kanban / happy | ✗ | partial (no auto-action) | partial | partial |
| LiteLLM / claude-code-router gateway | ✓ | ✗ (request-level only) | ✗ | ✗ |
| **Argus** | **✓ exponential + jitter** | **✓ dual-channel heartbeat + tree kill** | **✓ same-session resume at quota reset** | **✓ checklist ticks + journal** |

Argus deliberately does **not** reimplement a gateway (LiteLLM / claude-code-router stack fine in front of it). It fills the three layers gateways can't reach: the process layer, the session layer, and the task layer.

## 30-second start

```bash
npx argus-night init      # scaffold commented config + TODO.md
npx argus-night doctor    # pre-flight check (--probe does a real agent call)
npx argus-night run --until 07:00 --wrap-up
```

Single-mission mode (no checklist):

```bash
npx argus-night run --prompt "Fix every any-type in src and make tests pass" --max-cost 10
```

Schedule it to start itself every night:

```bash
npx argus-night schedule --at 23:00 --until 07:00   # Windows Task Scheduler / prints a cron line
```

## The four defenses

1. **Sentinel** — every output line is classified. `usage limit / weekly limit / 5-hour limit` → quota; `429 / 529 / overloaded / 503` → API busy; `no conversation found` → session lost; `unknown option` → config error (abort immediately instead of burning the night). Add your own via `quota.extraPatterns`.
2. **Quota-aware resume** — parses reset hints (`resets in 2h 15m`, `try again in 4:32`, `resets at 3am`; 5-hour fallback otherwise), sleeps until the reset point, then resumes the **same session** (`claude --resume <id>`, codex `exec resume --last`). The nap never crosses your `--until` deadline. Repeated immediate re-hits (weekly-limit signature) escalate the sleep cap to 24h and circuit-break after 6 consecutive hits.
3. **Exponential backoff with jitter** — API busy and crashes back off from 30s doubling to a 30min cap with 50–100% jitter; success resets the streak; a task that keeps crashing is given up before it wastes the night.
4. **Heartbeat watchdog** — two channels: any stdout byte, plus filesystem activity in the working tree. After `idleTimeoutMinutes` of total silence the process **tree** is killed (`taskkill /T /F` on Windows, process-group signals on POSIX), then: resume the same session ×2 → fresh session with an automatic **recap** (journal summary + `git status` + the task text) ×2 → give up and record it.

**Checkpoints**: `.argus/journal-*.jsonl` records every spawn, kill, quota nap, backoff and cost; TODO.md itself is the checkpoint — done items get ticked, failures stay unticked for the next run. The morning report is replayed from the journal, so even a hard-killed run produces one.

## Parallel mode (worktree isolation)

```bash
argus run --parallel 3 --until 07:00
# or "parallel": { "workers": 3, "merge": "auto" }
```

N workers pull tasks from a shared queue, each inside its **own git worktree** (branch `argus/<runId>/wN`) — they never share a working directory.

- Requires a clean git repo with ≥1 commit and a git identity (merges create merge commits).
- **Success → auto-merge**: commit in the worktree → tick TODO.md and commit → merge into the main branch → fast-forward the worker branch onto the new tip so the same worktree takes the next task (ignored files like node_modules survive, no reinstall).
- **Conflicts are not fought at 3am**: first worker's merge lands; the conflicting one keeps its branch + worktree, the report lists them for manual review in the morning.
- `merge: "leave"` skips all merging — branches are left for human review (Claude-Squad style).
- A worker napping on quota doesn't block the others; when **half or more** workers nap, an avalanche warning goes to the log and your webhook.

## Commands

| Command | What it does |
|---|---|
| `argus init [--force]` | Scaffold commented `argus.config.jsonc`, sample `TODO.md`, `.gitignore` |
| `argus run [options]` | Start the night watch (alias: `night`) |
| `argus schedule --at 23:00 [--until 07:00]` | Auto-start nightly (Windows Task Scheduler / cron line); `--remove`, `--show` |
| `argus status [--follow]` | Live status from another terminal / SSH, incl. per-worker sleep state |
| `argus report [--rebuild]` | Print the latest morning report |
| `argus doctor [--probe]` | Pre-flight check; `--probe` does one real agent call to verify the whole path |

`run` options: `--task <file>`, `--prompt <text>`, `--agent claude|codex|custom`, `--parallel 1-8`, `--until HH:MM`, `--max-hours <n>`, `--max-cost <usd>`, `--max-restarts <n>`, `--idle-minutes <n>`, `--wrap-up`, `--dry-run`, `--verbose`, `--no-fs-heartbeat`.

## Configuration

`argus init` writes a fully commented `argus.config.jsonc` (with `$schema` for editor autocompletion). Highlights:

- **`agent`**: `claude` (stream-json captures session id / cost / result), `codex` (`exec --json`), or `custom` (any CLI: `command` + `args` + `resumeArgs` with a `{sessionId}` placeholder + `promptVia`). Any CLI emitting claude-style `{"type":"result"}` lines gets cost/session tracking for free.
- **`permissions`**: `bypass` (default, unattended-friendly) · **`allowlist`** — combine with `claude.allowedTools` (e.g. `["Read","Edit","Glob","Grep","Bash(git *)","Bash(npm run test*)"]`) to allow only whitelisted tools while unattended · `acceptEdits` · `default`.
- **Stop conditions**: `stop.until` / `stop.maxHours` / `stop.maxCostUsd` (real dollars via the claude adapter) / `stop.maxRestarts` — any one ends the run safely with a report.
- **Notifications**: `notify.webhookUrl` with Slack / Discord / Lark(飞书) formats — quota naps, task results, avalanche warnings, the morning report.

## Safety notes (read this)

- The **allowlist tier** is the recommended middle ground: let the agent edit files and run tests at night without granting arbitrary-shell rights.
- The default `bypass` mode means the agent can execute anything without confirmation — prefer a container/VM for unattended runs.
- **git is the real safety net**: start with a clean repo; `git.autoCommit: true` makes a commit per task, and the report lists the night's commits.
- Ctrl+C once for a graceful wind-down (report still gets written), twice to force-quit.

## Platforms

| | Windows | macOS | Linux |
|---|---|---|---|
| Process-tree cleanup | `taskkill /T /F` ✓ | process-group signals ✓ | process-group signals ✓ |
| npm-global CLI resolution | auto-locates `.cmd` ✓ | `which` ✓ | `which` ✓ |
| Filesystem heartbeat | `fs.watch recursive` ✓ | ✓ | shallow fallback (stdout heartbeat covers) |
| Prompt delivery | **stdin** by default — sidesteps `cmd.exe` quoting entirely ✓ | ✓ | ✓ |

## Development & testing

```bash
npm install
npm test                          # 41 tests: unit + end-to-end
ARGUS_REAL_CLI=1 npm test         # also runs a real agent probe (uses a little quota)
```

E2E tests use `test/fixtures/fake-agent.mjs` to simulate every way an agent dies, verifying: quota → sleep → same-session resume → tick → report; hang → watchdog tree kill (asserting parent AND child processes are dead); 429 → backoff → resume; permanent failure → skip without blocking the queue; parallel mode → worktree isolation, auto-merge, conflict branches kept, dirty-tree rejection; recap injection; weekly-quota circuit breaker. Adapter parsing is regression-tested against recorded stream-json fixtures, and `--help` flag checks catch CLI version drift. Architecture details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Roadmap

- [x] Parallel agents (worktree isolation, auto-merge / conflict branches) — v1.1.0
- [x] allowlist safety tier · resume recap · weekly-quota breaker · `argus schedule` · config schema — v1.2.0
- [ ] `argus tui` full-screen dashboard
- [ ] Codex adapter cost parsing
- [ ] Morning report via email / Telegram
- [ ] Quota calendar: predict tonight's task capacity from historical burn

## License

MIT
