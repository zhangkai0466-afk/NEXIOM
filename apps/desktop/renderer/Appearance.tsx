import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import type { ThemeSource, ThemeState } from "../../../packages/contracts";
import { readPreference, writePreference } from "./preferences";
import { AgentTaskStatus } from "./AgentTaskStatus";
import { AGENT_TASK_STATES, type AgentTaskKind } from "./agent-task-state";

const TYPOGRAPHY_VERSION = "2";
const DEFAULT_UI_FONT_SIZE = 14;
const DEFAULT_CONTENT_FONT_SIZE = 14;
const DEFAULT_CODE_FONT_SIZE = 12;

function readFontSize(key: string, fallback: number, min: number, max: number) {
  const value = Number(readPreference(key));
  return Number.isFinite(value) && value > 0
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function migrateStoredTypography() {
  if (readPreference("nexiom.typographyVersion") === TYPOGRAPHY_VERSION) return;
  const uiFontSize = readPreference("nexiom.uiFontSize");
  const contentFontSize = readPreference("nexiom.fontSize");
  if (uiFontSize === null || Number(uiFontSize) === 16)
    writePreference("nexiom.uiFontSize", String(DEFAULT_UI_FONT_SIZE));
  if (contentFontSize === null || Number(contentFontSize) === 17)
    writePreference("nexiom.fontSize", String(DEFAULT_CONTENT_FONT_SIZE));
  if (readPreference("nexiom.codeFontSize") === null)
    writePreference("nexiom.codeFontSize", String(DEFAULT_CODE_FONT_SIZE));
  writePreference("nexiom.typographyVersion", TYPOGRAPHY_VERSION);
}

export function applyStoredTypography() {
  migrateStoredTypography();
  const root = document.documentElement;
  root.style.setProperty("--ui-font-size", `${readFontSize("nexiom.uiFontSize", DEFAULT_UI_FONT_SIZE, 12, 20)}px`);
  root.style.setProperty("--message-size", `${readFontSize("nexiom.fontSize", DEFAULT_CONTENT_FONT_SIZE, 12, 24)}px`);
  root.style.setProperty("--code-size", `${readFontSize("nexiom.codeFontSize", DEFAULT_CODE_FONT_SIZE, 10, 18)}px`);
}

export function initialTheme(): ThemeState {
  const stored = readPreference("nexiom.theme");
  const startupSource = document.documentElement.dataset.startupThemeSource;
  const source: ThemeSource =
    startupSource === "light" || startupSource === "dark" || startupSource === "system"
      ? startupSource
      : stored === "light" || stored === "system"
        ? stored
        : "dark";
  const startupResolved = document.documentElement.dataset.startupTheme;
  return {
    source,
    resolved: startupResolved === "light" || startupResolved === "dark"
      ? startupResolved
      : source === "system"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : source,
  };
}
export function applyTheme(theme: ThemeState) {
  document.documentElement.dataset.theme = theme.resolved;
  document.documentElement.dataset.startupTheme = theme.resolved;
  document.documentElement.style.colorScheme = theme.resolved;
  writePreference("nexiom.theme", theme.source);
}
export function useAppearance() {
  const [theme, setThemeState] = useState<ThemeState>(initialTheme);
  const [reduceMotion, setReduceMotion] = useState(
    () => readPreference("nexiom.reduceMotion") === "true",
  );
  const [fontSize, setFontSize] = useState(() =>
    readFontSize("nexiom.fontSize", DEFAULT_CONTENT_FONT_SIZE, 12, 24),
  );
  const [uiFontSize, setUiFontSize] = useState(() =>
    readFontSize("nexiom.uiFontSize", DEFAULT_UI_FONT_SIZE, 12, 20),
  );
  const [codeFontSize, setCodeFontSize] = useState(() =>
    readFontSize("nexiom.codeFontSize", DEFAULT_CODE_FONT_SIZE, 10, 18),
  );
  useEffect(() => {
    const accept = (value: ThemeState) => {
      applyTheme(value);
      setThemeState(value);
    };
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => {
      if (readPreference("nexiom.theme") === "system")
        accept({
          source: "system",
          resolved: media.matches ? "dark" : "light",
        });
    };
    media.addEventListener("change", changed);
    void window.nexiom
      ?.getTheme?.()
      .then(accept)
      .catch(() => {});
    const unsubscribe = window.nexiom?.onThemeChanged?.(accept);
    applyTheme(initialTheme());
    return () => {
      media.removeEventListener("change", changed);
      unsubscribe?.();
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.reduceMotion = String(reduceMotion);
    writePreference("nexiom.reduceMotion", String(reduceMotion));
  }, [reduceMotion]);
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--message-size",
      `${Math.min(24, Math.max(12, fontSize))}px`,
    );
    writePreference("nexiom.fontSize", String(fontSize));
  }, [fontSize]);
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-font-size", `${uiFontSize}px`);
    writePreference("nexiom.uiFontSize", String(uiFontSize));
  }, [uiFontSize]);
  useEffect(() => {
    document.documentElement.style.setProperty("--code-size", `${codeFontSize}px`);
    writePreference("nexiom.codeFontSize", String(codeFontSize));
  }, [codeFontSize]);
  async function setTheme(source: ThemeSource) {
    const next = window.nexiom?.setTheme
      ? await window.nexiom.setTheme(source)
      : ({
          source,
          resolved:
            source === "system"
              ? matchMedia("(prefers-color-scheme: dark)").matches
                ? "dark"
                : "light"
              : source,
        } as ThemeState);
    applyTheme(next);
    setThemeState(next);
  }
  return {
    theme,
    setTheme,
    reduceMotion,
    setReduceMotion,
    fontSize,
    setFontSize,
    uiFontSize,
    setUiFontSize,
    codeFontSize,
    setCodeFontSize,
  };
}
export type AppearanceState = ReturnType<typeof useAppearance>;

