import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Project, ProjectMemory } from "../contracts";

function memoryPath(project: Project, create = false): string {
  const root = realpathSync(project.root);
  const directory = path.join(root, ".nexiom");
  if (create) mkdirSync(directory, { recursive: true });
  if (existsSync(directory)) {
    if (
      lstatSync(directory).isSymbolicLink() ||
      path.relative(root, realpathSync(directory)) !== ".nexiom"
    )
      throw new Error("项目记忆目录不能是符号链接或位于项目之外。");
  }
  const target = path.join(directory, "MEMORY.md");
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error("项目记忆路径不是普通文件。");
    if (stat.size > 128000)
      throw new Error("项目记忆文件超过 128 KB，请先缩减内容。");
  }
  return target;
}

export function readProjectMemory(project: Project): ProjectMemory {
  const target = memoryPath(project);
  const exists = existsSync(target);
  const text = exists ? readFileSync(target, "utf8") : "";
  return {
    projectId: project.id,
    path: ".nexiom/MEMORY.md",
    text,
    revision: createHash("sha256").update(text).digest("hex"),
    updatedAt: exists ? statSync(target).mtime.toISOString() : null,
  };
}

export function writeProjectMemory(
  project: Project,
  text: string,
  expectedRevision: string,
): ProjectMemory {
  if (readProjectMemory(project).revision !== expectedRevision)
    throw new Error("项目记忆已在其他位置修改，请重新读取后保存。");
  const target = memoryPath(project, true);
  const temporary = path.join(
    path.dirname(target),
    `.memory-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return readProjectMemory(project);
}
