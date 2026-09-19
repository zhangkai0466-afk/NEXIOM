import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  Check,
  ImagePlus,
  LoaderCircle,
  Pencil,
  UserRound,
  X,
} from "lucide-react";
import type { AccountProfile, Run } from "../../../packages/contracts";
import { request } from "./bridge";
import { aggregateTokenUsage, localDateKey, usageLevel, type UsageDay } from "./token-usage";
import "./account.css";

const count = new Intl.NumberFormat("zh-CN");
const compactCount = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const CROP_VIEWPORT = 320;
const sameProfile = (a: AccountProfile, b: AccountProfile) =>
  a.nickname === b.nickname && a.avatar === b.avatar;

interface CropAsset {
  file: File;
  url: string;
  width: number;
  height: number;
}

type ActivityMode = "daily" | "weekly" | "cumulative";

function dayLabel(day: UsageDay) {
  const date = day.date.replaceAll("-", "/");
  if (!day.knownRuns && !day.unknownRuns) return `${date} · 暂无用量记录`;
  if (!day.knownRuns) return `${date} · ${day.unknownRuns} 次未报告用量`;
  return `${date} · ${count.format(day.totalTokens)} tokens${day.unknownRuns ? ` · ${day.unknownRuns} 次未报告` : ""}`;
}

