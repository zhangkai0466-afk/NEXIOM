from __future__ import annotations

import json
from pathlib import Path
import re
from typing import Any


def _patterns(corpus_root: str | Path | None = None) -> list[dict[str, Any]]:
    root = Path(corpus_root).expanduser().resolve() if corpus_root else Path(__file__).resolve().parents[3] / "corpus"
    path = root / "pattern_library.json"
    if not path.is_file():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload.get("patterns", []) if isinstance(payload, dict) else []


def detect_missing_figures(
    section_context: str,
    visual_requests: list[dict[str, Any]],
    *,
    corpus_root: str | Path | None = None,
) -> list[dict[str, Any]]:
    context = re.sub(r"\s+", " ", section_context).strip()
    existing_text = " ".join(
        " ".join(str(request.get(key, "")) for key in ("kind", "purpose", "caption_intent"))
        for request in visual_requests
    )
    suggestions: list[dict[str, Any]] = []
    for pattern in _patterns(corpus_root):
        markers = [str(marker) for marker in pattern.get("text_markers", []) if str(marker)]
        matched = [marker for marker in markers if marker.lower() in context.lower()]
        minimum = max(1, int(pattern.get("minimum_marker_matches", 1)))
        kind = str(pattern.get("kind", "mechanism_diagram"))
        suppress_markers = [kind, *[str(item) for item in pattern.get("existing_request_markers", [])]]
        already_requested = any(marker and marker.lower() in existing_text.lower() for marker in suppress_markers)
        if len(matched) < minimum or already_requested:
            continue
        suffix = str(pattern.get("id", "gap")).replace("pattern_", "")
        suggestions.append({
            "figure_id": f"vis_{suffix}_supplement",
            "kind": kind,
            "reason": str(pattern.get("reason", "章节存在难以仅用文字表达的读者障碍。")),
            "placement_hint": str(pattern.get("placement_hint", "相关分类讨论段落之后")),
            "ai_prompt": str(pattern.get("ai_prompt_template", "")),
            "matched_markers": matched,
            "source_pattern_id": pattern.get("id"),
            "requires_codex_editorial_review": True,
        })
    return suggestions

