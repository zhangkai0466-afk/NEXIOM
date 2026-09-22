import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { CleanupResult, StorageSummary } from "../contracts";
import { checkedFile, checkedRoot } from "../filesystem/safe-files";

export interface CacheLocation { id: string; label: string; relative: string; olderThan?: number }
export const coreCacheLocations: CacheLocation[] = [
  { id: "runtime-cache", label: "运行环境缓存", relative: "runtime/home/.cache" },
  { id: "plot-cache", label: "绘图字体缓存", relative: "runtime/visual-design/matplotlib" },
];
export function cleanStorage(directory: string, locations: CacheLocation[], clear = false): { storage: StorageSummary; cleanup: CleanupResult } {
  const root = checkedRoot(directory);
  const storage: StorageSummary = { categories: [], warnings: [] };
  const cleanup: CleanupResult = { freedBytes: 0, deletedFiles: 0, skippedFiles: 0, warnings: [] };
  for (const location of locations) {
    const category = { id: location.id, label: location.label, bytes: 0 };
    storage.categories.push(category);
    let visited = 0;
    const visit = (relative: string, depth: number) => {
      if (++visited > 20000 || depth > 24) throw new Error("缓存数量过多，本次扫描已停止。");
      let stat;
      let target;
      try {
        target = checkedFile(root, relative);
        stat = lstatSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        cleanup.skippedFiles++;
        if (!storage.warnings.includes(`${location.label}有无法访问的文件，已跳过。`)) storage.warnings.push(`${location.label}有无法访问的文件，已跳过。`);
        return;
      }
      if (stat.isDirectory()) {
        for (const entry of readdirSync(target)) visit(path.join(relative, entry), depth + 1);
      } else if (stat.isFile() && stat.nlink === 1 && (!location.olderThan || stat.mtimeMs < location.olderThan)) {
        category.bytes += stat.size;
        if (clear) {
          try {
            // Recheck immediately before unlinking; never recursively delete a cache root.
            const current = lstatSync(checkedFile(root, relative));
            if (current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs || current.size !== stat.size) throw new Error("文件已变化");
            unlinkSync(target);
            cleanup.freedBytes += stat.size;
            cleanup.deletedFiles++;
          } catch { cleanup.skippedFiles++; }
        }
      }
    };
    try { visit(location.relative, 0); }
    catch { storage.warnings.push(`${location.label}未能完整扫描，请稍后重试。`); cleanup.skippedFiles++; }
  }
  cleanup.warnings = [...storage.warnings];
  if (clear && cleanup.skippedFiles) cleanup.warnings.push(`有 ${cleanup.skippedFiles} 项正在使用、已变化或无法访问，已保留。`);
  return { storage, cleanup };
}
