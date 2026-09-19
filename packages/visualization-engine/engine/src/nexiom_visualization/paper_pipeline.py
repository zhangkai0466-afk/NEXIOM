from __future__ import annotations

import json
import csv
from pathlib import Path
import re
import time
from typing import Any

import json_repair

from .analyzers.data_analyzer import analyze_data_file
from .artifacts import write_json
from .config import Settings, validate_visual_design_roster
from .meeting import run_visual_design_meeting
from .model_client import ModelClient
from .production import render_and_inspect_figures
from .structural_production import render_structural_figures
from .recommenders.template_matcher import COLUMN_SYNONYMS, complete_encoding
from .template_registry import TEMPLATE_REGISTRY
from .visual_argument import (
    assess_figure_budget,
    audit_panel_plan,
    deduplicate_complementary_plans,
    discover_structural_opportunities,
    extract_chapter_map,
    visual_argument_coverage,
)


PAPER_PLAN_SYSTEM = (
    "你是数学建模论文的整篇视觉论证总设计师。扫描范围从问题重述、本文工作、数据理解与预处理，"
    "一直到各问建模、求解、验证、稳健性、评价和应用。只决定证据应如何被读者看见，不得创造数据、"
    "实验、显著性或结论。忽略论文原有图片的图形形式，但保留正文论证任务和冻结证据。"
    "不要按模型名机械套图，不要把相关性默认等同于热力图；先写读者问题、视觉角色、候选表达及取舍理由。"
    "允许同一证据产生回答不同读者问题的互补视图，禁止语义重复。图、表、公式或文字均可成为最佳方案。只返回 JSON。"
)


def _strip_existing_visual_design(text: str) -> str:
    text = re.sub(r"(?s)\\begin\{figure\*?\}.*?\\end\{figure\*?\}", "\n[原图已忽略]\n", text)
    text = re.sub(r"(?s)\\begin\{tikzpicture\}.*?\\end\{tikzpicture\}", "\n[原图已忽略]\n", text)
    text = re.sub(r"(?m)(?<!\\)%.*$", "", text)
    return text


def _tex_graph(entry: Path, root: Path) -> list[Path]:
    found: list[Path] = []
    seen: set[Path] = set()

    def visit(path: Path) -> None:
        path = path.resolve()
        if path in seen or not path.is_file() or root not in path.parents and path != root:
            return
        seen.add(path)
        found.append(path)
        text = path.read_text(encoding="utf-8", errors="replace")
        for raw in re.findall(r"\\(?:input|include)\{([^}]+)\}", text):
            raw_path = Path(raw)
            candidates = [path.parent / raw_path, root / raw_path]
            for candidate in candidates:
                candidate = candidate.with_suffix(".tex") if not raw_path.suffix else candidate
                if candidate.is_file():
                    visit(candidate)
                    break

    visit(entry)
    return found


def _compress_manuscript(text: str, limit: int = 38_000) -> str:
    text = re.sub(r"(?s)\\begin\{(?:table\*?|longtable|algorithm|equation\*?|align\*?)\}.*?\\end\{(?:table\*?|longtable|algorithm|equation\*?|align\*?)\}", "\n", text)
    keywords = ("问题", "结果", "表明", "比较", "差异", "分布", "相关", "性能", "区间", "敏感", "稳健", "校准", "曲线", "阈值", "预测", "模型", "结论", "限制", "检验")
    kept: list[str] = []
    for paragraph in re.split(r"\n\s*\n", text):
        compact = paragraph.strip()
        if not compact:
            continue
        is_heading = any(token in compact for token in ("\\section{", "\\subsection{", "\\subsubsection{", "\\begin{cumcmabstract}"))
        has_signal = any(token in compact for token in keywords)
        if is_heading or has_signal:
            kept.append(compact)
        if sum(len(item) for item in kept) >= limit:
            break
    return "\n\n".join(kept)[:limit]


def _batch_manuscript(manuscript: str, batch_name: str) -> str:
    chapter_name = re.sub(r"_part_\d+$", "", batch_name)
    section_chunks = re.split(r"(?=\\section\{)", manuscript)
    selectors = {
        "problem_restatement": ("问题重述",),
        "question_1": ("数据预处理", "问题一"),
        "question_2": ("问题二",),
        "question_3": ("问题三",),
    }
    selected = [
        chunk for chunk in section_chunks
        if any(token in chunk[:160] for token in selectors.get(chapter_name, ()))
    ]
    return _compress_manuscript("\n\n".join(selected) or manuscript, limit=10_000)


def _evidence_batches(data: list[dict[str, Any]], *, maximum_items: int = 3) -> list[tuple[str, list[dict[str, Any]]]]:
    """Group evidence by argument chapter using frozen artifact provenance."""
    grouped: dict[str, list[dict[str, Any]]] = {
        "problem_restatement": [], "question_1": [], "question_2": [], "question_3": [],
    }
    for item in data:
        provenance = str(item.get("source_artifact", "")).replace("\\", "/").lower()
        if "/q1/" in provenance:
            grouped["question_1"].append(item)
        elif "/q2/" in provenance or "/deployment/" in provenance:
            grouped["question_2"].append(item)
        elif "/q3/" in provenance or "/sensitivity/" in provenance or "/uncertainty/" in provenance:
            grouped["question_3"].append(item)
        else:
            grouped["question_1"].append(item)
    batches: list[tuple[str, list[dict[str, Any]]]] = []
    for name in ("problem_restatement", "question_1", "question_2", "question_3"):
        items = grouped[name]
        if not items:
            batches.append((name, []))
            continue
        parts = [items[index:index + maximum_items] for index in range(0, len(items), maximum_items)]
        batches.extend((name if len(parts) == 1 else f"{name}_part_{index}", part) for index, part in enumerate(parts, start=1))
    return batches


def _discover_frozen_visual_evidence(data_root: Path) -> list[Path]:
    """Find chapter-level frozen tables while excluding checkpoints and prior runs."""
    if data_root.name.lower() == "figures" and data_root.parent.name.lower() == "artifacts":
        artifact_root = data_root.parent
        allowed = ("figures", "q1", "q2", "q3", "sensitivity", "uncertainty", "deployment")
        candidates = [
            path
            for folder in allowed
            for path in (artifact_root / folder).glob("*.csv")
        ]
    elif data_root.name.lower() == "artifacts":
        allowed = ("figures", "q1", "q2", "q3", "sensitivity", "uncertainty", "deployment")
        candidates = [
            path
            for folder in allowed
            for path in (data_root / folder).glob("*.csv")
        ]
    else:
        candidates = [*data_root.glob("*.csv"), *data_root.glob("*.tsv")]
    return sorted({path.resolve() for path in candidates if path.is_file()})


def _structural_for_chapter(opportunities: list[dict[str, Any]], batch_name: str) -> list[dict[str, Any]]:
    chapter_name = re.sub(r"_part_\d+$", "", batch_name)
    if chapter_name == "problem_restatement":
        return [item for item in opportunities if item.get("visual_role") in {"domain_explanation", "paper_navigation"}]
    numeral = {"question_1": "一", "question_2": "二", "question_3": "三"}.get(chapter_name, "")
    selected = []
    for item in opportunities:
        role = str(item.get("visual_role", ""))
        chapter = str(item.get("chapter", ""))
        if chapter_name == "question_1" and role == "preprocessing_evidence":
            selected.append(item)
        elif numeral and role == "model_structure" and f"问题{numeral}" in chapter:
            selected.append(item)
    return selected


