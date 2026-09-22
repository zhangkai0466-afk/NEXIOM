import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export function checkedRoot(root: string): string {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root || path.relative(resolved, realpathSync(resolved)) !== "" || !lstatSync(resolved).isDirectory())
    throw new Error("清理路径必须是实际存在的独立文件夹，不能是磁盘根目录或目录联接。");
  return resolved;
}

// Inspect every ancestor, including dangling symlinks. Never follow a junction
// even if it happens to point back inside the workspace.
export function checkedFile(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  const normalized = path.relative(root, target);
  if (!normalized || normalized === ".." || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized))
    throw new Error("清理路径超出所属文件夹。");
  let current = root;
  for (const part of normalized.split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || path.relative(current, realpathSync(current)) !== "")
        throw new Error("清理路径不能包含符号链接或目录联接。");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

export function fileHash(target: string, maximumBytes = 64 * 1024 * 1024): string {
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximumBytes)
    throw new Error("文件类型、链接数或大小不适合自动清理。");
  return createHash("sha256").update(readFileSync(target)).digest("hex");
}

export function atomicJson(root: string, relative: string, data: unknown): void {
  const target = checkedFile(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  checkedFile(root, relative);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data), { flag: "wx", flush: true });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
