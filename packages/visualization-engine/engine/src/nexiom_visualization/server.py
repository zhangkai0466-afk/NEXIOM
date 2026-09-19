from __future__ import annotations

from pathlib import Path
from typing import Any
from importlib import import_module

from adapter import transport_protocol_descriptor

from . import __version__
from .analyzers.data_analyzer import analyze_data_file as analyze_file
from .analyzers.gap_detector import detect_missing_figures as find_missing_figures
from .analyzers.request_analyzer import preflight_visual_design_inputs as preflight_inputs
from .artifacts import create_run_dir
from .config import load_settings
from .contracts import validate_visual_design_output as validate_output
from .generators.prompt_generator import generate_principle_figure_prompt as principle_prompt
from .handoff import update_visual_request_fields as update_request_fields
from .meeting import (
    MEETING_PROTOCOL,
    STAGE_MAX_TOKENS,
    STAGE_PRESENTATION,
    build_visual_design_packet as build_packet,
    run_visual_design_meeting as run_meeting,
)
from .paper_pipeline import build_paper_visual_inventory as build_paper_inventory
from .paper_pipeline import execute_saved_paper_visual_plan as execute_saved_plan
from .paper_pipeline import run_paper_visualization_pipeline as run_paper_pipeline
from .production import render_and_inspect_figures as render_and_inspect
from .quality.checker import check_code_file, check_code_quality as check_source_quality
from .quality.checker import check_request_fulfillment as check_fulfillment
from .quality.rules import VISUAL_HARD_RULES
from .recommenders.template_matcher import (
    list_available_templates as available_templates,
    match_request as search_catalog,
)
from .recommenders.palette_recommender import palette_catalog_for_model
from .recommenders.grammar_index import search_visual_grammar_terms as search_grammar_terms
from .recommenders.grammar_index import visual_grammar_index_summary as grammar_index_summary
from .visual_argument import MAX_PANELS_PER_FIGURE, RECOMMENDED_MAX_FIGURES
from .template_registry import TEMPLATE_REGISTRY

from native_registry import NativeRegistry

# Import the Studio stack once on the server's main thread.  Importing
# Matplotlib-backed Studio modules for the first time inside FastMCP's worker
# thread can stall on Windows/Python 3.14, leaving small tool responses pending
# forever even though initialize and tools/list succeed.
try:
    from scientific_palette_studio.catalog import get_palette as studio_get_palette
    from scientific_palette_studio.catalog import load_palettes as studio_load_palettes
    from scientific_palette_studio.rendering import CHART_SPECS as STUDIO_CHART_SPECS
    from scientific_palette_studio.rendering import compose_palette as studio_compose_palette
    from scientific_palette_studio.rendering import render_chart as studio_render_chart
    _STUDIO_IMPORT_ERROR = ""
except Exception as exc:  # pragma: no cover - health_check reports the failure
    studio_get_palette = None
    studio_load_palettes = None
    studio_compose_palette = None
    studio_render_chart = None
    STUDIO_CHART_SPECS = ()
    _STUDIO_IMPORT_ERROR = f"{type(exc).__name__}: {exc}"


# Import scientific backends on the main thread too.  In particular the first
# Seaborn/SciPy import can otherwise block a Windows FastMCP worker's health call.
for _backend_name in ("matplotlib", "seaborn", "scipy"):
    try:
        import_module(_backend_name)
    except Exception:
        pass  # health_check retains its explicit dependency diagnostics.

registry = NativeRegistry("visual-design-mcp", instructions="""
项目级/论文级可视化默认先研究证据，不要求用户预制绘图CSV。流程：
discover_visual_research_project → search_visual_research_sources与get_visual_research_cards分页发现 →
read_visual_research_source核验资料 → run_visual_research_unit分单元研究 → execute_visual_research_tasks计算 →
prepare_researched_visual_inventory → run_visual_stage_unit逐研究问题探索，visual_stage_report汇总。
exploration第一层独立候选池可累计20、30张或更多；refinement第二层独立按框架设计，正文目标15至20张。
两层独立目录和验收，第二层不依赖第一层清单；少于目标必须查漏说明，不造数据凑图。
用visual_research_progress追踪未读卡片、待查来源和实验；next_offset非空意味着仍有未读页。
目录完整不等于全部模板可执行；角色/图形不适用可明确拒绝，不强制凑图。
外部训练与新实验交本地Codex审查范围、成本和验证数据流，不执行任意模型代码、不改论文源文件。
已完成研究后的选图只处理小单元，不能重复把全文全库塞回单次模型调用。
若用户明确只绘制某份数据或某张图，可使用现有单图入口。小型排版修订不调用模型。
""")