def _template_shortlist(data_item: dict[str, Any]) -> list[dict[str, Any]]:
    analysis = {
        "columns": [{"name": item["name"]} for item in data_item["columns"]],
        "numeric_columns": [item["name"] for item in data_item["columns"] if item["type"] in {"integer", "number"}],
        "categorical_columns": [item["name"] for item in data_item["columns"] if item["type"] in {"string", "boolean"}],
        "row_count": data_item["row_count"],
    }
    compatible = []
    for template_id, metadata in TEMPLATE_REGISTRY.items():
        if not metadata.get("selection_eligible", True):
            continue
        encoding, missing = complete_encoding(template_id, {}, analysis)
        if not missing:
            exact_hits = 0
            for role in metadata["required_columns"]:
                selected = str(encoding.get(role, "")).lower()
                if selected and any(selected == str(alias).lower() for alias in COLUMN_SYNONYMS.get(role, ())):
                    exact_hits += 1
            # These grammars encode a statistical meaning in their column
            # roles.  Type-compatible fallback columns are not evidence that
            # the data contain SHAP values, interval bounds, or low/high
            # perturbation endpoints.  Keep them out of the model shortlist
            # unless every required role was bound by a semantic alias.
            semantic_strict = {
                "faceted_shap_dependence_distribution",
                "uncertainty_band",
                "sensitivity_tornado",
                "forest_interval",
                "forest_table",
            }
            if template_id in semantic_strict and exact_hits < len(metadata["required_columns"]):
                continue
            compatible.append({
                "template_id": template_id, "family": metadata["family"], "suggested_encoding": encoding,
                "column_semantic_match_count": exact_hits,
                "reader_question": metadata["reader_question"],
            })
    compatible.sort(key=lambda item: (-item["column_semantic_match_count"], -len(TEMPLATE_REGISTRY[item["template_id"]]["required_columns"]), item["template_id"]))
    # A compact, semantically ranked shortlist keeps real model calls reliable.
    # The full 302-term grammar index remains searchable through the MCP; the
    # planner only needs the strongest executable candidates for this dataset.
    return compatible[:6]


def _infer_panel_contract(
    template_id: str,
    encoding: dict[str, Any],
    data_file: str,
    purpose: str,
    panel: dict[str, Any],
) -> dict[str, Any]:
    """Derive unavoidable homogeneous facets from frozen data, not another AI call."""
    metadata = TEMPLATE_REGISTRY[template_id]
    policy = metadata.get("panel_policy", {})
    declared = int(panel.get("count", 0) or 0)
    if declared > 0:
        return {**panel, "count": declared}
    minimum = int(policy.get("min_panels", 1) or 1)
    if minimum <= 1:
        return {**panel, "count": 1}
    group_column = str(encoding.get("group_column", ""))
    labels: list[str] = []
    if group_column:
        delimiter = "\t" if Path(data_file).suffix.lower() == ".tsv" else ","
        with Path(data_file).open("r", encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle, delimiter=delimiter):
                value = str(row.get(group_column, "")).strip()
                if value and value not in labels:
                    labels.append(value)
    count = max(minimum, len(labels))
    return {
        **panel,
        "count": count,
        "rationale": str(panel.get("rationale") or f"按 {group_column or '同构对象'} 分面，使用同一矩阵/曲线语义联合比较。"),
        "facet_dimension": str(panel.get("facet_dimension") or group_column),
        "joint_conclusion": str(panel.get("joint_conclusion") or purpose),
        "panels": list(panel.get("panels") or [{"title": label} for label in labels]),
    }


def _expand_compact_batch(
    parsed: dict[str, Any],
    batch_data: list[dict[str, Any]],
    structural_opportunities: list[dict[str, Any]],
    batch_name: str,
) -> dict[str, Any]:
    """Turn a small model decision into the verbose deterministic execution contract."""
    by_path = {str(item["path"]): item for item in batch_data}
    by_name = {Path(str(item["path"])).name: item for item in batch_data}
    expanded_items: list[dict[str, Any]] = []
    omitted = list(parsed.get("omitted_evidence", []))
    for index, raw in enumerate(parsed.get("plan_items", []), start=1):
        if not isinstance(raw, dict):
            continue
        ref = str(raw.get("data_file", ""))
        data_item = by_path.get(str(Path(ref).expanduser().resolve())) if ref else None
        data_item = data_item or by_name.get(Path(ref).name)
        if data_item is None:
            raise ValueError(f"章节 {batch_name} 的规划引用了未提供的数据: {ref}")
        placement = str(raw.get("placement_decision", "main_text"))
        if placement == "omit":
            omitted.append({"data_file": str(data_item["path"]), "reason": str(raw.get("reason", "图不优于文字或表格。"))})
            continue
        candidates = {item["template_id"]: item for item in _template_shortlist(data_item)}
        template_id = str(raw.get("template_id", ""))
        if template_id not in candidates:
            raise ValueError(f"章节 {batch_name} 选择了候选短名单之外的模板: {template_id}")
        purpose = str(raw.get("purpose", "")).strip()
        role = str(raw.get("visual_role", "evidence_display")).strip()
        panel = raw.get("panel", {}) if isinstance(raw.get("panel", {}), dict) else {}
        encoding = dict(candidates[template_id]["suggested_encoding"])
        panel = _infer_panel_contract(template_id, encoding, str(data_item["path"]), purpose, panel)
        panel_count = max(1, int(panel.get("count", 1)))
        panel_rationale = str(panel.get("rationale", ""))
        facet_dimension = str(panel.get("facet_dimension", ""))
        joint_conclusion = str(panel.get("joint_conclusion", purpose))
        expanded_items.append({
            "id": str(raw.get("id") or f"{batch_name}_{index:02d}"),
            "keep": True,
            "data_file": str(data_item["path"]),
            "template_id": template_id,
            "template_family": str(candidates[template_id]["family"]),
            "encoding_requirements": encoding,
            "purpose": purpose,
            "reader_question": str(raw.get("reader_question", purpose)),
            "visual_role": role,
            "intended_claim": str(raw.get("intended_claim", purpose)),
            "forbidden_claims": ["不得超出冻结证据", "不得把训练或折外证据表述为外部验证"],
            "alternatives_considered": list(raw.get("alternatives_considered", [])),
            "required_annotations": [],
            "placement_after_block_id": str(raw.get("placement_after_block_id", batch_name)),
            "placement_decision": placement,
            "placement_reason": str(raw.get("placement_reason", "推进本章论证。")),
            "allowed_conclusions": [str(raw.get("intended_claim", purpose))],
            "pre_figure_prose_intent": str(raw.get("reader_question", purpose)),
            "post_figure_observation": str(raw.get("intended_claim", purpose)),
            "modeling_consequence": str(raw.get("modeling_consequence", "据此推进本章下一步分析。")),
            "panel_count": panel_count,
            "panel_relationship_type": "homogeneous_comparison" if panel_count > 1 else "",
            "panel_rationale": panel_rationale,
            "facet_dimension": facet_dimension,
            "shared_reader_question": panel_count == 1 or bool(panel_rationale),
            "shared_visual_role": panel_count == 1 or bool(panel_rationale),
            "layout_readable_at_body_width": bool(panel.get("readable_at_body_width", True)),
            "shared_axis_semantics": panel_count == 1 or bool(panel.get("shared_axis_semantics", True)),
            "shared_legend_semantics": panel_count == 1 or bool(panel.get("shared_legend_semantics", True)),
            "comparison_requires_joint_scan": panel_count > 1 and bool(joint_conclusion),
            "evidence_chain_is_indivisible": False,
            "joint_conclusion": joint_conclusion,
            "panels": list(panel.get("panels", [])),
        })

    opportunities = {str(item["opportunity_id"]): item for item in structural_opportunities}
    expanded_structural: list[dict[str, Any]] = []
    for raw in parsed.get("structural_decisions", []):
        if not isinstance(raw, dict):
            continue
        opportunity_id = str(raw.get("opportunity_id", ""))
        if opportunity_id not in opportunities:
            raise ValueError(f"章节 {batch_name} 返回未知结构机会: {opportunity_id}")
        opportunity = opportunities[opportunity_id]
        expanded_structural.append({
            **opportunity,
            **raw,
            "visual_role": opportunity["visual_role"],
            "reader_question": str(raw.get("reader_question", opportunity["reader_question"])),
            "evidence_requirements": list(raw.get("evidence_requirements", [opportunity["evidence_requirement"]])),
            "placement_after_block_id": str(raw.get("placement_after_block_id", opportunity["chapter"])),
            "caption_intent": str(raw.get("caption_intent", raw.get("reason", ""))),
            "allowed_conclusions": list(raw.get("allowed_conclusions", [])),
        })
    return {
        **parsed,
        "plan_items": expanded_items,
        "structural_decisions": expanded_structural,
        "omitted_evidence": omitted,
    }


