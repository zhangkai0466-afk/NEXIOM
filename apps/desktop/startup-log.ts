import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

// Only lifecycle metadata belongs here: never messages, commands, keys or IPC bodies.
export function startupLogger(userData: string) {
  const directory = path.join(userData, "logs");
  const file = path.join(directory, "startup.log");
  function log(event: string, metadata: Record<string, unknown> = {}) {
    try {
      mkdirSync(directory, { recursive: true });
      try {
        if (statSync(file).size > 1_048_576) renameSync(file, `${file}.previous`);
      } catch { /* First launch has no log. */ }
      appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...metadata }) + "\n");
    } catch { /* Diagnostics must not prevent startup on a read-only volume. */ }
  }
  return { file, directory, log };
}
