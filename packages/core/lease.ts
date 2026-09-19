import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function acquireLease(directory: string): () => void {
  const file = path.join(directory, "core.lock");
  const token = randomUUID();
  const create = () =>
    writeFileSync(file, JSON.stringify({ pid: process.pid, token }), {
      flag: "wx",
    });
  try {
    create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let pid: number;
    try {
      pid = JSON.parse(readFileSync(file, "utf8")).pid;
    } catch {
      throw new Error("工作空间锁文件不完整，无法安全打开。");
    }
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("工作空间锁无效。");
    let running = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") running = false;
    }
    if (running) throw new Error("此工作空间已由另一个本地核心打开。");
    unlinkSync(file);
    create();
  }
  return () => {
    try {
      if (JSON.parse(readFileSync(file, "utf8")).token === token)
        unlinkSync(file);
    } catch {
      /* A missing lease cannot grant ownership to this process. */
    }
  };
}