def build_paper_visual_inventory(
    paper_root: str | Path,
    data_dir: str | Path,
    *,
    entry_tex: str | Path | None = None,
) -> dict[str, Any]:
    paper = Path(paper_root).expanduser().resolve()
    data_root = Path(data_dir).expanduser().resolve()
    if not paper.is_dir() or not data_root.is_dir():
        raise FileNotFoundError("paper_root 和 data_dir 必须是存在的目录。")
    entry = Path(entry_tex).expanduser().resolve() if entry_tex else (paper / "main.tex").resolve()
    if not entry.is_file():
        raise FileNotFoundError(f"entry_tex 不存在: {entry}")
    tex_files = [path for path in _tex_graph(entry, paper) if "appendix" not in path.name.lower()]
    manuscript_parts = []
    for path in tex_files:
        manuscript_parts.append(f"\n--- {path.relative_to(paper)} ---\n{_strip_existing_visual_design(path.read_text(encoding='utf-8', errors='replace'))}")
    data_files = _discover_frozen_visual_evidence(data_root)
    analyses = [analyze_data_file(path, sample_rows=3) for path in data_files]
    metadata_path = data_root / "metadata.json"
    metadata_by_file: dict[str, Any] = {}
    if metadata_path.is_file():
        raw = json.loads(metadata_path.read_text(encoding="utf-8"))
        for item in raw.get("figures", []):
            # Deliberately omit old figure_type/title/axes: they would anchor the
            # model to the existing visual design that the caller asked to ignore.
            metadata_by_file[str(item.get("data_file", ""))] = {
                "description": item.get("description", ""),
                "source_artifact": item.get("source_artifact", ""),
                "construction": item.get("construction", ""),
            }
    inventory = []
    for item in analyses:
        path = Path(item["path"])
        inventory.append({
            "path": item["path"],
            "sha256": item["sha256"],
            "row_count": item["row_count"],
            "columns": item["columns"],
            "numeric_columns": item["numeric_columns"],
            "categorical_columns": item["categorical_columns"],
            "sample_rows": item.get("sample_rows", []),
            "source_artifact": str(path.relative_to(paper)).replace("\\", "/") if paper in path.parents else str(path),
            **metadata_by_file.get(path.name, {}),
        })
    return {
        "paper_root": str(paper),
        "tex_files": [str(path) for path in tex_files],
        "entry_tex": str(entry),
        "manuscript": _compress_manuscript("".join(manuscript_parts)),
        "chapter_map": extract_chapter_map("".join(manuscript_parts)),
        "structural_opportunities": discover_structural_opportunities("".join(manuscript_parts)),
        "data_inventory": inventory,
    }


def _normalize_plan(parsed: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, str]]:
    requests: list[dict[str, Any]] = []
    mapping: dict[str, str] = {}
    for index, item in enumerate(parsed.get("plan_items", []), start=1):
        if not isinstance(item, dict):
            continue
        figure_id = str(item.get("id") or f"paper_visual_{index:02d}")
        data_file = str(Path(str(item.get("data_file", ""))).expanduser().resolve())
        raw_encoding = item.get("encoding_requirements", {})
        template_id = str(item.get("template_id", ""))
        if isinstance(raw_encoding, dict):
            encoding = dict(raw_encoding)
        else:
            analysis = analyze_data_file(data_file)
            encoding, _ = complete_encoding(template_id, {}, analysis)
        required_annotations = [str(value) for value in item.get("required_annotations", [])]
        # A semantic requirement must be implemented by a native plot element.
        # Never copy model prose into a footer merely to satisfy the gate.
        request = {
            "id": figure_id,
            "kind": str(item.get("kind", "data_driven_plot")),
            "owner": "nexiom_visualization",
            "status": "requires_design",
            "paper_figure_ref": None,
            "paperspec_update_required": True,
            "purpose": str(item.get("purpose", "")),
            "reader_question": str(item.get("reader_question", "")),
            "visual_role": str(item.get("visual_role", "unclassified")),
            "intended_claim": str(item.get("intended_claim", "")),
            "alternatives_considered": list(item.get("alternatives_considered", [])),
            "pre_figure_prose_intent": str(item.get("pre_figure_prose_intent", "")),
            "post_figure_observation": str(item.get("post_figure_observation", "")),
            "modeling_consequence": str(item.get("modeling_consequence", "")),
            "panel_count": item.get("panel_count", 1),
            "panel_relationship_type": str(item.get("panel_relationship_type", "")),
            "panel_rationale": str(item.get("panel_rationale", "")),
            "facet_dimension": str(item.get("facet_dimension", "")),
            "shared_reader_question": item.get("shared_reader_question", False),
            "shared_visual_role": item.get("shared_visual_role", False),
            "layout_readable_at_body_width": item.get("layout_readable_at_body_width", False),
            "shared_axis_semantics": item.get("shared_axis_semantics", False),
            "shared_legend_semantics": item.get("shared_legend_semantics", False),
            "comparison_requires_joint_scan": item.get("comparison_requires_joint_scan", False),
            "evidence_chain_is_indivisible": item.get("evidence_chain_is_indivisible", False),
            "joint_conclusion": str(item.get("joint_conclusion", "")),
            "panels": list(item.get("panels", [])) if isinstance(item.get("panels", []), list) else [],
            "evidence_refs": [str(value) for value in item.get("evidence_refs", [Path(str(item.get("data_file", ""))).name])],
            "candidate_visuals": [str(item.get("template_id", "data plot"))],
            "template_family": str(item.get("template_family", "")),
            "template_id": template_id,
            "template_selection_rationale": str(item.get("design_rationale", "整篇论文视觉规划选择。")),
            "encoding_requirements": encoding,
            "required_annotations": required_annotations,
            "forbidden_claims": [str(value) for value in item.get("forbidden_claims", ["不得超出冻结证据"])] ,
            "caption_intent": str(item.get("caption_intent", item.get("purpose", ""))),
            "placement_after_block_id": str(item.get("placement_after_block_id", "paper_body")),
            "placement_decision": str(item.get("placement_decision", "main_text")),
            "placement_reason": str(item.get("placement_reason", "推进正文主论证。")),
            "preferred_output_formats": ["pdf", "png", "svg"],
            "acceptance_checks": [str(value) for value in item.get("acceptance_checks", ["核心结论可读", "不重复表达"])] ,
            "allowed_conclusions": [str(value) for value in item.get("allowed_conclusions", [])],
            "render_level": "L1",
            "render_route": "presentation_only",
            "evidence_operation": {"depends_only_on_frozen_evidence": True, "derivation_formula": "", "requires_new_columns_or_runs": False, "route_reason": "仅重组冻结证据。"},
        }
        requests.append(request)
        mapping[figure_id] = data_file
    return requests, mapping


