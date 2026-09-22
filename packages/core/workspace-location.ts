import path from "node:path";

export const CASUAL_PROJECT_NAME = "__nexiom_casual_chat__";
export const DEFAULT_CASUAL_ROOT = "D:\\NEXIOM\\casual";

export function casualWorkspaceRoot(): string {
  const configured = process.env.NEXIOM_CASUAL_ROOT?.trim();
  return path.resolve(configured || DEFAULT_CASUAL_ROOT);
}

export function workspaceDriveEnforced(): boolean {
  return process.env.NEXIOM_ENFORCE_WORKSPACE_DRIVE === "1";
}

export function isSystemDrivePath(root: string): boolean {
  if (process.platform !== "win32") return false;
  const drive = path.parse(path.resolve(root)).root.replace(/[\\/]+$/, "");
  return drive.toUpperCase() === "C:";
}

export function systemDriveWorkspaceError(root: string): string {
  return `工作区不能放在 C 盘。随便聊聊使用 ${casualWorkspaceRoot()}，正式赛题请选择对应的赛题文件夹。当前路径：${root}`;
}

export function assertNotSystemDrive(root: string): void {
  if (isSystemDrivePath(root)) throw new Error(systemDriveWorkspaceError(root));
}

export function assertWorkspaceDrive(root: string): void {
  if (workspaceDriveEnforced()) assertNotSystemDrive(root);
}
