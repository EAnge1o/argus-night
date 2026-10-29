import fs from "node:fs";
import path from "node:path";
import { Journal } from "../journal.js";
import { loadConfig } from "../config.js";
import { writeReport } from "../report.js";

export function cmdReport(root: string, flags: { rebuild?: boolean }): number {
  const reportsDir = path.join(root, ".argus", "reports");
  if (fs.existsSync(reportsDir) && !flags.rebuild) {
    const files = fs
      .readdirSync(reportsDir)
      .filter((f) => f.startsWith("report-") && f.endsWith(".md"))
      .sort();
    const last = files[files.length - 1];
    if (last) {
      console.log(fs.readFileSync(path.join(reportsDir, last), "utf8"));
      return 0;
    }
  }

  const journalPath = Journal.latestJournal(root);
  if (!journalPath) {
    console.log("还没有任何运行记录。先跑一次：npx argus-night run");
    return 1;
  }
  const runId = path.basename(journalPath).replace(/^journal-/, "").replace(/\.jsonl$/, "");
  const { config } = loadConfig(root);
  const journal = new Journal(root, runId);
  const out = writeReport(root, config, journal, { stopReason: "（重新生成）", startCommit: null });
  console.log(fs.readFileSync(out, "utf8"));
  return 0;
}
