from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import re
import threading
from typing import Any


_EVENT_LOCK = threading.Lock()


def safe_name(value: str) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fff]+", "_", value.strip()).strip("_")
    return cleaned or "visual_design"


def create_run_dir(root: str | Path, run_name: str) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base = Path(root).expanduser().resolve()
    base.mkdir(parents=True, exist_ok=True)
    candidate = base / f"{timestamp}_{safe_name(run_name)}"
    suffix = 1
    while candidate.exists():
        candidate = base / f"{timestamp}_{safe_name(run_name)}_{suffix:02d}"
        suffix += 1
    candidate.mkdir(parents=True, exist_ok=False)
    return candidate


def write_json(path: str | Path, value: Any) -> Path:
    target = Path(path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return target


def write_text(path: str | Path, value: str) -> Path:
    target = Path(path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value.rstrip() + "\n", encoding="utf-8")
    return target


def append_visualization_event(output_dir: str | Path, event_type: str, **payload: Any) -> Path:
    path = Path(output_dir).expanduser().resolve() / "visualization_events" / "meeting-events.jsonl"
    record = {
        "event_type": event_type,
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        **payload,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with _EVENT_LOCK:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
    return path

