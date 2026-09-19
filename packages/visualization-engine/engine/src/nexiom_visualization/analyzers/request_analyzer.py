from __future__ import annotations

from pathlib import Path
from typing import Any

from .data_analyzer import analyze_data_file
from ..visual_argument import RECOMMENDED_MAX_FIGURES


ALGORITHM_VISUAL_KINDS = {
    "data_driven_plot", "result_comparison", "sensitivity_analysis",
    "diagnostic_plot", "spatial_visualization", "network_visualization",
    "schedule_visualization", "uncertainty_visualization",
}
CODEX_VISUAL_KINDS = {"conceptual_diagram", "model_flow", "mechanism_diagram", "timeline"}
SUPPORTED_OWNERS = {"algorithm_mcp", "local_codex", "nexiom_visualization"}
OUTPUT_FORMATS = {"pdf", "png", "svg"}
VISUAL_REQUEST_FIELDS = (
    "id", "kind", "owner", "status", "paper_figure_ref", "paperspec_update_required",
    "purpose", "reader_question", "evidence_refs", "candidate_visuals", "template_family",
    "template_id", "template_selection_rationale", "encoding_requirements",
    "required_annotations", "forbidden_claims", "caption_intent", "placement_after_block_id",
    "preferred_output_formats", "acceptance_checks",
)


def validate_visual_operation_route(request: dict[str, Any]) -> dict[str, Any]:
    """Derive the only permitted rendering level from the evidence operation."""
    route = str(request.get("render_route", "presentation_only")).strip() or "presentation_only"
    operation = request.get("evidence_operation", {})
    operation = operation if isinstance(operation, dict) else {}
    if route not in {"presentation_only", "derived_evidence", "new_experiment", "model_change"}:
        return {"valid": False, "errors": [{"type": "invalid_render_route", "value": route}], "operation_level": ""}
    expected_level = {
        "presentation_only": "L1",
        "derived_evidence": "L2",
        "new_experiment": "L3",
        "model_change": "L3",
    }[route]
    errors: list[dict[str, Any]] = []
    level = str(request.get("render_level", expected_level)).strip() or expected_level
    if level != expected_level:
        errors.append({"type": "render_level_route_mismatch", "route": route, "expected": expected_level, "actual": level})
    frozen_only = operation.get("depends_only_on_frozen_evidence", route in {"presentation_only", "derived_evidence"})
    formula = str(operation.get("derivation_formula", "")).strip()
    new_inputs = operation.get("requires_new_columns_or_runs", route in {"new_experiment", "model_change"})
    if route == "derived_evidence" and (frozen_only is not True or not formula or new_inputs is not False):
        errors.append({
            "type": "invalid_l2_operation",
            "detail": "L2 只能使用冻结证据，必须有派生公式，且不得新增列或重跑。",
        })
    if route in {"new_experiment", "model_change"}:
        errors.append({
            "type": "l3_requires_upstream_meeting",
            "route": route,
            "detail": "L3 不得进入可视化模型会议；需回算法会议或建模会议。",
        })
    return {
        "valid": not errors,
        "errors": errors,
        "operation_level": expected_level,
        "render_route": route,
        "depends_only_on_frozen_evidence": bool(frozen_only),
        "derivation_formula": formula,
        "requires_new_columns_or_runs": bool(new_inputs),
        "route_reason": str(operation.get("route_reason", "")).strip() or {
            "L1": "仅做展示层处理。", "L2": "冻结证据足以完成重渲染。", "L3": "需要上游会议处理新实验或模型变更。",
        }[expected_level],
    }


