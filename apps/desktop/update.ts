import path from "node:path";

export interface DesktopUpdateTarget {
  executable: string;
  targetVersion: string | null;
}

const releaseDirectoryPattern = /^NEXIOM-([0-9A-Za-z.+-]+)-win-x64$/i;
export const currentReleaseDirectoryName = "NEXIOM-current-win-x64";
const previousReleaseDirectoryPattern = /^\.nexiom-previous-[0-9a-f-]+$/i;
const normalized = (value: string) => path.normalize(value).toLowerCase();
export const releaseVersionFromDirectoryName = (name: string): string | null =>
  releaseDirectoryPattern.exec(name)?.[1] ?? null;
const numericVersion = (value: string): number[] | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  return match ? match.slice(1, 4).map(Number) : null;
};
const compareVersions = (left: string, right: string): number | null => {
  const leftParts = numericVersion(left);
  const rightParts = numericVersion(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index])
      return leftParts[index] - rightParts[index];
  }
  return 0;
};

export function obsoleteReleaseDirectoryNames(
  names: string[],
  currentDirectoryName: string,
): string[] {
  if (currentDirectoryName.toLowerCase() === currentReleaseDirectoryName.toLowerCase())
    return names.filter(
      (name) =>
        numericVersion(releaseVersionFromDirectoryName(name) ?? "") !== null ||
        previousReleaseDirectoryPattern.test(name),
    );
  const currentVersion = releaseVersionFromDirectoryName(currentDirectoryName);
  if (!currentVersion) return [];
  return names.filter((name) => {
    const version = releaseVersionFromDirectoryName(name);
    if (!version) return false;
    const comparison = compareVersions(version, currentVersion);
    return comparison !== null && comparison < 0;
  });
}

export function resolveDesktopUpdateTarget(
  shortcutTarget: string,
  currentExecutable: string,
): DesktopUpdateTarget {
  if (!shortcutTarget || path.basename(shortcutTarget).toLowerCase() !== "nexiom.exe")
    throw new Error("桌面的 NEXIOM 快捷方式没有指向有效的 NEXIOM.exe。");

  const executable = path.resolve(shortcutTarget);
  const targetFolder = path.dirname(executable);
  const targetVersion = releaseVersionFromDirectoryName(path.basename(targetFolder));
  if (!targetVersion)
    throw new Error("桌面的 NEXIOM 快捷方式没有指向受支持的版本目录。");

  const currentFolder = path.dirname(currentExecutable);
  const currentVersion = releaseVersionFromDirectoryName(path.basename(currentFolder));
  if (
    currentVersion &&
    normalized(path.dirname(targetFolder)) !== normalized(path.dirname(currentFolder))
  )
    throw new Error("桌面快捷方式指向了另一个 NEXIOM 发布目录，请重新创建快捷方式。");

  if (normalized(executable) === normalized(currentExecutable))
    throw new Error("当前已经是桌面快捷方式指向的最新版本。");
  if (currentVersion) {
    const comparison = compareVersions(targetVersion, currentVersion);
    if (comparison !== null && comparison <= 0)
      throw new Error("桌面快捷方式没有指向比当前版本更新的 NEXIOM。");
  }

  return { executable, targetVersion };
}
