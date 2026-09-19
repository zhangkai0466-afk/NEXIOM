from __future__ import annotations

from collections import Counter
import re
from typing import Any


VISUAL_ROLES = (
    "domain_explanation",
    "paper_navigation",
    "data_understanding",
    "preprocessing_evidence",
    "relationship_evidence",
    "model_structure",
    "solver_diagnostics",
    "model_validation",
    "decision_support",
    "robustness_boundary",
    "application_landing",
)

RECOMMENDED_MAX_FIGURES = 20
MAX_PANELS_PER_FIGURE = None
MULTI_PANEL_TEMPLATES = {"faceted_heatmap", "paired_curve", "binned_density_calibration"}


def assess_figure_budget(
    plan_items: list[dict[str, Any]],
    structural_decisions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    data_figures = len([item for item in plan_items if item.get("keep", True) is not False])
    structural_figures = len([
        item for item in (structural_decisions or []) if item.get("decision") == "keep"
    ])
    planned = data_figures + structural_figures
    return {
        "recommended_max_figures": RECOMMENDED_MAX_FIGURES,
        "planned_data_figures": data_figures,
        "planned_structural_figures": structural_figures,
        "planned_total_figures": planned,
        "status": "within_recommended_budget" if planned <= RECOMMENDED_MAX_FIGURES else "requires_argument_pruning_or_explicit_exception",
        "over_by": max(0, planned - RECOMMENDED_MAX_FIGURES),
        "rule": "全文通常控制在20图以内；超过时必须逐图证明不可由文字、表格或已有图承担，并由本地Codex批准例外。",
    }


def audit_panel_plan(item: dict[str, Any]) -> dict[str, Any]:
    template_id = str(item.get("template_id", ""))
    raw_count = item.get("panel_count")
    if raw_count is None:
        panel_count = 2 if template_id == "paired_curve" else 1
    else:
        try:
            panel_count = int(raw_count)
        except (TypeError, ValueError):
            panel_count = 0
    violations: list[str] = []
    if panel_count < 1:
        violations.append("panel_count_invalid")
    relation = str(item.get("panel_relationship_type", ""))
    if template_id in MULTI_PANEL_TEMPLATES and panel_count == 1:
        violations.append("multi_panel_template_requires_declared_panel_count")
    if panel_count > 1:
        if relation not in {"homogeneous_comparison", "tightly_coupled_evidence"}:
            violations.append("panel_relationship_type_required")
        if item.get("shared_reader_question") is not True:
            violations.append("shared_reader_question_required")
        if item.get("shared_visual_role") is not True:
            violations.append("shared_visual_role_required")
        if item.get("layout_readable_at_body_width") is not True:
            violations.append("layout_readable_at_body_width_required")
        if relation == "homogeneous_comparison":
            for field in ("shared_axis_semantics", "shared_legend_semantics", "comparison_requires_joint_scan"):
                if item.get(field) is not True:
                    violations.append(f"{field}_required")
        if relation == "tightly_coupled_evidence":
            if item.get("evidence_chain_is_indivisible") is not True:
                violations.append("evidence_chain_is_indivisible_required")
        for field in ("panel_rationale", "facet_dimension", "joint_conclusion"):
            if not str(item.get(field, "")).strip():
                violations.append(f"{field}_required")
        panels = item.get("panels")
        if not isinstance(panels, list) or len(panels) != panel_count:
            violations.append("panels_must_match_panel_count")
    return {
        "valid": not violations,
        "panel_count": panel_count,
        "violations": violations,
        "policy": "默认单图，不设固定面板数。由模型按共同读者问题、共同视觉角色、联合扫读必要性与正文栏宽可读性决定；同属一问不等于可以合并。概念机理、数据关系、结果验证等不同阅读任务应拆图。",
        "panel_label_policy": "同构分面优先使用响应量、情景或对象名称；异构证据可使用(a)(b)(c)，但每个面板必须承担同一论证链中的明确步骤，不得以字母标签掩盖无关拼接。",
    }


def extract_chapter_map(manuscript: str) -> list[dict[str, str]]:
    """Extract a lightweight chapter map without depending on old figure design."""
    pattern = re.compile(r"\\(section|subsection|subsubsection)\*?\{([^{}]+)\}")
    matches = list(pattern.finditer(manuscript))
    chapters: list[dict[str, str]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(manuscript)
        body = re.sub(r"\s+", " ", manuscript[match.end():end]).strip()
        chapters.append({
            "level": match.group(1),
            "title": match.group(2).strip(),
            "body_preview": body[:1200],
        })
    return chapters


def discover_structural_opportunities(manuscript: str) -> list[dict[str, Any]]:
    """Find non-data and missing-evidence opportunities across the whole paper.

    These are research prompts, not automatic orders to draw.  The planner must
    still decide necessity and may reject every candidate with a reason.
    """
    chapters = extract_chapter_map(manuscript)
    opportunities: list[dict[str, Any]] = []
    question_titles = [item["title"] for item in chapters if re.search(r"问题[一二三四五六七八九\d]", item["title"])]
    for chapter in chapters:
        title = chapter["title"]
        body = chapter["body_preview"]
        if re.search(r"问题重述|问题背景|研究背景", title):
            opportunities.append({
                "opportunity_id": "opp_domain_explanation",
                "chapter": title,
                "visual_role": "domain_explanation",
                "reader_question": "读者是否必须先理解领域机制、对象关系或变量来源，才能理解赛题？",
                "candidate_grammars": ["领域机制示意图", "对象—变量来源图", "纯文字（若背景直白）"],
                "decision_rule": "只有图能解释机制、对象、流程或变量来源时才保留；禁止装饰性背景图。",
                "evidence_requirement": "仅使用赛题与已核验领域事实，不得补造机制。",
                "status": "requires_semantic_research",
            })
        if re.search(r"本文工作|研究思路|问题分析|总体思路", title) and len(question_titles) >= 2:
            opportunities.append({
                "opportunity_id": "opp_paper_navigation",
                "chapter": title,
                "visual_role": "paper_navigation",
                "reader_question": "各问如何共享数据、传递中间结果并形成全文闭环？",
                "candidate_grammars": ["全文任务—证据—模型—输出路线图", "依赖关系图", "结构化文字"],
                "decision_rule": "若只是数据—模型—结果三个空框则拒绝；必须呈现真实跨问依赖。",
                "evidence_requirement": "绑定当前项目任务与已核验事实，不得根据旧流程图照抄。",
                "status": "requires_semantic_research",
            })
        if re.search(r"数据预处理|数据处理|数据清洗|异常值|缺失值", title):
            opportunities.append({
                "opportunity_id": f"opp_preprocessing_{len(opportunities)+1}",
                "chapter": title,
                "visual_role": "preprocessing_evidence",
                "reader_question": "关键处理是否必要，并且没有破坏主要数据结构？",
                "candidate_grammars": ["处理前后同轴对照", "缺失模式图", "异常诊断", "精确统计表"],
                "decision_rule": "处理会影响信号、样本量或分布时优先提供对照证据。",
                "evidence_requirement": "需要处理前后同口径冻结数据；若缺失则返回证据缺口。",
                "status": "requires_evidence_check",
            })
    for title in question_titles:
        opportunities.append({
            "opportunity_id": f"opp_local_route_{len(opportunities)+1}",
            "chapter": title,
            "visual_role": "model_structure",
            "reader_question": f"“{title}”是否存在需要图示的多步骤、分支或数据流？",
            "candidate_grammars": ["单问信息流/算法流程", "模型结构图", "公式与分点文字"],
            "decision_rule": "简单线性三步流程不画；存在多分支、迭代或跨数据源时才保留。",
            "evidence_requirement": "流程节点必须来自正文与可复现算法。",
            "status": "requires_semantic_research",
        })
    # Fixed semantic opportunities (background/navigation) may be discovered
    # under both a section and a subsection.  Keep their first, most specific
    # occurrence so the planner and the figure budget never count duplicates.
    unique: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for item in opportunities:
        opportunity_id = str(item["opportunity_id"])
        if opportunity_id not in seen_ids:
            unique.append(item)
            seen_ids.add(opportunity_id)
    return unique


def visual_argument_coverage(
    plan_items: list[dict[str, Any]],
    structural_opportunities: list[dict[str, Any]],
) -> dict[str, Any]:
    represented = Counter(str(item.get("visual_role", "unclassified")) for item in plan_items)
    unresolved = [
        item for item in structural_opportunities
        if item.get("decision") not in {"omit", "covered_by_text", "covered_by_existing_plan"}
        and item.get("status") not in {"not_needed", "resolved"}
    ]
    return {
        "schema_version": "visual_argument_coverage/1.0.0",
        "role_counts": dict(represented),
        "roles_represented": sorted(role for role in represented if role != "unclassified"),
        "unclassified_plan_items": represented.get("unclassified", 0),
        "structural_opportunity_count": len(structural_opportunities),
        "unresolved_structural_opportunities": unresolved,
        "argument_coverage_ready": not unresolved and represented.get("unclassified", 0) == 0,
        "rule": "按论证角色与未决读者问题验收，不以固定图数判定完成。",
    }


def deduplicate_complementary_plans(items: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Allow complementary views of one file while rejecting semantic duplicates."""
    kept: list[dict[str, Any]] = []
    omitted: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    per_file_role: Counter[tuple[str, str]] = Counter()
    for item in items:
        data_file = str(item.get("data_file", ""))
        role = str(item.get("visual_role", "unclassified"))
        question = re.sub(r"\s+", " ", str(item.get("reader_question", "")).strip().lower())
        template = str(item.get("template_id", ""))
        key = (data_file, role, question or template)
        if key in seen:
            omitted.append({"data_file": data_file, "reason": "semantic duplicate: same evidence, role and reader question"})
            continue
        role_key = (data_file, role)
        if per_file_role[role_key] >= 2:
            omitted.append({"data_file": data_file, "reason": "more than two views answer the same visual role for one evidence file"})
            continue
        seen.add(key)
        per_file_role[role_key] += 1
        kept.append(item)
    return kept, omitted