@registry.tool()
def run_visual_stage_unit(inventory_path: str, output_root: str, stage: str, unit_id: str,
                          research_question: str, section_context: str = '',
                          previous_plan_path: str = '', render: bool = True) -> dict[str, Any]:
    """赛前入口：每次执行一个小研究单元，两层自动隔离；重复输入可复用模型检查点。第二层只强制要求框架。"""
    from .competition_workflow import run_visual_stage_unit as run
    return run(inventory_path, output_root, stage, unit_id, research_question,
               section_context, previous_plan_path, render)


@registry.tool()
def visual_stage_report(output_root: str, stage: str) -> dict[str, Any]:
    """不调用模型：汇总独立层的候选与已渲染图，报告未完成单元、证据缺口和正文图量不足。"""
    from .competition_workflow import visual_stage_report as report
    return report(output_root, stage)


@registry.tool()
def get_visual_research_cards(family: str = "", offset: int = 0, limit: int = 12) -> dict[str, Any]:
    """分批读取图形作用、证据要求、准备步骤、替代画法与不能证明的结论。返回next_offset和全类别统计。"""
    from .recommenders.research_cards import get_visual_research_cards as run
    return run(family, offset, limit)


@registry.tool()
def discover_visual_research_project(project_root: str, output_dir: str, max_files: int = 3000) -> dict[str, Any]:
    """阶段1：索引授权项目的数据、方案与代码，不要求预制绘图CSV、不执行现有代码。"""
    from .research_workflow import discover_visual_research_project as run
    result=run(project_root, output_dir, max_files)
    return {k:v for k,v in result.items() if k not in {'sources','skipped'}} | {
        'source_count':len(result['sources']),'source_preview':result['sources'][:20],
        'skipped_count':len(result['skipped']),'next_tool':'search_visual_research_sources',
        'delivery_note':'完整索引保存在inventory_path，响应只预览前20项，避免一次塞入全部文件信息。'}


@registry.tool()
def search_visual_research_sources(inventory_path: str, query: str = "", kind: str = "", offset: int = 0, limit: int = 20) -> dict[str, Any]:
    """按研究名词、路径或列名检索项目来源，分页返回source_id；kind为table/document/code，未读资料不作结论。"""
    from .research_workflow import search_visual_research_sources as run
    return run(inventory_path, query, kind, offset, limit)


@registry.tool()
def read_visual_research_source(inventory_path: str, source_id: str, offset: int = 0, limit: int = 8000) -> dict[str, Any]:
    """阶段2：按稳定source_id核验哈希后分页阅读资料；PDF/Excel等明确要求提取，不假装已经读懂。"""
    from .research_workflow import read_visual_research_source as run
    return run(inventory_path, source_id, offset, limit)


@registry.tool()
def run_visual_research_unit(inventory_path: str, question: str, source_ids: list[str], family: str,
                             output_dir: str, card_offset: int = 0, source_offset: int = 0) -> dict[str, Any]:
    """阶段3：配置模型每次研究一个问题、最多4份资料与8张用途卡，输出反证、分析任务、待查来源和实验移交。"""
    from .research_workflow import run_visual_research_unit as run
    return run(inventory_path, question, source_ids, family, output_dir, card_offset, source_offset)


@registry.tool()
def execute_visual_research_tasks(plan_path: str, output_dir: str) -> dict[str, Any]:
    """阶段4：本地确定性计算缺失、分组描述、相关及连续响应预测诊断；新增实验交本地Codex审查，禁止任意代码。"""
    from .research_workflow import execute_visual_research_tasks as run
    return run(plan_path, output_dir)


