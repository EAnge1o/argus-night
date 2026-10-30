import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "src", "cli.js");

/**
 * 真机探针：ARGUS_REAL_CLI=1 npm test 时才运行（会花一点点真实配额）。
 * 默认跳过 —— 平时测试不烧钱，发布前手动跑一次验证全链路。
 */
const enabled = process.env.ARGUS_REAL_CLI === "1";

test(
  "real-cli: doctor --probe 真实调用已安装的 agent（ARGUS_REAL_CLI=1 启用）",
  { timeout: 300_000, skip: !enabled },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "argus-real-"));
    const agent = ["claude", "codex"].find((a) => whereCli(a) !== "");
    if (!agent) {
      console.log("未安装 claude/codex，真机探针跳过");
      return;
    }
    fs.writeFileSync(
      path.join(root, "argus.config.jsonc"),
      JSON.stringify({ agent }),
    );
    fs.writeFileSync(path.join(root, "TODO.md"), "# x\n- [ ] placeholder\n");
    const { code, out } = await new Promise<{ code: number; out: string }>((resolve) => {
      const p = spawn(process.execPath, [CLI, "doctor", "--probe"], { cwd: root });
      let out = "";
      p.stdout.on("data", (c: Buffer) => (out += c));
      p.stderr.on("data", (c: Buffer) => (out += c));
      p.on("close", (c) => resolve({ code: c ?? -1, out }));
    });
    assert.equal(code, 0, `探针失败:\n${out}`);
    assert.match(out, /真实调用成功/);
  },
);

function whereCli(cmd: string): string {
  try {
    const out = execFileSync(
      process.platform === "win32" ? "where" : "which",
      [cmd],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.split(/\r?\n/)[0] || "";
  } catch {
    return "";
  }
}
