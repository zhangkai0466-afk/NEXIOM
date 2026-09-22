import { useEffect, useState } from "react";
import { HardDrive, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import type { CleanupResult, StorageSummary } from "../../../packages/contracts";
import { request } from "./bridge";
import "./cleanup.css";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function StorageSettings({ running, onBusyChange }: { running: boolean; onBusyChange: (busy: boolean) => void }) {
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    let disposed = false;
    setBusy(true);
    void request({ type: "storage.inspect" }).then(response => {
      if (!disposed) setStorage(response.storage ?? null);
    }).catch(failure => { if (!disposed) setError((failure as Error).message); })
      .finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, []);
  async function scan(clear = false) {
    if (busy) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await request({ type: clear ? "storage.clear" : "storage.inspect" });
      setStorage(response.storage ?? null);
      setResult(response.cleanup ?? null);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  const bytes = storage?.categories.reduce((sum, category) => sum + category.bytes, 0) ?? 0;
  const warnings = [...new Set([...(storage?.warnings ?? []), ...(result?.warnings ?? [])])];
  return <section className="settings-section">
    <h2>应用缓存</h2>
    <p className="settings-section-description">清理可重新生成的缓存，释放磁盘空间。项目、聊天、模型连接和 API Key 均会保留。</p>
    <div className="settings-card">
      <div className="storage-total"><HardDrive size={24} /><div><span>预计可释放</span><strong>{storage ? formatBytes(bytes) : "正在计算…"}</strong></div>
        <button className="icon-button" aria-label="重新计算缓存" disabled={busy} onClick={() => void scan()}><RefreshCw size={16} /></button>
      </div>
      {storage?.categories.map(category => <div key={category.id} className="settings-row"><div className="settings-row-copy"><strong>{category.label}</strong></div><span className="settings-value">{formatBytes(category.bytes)}</span></div>)}
      <div className="settings-row"><div className="settings-row-copy"><strong>清理缓存</strong><p>{running ? "任务正在运行，结束或停止任务后可清理。" : "缓存会在需要时重新生成。"}</p></div>
        <button className="secondary-button" disabled={busy || running || !storage || bytes === 0} onClick={() => void scan(true)}>{busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}清理缓存</button>
      </div>
    </div>
    {result && <p className="cleanup-feedback" role="status">已释放 {formatBytes(result.freedBytes)}。{result.skippedFiles > 0 ? `有 ${result.skippedFiles} 项未能清理，已保留。` : ""}</p>}
    {warnings.map(warning => <p className="muted" key={warning}>{warning}</p>)}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