@registry.tool()
def prepare_researched_visual_inventory(execution_path: str, output_dir: str) -> dict[str, Any]:
    """阶段5：核验新计算证据与来源哈希，交给exploration/refinement选图绘图；保留未完成实验清单。"""
    from .research_workflow import prepare_researched_visual_inventory as run
    result=run(execution_path, output_dir)
    return {k:result[k] for k in ('status','inventory_path','snapshot_id','research_unresolved','selection_scope')} | {
        'evidence_count':len(result['evidence']),'next_tool':'run_evidence_visual_pipeline'}


@registry.tool()
def visual_research_progress(inventory_path: str, research_dir: str) -> dict[str, Any]:
    """阶段进度：区分已读/未读图形卡、过期研究单元、待查资料与外部实验；禁止把一页研究称为地毯式完成。"""
    from .research_workflow import visual_research_progress as run
    return run(inventory_path, research_dir)


@registry.tool()
def build_evidence_visual_inventory(data_files: list[str], context_files: list[str], output_dir: str) -> dict[str, Any]:
    """撰写前入口：输入CSV/TSV证据与MD/TXT/JSON研究资料，建立完整名词/模板/证据快照。"""
    from .evidence_pipeline import build_evidence_visual_inventory as build
    return build(data_files, context_files, output_dir)


@registry.tool()
def run_evidence_visual_pipeline(inventory_path: str, output_dir: str, stage: str = "exploration",
                                 section_context: str = "", previous_plan_path: str = "",
                                 render: bool = True) -> dict[str, Any]:
    """双阶段设计：exploration探索证据；refinement结合章节和前期清单补图选图。返回图像及待核验叙事建议。"""
    from .evidence_pipeline import run_evidence_visual_pipeline as run
    return run(inventory_path, output_dir, stage, section_context, previous_plan_path, render)


@registry.tool()
def health_check() -> dict[str, Any]:
    settings = load_settings()
    studio_available = not _STUDIO_IMPORT_ERROR and studio_load_palettes is not None
    studio_error = _STUDIO_IMPORT_ERROR
    palette_count = len(studio_load_palettes()) if studio_available else 0
    renderer_count = len(STUDIO_CHART_SPECS) if studio_available else 0
    plotting_libraries = {}
    for name in ("matplotlib", "seaborn", "scipy"):
        try:
            library = import_module(name)
            plotting_libraries[name] = {"available": True, "version": library.__version__}
        except Exception as exc:
            plotting_libraries[name] = {"available": False, "error": f"{type(exc).__name__}: {exc}"}
    plotting_ready = all(item["available"] for item in plotting_libraries.values())
    return {
        "status": "ok" if settings.model_configured and studio_available and plotting_ready else "needs_configuration",
        "plotting_libraries": plotting_libraries,
        "version": __version__,
        "project_workflow": "discover_search_read_research_compute_verify_select_refine",
        "research_request_wall_timeout_seconds": 60,
        "project_root": str(settings.project_root),
        "runs_dir": str(settings.runs_dir),
        "configuration_center_is_authoritative": False,
        "configuration_source": "NEXIOM visualization provider",
        "model_configured": settings.model_configured,
        "request_timeout_seconds": settings.timeout_seconds,
        "maximum_request_attempts": settings.retry_attempts,
        "retry_backoff_seconds": settings.retry_backoff_seconds,
        "meeting_deadline_seconds": settings.meeting_deadline_seconds,
        "models": [
            {"name": model.name, "model": model.model, "provider": model.provider, "role": model.role, "base_url": model.base_url}
            for model in settings.models
        ],
        "meeting_protocol": MEETING_PROTOCOL,
        "stage_presentation": STAGE_PRESENTATION,
        "stage_max_tokens": STAGE_MAX_TOKENS,
        "transport_protocol": transport_protocol_descriptor(),
        "template_count": len(TEMPLATE_REGISTRY),
        "studio_available": studio_available,
        "studio_error": studio_error,
        "studio_renderer_count": renderer_count,
        "palette_count": palette_count,
        "palette_catalog_source": "studio/data/palettes.json",
        "recommended_max_figures": RECOMMENDED_MAX_FIGURES,
        "max_panels_per_figure": MAX_PANELS_PER_FIGURE,
        "panel_count_policy": "model_decided_no_fixed_maximum; deterministic_gate_checks_shared_reader_question_shared_visual_role_joint_scan_and_body_width_readability",
        "output_contract": "visual_design_output/1.0.0",
        "visual_hard_rules": VISUAL_HARD_RULES,
        "writes_latex": False,
        "latex_owner": "local_codex",
    }


