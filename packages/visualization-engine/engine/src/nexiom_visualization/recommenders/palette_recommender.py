from __future__ import annotations

import re
from typing import Any


HEATMAP_PREFERRED_PALETTE_ID = "mist-blue-terracotta-10"


def _palettes() -> tuple[Any, ...]:
    """Read the live palette platform catalog; never maintain a shadow copy."""
    from scientific_palette_studio.catalog import load_palettes

    return load_palettes()


def palette_catalog_for_model() -> list[dict[str, Any]]:
    """Expose enough visual semantics for the configured model to make an aesthetic choice."""
    catalog: list[dict[str, Any]] = []
    for palette in _palettes():
        catalog.append({
            "palette_id": palette.id,
            "name": palette.name,
            "name_en": palette.name_en,
            "kind": palette.kind,
            "count": palette.count,
            "description": palette.description,
            "tags": list(palette.tags),
            "background": palette.background,
            "ink": palette.ink,
            "accent_index": palette.accent_index,
            "colors": [
                {"name": color.name, "hex": color.hex, "role": color.role}
                for color in palette.colors
            ],
            "catalog_source": "studio/data/palettes.json",
        })
    return catalog


def _request_text(request: dict[str, Any], template_id: str) -> str:
    parts = [
        template_id,
        str(request.get("kind", "")),
        str(request.get("purpose", "")),
        str(request.get("reader_question", "")),
        str(request.get("caption_intent", "")),
        " ".join(str(value) for value in request.get("candidate_visuals", [])),
    ]
    return " ".join(parts).lower()


def _tokens(text: str) -> set[str]:
    return {token for token in re.split(r"[^0-9a-zA-Z\u4e00-\u9fff]+", text) if token}


def rank_palette_candidates(
    request: dict[str, Any],
    template_id: str,
    *,
    limit: int = 6,
) -> list[dict[str, Any]]:
    """Rank, but do not hard-code, palette choices from the live aesthetic platform."""
    text = _request_text(request, template_id)
    text_tokens = _tokens(text)
    heatmap_like = "heatmap" in template_id or any(word in text for word in ("热力图", "矩阵", "偏差", "相关性", "双向效应"))
    continuous_like = heatmap_like or any(word in text for word in ("连续", "密度", "强度", "效应方向", "渐变"))
    candidates: list[dict[str, Any]] = []
    for palette in _palettes():
        score = 0
        reasons: list[str] = []
        if heatmap_like and palette.id == HEATMAP_PREFERRED_PALETTE_ID:
            score += 120
            reasons.append("热力图优先：雾蓝陶橙")
        if continuous_like and palette.kind == "continuous":
            score += 45
            reasons.append("连续/矩阵语义匹配")
        if not continuous_like and palette.kind == "categorical":
            score += 35
            reasons.append("离散系列语义匹配")
        tag_hits = [tag for tag in palette.tags if str(tag).lower() in text or str(tag).lower() in text_tokens]
        if tag_hits:
            score += min(36, 9 * len(tag_hits))
            reasons.append("命中标签：" + "、".join(tag_hits))
        if palette.id == "teal-ember-9":
            score += 2  # stable final fallback, never stronger than semantic matching
        candidates.append({
            "palette_id": palette.id,
            "name": palette.name,
            "kind": palette.kind,
            "score": score,
            "selection_signals": reasons or ["由设计模型结合完整色板审美选择"],
            "description": palette.description,
            "tags": list(palette.tags),
            "colors": list(palette.hex_colors),
        })
    candidates.sort(key=lambda item: (-item["score"], item["palette_id"]))
    return candidates[:limit]


def preferred_palette_id(request: dict[str, Any], template_id: str) -> str:
    candidates = rank_palette_candidates(request, template_id, limit=1)
    return str(candidates[0]["palette_id"]) if candidates else "teal-ember-9"


def validate_palette_for_template(palette_id: str, template_id: str) -> bool:
    palette = next((item for item in _palettes() if item.id == palette_id), None)
    if palette is None:
        return False
    if "heatmap" in template_id:
        return palette.kind == "continuous"
    return True
