import fs from "node:fs";
import path from "node:path";
import { findConfigFile, starterConfigText } from "../config.js";
import { sampleTaskFile } from "../tasks.js";

export function cmdInit(root: string, flags: { force?: boolean }): number {
  const created: string[] = [];
  const skipped: string[] = [];

  const cfgPath = findConfigFile(root);
  if (!cfgPath || flags.force) {
    const target = path.join(root, "argus.config.jsonc");
    fs.writeFileSync(target, starterConfigText());
    created.push("argus.config.jsonc（已带注释）");
  } else {
    skipped.push("argus.config.jsonc 已存在");
  }

  const todoPath = path.join(root, "TODO.md");
  if (!fs.existsSync(todoPath)) {
    fs.writeFileSync(todoPath, sampleTaskFile());
    created.push("TODO.md（示例任务清单）");
  } else {
    skipped.push("TODO.md 已存在");
  }

  const gitignorePath = path.join(root, ".gitignore");
  let gi = "";
  try {
    gi = fs.readFileSync(gitignorePath, "utf8");
  } catch {
    /* new file */
  }
  if (!gi.split(/\r?\n/).includes(".argus/")) {
    gi = gi.replace(/\s*$/, "") + (gi.trim() ? "\n" : "") + ".argus/\n";
    fs.writeFileSync(gitignorePath, gi);
    created.push(".gitignore += .argus/");
  }

  console.log("\n🌙 argus init — 守夜岗哨已就绪\n");
  for (const c of created) console.log(`  ✓ 已创建 ${c}`);
  for (const s of skipped) console.log(`  · ${s}`);
  console.log(`
下一步：
  1. 编辑 TODO.md，把今晚要做的任务写成可独立验证的小步
  2. 按需调整 argus.config.jsonc（agent / 收工时间 / 通知）
  3. 体检: npx argus-night doctor
  4. 开守: npx argus-night run --until 07:00
`);
  return 0;
}
