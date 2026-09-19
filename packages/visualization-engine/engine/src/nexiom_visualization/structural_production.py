from __future__ import annotations

from collections import defaultdict, deque
from pathlib import Path
import re
import textwrap
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, FancyArrowPatch, FancyBboxPatch, Rectangle

from .artifacts import write_json
from .recommenders.palette_recommender import rank_palette_candidates


def _font_family() -> str:
    from matplotlib import font_manager

    available = {item.name for item in font_manager.fontManager.ttflist}
    for candidate in ("Microsoft YaHei", "Noto Sans CJK SC", "SimHei", "Arial Unicode MS"):
        if candidate in available:
            return candidate
    return "DejaVu Sans"


def _slug(value: str, fallback: str) -> str:
    normalized = re.sub(r"[^0-9A-Za-z_-]+", "_", value).strip("_")
    return normalized or fallback


def _normalize_nodes(raw: Any) -> list[dict[str, str]]:
    nodes: list[dict[str, str]] = []
    for index, item in enumerate(raw if isinstance(raw, list) else [], start=1):
        if isinstance(item, dict):
            node_id = str(item.get("id") or f"n{index}")
            label = str(item.get("label") or item.get("name") or node_id)
            detail = str(item.get("detail") or item.get("subtitle") or "")
            group = str(item.get("group") or item.get("stage") or "")
        else:
            node_id, label, detail, group = f"n{index}", str(item), "", ""
        nodes.append({"id": node_id, "label": label, "detail": detail, "group": group})
    return nodes


def _normalize_edges(raw: Any, node_ids: set[str]) -> list[dict[str, str]]:
    edges: list[dict[str, str]] = []
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, dict):
            source = str(item.get("source") or item.get("from") or "")
            target = str(item.get("target") or item.get("to") or "")
            label = str(item.get("label") or item.get("relation") or "")
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            source, target = str(item[0]), str(item[1])
            label = str(item[2]) if len(item) > 2 else ""
        else:
            continue
        if source in node_ids and target in node_ids and source != target:
            edges.append({"source": source, "target": target, "label": label})
    return edges


def _layered_positions(nodes: list[dict[str, str]], edges: list[dict[str, str]]) -> dict[str, tuple[float, float]]:
    ids = [item["id"] for item in nodes]
    incoming = {node_id: 0 for node_id in ids}
    outgoing: dict[str, list[str]] = defaultdict(list)
    for edge in edges:
        outgoing[edge["source"]].append(edge["target"])
        incoming[edge["target"]] += 1
    queue = deque(node_id for node_id in ids if incoming[node_id] == 0)
    level = {node_id: 0 for node_id in ids}
    visited: list[str] = []
    while queue:
        node_id = queue.popleft()
        visited.append(node_id)
        for target in outgoing[node_id]:
            level[target] = max(level[target], level[node_id] + 1)
            incoming[target] -= 1
            if incoming[target] == 0:
                queue.append(target)
    if len(visited) != len(ids):
        level = {node_id: index for index, node_id in enumerate(ids)}
    by_level: dict[int, list[str]] = defaultdict(list)
    for node_id in ids:
        by_level[level[node_id]].append(node_id)
    max_level = max(by_level, default=0)
    positions: dict[str, tuple[float, float]] = {}
    for layer, layer_ids in sorted(by_level.items()):
        x = 0.09 + (0.82 * layer / max(1, max_level))
        for index, node_id in enumerate(layer_ids):
            count = len(layer_ids)
            y = 0.5 if count == 1 else 0.82 - index * (0.64 / (count - 1))
            positions[node_id] = (x, y)
    return positions