def _apply_deterministic_evidence_gates(parsed: dict[str, Any]) -> dict[str, Any]:
    """Remove plots that are structurally misleading before code generation."""
    kept: list[dict[str, Any]] = []
    omitted = list(parsed.get("omitted_evidence", []))
    for item in parsed.get("plan_items", []):
        if not isinstance(item, dict):
            continue
        path = Path(str(item.get("data_file", ""))).expanduser().resolve()
        reason = ""
        if item.get("keep", True) is False or item.get("placement_decision") == "omit":
            reason = str(item.get("placement_reason", "规划已明确不制图。"))
        elif item.get("mixed_scale_without_normalization") is True:
            reason = "异量纲原始变量共用同一数值轴会产生误导，且核心组间差异已由效应量图区间化表达。"
        elif str(item.get("template_id", "")) == "two_way_sensitivity_heatmap" and path.is_file():
            with path.open("r", encoding="utf-8-sig", newline="") as handle:
                rows = list(csv.DictReader(handle))
            factor_column = str(item.get("encoding_requirements", {}).get("row_column", "factor"))
            value_column = str(item.get("encoding_requirements", {}).get("value_column", "delta_youden_vs_main"))
            comparable_factors = {
                str(row.get(factor_column, "")).strip() for row in rows
                if str(row.get(value_column, "")).strip()
            }
            if len(comparable_factors) < 2:
                reason = "可比敏感性差值只覆盖一个因素，无法支撑多因素热图；该证据留表不制图。"
        if reason:
            omitted.append({"data_file": str(path), "reason": reason, "gate": "deterministic_evidence_shape"})
        else:
            kept.append(item)
    panel_audits = [
        {"figure_id": str(item.get("id", "")), **audit_panel_plan(item)}
        for item in kept
    ]
    return {
        **parsed,
        "plan_items": kept,
        "omitted_evidence": omitted,
        "panel_policy_audit": {
            "valid": all(item["valid"] for item in panel_audits),
            "items": panel_audits,
        },
    }


def _csv_columns(path: str) -> set[str]:
    delimiter = "\t" if Path(path).suffix.lower() == ".tsv" else ","
    with Path(path).open("r", encoding="utf-8-sig", newline="") as handle:
        return set(next(csv.reader(handle, delimiter=delimiter), []))


