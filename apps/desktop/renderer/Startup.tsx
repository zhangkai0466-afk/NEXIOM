import { useEffect, useId, useState, type CSSProperties } from "react";
import { App } from "./App";
import { readPreference } from "./preferences";
import "./startup-animation.css";

const DRAWING_DURATION = 2900;
const EXIT_DURATION = 420;

function useReducedStartupMotion() {
  const [reduced, setReduced] = useState(
    () => readPreference("nexiom.reduceMotion") === "true" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(
      readPreference("nexiom.reduceMotion") === "true" || media.matches,
    );
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

function StartupMark({ reduced }: { reduced: boolean }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      className={`boot-brand${reduced ? " boot-brand-still" : ""}`}
      viewBox="0 0 560 160"
      aria-hidden="true"
    >
      <defs>
        {/* Trace the two ribbons in opposite directions, preserving the Agent logo. */}
        <mask id={`${id}-upper`} maskUnits="userSpaceOnUse" x="20" y="7" width="72" height="100">
          <path className="boot-trace" pathLength="1" d="M75 72 35 25 35 70 53 92" />
        </mask>
        <mask id={`${id}-lower`} maskUnits="userSpaceOnUse" x="20" y="7" width="72" height="100">
          <path className="boot-trace" pathLength="1" d="M37 42 77 89 77 44 59 22" />
        </mask>
        <clipPath id={`${id}-word`}>
          <path className="boot-word-curtain" d="M168 36H520V124H168Z" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}-word)`}>
        {Array.from("NEXIOM").map((letter, index) => (
          <g key={letter} className="boot-letter" style={{ "--letter": index } as CSSProperties}>
            <text x={[190, 247, 294, 344, 373, 431][index]} y="99">{letter}</text>
          </g>
        ))}
      </g>
      <g className="boot-symbol">
        <path className="boot-symbol-cover" d="M-560-200H324V360H-560Z" />
        <svg x="234" y="16" width="92" height="128" viewBox="20 7 72 100">
          <path fill="currentColor" mask={`url(#${id}-upper)`} d="M31 17V72L46 87V76L39 69V36L66 63V52Z" />
          <path fill="currentColor" mask={`url(#${id}-lower)`} d="M66 27V38L73 45V78L46 51V62L81 97V42Z" />
        </svg>
      </g>
    </svg>
  );
}

export function StartupPreview() {
  const [replay, setReplay] = useState(0);
  const reduced = useReducedStartupMotion();
  return (
    <main className="boot-preview">
      <div className="boot-stage" role="img" aria-label="NEXIOM 启动动画：双线展开，字标向右滑出">
        <StartupMark key={replay} reduced={reduced} />
      </div>
      <footer className="boot-preview-controls">
        <span>NEXIOM <i /> 启动动画</span>
        <button onClick={() => setReplay((value) => value + 1)} aria-label="重播启动动画">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M4 10a8 8 0 1 1 1 7M4 4v6h6" />
          </svg>
          重播
        </button>
      </footer>
    </main>
  );
}

export function Startup() {
  const reduced = useReducedStartupMotion();
  const [presented, setPresented] = useState(() => !window.nexiom?.whenWindowShown);
  const [ready, setReady] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [expired, setExpired] = useState(false);
  const [finished, setFinished] = useState(false);
  const exiting = drawn && (ready || expired);

  useEffect(() => {
    let active = true;
    const start = () => { if (active) setPresented(true); };
    void window.nexiom?.whenWindowShown?.().then(start, start);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!presented) return;
    const timer = window.setTimeout(() => setDrawn(true), reduced ? 120 : DRAWING_DURATION);
    return () => window.clearTimeout(timer);
  }, [presented, reduced]);

  useEffect(() => {
    if (!presented) return;
    // A slow core must not trap the user behind a decorative animation.
    const timer = window.setTimeout(() => setExpired(true), 6500);
    return () => window.clearTimeout(timer);
  }, [presented]);

  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(() => {
      setFinished(true);
      document.documentElement.removeAttribute("data-starting");
      window.nexiom?.reportStartupComplete?.();
    }, reduced ? 0 : EXIT_DURATION);
    return () => window.clearTimeout(timer);
  }, [exiting, reduced]);

  return (
    <>
      <div className="boot-workspace" inert={!finished} aria-hidden={!finished ? true : undefined}>
        <App onStartupReady={setReady} />
      </div>
      {!finished && (
        <div className={`boot-overlay${!presented ? " boot-waiting" : ""}${exiting ? " boot-exit" : ""}`} role="status" aria-label="正在启动 NEXIOM">
          <div className="boot-drag-region" />
          <div className="boot-stage"><StartupMark reduced={reduced} /></div>
        </div>
      )}
    </>
  );
}