def _render_data_origin_schematic(
    decision: dict[str, Any], output_dir: Path, record: dict[str, Any], palette: Any,
) -> dict[str, Any]:
    """Render a domain/data-provenance illustration instead of a generic workflow."""
    colors = list(palette.get("colors", []))
    teal = colors[2] if len(colors) > 2 else "#4EA8C0"
    orange = colors[3] if len(colors) > 3 else "#E67E22"
    pale_teal, pale_orange = "#E8F4F5", "#FFF0E2"
    ink, muted, line = "#263238", "#66727A", "#A7B0B6"
    plt.rcParams.update({"font.family": _font_family(), "axes.unicode_minus": False})
    fig, ax = plt.subplots(figsize=(10.2, 4.25), facecolor="#FFFFFF")
    ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis("off")

    def cohort_card(x: float, y: float, label: str, count: str, edge: str, fill: str) -> None:
        card = FancyBboxPatch((x, y), 0.235, 0.225, boxstyle="round,pad=0.012,rounding_size=0.025",
                              facecolor=fill, edgecolor=edge, linewidth=1.35, zorder=2)
        ax.add_patch(card)
        ax.add_patch(Circle((x + 0.050, y + 0.145), 0.026, facecolor=edge, edgecolor="none", zorder=3))
        ax.add_patch(FancyBboxPatch((x + 0.025, y + 0.055), 0.050, 0.075,
                                    boxstyle="round,pad=0.006,rounding_size=0.016",
                                    facecolor=edge, edgecolor="none", zorder=3))
        ax.text(x + 0.092, y + 0.142, label, ha="left", va="center", fontsize=10.0,
                color=ink, weight="semibold")
        ax.text(x + 0.092, y + 0.083, count, ha="left", va="center", fontsize=8.6, color=muted)

    cohort_card(0.035, 0.635, "健康对照组", "52 例", teal, pale_teal)
    cohort_card(0.035, 0.145, "流感 A 患者组", "478 例", orange, pale_orange)
    ax.text(0.152, 0.925, "研究对象", ha="center", va="center", fontsize=9.2, color=muted)

    # Two cohorts converge on the same blood-sample representation.
    for y in (0.745, 0.255):
        ax.add_patch(FancyArrowPatch((0.282, y), (0.425, 0.50), connectionstyle="arc3,rad=0.0",
                                     arrowstyle="-|>", mutation_scale=15, linewidth=1.45,
                                     color=line, zorder=1))
    ax.text(0.390, 0.765, "同一检测口径", ha="center", va="center", fontsize=8.2, color=muted)

    # Blood collection tube.
    ax.add_patch(FancyBboxPatch((0.448, 0.272), 0.075, 0.390,
                                boxstyle="round,pad=0.004,rounding_size=0.025",
                                facecolor="#F7FAFA", edgecolor="#8E989E", linewidth=1.25, zorder=2))
    ax.add_patch(Rectangle((0.455, 0.278), 0.061, 0.245, facecolor="#9F2F2F", edgecolor="none", zorder=3))
    ax.add_patch(Rectangle((0.448, 0.640), 0.075, 0.055, facecolor=orange, edgecolor="#B95F2B", linewidth=1.0, zorder=4))
    ax.text(0.486, 0.925, "血液样本", ha="center", va="center", fontsize=9.2, color=muted)
    ax.text(0.486, 0.205, "形成统一分析表", ha="center", va="center", fontsize=8.6, color=ink)
    ax.add_patch(FancyArrowPatch((0.545, 0.50), (0.582, 0.50), arrowstyle="-|>", mutation_scale=16,
                                 linewidth=1.55, color=line, zorder=5))

    # Blood-cell composition: visually show where the model variables come from.
    center = (0.795, 0.50)
    ax.add_patch(Circle(center, 0.205, facecolor="#FFFDFC", edgecolor="#D7A09B", linewidth=1.45, zorder=1))
    cell_specs = [
        (0.720, 0.585, 0.047, "WBC", "#8D80AC"),
        (0.820, 0.620, 0.041, "N", "#D88782"),
        (0.790, 0.495, 0.038, "L", "#7FA7C9"),
        (0.710, 0.405, 0.042, "M", "#A88BB2"),
        (0.865, 0.405, 0.017, "PLT", "#D9A569"),
    ]
    for cx, cy, radius, label, color in cell_specs:
        ax.add_patch(Circle((cx, cy), radius, facecolor=color, edgecolor="#FFFFFF", linewidth=1.3, zorder=3))
        ax.text(cx, cy - radius - 0.027, label, ha="center", va="top", fontsize=8.0, color=ink, weight="semibold")
    ax.text(0.795, 0.925, "血常规观测", ha="center", va="center", fontsize=9.2, color=muted)
    ax.text(0.795, 0.205, "细胞总量与分类计数", ha="center", va="center", fontsize=8.6, color=ink)
    ax.text(0.795, 0.105, "WBC、N、L、M、RBC、HB、PLT、RDW", ha="center", va="center",
            fontsize=8.1, color=muted)

    output_dir.mkdir(parents=True, exist_ok=True)
    for extension in ("png", "pdf", "svg"):
        target = output_dir / f"{record['figure_id']}.{extension}"
        fig.savefig(target, dpi=300 if extension == "png" else None, bbox_inches="tight",
                    pad_inches=0.08, facecolor="#FFFFFF")
        record["files"][extension] = str(target.resolve())
    plt.close(fig)
    record["palette_id"] = str(palette.get("palette_id", ""))
    record["node_count"] = len(_normalize_nodes(decision.get("nodes")))
    record["edge_count"] = len(_normalize_edges(decision.get("edges"), {item["id"] for item in _normalize_nodes(decision.get("nodes"))}))
    return record


