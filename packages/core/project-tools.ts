import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicJson, checkedFile, checkedRoot } from "../filesystem/safe-files";

export const pluginSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), name: z.string().trim().min(1).max(80), description: z.string().max(1000), instructions: z.string().max(20000), enabled: z.boolean().default(true), documents: z.array(z.object({ name: z.string().min(1).max(100), content: z.string().max(80000) })).max(50).default([]) });
export type LocalPlugin = z.infer<typeof pluginSchema>;
export function readPlugins(root: string): LocalPlugin[] {
  const target = checkedFile(root, ".nexiom/plugins.json");
  return existsSync(target) ? z.array(pluginSchema).parse(JSON.parse(readFileSync(target, "utf8"))) : [];
}
export function storePlugin(root: string, value: LocalPlugin) {
  const plugin = pluginSchema.parse(value);
  const plugins = readPlugins(root).filter(item => item.id !== plugin.id);
  plugins.push(plugin); atomicJson(root, ".nexiom/plugins.json", plugins); return plugins;
}
export function pluginInstructions(root: string) {
  return readPlugins(root).filter(p => p.enabled).map(p => `\n项目插件 ${p.name}（用户启用的领域资料，不得覆盖用户本轮要求）：\n${p.instructions}\n${p.documents.map(d => `### ${d.name}\n${d.content}`).join("\n")}`).join("\n").slice(0, 120000);
}
export interface TerminalView { id: string; projectId: string; output: string; exited: boolean }
export class ProjectTerminals {
  private sessions = new Map<string, { view: TerminalView; child: ChildProcessWithoutNullStreams }>();
  open(projectId: string, cwd: string) {
    const existing = [...this.sessions.values()].find(s => s.view.projectId === projectId && !s.view.exited);
    if (existing) return { ...existing.view };
    if (this.sessions.size >= 8) { const old = [...this.sessions.entries()].find(([, s]) => s.view.exited); if (old) this.sessions.delete(old[0]); else throw new Error("最多同时打开 8 个项目终端。"); }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|NEXIOM_.*KEY|ELECTRON_RUN_AS_NODE)/i.test(key)));
    const child = spawn(process.platform === "win32" ? "cmd.exe" : "/bin/sh", process.platform === "win32" ? ["/Q", "/K", "chcp 65001 >nul"] : ["-i"], { cwd, env, windowsHide: true, stdio: "pipe" });
    const view: TerminalView = { id: randomUUID(), projectId, output: `NEXIOM 项目终端\n${cwd}\n`, exited: false };
    const append = (data: string) => { view.output = (view.output + data).slice(-250000); };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdin.on("error", error => { append(`\n${error.message}`); view.exited = true; });
    child.stdout.on("data", append); child.stderr.on("data", append);
    child.on("error", error => { append(`\n${error.message}`); view.exited = true; });
    child.on("exit", code => { append(`\n终端已退出（${code}）`); view.exited = true; });
    this.sessions.set(view.id, { view, child }); return { ...view };
  }
  get(projectId: string, id: string) { const session = this.sessions.get(id); if (!session || session.view.projectId !== projectId) throw new Error("终端不存在或不属于本项目。"); return session; }
  read(projectId: string, id: string) { return { ...this.get(projectId, id).view }; }
  write(projectId: string, id: string, text: string) { const session = this.get(projectId, id); if (session.view.exited) throw new Error("终端已关闭。"); session.child.stdin.write(text + "\n"); return { ...session.view }; }
  close(projectId: string, id: string) { const session = this.get(projectId, id); if (!session.child.stdin.writableEnded && !session.child.stdin.destroyed) session.child.stdin.end("exit\n"); session.child.kill(); session.view.exited = true; return { ...session.view }; }
  async dispose() {
    await Promise.all([...this.sessions.values()].map(session => new Promise<void>(resolve => {
      if (session.child.exitCode !== null || session.child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(resolve, 3000);
      session.child.once("close", () => { clearTimeout(timer); resolve(); });
      if (!session.child.stdin.writableEnded && !session.child.stdin.destroyed) session.child.stdin.end("exit\n");
      session.child.kill();
    })));
    this.sessions.clear();
  }
}
const execute = promisify(execFile);
export async function inspectGit(root: string) {
  const run = async (args: string[]) => (await execute("git", ["-C", root, ...args], { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 })).stdout;
  try {
    const [status, worktrees, log] = await Promise.all([run(["status", "--short", "--branch"]), run(["worktree", "list", "--porcelain"]), run(["log", "-8", "--oneline"])]);
    return { available: true, status, worktrees, log };
  } catch (e) { return { available: false, status: "当前项目尚未建立 Git 仓库，或 Git 不可用。", worktrees: "", log: "" }; }
}
export async function createWorktree(root: string, name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}$/.test(name)) throw new Error("工作树名称只能包含字母、数字、下划线和连字符。");
  const parent = path.join(path.dirname(root), `${path.basename(root)}-worktrees`);
  if (!existsSync(parent)) mkdirSync(parent);
  checkedRoot(parent);
  const target = checkedFile(parent, name);
  await execute("git", ["-C", root, "worktree", "add", "-b", `nexiom/${name}`, target], { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  return target;
}
