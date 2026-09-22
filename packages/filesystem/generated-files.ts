import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicJson, checkedFile, checkedRoot, fileHash } from "./safe-files";

const manifestPath = ".nexiom/generated-files.json";
const schema = z.object({ version: z.literal(1), files: z.array(z.object({
  path: z.string().min(1).max(4096), hash: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(),
})).max(20000) });
export type GeneratedFile = z.infer<typeof schema>["files"][number];

export function outputPath(root: string, file: string): string {
  const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join("/");
  checkedFile(root, relative);
  if (relative.split("/").some(part => part.startsWith(".")) || /^(inputs|node_modules|vendor)(\/|$)/i.test(relative))
    throw new Error("原始附件、隐藏文件及依赖文件不属于可清理成果。");
  return relative;
}

export function generatedFiles(root: string): GeneratedFile[] {
  root = checkedRoot(root);
  const target = checkedFile(root, manifestPath);
  if (!existsSync(target)) return [];
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new Error("成果清单无法安全读取。");
  return schema.parse(JSON.parse(readFileSync(target, "utf8"))).files;
}

export function forgetDeletedGeneratedFiles(root: string, paths: string[]): void {
  if (!paths.length) return;
  try {
    const deleted = new Set(paths);
    const files = generatedFiles(root).filter(file => !deleted.has(file.path) || existsSync(checkedFile(root, file.path)));
    atomicJson(root, manifestPath, { version: 1, files });
  } catch { /* Retaining an old hash is conservative: new contents will be preserved. */ }
}

// Called only after an exclusive creation or a native 'add' file-change event.
// Existing untracked files are never inferred from their name or extension.
export function registerGeneratedFiles(projectRoot: string, files: string[], replaceTracked: string[] = []): void {
  if (!files.length) return;
  try {
    const root = checkedRoot(projectRoot);
    const entries = new Map(generatedFiles(root).map(file => [file.path, file]));
    const replace = new Set(replaceTracked.map(file => outputPath(root, file)));
    for (const file of files) {
      try {
        const relative = outputPath(root, file);
        // Replayed native 'add' events must not adopt later manual edits.
        if (entries.has(relative) && !replace.has(relative)) continue;
        const target = checkedFile(root, relative);
        entries.set(relative, { path: relative, hash: fileHash(target), size: lstatSync(target).size });
      } catch { /* Unverifiable files remain outside automatic deletion. */ }
    }
    if (entries.size <= 20000) atomicJson(root, manifestPath, { version: 1, files: [...entries.values()] });
  } catch { /* A missing provenance record must never interrupt task output. */ }
}
