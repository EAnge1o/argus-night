export interface TaskItem {
  text: string;
  done: boolean;
  /** 0-based index into the file's line array. */
  line: number;
}

const TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s*)(.*)$/;

/** Parse a markdown checklist into task items. */
export function parseTaskList(md: string): TaskItem[] {
  const out: TaskItem[] = [];
  const lines = md.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const m = TASK_RE.exec(line);
    if (m) {
      out.push({ text: m[4].trim(), done: m[2] !== " ", line: idx });
    }
  });
  return out;
}

export function remainingTasks(md: string): TaskItem[] {
  return parseTaskList(md).filter((t) => !t.done && t.text.length > 0);
}

/** Rewrite the checkbox on one line (by 0-based line index). */
export function markTaskLine(md: string, line: number, mark: " " | "x"): string {
  const lines = md.split(/\r?\n/);
  if (line < 0 || line >= lines.length) return md;
  const m = TASK_RE.exec(lines[line]);
  if (!m) return md;
  lines[line] = `${m[1]}${mark}${m[3]}${m[4]}`;
  return lines.join("\n");
}

/** Append a small header so an empty TODO.md is self-explanatory. */
export function sampleTaskFile(): string {
  return `# 夜间任务清单

> argus 会从上往下逐条执行，每完成一条自动打勾。
> 写得越具体、越可验证，夜里续跑就越稳。建议每条任务都是一个能独立提交的小步。

- [ ] 阅读 src/ 目录，总结当前代码结构，写入 docs/NOTES.md（没有 docs 目录就新建）
- [ ] 修复 TODO.md 中提到的已知问题，并为每个修复补一个最小测试
- [ ] 运行完整测试套件，修复所有失败，然后 git 提交
`;
}