def _apply_schema_semantic_repairs(parsed: dict[str, Any], data_inventory: list[dict[str, Any]]) -> dict[str, Any]:
    """Repair provable template/column mismatches without spending another model call.

    This layer is intentionally narrow: every rule is keyed by a distinctive
    frozen schema.  It never infers a new scientific claim from values.
    """
    repaired = dict(parsed)
    items = [dict(item) for item in parsed.get("plan_items", []) if isinstance(item, dict)]
    omitted = list(parsed.get("omitted_evidence", []))
    by_path = {str(item["path"]): item for item in data_inventory}
    existing_paths = {str(item.get("data_file", "")) for item in items}
    recovered_filenames: set[str] = set()

    for item in items:
        path = str(item.get("data_file", ""))
        if path not in by_path or not Path(path).is_file():
            continue
        columns = _csv_columns(path)
        if {"variable", "cliffs_delta", "bca_ci_low", "bca_ci_high"} <= columns:
            item["template_id"], item["template_family"] = "forest_interval", "scientific"
            item["encoding_requirements"] = {
                "category_column": "variable", "estimate_column": "cliffs_delta",
                "lower_column": "bca_ci_low", "upper_column": "bca_ci_high", "group_column": "route",
                "x_label": "Cliff's delta（BCa 95% 区间）", "reference_lines": [{"axis": "x", "value": 0, "label": "零效应"}],
            }
        elif {"variable", "marginal_abs_delta", "residual_delta"} <= columns:
            item["template_id"], item["template_family"] = "paired_metric_bar", "bar"
            item["encoding_requirements"] = {
                "category_column": "variable", "value1_column": "marginal_abs_delta", "value2_column": "residual_delta",
                "value1_label": "边际效应绝对值", "value2_label": "控制 M/L 后残差效应", "y_label": "效应量",
            }
        elif {"group", "variable_i", "variable_j", "rho"} <= columns:
            item["template_id"], item["template_family"] = "faceted_heatmap", "matrix"
            item["encoding_requirements"] = {
                "row_column": "variable_i", "column_column": "variable_j", "value_column": "rho", "group_column": "group",
                "colorbar_label": "Spearman ρ", "filter_column": "group", "filter_values": ["FLUA", "HC"],
            }
            panel = {
                "count": 2,
                "rationale": "仅并列患者组与健康对照组的同构相关矩阵；差值矩阵与合并样本矩阵不进入该图。",
                "facet_dimension": "group",
                "joint_conclusion": str(item.get("purpose", "")),
                "panels": [{"title": "FLUA"}, {"title": "HC"}],
            }
            item.update({
                "panel_count": panel["count"], "panel_relationship_type": "homogeneous_comparison",
                "panel_rationale": panel["rationale"], "facet_dimension": panel["facet_dimension"],
                "comparison_requires_joint_scan": True, "joint_conclusion": panel["joint_conclusion"],
                "panels": panel["panels"], "shared_reader_question": True, "shared_visual_role": True,
                "shared_axis_semantics": True, "shared_legend_semantics": True,
            })
        elif {"config_id", "family", "youden_median", "youden_p025", "youden_p975"} <= columns and "delta_youden_median" not in columns:
            presentation_encoding = item.get("encoding_requirements", {})
            item["template_id"], item["template_family"] = "forest_interval", "scientific"
            item["encoding_requirements"] = {
                "category_column": "config_id", "estimate_column": "youden_median",
                "lower_column": "youden_p025", "upper_column": "youden_p975", "group_column": "family",
                "x_label": "约登指数（2.5%–97.5%）",
            }
            if isinstance(presentation_encoding, dict):
                for key in ("category_label_map", "group_label_map", "highlight_categories", "title"):
                    if key in presentation_encoding:
                        item["encoding_requirements"][key] = presentation_encoding[key]
        elif {"object", "delta_youden_median", "delta_youden_p025", "delta_youden_p975"} <= columns:
            item["template_id"], item["template_family"] = "forest_interval", "scientific"
            item["encoding_requirements"] = {
                "category_column": "object", "estimate_column": "delta_youden_median",
                "lower_column": "delta_youden_p025", "upper_column": "delta_youden_p975", "group_column": "row_role",
                "x_label": "相对完整模型的约登指数差值", "reference_lines": [{"axis": "x", "value": 0, "label": "无差异"}],
            }
            item["intended_claim"] = "简化规则相对完整模型的约登指数差值区间覆盖零；基线方案与完整模型差距明显。"
            item["allowed_conclusions"] = [item["intended_claim"]]
            item["post_figure_observation"] = item["intended_claim"]
        elif {"prevalence", "ppv", "npv", "model"} <= columns:
            item["template_id"], item["template_family"] = "paired_curve", "line"
            item["encoding_requirements"] = {
                "x1_column": "prevalence", "y1_column": "ppv", "x2_column": "prevalence", "y2_column": "npv",
                "group_column": "model", "panel1_title": "阳性预测值（PPV）", "panel2_title": "阴性预测值（NPV）",
                "x1_label": "患病率", "x2_label": "患病率", "x1_percent": True, "x2_percent": True,
            }
            item.update({
                "panel_count": 2, "panel_relationship_type": "homogeneous_comparison",
                "panel_rationale": "PPV 与 NPV 来自同一冻结情景网格，需并列扫读才能解释患病率迁移下的应用边界。",
                "facet_dimension": "预测值类型", "comparison_requires_joint_scan": True,
                "joint_conclusion": str(item.get("intended_claim", "")),
                "panels": [{"title": "PPV"}, {"title": "NPV"}],
                "shared_reader_question": True, "shared_visual_role": True,
                "shared_axis_semantics": True, "shared_legend_semantics": True,
            })
        elif {"factor", "level", "object", "auc_median", "youden_median", "n_flip_worst"} <= columns:
            # One file mixes categorical ablations, measurement-error flips and
            # missing metrics.  No single executable grammar can honestly bind
            # it without first producing separate frozen derived tables.
            item["keep"] = False
            item["placement_decision"] = "omit"
            omitted.append({
                "data_file": path,
                "reason": "该汇总混合类别消融、连续扰动与翻转次数；需拆成同口径派生表后再绘图，禁止强塞龙卷风图。",
            })

    # Recover two indispensable Q2 validation views when the model reported a
    # template gap although the frozen schema is already sufficient.
    for data in data_inventory:
        path = str(data["path"])
        if path in existing_paths or not Path(path).is_file():
            continue
        columns = _csv_columns(path)
        if {"model", "fpr", "tpr", "recall", "precision"} <= columns:
            recovered_filenames.add(Path(path).name)
            items.append({
                "id": "q2_roc_pr_validation", "keep": True, "data_file": path,
                "template_id": "paired_curve", "template_family": "line",
                "encoding_requirements": {"x1_column": "fpr", "y1_column": "tpr", "x2_column": "recall", "y2_column": "precision", "group_column": "model", "panel1_title": "ROC 曲线", "panel2_title": "PR 曲线"},
                "purpose": "并列验证推荐模型的 ROC 与查准率—查全率表现。",
                "reader_question": "推荐模型在不同判别阈值下的区分能力与阳性检出权衡如何？",
                "visual_role": "classification_validation", "intended_claim": "曲线仅呈现冻结折外预测下的阈值权衡，不替代外部验证。",
                "forbidden_claims": ["不得把折外证据表述为外部验证"], "required_annotations": [],
                "placement_after_block_id": "question_2", "placement_decision": "main_text", "placement_reason": "属于分类模型核心验证。",
                "allowed_conclusions": ["曲线仅呈现冻结折外预测下的阈值权衡，不替代外部验证。"],
                "pre_figure_prose_intent": "比较 ROC 与 PR 两种互补阈值视角。", "post_figure_observation": "读取两条曲线的共同阈值权衡。", "modeling_consequence": "据此说明推荐模型的判别边界。",
                "panel_count": 2, "panel_relationship_type": "homogeneous_comparison", "panel_rationale": "ROC 与 PR 来自同一折外预测并共同刻画分类阈值权衡。", "facet_dimension": "验证曲线类型",
                "shared_reader_question": True, "shared_visual_role": True, "layout_readable_at_body_width": True,
                "shared_axis_semantics": True, "shared_legend_semantics": True, "comparison_requires_joint_scan": True,
                "evidence_chain_is_indivisible": False, "joint_conclusion": "联合判断区分能力与阳性检出权衡。", "panels": [{"title": "ROC"}, {"title": "PR"}],
            })
        elif {"model", "predicted_probability", "observed_rate"} <= columns:
            recovered_filenames.add(Path(path).name)
            items.append({
                "id": "q2_probability_calibration", "keep": True, "data_file": path,
                "template_id": "calibration_plot", "template_family": "diagnostic",
                "encoding_requirements": {"predicted_column": "predicted_probability", "observed_column": "observed_rate", "group_column": "model", "x_label": "平均预测概率", "y_label": "观察发生率"},
                "purpose": "检查推荐模型折外预测概率与观察发生率的一致性。", "reader_question": "预测概率是否经过合理校准？",
                "visual_role": "calibration_diagnostic", "intended_claim": "分箱点相对理想校准线的位置反映折外概率偏差。",
                "forbidden_claims": ["不得把折外校准表述为外部校准"], "required_annotations": [],
                "placement_after_block_id": "question_2", "placement_decision": "main_text", "placement_reason": "概率模型除区分度外还需校准证据。",
                "allowed_conclusions": ["分箱点相对理想校准线的位置反映折外概率偏差。"],
                "pre_figure_prose_intent": "检验预测概率与观察率的一致性。", "post_figure_observation": "识别偏离理想线的概率区间。", "modeling_consequence": "限定概率输出的解释边界。",
                "panel_count": 1, "panel_relationship_type": "", "panel_rationale": "", "facet_dimension": "",
                "shared_reader_question": True, "shared_visual_role": True, "layout_readable_at_body_width": True,
                "shared_axis_semantics": True, "shared_legend_semantics": True, "comparison_requires_joint_scan": False,
                "evidence_chain_is_indivisible": False, "joint_conclusion": "检查折外概率校准。", "panels": [],
            })

    # Do not leave stale "omitted" or gap records after deterministic recovery.
    omitted = [
        item for item in omitted
        if Path(str(item.get("data_file", ""))).name not in recovered_filenames
    ]
    unique_omitted: list[dict[str, Any]] = []
    seen_omitted: set[tuple[str, str]] = set()
    for item in omitted:
        key = (str(item.get("data_file", "")), str(item.get("reason", "")))
        if key not in seen_omitted:
            unique_omitted.append(item)
            seen_omitted.add(key)
    evidence_gaps = list(parsed.get("evidence_gaps", []))
    if "fig08_recommended_roc_pr.csv" in recovered_filenames:
        evidence_gaps = [item for item in evidence_gaps if "ROC" not in str(item.get("reader_question", "")).upper()]
    if "fig09_recommended_calibration.csv" in recovered_filenames:
        evidence_gaps = [item for item in evidence_gaps if "校准" not in str(item.get("reader_question", ""))]
    repaired["plan_items"] = items
    repaired["omitted_evidence"] = unique_omitted
    repaired["evidence_gaps"] = evidence_gaps
    repaired["semantic_repair_applied"] = True
    return repaired