@registry.tool()
def create_visual_design_run(run_name: str = "visual_design") -> dict[str, Any]:
    path = create_run_dir(load_settings().runs_dir, run_name)
    return {"status": "created", "run_id": path.name, "output_dir": str(path)}


@registry.tool()
def preflight_visual_design_inputs(
    visual_requests: list[dict[str, Any]],
    data_files: list[str],
    section_context: str,
    output_dir: str,
    data_file_by_request: dict[str, str] | None = None,
) -> dict[str, Any]:
    return preflight_inputs(
        visual_requests, data_files, section_context, output_dir,
        data_file_by_request=data_file_by_request,
    )


@registry.tool()
def analyze_data_file(data_file: str, sample_rows: int = 5) -> dict[str, Any]:
    return analyze_file(data_file, sample_rows=sample_rows)


@registry.tool()
def build_visual_design_packet(
    visual_requests: list[dict[str, Any]],
    data_files: list[str],
    section_context: str,
    output_dir: str,
    data_file_by_request: dict[str, str] | None = None,
) -> dict[str, Any]:
    return build_packet(
        visual_requests, data_files, section_context, output_dir,
        data_file_by_request=data_file_by_request,
    )


@registry.tool()
def run_visual_design_meeting(
    visual_requests: list[dict[str, Any]],
    data_files: list[str],
    section_context: str,
    output_dir: str,
    data_file_by_request: dict[str, str] | None = None,
    use_mock_models: bool = False,
) -> dict[str, Any]:
    return run_meeting(
        visual_requests, data_files, section_context, output_dir,
        settings=load_settings(),
        data_file_by_request=data_file_by_request,
        use_mock_models=use_mock_models,
    )


@registry.tool()
def build_paper_visual_inventory(paper_root: str, data_dir: str, entry_tex: str = "") -> dict[str, Any]:
    """Read a full LaTeX paper while removing existing visual forms, and inventory frozen figure data."""
    return build_paper_inventory(paper_root, data_dir, entry_tex=entry_tex or None)


@registry.tool()
def run_paper_visualization_pipeline(
    paper_root: str,
    data_dir: str,
    output_dir: str,
    entry_tex: str = "",
) -> dict[str, Any]:
    """Plan, generate, render and gate a complete paper-level visualization set."""
    return run_paper_pipeline(paper_root, data_dir, output_dir, settings=load_settings(), entry_tex=entry_tex or None)


@registry.tool()
def execute_saved_paper_visual_plan(
    plan_path: str,
    paper_root: str,
    data_dir: str,
    output_dir: str,
    entry_tex: str = "",
) -> dict[str, Any]:
    """Re-run local semantic gates and rendering from a saved plan, with zero additional model calls."""
    return execute_saved_plan(
        plan_path, paper_root, data_dir, output_dir,
        settings=load_settings(), entry_tex=entry_tex or None,
    )


@registry.tool()
def render_and_inspect_visual_design(visual_design_output_json: str, output_dir: str) -> dict[str, Any]:
    payload = Path(visual_design_output_json).expanduser().resolve()
    import json
    return render_and_inspect(json.loads(payload.read_text(encoding="utf-8")), output_dir)


@registry.tool()
def check_request_fulfillment(visual_request: dict[str, Any], encoding_requirements: dict[str, Any]) -> dict[str, Any]:
    return check_fulfillment(visual_request, encoding_requirements)


