from __future__ import annotations

import hashlib
import json
from pathlib import Path
import time
from typing import Any, Callable

import json_repair

from .analyzers.gap_detector import detect_missing_figures
from .analyzers.request_analyzer import ALGORITHM_VISUAL_KINDS, preflight_visual_design_inputs
from .artifacts import append_visualization_event, safe_name, write_json
from .config import Settings, validate_visual_design_roster
from .contracts import validate_visual_design_output
from .generators.code_generator import generate_code_file
from .model_client import ModelClient
from .quality.checker import check_code_file, check_request_fulfillment
from .quality.rules import VISUAL_HARD_RULES_PROMPT
from .recommenders.corpus_matcher import corpus_examples_for_prompt
from .recommenders.palette_recommender import palette_catalog_for_model, validate_palette_for_template
from .recommenders.template_matcher import match_request, validate_template_encoding
from .template_registry import TEMPLATE_REGISTRY, template_catalog
from .visual_argument import MULTI_PANEL_TEMPLATES, audit_panel_plan


MEETING_PROTOCOL = "single_model_visual_design"
MAX_STAGE_PROMPT_CHARS = 180_000
MAX_STAGE_PROMPT_BYTES = 540_000
STAGE_MAX_TOKENS = {
    "single_model_design": 12000,
}
STAGE_MAX_PUBLIC_CHARS = {
    "single_model_design": 18000,
}
STAGE_PRESENTATION = {
    "single_model_design": {"display_lane": "center", "speaker_label": "可视化设计模型", "turn_order": 1},
}
SYSTEM = (
    "你是数学建模论文的可视化设计席位。事实优先级为赛题附件 > 项目已核验事实 > "
    "可复现实验与代码输出 > 已核验参考文献 > 语料经验 > 模型建议。不得创造数值、证据、"
    "显著性、最优性或实验。只返回所要求的 JSON；不得写 LaTeX，不得替本地 Codex 决定最终排版。"
) + "\n" + VISUAL_HARD_RULES_PROMPT


def _prompt_metrics(system: str, user: str) -> dict[str, Any]:
    encoded = (system + "\n" + user).encode("utf-8")
    return {
        "character_count": len(system + "\n" + user),
        "utf8_byte_count": len(encoded),
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "character_limit": MAX_STAGE_PROMPT_CHARS,
        "utf8_byte_limit": MAX_STAGE_PROMPT_BYTES,
    }