export function AppearanceSettings({
  appearance,
}: {
  appearance: AppearanceState;
}) {
  const [error, setError] = useState("");
  return (
    <div className="appearance-settings">
      <section className="settings-section">
        <h2>主题</h2>
        <div className="settings-card appearance-theme-card">
          <div className="settings-row-copy">
            <strong>应用主题</strong>
            <span>选择浅色、暗色，或随系统自动切换。</span>
          </div>
          <div className="theme-options" role="group" aria-label="主题模式">
            {(
              [
                ["light", "浅色", Sun],
                ["dark", "暗色", Moon],
                ["system", "跟随系统", Monitor],
              ] as const
            ).map(([source, label, Icon]) => (
              <button
                key={source}
                aria-pressed={appearance.theme.source === source}
                onClick={() => {
                  setError("");
                  void appearance
                    .setTheme(source)
                    .catch((error) => setError(error.message));
                }}
              >
                <span className={`theme-preview theme-preview-${source}`}>
                  <i />
                  <b />
                  <em />
                </span>
                <span>
                  <Icon size={15} />
                  {label}
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="settings-section">
        <h2>显示与动画</h2>
        <div className="settings-card">
          <label className="settings-row typography-row">
            <span className="settings-row-copy">
              <strong>界面字号</strong>
              <span>调整整个 NEXIOM 界面的基准字号。</span>
            </span>
            <div className="font-size-control">
              <input
                aria-label="界面字号"
                type="range"
                min={12}
                max={20}
                step={1}
                value={appearance.uiFontSize}
                onChange={(event) =>
                  appearance.setUiFontSize(Number(event.target.value))
                }
              />
              <output>{appearance.uiFontSize} px</output>
            </div>
          </label>
          <label className="settings-row typography-row">
            <span className="settings-row-copy">
              <strong>对话字号</strong>
              <span>调整消息正文的文字大小。</span>
            </span>
            <div className="font-size-control">
              <input
                aria-label="对话字号"
                type="range"
                min={12}
                max={24}
                step={1}
                value={appearance.fontSize}
                onChange={(event) =>
                  appearance.setFontSize(Number(event.target.value))
                }
              />
              <output>{appearance.fontSize} px</output>
            </div>
          </label>
          <label className="settings-row typography-row">
            <span className="settings-row-copy">
              <strong>代码字号</strong>
              <span>调整代码块、工具输出和文件预览的文字大小。</span>
            </span>
            <div className="font-size-control">
              <input
                aria-label="代码字号"
                type="range"
                min={10}
                max={18}
                step={1}
                value={appearance.codeFontSize}
                onChange={(event) =>
                  appearance.setCodeFontSize(Number(event.target.value))
                }
              />
              <output>{appearance.codeFontSize} px</output>
            </div>
          </label>
          <label className="settings-row">
            <span className="settings-row-copy">
              <strong>减少动态效果</strong>
              <span>暂停状态动画，减少界面切换时的运动。</span>
            </span>
            <input
              aria-label="减少动态效果"
              className="switch"
              type="checkbox"
              checked={appearance.reduceMotion}
              onChange={(event) =>
                appearance.setReduceMotion(event.target.checked)
              }
            />
          </label>
          <div className="settings-row motion-preview">
            <div className="nexiom-task-palette" aria-label="七种任务状态动画预览">
              {(Object.keys(AGENT_TASK_STATES) as AgentTaskKind[]).map((kind) => (
                <AgentTaskStatus key={kind} kind={kind} paused={appearance.reduceMotion} compact />
              ))}
            </div>
          </div>
        </div>
        <p className="settings-section-description">
          外观设置即时生效，并保存在当前设备。
        </p>
      </section>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
