from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .artifacts import write_json
from .contracts import validate_visual_design_output


def update_visual_request_fields(
    section_content_package: str | Path,
    visual_design_output: dict[str, Any] | str | Path,
    output_path: str | Path,
) -> dict[str, Any]:
    source = Path(section_content_package).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    package = json.loads(source.read_text(encoding="utf-8"))
    if package.get("status") != "ready_for_codex":
        raise ValueError("仅 status=ready_for_codex 的内容包允许进入设计字段回填。")
    handoff = package.get("codex_handoff", {})
    if isinstance(handoff, dict) and not bool(handoff.get("ready_for_local_editorial_review", False)):
        raise ValueError("内容包尚未 ready_for_local_editorial_review。")
    if isinstance(visual_design_output, dict):
        design = visual_design_output
    else:
        raw = str(visual_design_output)
        candidate = Path(raw).expanduser()
        design = json.loads(candidate.read_text(encoding="utf-8") if candidate.is_file() else raw)
    validation = validate_visual_design_output(design)
    if not validation["valid"]:
        raise ValueError(f"visual_design_output 契约无效: {validation['errors']}")
    if design.get("status") != "completed":
        raise ValueError("仅 completed 的 visual_design_output 可用于回填。")
    figures = {item["figure_id"]: item for item in design.get("figures", [])}
    updated_ids: list[str] = []
    for request in package.get("visual_requests", []):
        if not isinstance(request, dict) or request.get("id") not in figures:
            continue
        figure = figures[request["id"]]
        if not figure.get("quality_checks_passed"):
            raise ValueError(f"图 {request['id']} 未通过确定性质量门禁。")
        request.update({
            "owner": "nexiom_visualization",
            "status": "design_completed",
            "template_id": figure["template_id"],
            "encoding_requirements": figure["encoding_requirements"],
            "template_selection_rationale": figure["template_selection_rationale"],
            "visual_design_output_ref": str(Path(figure["python_code_path"]).expanduser().resolve()),
            # Reader-facing title/task/conclusion remain owned by the writing
            # MCP; this handoff only fills visual implementation fields.
            "content_ownership": request.get("content_ownership", figure.get("content_ownership", {})),
            "allowed_conclusions": request.get("allowed_conclusions", figure.get("allowed_conclusions", [])),
            "forbidden_claims": request.get("forbidden_claims", figure.get("forbidden_claims", [])),
            "render_level": figure.get("render_level", request.get("render_level", "L1")),
            "render_route": figure.get("render_route", request.get("render_route", "presentation_only")),
            "evidence_operation": figure.get("evidence_operation", request.get("evidence_operation", {})),
        })
        updated_ids.append(str(request["id"]))
    target = write_json(output_path, package)
    return {
        "status": "updated",
        "source_path": str(source),
        "output_path": str(target),
        "updated_request_ids": updated_ids,
        "original_preserved": target != source,
    }