def _json_object(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        value = json_repair.loads(text)
    return value if isinstance(value, dict) else {}


def _checkpoint_response(
    output_dir: Path,
    stage: str,
    response: dict[str, Any],
    metrics: dict[str, Any],
) -> Path:
    model_name = safe_name(str(response.get("model_name", "unknown")))
    raw_manifest = None
    if isinstance(response.get("raw"), dict):
        raw_path = write_json(output_dir / "raw_responses" / f"{stage}.{model_name}.json", response["raw"])
        raw = raw_path.read_bytes()
        raw_manifest = {"path": str(raw_path), "sha256": hashlib.sha256(raw).hexdigest(), "size_bytes": len(raw)}
    checkpoint = {
        "schema_version": "visual_design_stage_checkpoint/1.0.0",
        "stage": stage,
        "presentation": STAGE_PRESENTATION[stage],
        "input_metrics": metrics,
        "response": {
            key: value for key, value in response.items()
            if key in {"model_name", "model", "role", "content", "usage", "finish_reason", "transport_attempts", "error", "error_type", "error_message"}
        },
        "raw_response_artifact": raw_manifest,
    }
    return write_json(output_dir / "checkpoints" / f"{stage}.{model_name}.json", checkpoint)


def _stage_call(
    client: ModelClient,
    model: Any,
    stage: str,
    system: str,
    user: str,
    output_dir: Path,
    deadline_at: float,
    *,
    temperature: float,
) -> dict[str, Any]:
    metrics = _prompt_metrics(system, user)
    append_visualization_event(
        output_dir,
        "visual_design.context.preflight",
        stage=stage,
        model_name=model.name,
        role=model.role,
        **STAGE_PRESENTATION[stage],
        **metrics,
    )
    if metrics["character_count"] > MAX_STAGE_PROMPT_CHARS or metrics["utf8_byte_count"] > MAX_STAGE_PROMPT_BYTES:
        response = {
            "model_name": model.name,
            "model": model.model,
            "role": model.role,
            "content": "",
            "error": True,
            "error_type": "ContextBudgetError",
            "error_message": "阶段输入超过确定性上下文上限；未调用模型。",
        }
    else:
        append_visualization_event(output_dir, "visual_design.model.call.started", stage=stage, model_name=model.name, role=model.role)
        try:
            response = client.chat(
                model,
                system,
                user,
                temperature=temperature,
                deadline_at=deadline_at,
                max_tokens=STAGE_MAX_TOKENS[stage],
            )
        except Exception as exc:
            response = {
                "model_name": model.name,
                "model": model.model,
                "role": model.role,
                "content": "",
                "error": True,
                "error_type": type(exc).__name__,
                "error_message": str(exc),
            }
    if len(str(response.get("content", ""))) > STAGE_MAX_PUBLIC_CHARS[stage]:
        response.update({
            "error": True,
            "error_type": "ModelOutputOversizeError",
            "error_message": f"{stage} 输出超过字符上限。",
        })
    if response.get("finish_reason") == "length":
        response.update({"error": True, "error_type": "ModelOutputTruncatedError", "error_message": "模型输出被截断。"})
    checkpoint = _checkpoint_response(output_dir, stage, response, metrics)
    append_visualization_event(
        output_dir,
        "visual_design.model.call.failed" if response.get("error") else "visual_design.model.call.completed",
        stage=stage,
        model_name=model.name,
        role=model.role,
        checkpoint_json=str(checkpoint),
        error_type=response.get("error_type"),
        error_message=response.get("error_message"),
        usage=response.get("usage", {}),
    )
    parsed = {} if response.get("error") else _json_object(str(response.get("content", "")))
    return {**response, "parsed": parsed, "checkpoint_path": str(checkpoint)}


def _mock_response(model: Any, stage: str, payload: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    parsed = {
        "template_selections": payload["deterministic_recommendations"],
        "design_summary": "采用确定性模板推荐；最终代码质量由本地硬门禁检查。",
    }
    response = {
        "model_name": model.name,
        "model": model.model,
        "role": model.role,
        "content": json.dumps(parsed, ensure_ascii=False),
        "usage": {"mock": True},
        "finish_reason": "stop",
        "transport_attempts": 0,
        "parsed": parsed,
    }
    metrics = _prompt_metrics(SYSTEM, json.dumps(payload, ensure_ascii=False))
    checkpoint = _checkpoint_response(output_dir, stage, response, metrics)
    append_visualization_event(output_dir, "visual_design.model.call.mocked", stage=stage, model_name=model.name, role=model.role, checkpoint_json=str(checkpoint))
    response["checkpoint_path"] = str(checkpoint)
    return response


def _request_data_path(request_id: str, preflight: dict[str, Any]) -> str:
    mapping = preflight.get("data_file_by_request", {})
    if request_id in mapping:
        return str(mapping[request_id])
    reports = preflight.get("data_files", [])
    if len(reports) == 1:
        return str(reports[0]["path"])
    raise ValueError(f"图 {request_id} 缺少唯一数据文件绑定。")


def build_visual_design_packet(
    visual_requests: list[dict[str, Any]],
    data_files: list[str | Path],
    section_context: str,
    output_dir: str | Path,
    *,
    data_file_by_request: dict[str, str] | None = None,
) -> dict[str, Any]:
    output = Path(output_dir).expanduser().resolve()
    preflight = preflight_visual_design_inputs(
        visual_requests,
        data_files,
        section_context,
        output,
        data_file_by_request=data_file_by_request,
    )
    by_path = {item["path"]: item for item in preflight["data_files"]}
    recommendations: list[dict[str, Any]] = []
    if preflight["valid"]:
        for request in preflight["visual_requests"]:
            if request.get("kind") not in ALGORITHM_VISUAL_KINDS:
                continue
            path = _request_data_path(str(request["id"]), preflight)
            recommendation = match_request(request, by_path[path])
            if recommendation.get("template_id") in MULTI_PANEL_TEMPLATES:
                panel_audit = audit_panel_plan({**request, "template_id": recommendation["template_id"]})
                recommendation["panel_policy_audit"] = panel_audit
                if not panel_audit["valid"]:
                    recommendation["catalog_status"] = "panel_policy_no_match"
                    recommendation["template_selection_rationale"] = (
                        "候选组合图未声明共同读者问题及联合结论；同构比较还须共享坐标/图例语义并证明必须横向扫读，"
                        "异构证据则须证明论证链不可拆。请补齐组合关系字段或改用单面板模板。"
                    )
            recommendation["data_file"] = path
            recommendation["data_sha256"] = by_path[path]["sha256"]
            recommendations.append(recommendation)
    return {
        "schema_version": "visual_design_packet/1.0.0",
        "preflight": preflight,
        "visual_requests": preflight["visual_requests"],
        "data_analyses": preflight["data_files"],
        "section_context": section_context,
        "template_catalog": template_catalog(),
        "palette_catalog": palette_catalog_for_model(),
        "corpus_examples": corpus_examples_for_prompt(),
        "deterministic_recommendations": recommendations,
        "catalog_policy": "data_compatibility_then_kind_family_semantics; model_must_select_registered_template",
    }


def _validate_template_selections(
    value: dict[str, Any],
    expected_ids: set[str],
    *,
    deterministic_by_id: dict[str, dict[str, Any]],
    analyses_by_path: dict[str, dict[str, Any]],
) -> bool:
    rows = value.get("template_selections")
    if (
        not isinstance(rows, list)
        or len(rows) != len(expected_ids)
        or {str(item.get("figure_id")) for item in rows if isinstance(item, dict)} != expected_ids
    ):
        return False
    allowed_scales = {"linear", "log", "symlog", "logit"}
    return all(
        isinstance(item, dict)
        and str(item.get("template_id")) in TEMPLATE_REGISTRY
        and isinstance(item.get("encoding_requirements"), dict)
        and validate_palette_for_template(str(item.get("palette_id", "")), str(item.get("template_id", "")))
        and all(
            key not in item["encoding_requirements"]
            or str(item["encoding_requirements"][key]) in allowed_scales
            for key in ("x_scale", "y_scale")
        )
        and str(item.get("template_selection_rationale", "")).strip()
        and str(item.get("palette_selection_rationale", "")).strip()
        and validate_template_encoding(
            str(item.get("template_id")),
            item["encoding_requirements"],
            analyses_by_path[deterministic_by_id[str(item.get("figure_id"))]["data_file"]],
        )["valid"]
        for item in rows
    )


def _blocked_output(
    output: Path,
    status: str,
    preflight: dict[str, Any],
    detail: str,
    *,
    model_calls_started: bool = False,
    stages: list[dict[str, Any]] | None = None,
    route_events: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    presentation_preflight = preflight.get("presentation_preflight") or {
        "figure_budget": {
            "body_page_limit": 30,
            "requested_figure_count": 0,
            "status": "requires_local_layout_audit",
            "rule": "正文不超过30页；图件、图题、图前图后文字均占版面。",
        },
        "grayscale_readability": {
            "required": True,
            "status": "required_at_formal_render",
            "checks": ["颜色转灰后系列仍可区分", "关键关系不只依赖颜色", "线型、标记或文字标签提供冗余编码"],
        },
    }
    stage_records = [
        {
            "stage": stage,
            "presentation": STAGE_PRESENTATION[stage],
            "model_name": value.get("model_name"),
            "model": value.get("model"),
            "role": value.get("role"),
            "parsed": value.get("parsed", {}),
            "error_type": value.get("error_type"),
            "error_message": value.get("error_message"),
            "checkpoint_path": value.get("checkpoint_path"),
        }
        for stage, value in zip(STAGE_PRESENTATION, stages or [])
    ]
    transcript_path = write_json(output / "meeting_transcript.json", {
        "schema_version": "visual_design_meeting_transcript/1.0.0",
        "protocol": MEETING_PROTOCOL,
        "status": status,
        "detail": detail,
        "stages": stage_records,
    })
    preflight_path = write_json(output / "preflight_report.json", preflight)
    result = {
        "schema_version": "1.0.0",
        "run_id": output.name,
        "status": status,
        "model_calls_started": model_calls_started,
        "figures": [],
        "gap_suggestions": [],
        "quality_report": {
            "total_figures": 0,
            "passed": 0,
            "violations_count": len(preflight.get("errors", [])),
            "common_issues": [str(item.get("type")) for item in preflight.get("errors", [])],
            "deterministic_gate_passed": False,
            "model_gate_decision": "not_run",
        },
        "meeting_transcript_path": str(transcript_path),
        "preflight_report_path": str(preflight_path),
        "request_updates_path": "",
        "route_events": route_events or [],
        "presentation_preflight": presentation_preflight,
    }
    write_json(output / "visual_design_output-1.0.0.json", result)
    return result


def run_visual_design_meeting(
    visual_requests: list[dict[str, Any]],
    data_files: list[str | Path],
    section_context: str,
    output_dir: str | Path,
    *,
    settings: Settings,
    data_file_by_request: dict[str, str] | None = None,
    use_mock_models: bool = False,
) -> dict[str, Any]:
    output = Path(output_dir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    empty_preflight: dict[str, Any] = {"valid": False, "errors": [], "warnings": []}
    try:
        validate_visual_design_roster(settings, require_credentials=not use_mock_models)
    except ValueError as exc:
        empty_preflight["errors"] = [{"type": "invalid_roster", "detail": str(exc)}]
        return _blocked_output(output, "blocked_by_roster", empty_preflight, str(exc))

    packet = build_visual_design_packet(
        visual_requests,
        data_files,
        section_context,
        output,
        data_file_by_request=data_file_by_request,
    )
    preflight = packet["preflight"]
    preflight_path = write_json(output / "preflight_report.json", preflight)
    if not preflight["valid"]:
        data_errors = {"invalid_data_file", "missing_data_files", "ambiguous_data_file_mapping", "data_mapping_unknown_file"}
        if any(item.get("type") == "l3_requires_upstream_meeting" for item in preflight["errors"]):
            status = "blocked_by_upstream_meeting"
        else:
            status = "blocked_by_missing_data" if any(item.get("type") in data_errors for item in preflight["errors"]) else "blocked_by_input"
        return _blocked_output(output, status, preflight, "输入预检未通过；模型调用被阻断。")

    catalog_failures = [
        item for item in packet["deterministic_recommendations"]
        if item.get("catalog_status") != "matched" or not str(item.get("template_id", "")).strip()
    ]
    if catalog_failures:
        catalog_preflight = {**preflight, "valid": False, "errors": [
            *preflight.get("errors", []),
            *[
                {
                    "type": "template_catalog_no_match",
                    "request_id": item.get("figure_id"),
                    "detail": item.get("template_selection_rationale", "模板库无可用匹配。"),
                    "candidate_templates": [candidate.get("template_id") for candidate in item.get("template_candidates", [])],
                }
                for item in catalog_failures
            ],
        ]}
        return _blocked_output(
            output,
            "blocked_by_template_catalog",
            catalog_preflight,
            "模板库检索未找到满足数据列与数据类型要求的已注册模板；需要扩库后再调用模型。",
        )

    expected_ids = {item["figure_id"] for item in packet["deterministic_recommendations"]}
    client = ModelClient(settings)
    deadline_at = time.monotonic() + settings.meeting_deadline_seconds
    stages: list[dict[str, Any]] = []

    design_model = settings.model
    design_payload = {
        "visual_requests": packet["visual_requests"],
        "data_analyses": packet["data_analyses"],
        "section_context": section_context,
        "corpus_examples": packet["corpus_examples"],
        "template_catalog": packet["template_catalog"],
        "palette_catalog": packet["palette_catalog"],
        "deterministic_recommendations": packet["deterministic_recommendations"],
        "response_contract": {
            "template_selections": ["figure_id", "template_id", "palette_id", "encoding_requirements", "template_selection_rationale", "palette_selection_rationale"],
            "design_summary": "short string",
        },
    }
    design_user = (
        "一次完成图表意图复核和模板确认。逐图选择已注册模板；确定性推荐是首选，如替换仍须来自 template_catalog，"
        "不得更改 figure_id、证据或数据文件，不得发明模板、色板、数值或统计结论。配色必须从 palette_catalog 选择；"
        "热力图优先考虑雾蓝陶橙，但若图义、对比或可读性更适合其他连续色板，可据前端审美改选并写明 palette_selection_rationale。"
        "代码质量由本地确定性门禁负责。"
        "只返回符合 response_contract 的 JSON。\n" + json.dumps(design_payload, ensure_ascii=False)
    )
    design = _mock_response(design_model, "single_model_design", design_payload, output) if use_mock_models else _stage_call(
        client, design_model, "single_model_design", SYSTEM, design_user, output, deadline_at, temperature=0.2,
    )
    stages.append(design)
    deterministic_by_id = {item["figure_id"]: item for item in packet["deterministic_recommendations"]}
    analyses_by_path = {str(item["path"]): item for item in packet["data_analyses"]}
    if design.get("error") or not _validate_template_selections(
        design.get("parsed", {}), expected_ids,
        deterministic_by_id=deterministic_by_id, analyses_by_path=analyses_by_path,
    ):
        return _blocked_output(
            output, "blocked_by_model_stage", preflight, "single_model_design 未满足输出契约。",
            model_calls_started=True, stages=stages, route_events=client.route_events,
        )

    requests_by_id = {str(item["id"]): item for item in packet["visual_requests"]}
    analyses_by_path = {str(item["path"]): item for item in packet["data_analyses"]}
    deterministic_by_id = {item["figure_id"]: item for item in packet["deterministic_recommendations"]}
    figures: list[dict[str, Any]] = []
    for selection in design["parsed"]["template_selections"]:
        figure_id = str(selection["figure_id"])
        fixed = deterministic_by_id[figure_id]
        data_file = fixed["data_file"]
        encoding = dict(selection["encoding_requirements"])
        required = TEMPLATE_REGISTRY[str(selection["template_id"])]["required_columns"]
        columns = {str(item["name"]) for item in analyses_by_path[data_file]["columns"]}
        missing = [logical for logical in required if str(encoding.get(logical, "")) not in columns]
        request = requests_by_id[figure_id]
        code_path = output / "figures" / f"{safe_name(figure_id)}.py"
        generate_code_file(
            code_path,
            str(selection["template_id"]),
            str(selection["palette_id"]),
            encoding,
            data_file,
            output_formats=request.get("preferred_output_formats", ["pdf", "png", "svg"]),
        )
        quality = check_code_file(
            code_path,
            caption_intent=str(request.get("caption_intent", "")),
            required_annotations=[str(item) for item in request.get("required_annotations", [])],
        )
        fulfillment = check_request_fulfillment(request, encoding)
        quality["violations"].extend(fulfillment["violations"])
        quality["quality_checks_passed"] = not quality["violations"]
        if missing:
            quality["violations"].extend({
                "type": "missing_data_column",
                "line_number": 0,
                "detail": f"逻辑编码 {logical} 未绑定到数据列。",
            } for logical in missing)
            quality["quality_checks_passed"] = False
        figure = {
            "figure_id": figure_id,
            "kind": request["kind"],
            "template_id": str(selection["template_id"]),
            "palette_id": str(selection["palette_id"]),
            "palette_selection_rationale": str(selection["palette_selection_rationale"]),
            "python_code_path": str(code_path),
            "python_code_sha256": hashlib.sha256(code_path.read_bytes()).hexdigest(),
            "data_file": data_file,
            "data_sha256": analyses_by_path[data_file]["sha256"],
            "paper_figure_ref": request.get("paper_figure_ref"),
            "content_ownership": request.get("content_ownership", {
                "figure_title_owner": "paper_writing_mcp",
                "pre_reading_task_owner": "paper_writing_mcp",
                "post_conclusion_owner": "paper_writing_mcp",
                "encoding_owner": "nexiom_visualization",
                "annotation_owner": "nexiom_visualization",
            }),
            "allowed_conclusions": list(request.get("allowed_conclusions", [])),
            "forbidden_claims": list(request.get("forbidden_claims", [])),
            "render_level": str(request.get("render_level", "L1")),
            "render_route": str(request.get("render_route", "presentation_only")),
            "evidence_operation": dict(request.get("evidence_operation", {})),
            "encoding_requirements": encoding,
            "template_selection_rationale": str(selection["template_selection_rationale"]),
            "quality_checks_passed": quality["quality_checks_passed"],
            "violations": quality["violations"],
        }
        figures.append(figure)

    gap_suggestions = detect_missing_figures(section_context, packet["visual_requests"], corpus_root=settings.project_root / "corpus")
    request_updates = [
        {
            "id": figure["figure_id"],
            "owner": "nexiom_visualization",
            "status": "design_completed" if figure["quality_checks_passed"] else "requires_revision",
            "template_id": figure["template_id"],
            "encoding_requirements": figure["encoding_requirements"],
            "template_selection_rationale": figure["template_selection_rationale"],
            "palette_id": figure["palette_id"],
            "palette_selection_rationale": figure["palette_selection_rationale"],
        }
        for figure in figures
    ]
    request_updates_path = write_json(output / "visual_request_updates.json", request_updates)
    transcript_path = write_json(output / "meeting_transcript.json", {
        "schema_version": "visual_design_meeting_transcript/1.0.0",
        "protocol": MEETING_PROTOCOL,
        "status": "complete",
        "stages": [
            {
                "stage": stage,
                "presentation": STAGE_PRESENTATION[stage],
                "model_name": value.get("model_name"),
                "model": value.get("model"),
                "role": value.get("role"),
                "parsed": value.get("parsed", {}),
                "usage": value.get("usage", {}),
                "checkpoint_path": value.get("checkpoint_path"),
            }
            for stage, value in zip(STAGE_PRESENTATION, stages)
        ],
    })
    violations = [violation for figure in figures for violation in figure["violations"]]
    issue_types = sorted({str(item["type"]) for item in violations})
    deterministic_pass = all(figure["quality_checks_passed"] for figure in figures)
    result = {
        "schema_version": "1.0.0",
        "run_id": output.name,
        "status": "completed" if deterministic_pass else "blocked_by_quality_gate",
        "model_calls_started": True,
        "figures": figures,
        "gap_suggestions": gap_suggestions,
        "quality_report": {
            "total_figures": len(figures),
            "passed": sum(bool(figure["quality_checks_passed"]) for figure in figures),
            "violations_count": len(violations),
            "common_issues": issue_types,
            "deterministic_gate_passed": deterministic_pass,
            "model_gate_decision": "pass" if deterministic_pass else "not_run",
        },
        "meeting_transcript_path": str(transcript_path),
        "preflight_report_path": str(preflight_path),
        "request_updates_path": str(request_updates_path),
        "route_events": client.route_events,
        "presentation_preflight": preflight.get("presentation_preflight", {}),
    }
    validation = validate_visual_design_output(result)
    if not validation["valid"]:
        raise RuntimeError(f"内部 visual_design_output 契约失败: {validation['errors']}")
    write_json(output / "visual_design_output-1.0.0.json", result)
    append_visualization_event(output, "visual_design.meeting.completed", status=result["status"], figures=len(figures), passed=result["quality_report"]["passed"])
    return result