function formatDuration(milliseconds: number) {
  if (milliseconds <= 0) return "0 分";
  const totalMinutes = Math.max(1, Math.round(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分`;
}

function getStreaks(days: readonly UsageDay[]) {
  let longest = 0;
  let running = 0;
  for (const day of days) {
    if (day.knownRuns || day.unknownRuns) {
      running += 1;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
  }
  return { current: running, longest };
}

async function inspectAvatar(file: File): Promise<CropAsset> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("请选择 PNG、JPEG 或 WebP 图片。");
  }
  if (file.size > 8 * 1024 * 1024) throw new Error("头像图片不能超过 8 MB。");
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height) throw new Error("无法读取这张图片。");
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("无法读取这张图片。"));
      reader.onerror = () => reject(new Error("无法读取这张图片。"));
      reader.readAsDataURL(file);
    });
    return {
      file,
      url,
      width: bitmap.width,
      height: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}

export function AccountSettings({
  profile,
  runs,
  onSaved,
  onDirtyChange,
  onBusyChange,
}: {
  profile: AccountProfile;
  runs: Run[];
  onSaved: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState(profile);
  const [baseline, setBaseline] = useState(profile);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cropBusy, setCropBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [activityMode, setActivityMode] = useState<ActivityMode>("daily");
  const [cropAsset, setCropAsset] = useState<CropAsset | null>(null);
  const [cropZoom, setCropZoom] = useState(1);
  const [cropPosition, setCropPosition] = useState({ x: 0, y: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const nicknameRef = useRef<HTMLInputElement>(null);
  const lastProfile = useRef(JSON.stringify(profile));
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const dirty = !sameProfile(draft, baseline);
  const [today, setToday] = useState(() => localDateKey(new Date()));
  const usage = useMemo(() => aggregateTokenUsage(runs), [runs, today]);
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusedDate, setFocusedDate] = useState(today);
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const leading = (usage.start.getDay() + 6) % 7;
  const cells = [...Array<null>(leading).fill(null), ...usage.daily];
  const columns = Math.ceil(cells.length / 7);
  const activeDay = usage.daily.find((day) => day.date === (hoveredDate ?? focusedDate)) ?? usage.daily.at(-1)!;
  const activeDayIndex = Math.max(0, usage.daily.indexOf(activeDay));
  const months = usage.daily.flatMap((day, index) => {
    const [, month, date] = day.date.split("-").map(Number);
    if (date !== 1 && index !== 0) return [];
    if (index === 0 && new Date(usage.start.getFullYear(), month, 0).getDate() - date < 7) return [];
    return [{ column: Math.floor((index + leading) / 7) + 1, label: `${month}月` }];
  });
  const streaks = useMemo(() => getStreaks(usage.daily), [usage.daily]);
  const longestRun = useMemo(() => runs.reduce((maximum, run) => {
    if (run.kind === "inspection" || !run.finishedAt) return maximum;
    const started = new Date(run.createdAt).getTime();
    const finished = new Date(run.finishedAt).getTime();
    if (!Number.isFinite(started) || !Number.isFinite(finished)) return maximum;
    return Math.max(maximum, finished - started);
  }, 0), [runs]);
  const peakTokens = Math.max(0, ...usage.daily.map((day) => day.totalTokens));
  const activityValues = useMemo(() => {
    if (activityMode === "daily") return usage.daily.map((day) => day.totalTokens);
    if (activityMode === "cumulative") {
      let total = 0;
      return usage.daily.map((day) => (total += day.totalTokens));
    }
    const weekTotals = new Map<number, number>();
    usage.daily.forEach((day, index) => {
      const week = Math.floor((index + leading) / 7);
      weekTotals.set(week, (weekTotals.get(week) ?? 0) + day.totalTokens);
    });
    return usage.daily.map((_, index) => weekTotals.get(Math.floor((index + leading) / 7)) ?? 0);
  }, [activityMode, leading, usage.daily]);
  const activityMaximum = Math.max(0, ...activityValues);
  const cropBaseScale = cropAsset
    ? Math.max(CROP_VIEWPORT / cropAsset.width, CROP_VIEWPORT / cropAsset.height)
    : 1;

  useEffect(() => {
    const timer = window.setInterval(() => setToday(localDateKey(new Date())), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(busy || cropBusy), [busy, cropBusy, onBusyChange]);
  useEffect(() => {
    const current = JSON.stringify(profile);
    if (current === lastProfile.current) return;
    lastProfile.current = current;
    if (!dirty && !sameProfile(profile, baseline)) {
      setDraft(profile);
      setBaseline(profile);
    }
  }, [profile, baseline, dirty]);
  useEffect(() => {
    if (!editing) return;
    window.setTimeout(() => nicknameRef.current?.focus(), 0);
  }, [editing]);
  useEffect(() => {
    if (!editing && !cropAsset) return;
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (cropAsset) setCropAsset(null);
      else cancelEditing();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  });

  function constrainCrop(x: number, y: number, zoom = cropZoom) {
    if (!cropAsset) return { x: 0, y: 0 };
    const scale = cropBaseScale * zoom;
    const xLimit = Math.max(0, (cropAsset.width * scale - CROP_VIEWPORT) / 2);
    const yLimit = Math.max(0, (cropAsset.height * scale - CROP_VIEWPORT) / 2);
    return {
      x: Math.max(-xLimit, Math.min(xLimit, x)),
      y: Math.max(-yLimit, Math.min(yLimit, y)),
    };
  }

  function cancelEditing() {
    setDraft(baseline);
    setError("");
    setSaved(false);
    setEditing(false);
  }

  async function chooseAvatar(file: File | undefined) {
    if (!file) return;
    setCropBusy(true);
    setError("");
    setSaved(false);
    try {
      const asset = await inspectAvatar(file);
      setCropAsset(asset);
      setCropZoom(1);
      setCropPosition({ x: 0, y: 0 });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "头像读取失败。");
    } finally {
      setCropBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function applyCrop() {
    if (!cropAsset) return;
    setCropBusy(true);
    setError("");
    try {
      const bitmap = await createImageBitmap(cropAsset.file);
      try {
        const scale = cropBaseScale * cropZoom;
        const displayedWidth = cropAsset.width * scale;
        const displayedHeight = cropAsset.height * scale;
        const imageLeft = (CROP_VIEWPORT - displayedWidth) / 2 + cropPosition.x;
        const imageTop = (CROP_VIEWPORT - displayedHeight) / 2 + cropPosition.y;
        const sourceX = -imageLeft / scale;
        const sourceY = -imageTop / scale;
        const sourceSize = CROP_VIEWPORT / scale;
        const canvas = document.createElement("canvas");
        canvas.width = 512;
        canvas.height = 512;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法处理头像，请重试。");
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(bitmap, sourceX, sourceY, sourceSize, sourceSize, 0, 0, 512, 512);
        setDraft((current) => ({ ...current, avatar: canvas.toDataURL("image/png") }));
        setCropAsset(null);
      } finally {
        bitmap.close();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "头像裁剪失败。");
    } finally {
      setCropBusy(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const next = { ...draft, nickname: draft.nickname.trim() };
    if (!next.nickname) {
      setError("请输入昵称。");
      return;
    }
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await request({ type: "account.update", profile: next });
      setDraft(next);
      setBaseline(next);
      await onSaved();
      setSaved(true);
      setEditing(false);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function moveDay(event: KeyboardEvent<HTMLButtonElement>, day: UsageDay) {
    const index = usage.daily.indexOf(day);
    const offset = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
    let nextIndex = offset === undefined ? undefined : index + offset;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = usage.daily.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = usage.daily[Math.min(usage.daily.length - 1, Math.max(0, nextIndex))];
    setFocusedDate(next.date);
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${next.date}"]`)?.focus();
  }

  function activityLabel(day: UsageDay, dayIndex: number) {
    if (activityMode === "daily") return dayLabel(day);
    const label = activityMode === "weekly" ? "所在周" : "截至当日累计";
    return `${day.date.replaceAll("-", "/")} · ${label} ${count.format(activityValues[dayIndex] ?? 0)} tokens`;
  }

  function startCropDrag(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: cropPosition.x,
      originY: cropPosition.y,
    };
  }

  function moveCropDrag(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    setCropPosition(constrainCrop(
      drag.current.originX + event.clientX - drag.current.startX,
      drag.current.originY + event.clientY - drag.current.startY,
    ));
  }

  function endCropDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function moveCropWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 24 : 8;
    const movement = {
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
    }[event.key];
    if (!movement) return;
    event.preventDefault();
    setCropPosition((current) => constrainCrop(current.x + movement.x, current.y + movement.y));
  }

  const activeMetricLabel = activityMode === "daily"
    ? dayLabel(activeDay)
    : activityLabel(activeDay, activeDayIndex);

  return (
    <div className="account-settings">
      <header className="account-page-header">
        <h1>个人资料</h1>
        <div className="account-page-actions">
          <button type="button" className="account-edit-button" onClick={() => setEditing(true)}>
            <Pencil size={15} />编辑
          </button>
        </div>
      </header>

      <section className="account-identity" aria-label="账户资料">
        <button type="button" className="account-avatar account-avatar-button" onClick={() => setEditing(true)} aria-label="编辑头像">
          {draft.avatar ? <img src={draft.avatar} alt="账户头像" /> : <UserRound size={45} strokeWidth={1.25} />}
          <span><Pencil size={14} /></span>
        </button>
        <h2>{draft.nickname}</h2>
        {saved && <span className="account-saved"><Check size={14} />资料已保存</span>}
      </section>

      <dl className="account-overview" aria-label="账户使用概览">
        <div><dd>{compactCount.format(usage.totals.totalTokens)}</dd><dt>累计 Token 数</dt></div>
        <div><dd>{compactCount.format(peakTokens)}</dd><dt>峰值 Token 数</dt></div>
        <div><dd>{formatDuration(longestRun)}</dd><dt>最长任务时长</dt></div>
        <div><dd>{streaks.current} 天</dd><dt>当前连续天数</dt></div>
        <div><dd>{streaks.longest} 天</dd><dt>最长连续天数</dt></div>
      </dl>

      <section className="account-activity">
        <div className="account-activity-heading">
          <h2>Token 活动</h2>
          <div className="account-activity-tabs" aria-label="Token 活动聚合方式">
            {(["daily", "weekly", "cumulative"] as const).map((mode) => (
              <button
                type="button"
                key={mode}
                aria-pressed={activityMode === mode}
                onClick={() => setActivityMode(mode)}
              >
                {{ daily: "每日", weekly: "每周", cumulative: "累计" }[mode]}
              </button>
            ))}
          </div>
        </div>
        <div className="account-heatmap-scroll">
          <div className="account-heatmap" style={{ "--usage-columns": columns } as React.CSSProperties}>
            <div className="account-heatmap-grid" ref={gridRef} role="group" aria-label="每日 token 用量，方向键切换日期">
              {cells.map((day, index) => day ? (
                <button
                  key={day.date}
                  type="button"
                  className={`account-usage-cell level-${usageLevel(activityValues[index - leading] ?? 0, activityMaximum)}${day.unknownRuns ? " has-unknown" : ""}`}
                  data-date={day.date}
                  title={activityLabel(day, index - leading)}
                  aria-label={activityLabel(day, index - leading)}
                  tabIndex={focusedDate === day.date ? 0 : -1}
                  onFocus={() => setFocusedDate(day.date)}
                  onMouseEnter={() => setHoveredDate(day.date)}
                  onMouseLeave={() => setHoveredDate(null)}
                  onKeyDown={(event) => moveDay(event, day)}
                />
              ) : <span key={`blank-${index}`} aria-hidden="true" />)}
            </div>
            <div className="account-heatmap-months" aria-hidden="true">
              {months.map((month, index) => <span key={index} style={{ gridColumn: month.column }}>{month.label}</span>)}
            </div>
          </div>
        </div>
        <div className="account-heatmap-footer">
          <span className="account-activity-detail">{activeMetricLabel}</span>
          <div className="account-heatmap-legend" aria-label="颜色越深，用量越多">
            <span>少</span>{[0, 1, 2, 3, 4].map((level) => <i className={`account-usage-cell level-${level}`} key={level} aria-hidden="true" />)}<span>多</span>
          </div>
        </div>
        {(usage.totals.unknownRuns > 0 || usage.invalidDateRuns > 0) && <p className="account-usage-incomplete">
          {usage.totals.unknownRuns > 0 && `${usage.totals.unknownRuns} 次任务未报告用量`}
          {usage.totals.unknownRuns > 0 && usage.invalidDateRuns > 0 && " · "}
          {usage.invalidDateRuns > 0 && `${usage.invalidDateRuns} 次记录缺少有效日期`}
        </p>}
      </section>

      {editing && (
        <div className="account-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) cancelEditing();
        }}>
          <form className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-editor-title" onSubmit={(event) => void save(event)}>
            <header>
              <div>
                <h2 id="account-editor-title">编辑个人资料</h2>
                <p>更新头像和在 NEXIOM 中显示的名称。</p>
              </div>
              <button type="button" className="icon-button" aria-label="关闭编辑" onClick={cancelEditing}><X size={17} /></button>
            </header>
            <div className="account-editor-avatar">
              <button type="button" className="account-avatar" disabled={cropBusy} onClick={() => inputRef.current?.click()}>
                {draft.avatar ? <img src={draft.avatar} alt="头像预览" /> : <UserRound size={39} strokeWidth={1.25} />}
                <span><ImagePlus size={15} /></span>
              </button>
              <div>
                <strong>头像</strong>
                <p>选择图片后可拖动和缩放，精确框选头像区域。</p>
                <div>
                  <button type="button" className="secondary-button" disabled={cropBusy} onClick={() => inputRef.current?.click()}>
                    {cropBusy && <LoaderCircle size={14} className="spin" />}选择图片
                  </button>
                  {draft.avatar && <button type="button" className="text-button" disabled={cropBusy} onClick={() => {
                    setDraft((current) => ({ ...current, avatar: null }));
                    setSaved(false);
                  }}>移除</button>}
                </div>
              </div>
              <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传头像" hidden onChange={(event) => void chooseAvatar(event.target.files?.[0])} />
            </div>
            <label className="account-nickname">
              <span>昵称</span>
              <input ref={nicknameRef} value={draft.nickname} maxLength={40} required autoComplete="nickname" disabled={busy} onChange={(event) => {
                setDraft((current) => ({ ...current, nickname: event.target.value }));
                setSaved(false);
              }} />
              <small>最多 40 个字符</small>
            </label>
            {error && <p className="form-error account-form-error" role="alert">{error}</p>}
            <footer>
              <button type="button" className="secondary-button" disabled={busy || cropBusy} onClick={cancelEditing}>取消</button>
              <button className="primary-button" type="submit" disabled={busy || cropBusy || !dirty}>
                {busy && <LoaderCircle size={14} className="spin" />}保存
              </button>
            </footer>
          </form>
        </div>
      )}

      {cropAsset && (
        <div className="account-crop-backdrop" role="presentation">
          <section className="account-crop-dialog" role="dialog" aria-modal="true" aria-labelledby="avatar-crop-title">
            <header>
              <div>
                <h2 id="avatar-crop-title">框选头像</h2>
                <p>拖动图片调整位置，使用滑块缩放。</p>
              </div>
              <button type="button" className="account-crop-close" aria-label="关闭裁剪" onClick={() => setCropAsset(null)}><X size={18} /></button>
            </header>
            <div
              className="account-crop-viewport"
              role="application"
              aria-label="头像裁剪区域，可拖动图片或使用方向键调整位置"
              tabIndex={0}
              onPointerDown={startCropDrag}
              onPointerMove={moveCropDrag}
              onPointerUp={endCropDrag}
              onPointerCancel={endCropDrag}
              onKeyDown={moveCropWithKeyboard}
            >
              <img
                src={cropAsset.url}
                alt="待裁剪头像"
                draggable={false}
                style={{
                  width: cropAsset.width * cropBaseScale * cropZoom,
                  height: cropAsset.height * cropBaseScale * cropZoom,
                  transform: `translate(calc(-50% + ${cropPosition.x}px), calc(-50% + ${cropPosition.y}px))`,
                }}
              />
              <div className="account-crop-mask" aria-hidden="true" />
              <div className="account-crop-frame" aria-hidden="true" />
            </div>
            <label className="account-crop-zoom">
              <span>缩放</span>
              <input
                type="range"
                min="1"
                max="3"
                step="0.01"
                value={cropZoom}
                aria-label="缩放头像"
                onChange={(event) => {
                  const zoom = Number(event.target.value);
                  setCropZoom(zoom);
                  setCropPosition((current) => constrainCrop(current.x, current.y, zoom));
                }}
              />
              <output>{Math.round(cropZoom * 100)}%</output>
            </label>
            <footer>
              <button type="button" className="secondary-button" disabled={cropBusy} onClick={() => setCropAsset(null)}>取消</button>
              <button type="button" className="primary-button" disabled={cropBusy} onClick={() => void applyCrop()}>
                {cropBusy && <LoaderCircle size={14} className="spin" />}应用头像
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
