import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ArgusError, truncate } from "./util.js";

export interface Worktree {
  id: number;
  path: string;
  branch: string;
  /** Commit the worktree branched from. */
  base: string;
  /** Set by mergeToMain(); conflict leaves branch+worktree for manual review. */
  merged: boolean;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

/**
 * One git worktree per parallel worker, so agents never share a working
 * directory. Successful tasks are committed on their branch and merged back
 * into the main checkout; conflicting branches are kept for the morning.
 */
export class WorktreeManager {
  private mainBranch = "main";

  constructor(private root: string) {}

  /** Parallel mode requires: git repo, ≥1 commit, clean tracked files, git identity. */
  assertParallelReady(): void {
    try {
      git(this.root, ["rev-parse", "--is-inside-work-tree"]);
    } catch {
      throw new ArgusError("并行模式需要当前目录是 git 仓库", "先 git init，或去掉 --parallel 用顺序模式");
    }
    try {
      git(this.root, ["rev-parse", "HEAD"]);
    } catch {
      throw new ArgusError("并行模式要求仓库至少有一次提交（worktree 需要基于某个 commit）", "先 git commit 一次");
    }
    const status = git(this.root, ["status", "--porcelain"]);
    const trackedDirty = status
      .split(/\r?\n/)
      .filter(Boolean)
      .some((l) => !l.startsWith("??"));
    if (trackedDirty) {
      throw new ArgusError(
        "并行模式要求工作区干净（有未提交的修改，worker 之间会互相覆盖）",
        "先 git commit 或 git stash；未跟踪文件不受影响",
      );
    }
    try {
      this.mainBranch = git(this.root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim() || "main";
    } catch {
      this.mainBranch = "main";
    }
    let identity = "";
    try {
      identity = git(this.root, ["config", "user.email"]).trim();
    } catch {
      /* missing */
    }
    if (!identity) {
      throw new ArgusError(
        "并行模式需要 git 提交身份（自动合并会创建 merge commit）",
        "运行 git config --global user.name / user.email",
      );
    }
  }

  create(id: number, runId: string): Worktree {
    const branch = `argus/${runId}/w${id}`;
    const wtPath = path.join(this.root, ".argus", "worktrees", `w${id}`);
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    try {
      fs.rmSync(wtPath, { recursive: true, force: true });
      git(this.root, ["worktree", "prune"]);
    } catch {
      /* fresh */
    }
    const base = git(this.root, ["rev-parse", "HEAD"]).trim();
    git(this.root, ["worktree", "add", "-b", branch, wtPath, base]);
    return { id, path: wtPath, branch, base, merged: false };
  }

  /** Commit leftover changes in the worktree (agent may have committed already). */
  commitWork(wt: Worktree, message: string): boolean {
    const status = git(wt.path, ["status", "--porcelain"]);
    if (!status.trim()) return false;
    git(wt.path, ["add", "-A"]);
    git(wt.path, ["commit", "-m", truncate(message, 72)]);
    return true;
  }

  /**
   * Merge the worker branch back into the main checkout, then fast-forward the
   * worker's worktree onto the new main tip so the SAME worktree can take the
   * next task (ignored files like node_modules survive reset --hard).
   * On conflict: abort the merge, keep branch + worktree, return "conflict".
   */
  mergeToMain(wt: Worktree): "merged" | "conflict" {
    try {
      git(this.root, ["merge", wt.branch, "--no-edit"]);
      wt.merged = true;
      // Advance the worker branch to the merged main tip; keep the worktree.
      try {
        git(wt.path, ["reset", "--hard", this.mainBranch]);
      } catch {
        /* next task still works from the older base; merge is already done */
      }
      return "merged";
    } catch {
      try {
        git(this.root, ["merge", "--abort"]);
      } catch {
        /* nothing to abort */
      }
      return "conflict";
    }
  }

  /** Commit argus's own tracked edits in the main checkout (TODO.md ticks) so merges never hit dirty files. */
  commitCheckpoints(message: string): void {
    const status = git(this.root, ["status", "--porcelain"]);
    const dirty = status
      .split(/\r?\n/)
      .filter(Boolean)
      .some((l) => !l.startsWith("??"));
    if (!dirty) return;
    git(this.root, ["add", "-A"]);
    git(this.root, ["commit", "-m", truncate(message, 72)]);
  }

  /**
   * End-of-run cleanup: remove worktrees whose work is already merged and
   * delete their branches; keep unmerged ones (their work only exists there).
   */
  cleanupAll(worktrees: Worktree[]): Worktree[] {
    for (const wt of worktrees) {
      if (!wt.merged) continue;
      try {
        git(this.root, ["worktree", "remove", "--force", wt.path]);
      } catch {
        try {
          fs.rmSync(wt.path, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      try {
        git(this.root, ["branch", "-d", wt.branch]);
      } catch {
        /* keep branch if git refuses */
      }
    }
    try {
      git(this.root, ["worktree", "prune"]);
    } catch {
      /* best effort */
    }
    return this.listLeftover(worktrees);
  }

  listLeftover(worktrees: Worktree[]): Worktree[] {
    return worktrees.filter((wt) => !wt.merged);
  }
}
