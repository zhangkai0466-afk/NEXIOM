import type {
  Command,
  CoreResponse,
  DesktopUpdateResult,
} from "../../../packages/contracts";

function readableDesktopError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const readable = message.replace(
    /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error:\s*)?/,
    "",
  );
  return error instanceof Error && readable === message
    ? error
    : new Error(readable, { cause: error });
}

export async function request(command: Command): Promise<CoreResponse> {
  if (window.nexiom) {
    try {
      return await window.nexiom.request(command);
    } catch (error) {
      throw readableDesktopError(error);
    }
  }
  const response = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "本地核心连接失败。");
  return result;
}
export async function applyDesktopUpdate(): Promise<DesktopUpdateResult> {
  if (!window.nexiom?.applyUpdate) {
    window.location.reload();
    return { targetVersion: null };
  }
  try {
    return await window.nexiom.applyUpdate();
  } catch (error) {
    throw readableDesktopError(error);
  }
}
export function subscribe(listener: () => void): () => void {
  if (window.nexiom) return window.nexiom.subscribe(listener);
  const events = new EventSource("/api/events");
  events.onmessage = listener;
  return () => events.close();
}
