from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_pattern_library(corpus_root: str | Path | None = None) -> dict[str, Any]:
    root = Path(corpus_root).expanduser().resolve() if corpus_root else Path(__file__).resolve().parents[3] / "corpus"
    path = root / "pattern_library.json"
    if not path.is_file():
        return {"schema_version": "visual_pattern_library/1.0.0", "patterns": []}
    return json.loads(path.read_text(encoding="utf-8"))


def corpus_examples_for_prompt(corpus_root: str | Path | None = None) -> list[dict[str, Any]]:
    return [
        {
            "id": item.get("id"),
            "kind": item.get("kind"),
            "text_markers": item.get("text_markers", []),
            "reason": item.get("reason"),
            "visual_form": item.get("visual_form"),
        }
        for item in load_pattern_library(corpus_root).get("patterns", [])
    ]