def analyze_visual_requests(visual_requests: Any) -> dict[str, Any]:
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    normalized: list[dict[str, Any]] = []
    if not isinstance(visual_requests, list):
        return {"valid": False, "requests": [], "errors": [{"type": "visual_requests_not_list"}], "warnings": []}
    seen: set[str] = set()
    for index, raw in enumerate(visual_requests, start=1):
        if not isinstance(raw, dict):
            errors.append({"type": "invalid_visual_request", "request_index": index})
            continue
        request = dict(raw)
        request_id = str(request.get("id", "")).strip()
        missing_keys = [field for field in VISUAL_REQUEST_FIELDS if field not in request]
        if missing_keys:
            errors.append({"type": "missing_visual_request_fields", "request_id": request_id or None, "fields": missing_keys})
        if not request_id:
            errors.append({"type": "missing_visual_request_id", "request_index": index})
            continue
        if request_id in seen:
            errors.append({"type": "duplicate_visual_request_id", "request_id": request_id})
            continue
        seen.add(request_id)
        kind = str(request.get("kind", "")).strip()
        if kind not in ALGORITHM_VISUAL_KINDS | CODEX_VISUAL_KINDS:
            errors.append({"type": "unsupported_visual_kind", "request_id": request_id, "value": kind})
        owner = str(request.get("owner", "")).strip()
        if owner not in SUPPORTED_OWNERS:
            errors.append({"type": "unsupported_visual_owner", "request_id": request_id, "value": owner})
        for field in ("purpose", "reader_question", "caption_intent", "placement_after_block_id"):
            if not str(request.get(field, "")).strip():
                errors.append({"type": "missing_visual_field", "request_id": request_id, "field": field})
        for field in ("evidence_refs", "candidate_visuals", "preferred_output_formats", "acceptance_checks"):
            if not isinstance(request.get(field), list) or not request.get(field):
                errors.append({"type": "missing_visual_list", "request_id": request_id, "field": field})
        for field in ("required_annotations", "forbidden_claims"):
            if field in request and not isinstance(request.get(field), list):
                errors.append({"type": "visual_field_not_list", "request_id": request_id, "field": field})
        if not isinstance(request.get("encoding_requirements", {}), dict):
            errors.append({"type": "encoding_requirements_not_object", "request_id": request_id})
            request["encoding_requirements"] = {}
        route_report = validate_visual_operation_route(request)
        request["render_level"] = route_report.get("operation_level") or str(request.get("render_level", "L1"))
        request["render_route"] = route_report.get("render_route", str(request.get("render_route", "presentation_only")))
        request["evidence_operation"] = {
            "depends_only_on_frozen_evidence": route_report.get("depends_only_on_frozen_evidence", True),
            "derivation_formula": route_report.get("derivation_formula", ""),
            "requires_new_columns_or_runs": route_report.get("requires_new_columns_or_runs", False),
            "route_reason": route_report.get("route_reason", ""),
        }
        errors.extend({"request_id": request_id, **item} for item in route_report["errors"])
        formats = [str(value).lower() for value in request.get("preferred_output_formats", [])]
        invalid_formats = sorted(set(formats) - OUTPUT_FORMATS)
        if invalid_formats:
            errors.append({"type": "unsupported_output_format", "request_id": request_id, "formats": invalid_formats})
        if str(request.get("template_selection_rationale", "")).strip().lower() in {
            "留待本地 codex 确定", "模板选择留待本地 codex 根据数据结构和版面约束确定。",
        }:
            warnings.append({"type": "template_placeholder_detected", "request_id": request_id})
        if not request.get("paper_figure_ref") and not bool(request.get("paperspec_update_required")):
            errors.append({"type": "missing_paperspec_update_flag", "request_id": request_id})
        normalized.append(request)
    return {"valid": not errors, "requests": normalized, "errors": errors, "warnings": warnings}


def preflight_visual_design_inputs(
    visual_requests: Any,
    data_files: list[str | Path],
    section_context: str,
    output_dir: str | Path,
    *,
    data_file_by_request: dict[str, str] | None = None,
) -> dict[str, Any]:
    request_report = analyze_visual_requests(visual_requests)
    errors = list(request_report["errors"])
    data_reports: list[dict[str, Any]] = []
    resolved_files: set[str] = set()
    for raw_path in data_files:
        try:
            report = analyze_data_file(raw_path)
            data_reports.append(report)
            resolved_files.add(report["path"])
        except (FileNotFoundError, ValueError, UnicodeDecodeError) as exc:
            errors.append({"type": "invalid_data_file", "path": str(raw_path), "detail": str(exc)})
    if not str(section_context).strip():
        errors.append({"type": "missing_section_context"})
    target = Path(output_dir).expanduser().resolve()
    if target.exists() and not target.is_dir():
        errors.append({"type": "output_path_not_directory", "path": str(target)})
    mapping = data_file_by_request or {}
    request_ids = {item.get("id") for item in request_report["requests"]}
    for request_id, raw_path in mapping.items():
        resolved = str(Path(raw_path).expanduser().resolve())
        if request_id not in request_ids:
            errors.append({"type": "data_mapping_unknown_request", "request_id": request_id})
        if resolved not in resolved_files:
            errors.append({"type": "data_mapping_unknown_file", "request_id": request_id, "path": resolved})
    data_driven = [item for item in request_report["requests"] if item.get("kind") in ALGORITHM_VISUAL_KINDS]
    if data_driven and not data_reports:
        errors.append({"type": "missing_data_files"})
    if len(data_reports) > 1:
        missing_mapping = [str(item["id"]) for item in data_driven if str(item["id"]) not in mapping]
        if missing_mapping:
            errors.append({"type": "ambiguous_data_file_mapping", "request_ids": missing_mapping})
    requested_figure_count = len(request_report["requests"])
    presentation_preflight = {
        "figure_budget": {
            "body_page_limit": 30,
            "recommended_max_figures": RECOMMENDED_MAX_FIGURES,
            "requested_figure_count": requested_figure_count,
            "status": "within_recommended_budget" if requested_figure_count <= RECOMMENDED_MAX_FIGURES else "requires_argument_pruning_or_explicit_exception",
            "over_by": max(0, requested_figure_count - RECOMMENDED_MAX_FIGURES),
            "rule": "全文通常控制在20图以内，同时满足正文30页上限；超出须逐图论证必要性并由本地Codex批准例外。",
        },
        "grayscale_readability": {
            "required": True,
            "status": "required_at_formal_render",
            "checks": [
                "颜色转灰后系列仍可区分",
                "关键关系不只依赖颜色",
                "线型、标记或文字标签提供冗余编码",
            ],
        },
    }
    return {
        "valid": not errors,
        "errors": errors,
        "warnings": request_report["warnings"],
        "visual_requests": request_report["requests"],
        "data_files": data_reports,
        "section_context_characters": len(section_context),
        "output_dir": str(target),
        "data_file_by_request": {key: str(Path(value).expanduser().resolve()) for key, value in mapping.items()},
        "presentation_preflight": presentation_preflight,
    }