@registry.tool()
def validate_visual_design_output(visual_design_output_json: str) -> dict[str, Any]:
    return validate_output(visual_design_output_json)


@registry.tool()
def detect_missing_figures(section_context: str, visual_requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return find_missing_figures(section_context, visual_requests, corpus_root=load_settings().project_root / "corpus")


@registry.tool()
def generate_principle_figure_prompt(
    visual_request: dict[str, Any],
    section_context: str,
    visual_form: str = "",
) -> dict[str, Any]:
    return principle_prompt(visual_request, section_context, visual_form=visual_form)


@registry.tool()
def check_code_quality(
    python_code: str = "",
    python_code_path: str = "",
    caption_intent: str = "",
    required_annotations: list[str] | None = None,
) -> dict[str, Any]:
    if bool(python_code.strip()) == bool(python_code_path.strip()):
        raise ValueError("python_code 与 python_code_path 必须且只能提供一个。")
    if python_code_path.strip():
        return check_code_file(python_code_path, caption_intent=caption_intent, required_annotations=required_annotations)
    return check_source_quality(python_code, caption_intent=caption_intent, required_annotations=required_annotations)


@registry.tool()
def list_available_templates() -> dict[str, Any]:
    return available_templates()


@registry.tool()
def list_visual_grammar_index() -> dict[str, Any]:
    """Summarize executable templates plus the larger chart-name discovery vocabulary."""
    return grammar_index_summary()


@registry.tool()
def search_visual_grammar_terms(query: str = "", limit: int = 20, executable_only: bool = False) -> dict[str, Any]:
    """Find a chart even when the caller only knows a Chinese/English fragment or its intended reader question."""
    return search_grammar_terms(query=query, limit=limit, executable_only=executable_only)


@registry.tool()
def search_visual_templates(visual_request: dict[str, Any], data_file: str) -> dict[str, Any]:
    """Search executable registered templates against one request and one analyzed data file."""
    analysis = analyze_file(data_file)
    result = search_catalog(visual_request, analysis)
    return {
        "schema_version": "visual_template_search/1.0.0",
        "catalog_policy": "data_compatibility_then_kind_family_semantics",
        "data_file": analysis["path"],
        "data_sha256": analysis["sha256"],
        **result,
    }


@registry.tool()
def list_available_palettes() -> list[dict[str, Any]]:
    if studio_load_palettes is None:
        raise RuntimeError(f"Science Palette Studio unavailable: {_STUDIO_IMPORT_ERROR}")
    return palette_catalog_for_model()


@registry.tool()
def render_preview(
    palette_id: str,
    chart_id: str,
    output_dir: str,
    color_indices: list[int] | None = None,
    extension_indices: list[int] | None = None,
    output_formats: list[str] | None = None,
    dpi: int = 300,
    width: float = 6.4,
    height: float = 4.0,
) -> dict[str, Any]:
    if studio_get_palette is None or studio_compose_palette is None or studio_render_chart is None:
        raise RuntimeError(f"Science Palette Studio unavailable: {_STUDIO_IMPORT_ERROR}")
    palette = studio_get_palette(palette_id)
    if color_indices is not None or extension_indices is not None:
        palette = studio_compose_palette(
            palette,
            color_indices if color_indices is not None else range(palette.count),
            extension_indices or [],
        )
    paths = studio_render_chart(
        palette,
        chart_id,
        Path(output_dir).expanduser().resolve(),
        formats=tuple(output_formats or ["svg", "png", "pdf"]),
        dpi=dpi,
        figsize=(width, height),
    )
    return {"status": "rendered", "palette_id": palette_id, "chart_id": chart_id, "paths": [str(path) for path in paths]}


@registry.tool()
def update_visual_request_fields(
    section_content_package_json: str,
    visual_design_output_json: str,
    output_path: str,
) -> dict[str, Any]:
    return update_request_fields(section_content_package_json, visual_design_output_json, output_path)


def main() -> None:
    raise RuntimeError("Use the NEXIOM native.py worker.")


if __name__ == "__main__":
    main()