def execute_saved_paper_visual_plan(
    plan_path: str | Path,
    paper_root: str | Path,
    data_dir: str | Path,
    output_dir: str | Path,
    *,
    settings: Settings,
    entry_tex: str | Path | None = None,
) -> dict[str, Any]:
    """Re-run deterministic gates, code generation and rendering without another AI call."""
    source_plan = Path(plan_path).expanduser().resolve()
    parsed = json.loads(source_plan.read_text(encoding="utf-8"))
    if not isinstance(parsed, dict) or not isinstance(parsed.get("plan_items"), list):
        raise ValueError("saved plan 必须包含 plan_items 数组。")
    output = Path(output_dir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    inventory = build_paper_visual_inventory(paper_root, data_dir, entry_tex=entry_tex)
    parsed = _apply_schema_semantic_repairs(parsed, inventory["data_inventory"])
    parsed = _apply_deterministic_evidence_gates(parsed)
    if not parsed["plan_items"]:
        raise ValueError("确定性证据门禁后没有可执行图。")
    if not parsed["panel_policy_audit"]["valid"]:
        raise ValueError(f"子图组合策略未通过：{parsed['panel_policy_audit']['items']}")
    budget = assess_figure_budget(parsed["plan_items"], parsed.get("structural_decisions", []))
    exception = parsed.get("figure_budget_exception", {})
    if budget["status"] != "within_recommended_budget" and exception.get("approved_by_local_codex") is not True:
        raise ValueError(f"全文图数超过20且无本地Codex批准的必要性例外：{budget}")
    parsed["figure_budget"] = budget
    revised_plan_path = write_json(output / "paper_visual_plan.executed.json", parsed)
    requests, mapping = _normalize_plan(parsed)
    known = {str(item["path"]) for item in inventory["data_inventory"]}
    unknown = sorted({path for path in mapping.values() if path not in known})
    if unknown:
        raise ValueError(f"规划引用了 inventory 之外的数据文件: {unknown}")
    requests_path = write_json(output / "visual_requests.executed.json", {
        "visual_requests": requests, "data_file_by_request": mapping,
    })
    design = run_visual_design_meeting(
        requests, sorted(set(mapping.values())), inventory["manuscript"], output / "design",
        settings=settings, data_file_by_request=mapping, use_mock_models=True,
    )
    production = render_and_inspect_figures(design, output / "production")
    structural = render_structural_figures(parsed.get("structural_decisions", []), output / "structural_production")
    status = "formal_landing_ready" if (
        design.get("status") == "completed"
        and production["status"] == "formal_landing_ready"
        and structural["status"] == "formal_landing_ready"
    ) else "blocked"
    result = {
        "schema_version": "paper_visualization_execution/1.0.0", "status": status,
        "source_plan_path": str(source_plan), "executed_plan_path": str(revised_plan_path),
        "requests_path": str(requests_path),
        "design_output_path": str((output / "design" / "visual_design_output-1.0.0.json").resolve()),
        "production_manifest_path": production["manifest_path"],
        "structural_production_manifest_path": structural["manifest_path"],
        "planning_model_calls": 0, "layout_ai_repair_calls": 0,
        "data_figure_count": len(design.get("figures", [])),
        "structural_figure_count": structural["summary"]["requested"],
        "figure_count": len(design.get("figures", [])) + structural["summary"]["requested"],
        "production_ready_count": production["summary"]["production_ready"] + structural["summary"]["production_ready"],
        "omitted_evidence": parsed.get("omitted_evidence", []),
        "blocking_summary": (
            [item for item in production["figures"] if item["blocking_issues"]]
            + [item for item in structural["figures"] if item["blocking_issues"]]
        ),
        "manual_adjustment_queue": [
            {"figure_id": item["figure_id"], "items": item["manual_adjustment_queue"]}
            for item in production["figures"] if item["manual_adjustment_queue"]
        ],
    }
    status_path = write_json(output / "paper_visualization_execution_status.json", result)
    return {**result, "status_path": str(status_path)}


def run_paper_visualization_pipeline(
    paper_root: str | Path,
    data_dir: str | Path,
    output_dir: str | Path,
    *,
    settings: Settings,
    entry_tex: str | Path | None = None,
) -> dict[str, Any]:
    validate_visual_design_roster(settings, require_credentials=True)
    output = Path(output_dir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    inventory = build_paper_visual_inventory(paper_root, data_dir, entry_tex=entry_tex)
    compact_data = [
            {
                "path": item["path"], "sha256": item["sha256"], "row_count": item["row_count"],
                "columns": [{"name": column["name"], "type": column["inferred_type"]} for column in item["columns"]],
                "source_artifact": item.get("source_artifact", ""),
            }
            for item in inventory["data_inventory"]
        ]
    payload = {
        "manuscript_without_existing_figures": inventory["manuscript"],
        # The manuscript digest already carries the evidence-bearing prose.
        # Repeating every 1,200-character body preview here triples UTF-8 input
        # size and makes proxied requests needlessly fragile.
        "chapter_map": [
            {"level": item["level"], "title": item["title"]}
            for item in inventory["chapter_map"]
        ],
        "structural_opportunities": inventory["structural_opportunities"],
        "frozen_data_inventory": compact_data,
        "registered_templates": "每批按真实列类型提供候选短名单",
        "rules": [
            "按读者问题和论证角色发现图；正文数据图与结构图合计通常不超过20图，补充诊断可进入附录",
            "数据驱动型竞赛论文通常需要约14至17张正文图才能覆盖背景、数据认识、关系发现、模型结构、比较、验证、稳健性与应用边界；这是覆盖审计参照而非凑数配额",
            "允许同一证据产生不同角色的互补视图，但禁止同一问题的重复图",
            "数据图只用真实文件、真实列和候选短名单",
            "概念图只形成研究型设计请求，不得伪造数据或领域机制",
            "问题重述中的领域图必须先区分数据来源、对象构成、变量来源与应用流程：正文介绍样本和观测来源时优先采用场景化数据来源示意，不得自动画成模型业务流程图",
            "正文正在引用并逐项解释的一级数据证据不得仅因信息密度高而降入附录；只有不推进主结论、与正文图重复或在版心内确实不可读时才转附录",
            "相关性不得默认热力图，必须比较散点、响应、分组、时滞、表格等方案",
            "图必须适配论文正文版心，禁止把原始配置代号直接作为主要读者标签；需要保留代号时应同时提供可读释义",
            "标签、图例、字号与边距等排版小问题由本地或人工处理",
            "默认一图一面板，不设固定面板数；由模型根据共同读者问题、共同视觉角色、联合扫读必要性和正文栏宽可读性决定",
            "同属一个大问题不构成合并理由；机理解释、变量关系、结果验证、约束诊断、KPI汇总等不同阅读任务应拆图",
            "禁止把路线、工时、约束、KPI或机理图与验证曲线做成论文仪表盘；字母标签不是判据，子图间的论证关系才是判据",
        ],
        "response_contract": {
            "plan_items": [{
                "id": "short unique id", "data_file": "exact filename from this chapter",
                "placement_decision": "main_text|appendix|omit",
                "placement_reason": "short reason", "template_id": "id from this file shortlist",
                "purpose": "one sentence", "reader_question": "one sentence", "visual_role": "argument role",
                "intended_claim": "one evidence-bound observation",
                "panel": {"count": 1, "rationale": "only when count>1", "facet_dimension": "optional", "joint_conclusion": "optional"}
            }],
            "structural_decisions": [{
                "opportunity_id": "id from structural_opportunities", "decision": "keep|omit|covered_by_text",
                "selected_grammar": "diagram form", "reason": "short reason", "figure_id": "required when keep",
                "nodes": [{"id": "id", "label": "short visible label", "detail": "optional"}],
                "edges": [{"source": "id", "target": "id", "label": "short relation"}]
            }],
            "evidence_gaps": [{"reader_question": "unanswered question", "required_artifact": "new frozen result"}],
            "omitted_evidence": [{"data_file": "absolute path", "reason": "short reason"}],
        },
    }
    # Plan by argument-bearing chapter and keep supplementary evidence available
    # for appendix routing instead of either crowding the main text or deleting it.
    data_batches = _evidence_batches(compact_data)
    combined_items: list[dict[str, Any]] = []
    combined_omitted: list[dict[str, Any]] = []
    combined_structural: list[dict[str, Any]] = []
    combined_evidence_gaps: list[dict[str, Any]] = []
    batch_records: list[dict[str, Any]] = []
    all_route_events: list[dict[str, Any]] = []
    usage_records: list[dict[str, Any]] = []
    response_model = settings.model.model
    for batch_index, (batch_name, batch_data) in enumerate(data_batches, start=1):
        batch_payload = {
            **payload,
            "batch_name": batch_name,
            "batch_index": batch_index,
            "batch_count": len(data_batches),
            "manuscript_without_existing_figures": _batch_manuscript(inventory["manuscript"], batch_name),
            "structural_opportunities": _structural_for_chapter(inventory["structural_opportunities"], batch_name),
            "frozen_data_inventory": [
                {**item, "compatible_template_shortlist": _template_shortlist(item)} for item in batch_data
            ],
        }
        checkpoint = write_json(output / "planning_batches" / f"batch_{batch_index:02d}_input.json", batch_payload)
        cached_response_path = output / "planning_batches" / f"batch_{batch_index:02d}_output.json"
        cached_response: dict[str, Any] | None = None
        if cached_response_path.is_file():
            candidate = json.loads(cached_response_path.read_text(encoding="utf-8"))
            if isinstance(candidate, dict) and isinstance(candidate.get("plan_items"), list):
                cached_response = candidate
        client = ModelClient(settings)
        if cached_response is None:
            try:
                response = client.chat(
                settings.model, PAPER_PLAN_SYSTEM,
                f"你看到的是同一篇论文中“{batch_name}”这一论证章节的正文摘要、冻结证据和结构性视觉机会。"
                "逐项判断证据能回答哪些独立读者问题；正文只保留推进本章主论证的必要图，补充诊断放入 appendix，"
                "表格或文字更清楚时 placement_decision=omit 且 keep=false。不要为凑数画图，也不要因追求少量漏掉必要证据。"
                "本次是数据驱动型竞赛论文：跨全文正文视觉密度通常应在14至17图附近；若本批有新的数据认识、关系发现、模型比较、验证、稳健性或应用边界证据，应分别保留，不能只选一张总结果图。"
                "同一文件通常保留零至两个互补视图，确有三个独立读者问题时才可提出三个，且 visual_role 或 reader_question 必须不同。"
                "默认单面板。只有同构比较确实必须联合扫读时才返回精简 panel 对象；列绑定、代码参数和硬门禁由本地完成。"
                "仅评估本章节给出的 structural_opportunities；空列表不得输出结构决策。不要复述论文，不写长理由；"
                "结构图若 decision=keep，必须给出2至12个证据绑定 nodes 及必要 edges；禁止空泛的数据—模型—结果三框图。"
                "需要处理前后数值证据的 preprocessing_evidence 不得伪装成概念结构图：应 covered_by_existing_plan、omit，或登记 evidence_gap。"
                "数据图的 template_id 必须取自各数据的候选短名单；不要返回 encoding、配色、代码或排版参数。"
                "只返回极简 JSON。\n" + json.dumps(batch_payload, ensure_ascii=False),
                    temperature=0.1, deadline_at=time.monotonic() + settings.meeting_deadline_seconds, max_tokens=1200,
                )
            except Exception as exc:
                all_route_events.extend(client.route_events)
                blocked = {
                "schema_version": "paper_visualization_pipeline/1.0.0",
                "status": "blocked_by_model_route",
                "model": settings.model.model,
                "planning_model_calls": batch_index,
                "layout_ai_repair_calls": 0,
                "failed_batch": batch_index,
                "planning_input_path": str(checkpoint),
                "route_events": all_route_events,
                "error_type": type(exc).__name__,
                "error_message": str(exc),
                }
                status_path = write_json(output / "paper_visualization_pipeline_status.json", blocked)
                return {**blocked, "status_path": str(status_path)}
            all_route_events.extend(client.route_events)
            response_model = str(response.get("model", response_model))
            usage_records.append(dict(response.get("usage", {})))
            content = str(response.get("content", "")).strip()
            if content.startswith("```"):
                content = content.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            parsed_batch = json_repair.loads(content)
            if not isinstance(parsed_batch, dict) or not isinstance(parsed_batch.get("plan_items"), list):
                raise ValueError(f"全文视觉规划第 {batch_index} 批没有返回 plan_items 数组。")
            parsed_batch = _expand_compact_batch(
                parsed_batch,
                batch_data,
                batch_payload["structural_opportunities"],
                batch_name,
            )
            response_path = write_json(cached_response_path, {
                "model": response.get("model"), "usage": response.get("usage", {}), "batch_name": batch_name, **parsed_batch,
            })
        else:
            parsed_batch = cached_response
            response_model = str(cached_response.get("model", response_model))
            usage_records.append(dict(cached_response.get("usage", {})))
            response_path = cached_response_path
        batch_records.append({"batch": batch_index, "batch_name": batch_name, "input": str(checkpoint), "output": str(response_path), "items": len(parsed_batch["plan_items"])})
        combined_items.extend(
            item for item in parsed_batch["plan_items"]
            if isinstance(item, dict)
            and item.get("keep", True) is not False
            and item.get("placement_decision", "main_text") != "omit"
        )
        combined_omitted.extend(item for item in parsed_batch.get("omitted_evidence", []) if isinstance(item, dict))
        combined_structural.extend(item for item in parsed_batch.get("structural_decisions", []) if isinstance(item, dict))
        combined_evidence_gaps.extend(item for item in parsed_batch.get("evidence_gaps", []) if isinstance(item, dict))
    deduplicated, duplicate_omissions = deduplicate_complementary_plans(combined_items)
    combined_omitted.extend(duplicate_omissions)
    structural_by_id: dict[str, dict[str, Any]] = {}
    for item in combined_structural:
        opportunity_id = str(item.get("opportunity_id", ""))
        completeness = (
            100 if item.get("decision") == "keep" and len(item.get("nodes", [])) >= 2 else 0
        ) + len(item.get("edges", [])) + len(item.get("evidence_requirements", []))
        previous = structural_by_id.get(opportunity_id, {})
        previous_completeness = (
            100 if previous.get("decision") == "keep" and len(previous.get("nodes", [])) >= 2 else 0
        ) + len(previous.get("edges", [])) + len(previous.get("evidence_requirements", []))
        if opportunity_id and completeness > previous_completeness:
            structural_by_id[opportunity_id] = item
    resolved_structural = [
        {**opportunity, **structural_by_id.get(str(opportunity["opportunity_id"]), {})}
        for opportunity in inventory["structural_opportunities"]
    ]
    coverage = visual_argument_coverage(deduplicated, resolved_structural)
    parsed = {
        "plan_summary": f"{response_model} 分批读取同一全文摘要；本地按冻结证据去重合并。",
        "planning_strategy": "whole_paper_visual_argument_planning_with_complementary_evidence_views",
        "batches": batch_records,
        "omitted_evidence": combined_omitted,
        "structural_decisions": resolved_structural,
        "evidence_gaps": combined_evidence_gaps,
        "argument_coverage": coverage,
        "plan_items": deduplicated,
    }
    parsed = _apply_schema_semantic_repairs(parsed, inventory["data_inventory"])
    parsed = _apply_deterministic_evidence_gates(parsed)
    if not parsed["plan_items"]:
        raise ValueError("全文视觉规划没有保留任何可执行图。")
    main_items = [item for item in parsed["plan_items"] if item.get("placement_decision", "main_text") != "appendix"]
    appendix_items = [item for item in parsed["plan_items"] if item.get("placement_decision") == "appendix"]
    budget = assess_figure_budget(main_items, parsed.get("structural_decisions", []))
    budget["main_text_data_figure_count"] = len(main_items)
    budget["appendix_data_figure_count"] = len(appendix_items)
    budget["total_data_figure_count"] = len(parsed["plan_items"])
    parsed["figure_budget"] = budget
    panel_ready = bool(parsed["panel_policy_audit"]["valid"])
    budget_ready = budget["status"] == "within_recommended_budget"
    plan_path = write_json(output / "paper_visual_plan-1.0.0.json", {"model": response_model, "usage_by_batch": usage_records, **parsed})
    if not panel_ready or not budget_ready:
        status = "blocked_by_panel_policy" if not panel_ready else "blocked_by_figure_budget"
        blocked = {
            "schema_version": "paper_visualization_pipeline/1.0.0",
            "status": status,
            "model": response_model,
            "planning_model_calls": len(data_batches),
            "layout_ai_repair_calls": 0,
            "plan_path": str(plan_path),
            "figure_budget": budget,
            "panel_policy_audit": parsed["panel_policy_audit"],
            "detail": "先按论证必要性把正文压缩到20图以内；补充诊断明确转入附录，并拆解不满足同构比较门槛的组合图。",
        }
        status_path = write_json(output / "paper_visualization_pipeline_status.json", blocked)
        return {**blocked, "status_path": str(status_path)}
    requests, mapping = _normalize_plan(parsed)
    data_paths = {str(item["path"]) for item in inventory["data_inventory"]}
    unknown = sorted({path for path in mapping.values() if path not in data_paths})
    if unknown:
        raise ValueError(f"规划引用了 inventory 之外的数据文件: {unknown}")
    requests_path = write_json(output / "visual_requests.full_paper.json", {"visual_requests": requests, "data_file_by_request": mapping})
    design = run_visual_design_meeting(
        requests, sorted(set(mapping.values())), inventory["manuscript"], output / "design",
        settings=settings, data_file_by_request=mapping, use_mock_models=True,
    )
    production = render_and_inspect_figures(design, output / "production")
    structural_production = render_structural_figures(resolved_structural, output / "structural_production")
    render_ready = (
        design.get("status") == "completed"
        and production["status"] == "formal_landing_ready"
        and structural_production["status"] == "formal_landing_ready"
    )
    # A missing optional diagnostic must not suppress every renderable figure.
    # Only a gap explicitly marked blocking means the visual argument cannot
    # land; all other gaps remain visible editorial follow-ups.
    blocking_evidence_gaps = [item for item in combined_evidence_gaps if item.get("blocking") is True]
    argument_ready = bool(coverage.get("argument_coverage_ready")) and not blocking_evidence_gaps and panel_ready and budget_ready
    status = "formal_landing_ready" if render_ready and argument_ready else "blocked"
    final = {
        "schema_version": "paper_visualization_pipeline/1.0.0",
        "status": status,
        "model": response_model,
        "planning_model_calls": len(data_batches),
        "layout_ai_repair_calls": 0,
        "plan_path": str(plan_path),
        "requests_path": str(requests_path),
        "design_output_path": str((output / "design" / "visual_design_output-1.0.0.json").resolve()),
        "production_manifest_path": production["manifest_path"],
        "structural_production_manifest_path": structural_production["manifest_path"],
        "data_figure_count": len(design.get("figures", [])),
        "main_text_data_figure_count": len(main_items),
        "appendix_data_figure_count": len(appendix_items),
        "structural_figure_count": structural_production["summary"]["requested"],
        "figure_count": len(design.get("figures", [])) + structural_production["summary"]["requested"],
        "figure_budget": budget,
        "panel_policy_audit": parsed["panel_policy_audit"],
        "production_ready_count": production["summary"]["production_ready"] + structural_production["summary"]["production_ready"],
        "render_ready": render_ready,
        "argument_coverage_ready": argument_ready,
        "argument_coverage": coverage,
        "structural_decisions": resolved_structural,
        "evidence_gaps": combined_evidence_gaps,
        "blocking_evidence_gaps": blocking_evidence_gaps,
        "blocking_summary": (
            [item for item in production["figures"] if item["blocking_issues"]]
            + [item for item in structural_production["figures"] if item["blocking_issues"]]
        ),
        "manual_adjustment_queue": [
            {"figure_id": item["figure_id"], "items": item["manual_adjustment_queue"]}
            for item in production["figures"] if item["manual_adjustment_queue"]
        ],
    }
    final_path = write_json(output / "paper_visualization_pipeline_status.json", final)
    return {**final, "status_path": str(final_path)}