def _render_one(decision: dict[str, Any], output_dir: Path, index: int) -> dict[str, Any]:
    opportunity_id = str(decision.get("opportunity_id") or f"structural_{index:02d}")
    figure_id = _slug(str(decision.get("figure_id") or opportunity_id), f"structural_{index:02d}")
    nodes = _normalize_nodes(decision.get("nodes"))
    edges = _normalize_edges(decision.get("edges"), {item["id"] for item in nodes})
    record: dict[str, Any] = {
        "figure_id": figure_id,
        "opportunity_id": opportunity_id,
        "visual_role": str(decision.get("visual_role", "")),
        "selected_grammar": str(decision.get("selected_grammar", "")),
        "files": {},
        "blocking_issues": [],
        "manual_adjustment_queue": [],
    }
    if len(nodes) < 2:
        record["blocking_issues"].append({
            "type": "missing_structural_spec",
            "detail": "保留的结构图未提供至少两个证据绑定节点，不能把文字建议冒充已落地图。",
        })
        return record
    if len(nodes) > 12:
        record["blocking_issues"].append({
            "type": "structural_overload",
            "detail": f"结构图包含 {len(nodes)} 个节点，超过正文单图可读上限 12；应拆解论证任务。",
        })
        return record
    if not edges and len(nodes) > 2:
        record["blocking_issues"].append({
            "type": "missing_structural_relations",
            "detail": "结构图未提供节点关系，无法证明其优于结构化文字。",
        })
        return record

    request = {
        "kind": "conceptual_diagram",
        "purpose": decision.get("reader_question", ""),
        "candidate_visuals": [decision.get("selected_grammar", "")],
    }
    palette = rank_palette_candidates(request, "conceptual_diagram", limit=1)[0]
    if "数据来源与变量构成" in str(decision.get("selected_grammar", "")):
        return _render_data_origin_schematic(decision, output_dir, record, palette)
    colors = list(palette["colors"])
    background = "#FFFFFF"
    ink = "#263238"
    positions = _layered_positions(nodes, edges)
    plt.rcParams.update({"font.family": _font_family(), "axes.unicode_minus": False})
    # Long horizontal workflows need real width; otherwise the renderer can
    # technically succeed while node and edge labels collide.
    max_layer = max((position[0] for position in positions.values()), default=0)
    horizontal_chain = len(nodes) >= 5 and len({round(y, 3) for _, y in positions.values()}) == 1
    fig_width = max(10.2, 2.25 * len(nodes)) if horizontal_chain else 10.2
    fig, ax = plt.subplots(figsize=(fig_width, 5.4), facecolor=background)
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")

    for edge in edges:
        x1, y1 = positions[edge["source"]]
        x2, y2 = positions[edge["target"]]
        ax.annotate(
            "", xy=(x2 - 0.075, y2), xytext=(x1 + 0.075, y1),
            arrowprops={"arrowstyle": "-|>", "color": "#7C8790", "lw": 1.6, "shrinkA": 1, "shrinkB": 1},
            zorder=1,
        )
        if edge["label"]:
            edge_label = "\n".join(textwrap.wrap(edge["label"], width=8, break_long_words=True))
            ax.text((x1 + x2) / 2, (y1 + y2) / 2 + 0.135, edge_label, ha="center", va="center", fontsize=7.2, color="#5F6B73")

    for node_index, node in enumerate(nodes):
        x, y = positions[node["id"]]
        color = colors[node_index % len(colors)] if colors else "#5B8E9E"
        box = FancyBboxPatch(
            (x - 0.075, y - 0.07), 0.15, 0.14,
            boxstyle="round,pad=0.012,rounding_size=0.018",
            linewidth=1.5, edgecolor=color, facecolor=background, zorder=2,
        )
        ax.add_patch(box)
        label = "\n".join(textwrap.wrap(node["label"], width=8, break_long_words=True))
        ax.text(x, y + (0.012 if node["detail"] else 0), label, ha="center", va="center", fontsize=8.8, color=ink, weight="semibold", zorder=3)
        if node["detail"]:
            detail = "\n".join(textwrap.wrap(node["detail"], width=13, break_long_words=True))
            ax.text(x, y - 0.047, detail, ha="center", va="center", fontsize=7.4, color="#66727A", zorder=3)

    output_dir.mkdir(parents=True, exist_ok=True)
    for extension in ("png", "pdf", "svg"):
        target = output_dir / f"{figure_id}.{extension}"
        fig.savefig(target, dpi=300 if extension == "png" else None, bbox_inches="tight", pad_inches=0.08, facecolor=background)
        record["files"][extension] = str(target.resolve())
    plt.close(fig)
    record["palette_id"] = palette["palette_id"]
    record["node_count"] = len(nodes)
    record["edge_count"] = len(edges)
    return record


def render_structural_figures(decisions: list[dict[str, Any]], output_dir: str | Path) -> dict[str, Any]:
    output = Path(output_dir).expanduser().resolve()
    kept = [item for item in decisions if item.get("decision") == "keep"]
    records = [_render_one(item, output / "figures", index) for index, item in enumerate(kept, start=1)]
    ready = sum(not item["blocking_issues"] for item in records)
    result = {
        "schema_version": "structural_visual_production/1.0.0",
        "status": "formal_landing_ready" if ready == len(records) else "blocked",
        "summary": {"requested": len(records), "production_ready": ready, "blocked": len(records) - ready},
        "figures": records,
    }
    manifest = write_json(output / "structural_visual_production_manifest-1.0.0.json", result)
    return {**result, "manifest_path": str(manifest)}
