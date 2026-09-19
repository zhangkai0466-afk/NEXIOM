from __future__ import annotations

import re
from typing import Any

from ..template_registry import TEMPLATE_REGISTRY
from .palette_recommender import preferred_palette_id, rank_palette_candidates


FAMILY_DEFAULTS = {
    "line": "line", "scatter": "scatter", "bar": "bar_grouped", "distribution": "boxplot",
    "matrix": "heatmap", "polar": "pie", "scientific": "errorbar", "control": "sensitivity_tornado",
    "diagnostic": "residual_plot", "composition": "stacked_area", "schedule": "gantt_schedule",
    "network": "network_graph",
    "spatial": "trajectory_path",
}
KIND_WEIGHTS = {
    "result_comparison": 20,
    "sensitivity_analysis": 100,
    "diagnostic_plot": 40,
    "uncertainty_visualization": 100,
    "network_visualization": 100,
    "schedule_visualization": 100,
    "spatial_visualization": 100,
    "relationship_analysis": 100,
    "preprocessing_validation": 100,
    "classification_validation": 100,
    "sampling_diagnostics": 100,
    "time_series_diagnostics": 100,
    "solver_diagnostics": 100,
    "decision_support": 100,
    "optimization_tradeoff": 100,
}
KIND_DEFAULTS = {
    "result_comparison": "bar_grouped",
    "sensitivity_analysis": "sensitivity_tornado",
    "diagnostic_plot": "residual_plot",
    "uncertainty_visualization": "uncertainty_band",
    "network_visualization": "network_graph",
    "schedule_visualization": "gantt_schedule",
    "spatial_visualization": "trajectory_path",
    "relationship_analysis": "scatter_smooth",
    "preprocessing_validation": "before_after_series",
    "classification_validation": "confusion_matrix",
    "sampling_diagnostics": "trace_plot",
    "time_series_diagnostics": "acf_plot",
    "solver_diagnostics": "convergence_curve",
    "decision_support": "threshold_tradeoff",
    "optimization_tradeoff": "pareto_front",
}
COLUMN_SYNONYMS = {
    "x_column": ("x", "iteration", "迭代", "time", "时间", "obj1", "目标1", "fitted", "predicted", "预测值"),
    "y_column": ("y", "objective_value", "objective", "obj_val", "误差", "value", "值", "obj2", "目标2"),
    "estimate_column": ("estimate", "effect", "cliffs_delta", "delta_youden_median", "delta_auc_median", "delta_ba_median", "youden_median", "估计值", "效应量"),
    "residual_column": ("residual", "resid", "残差", "error", "误差"),
    "value_column": ("value", "值", "score", "rho", "correlation", "signed_group_difference", "结果", "objective", "residual", "resid", "残差", "measurement", "观测值"),
    "predicted_column": ("predicted", "prediction", "probability", "prob", "预测", "预测概率"),
    "observed_column": ("observed", "actual", "outcome", "observed_rate", "观测", "实际", "观测频率"),
    "lower_column": ("lower", "low", "bca_ci_low", "delta_youden_p025", "delta_auc_p025", "delta_ba_p025", "youden_p025", "p025", "下界", "下限", "lower_bound"),
    "upper_column": ("upper", "high", "bca_ci_high", "delta_youden_p975", "delta_auc_p975", "delta_ba_p975", "youden_p975", "p975", "上界", "上限", "upper_bound"),
    "hue_column": ("hue", "class", "category", "类别", "group", "组别"),
    "group_column": ("group", "组别", "series", "方案", "category", "类别"),
    "category_column": ("category", "variable", "config_id", "row_role", "factor", "类别", "label", "名称", "parameter", "参数"),
    "row_column": ("row", "variable_i", "行", "feature_y", "指标y"),
    "column_column": ("column", "col", "variable_j", "列", "feature_x", "指标x"),
    "yerr_column": ("yerr", "std", "sd", "标准差", "error", "误差"),
    "bound_column": ("theoretical_bound", "bound", "下界", "上界"),
    "parameter_column": ("parameter", "参数", "factor", "因素"),
    "low_column": ("low", "下限", "lower", "负向"),
    "high_column": ("high", "上限", "upper", "正向"),
    "baseline_column": ("baseline", "基准", "base"),
    "dominated_column": ("dominated", "支配", "is_dominated"),
    "task_column": ("task", "任务", "activity", "活动"),
    "start_column": ("start", "开始", "start_time", "起始时间"),
    "end_column": ("end", "结束", "end_time", "结束时间"),
    "source_column": ("source", "来源", "from", "起点"),
    "target_column": ("target", "目标", "to", "终点"),
    "weight_column": ("weight", "权重", "strength", "强度"),
    "label_column": ("label", "标签", "name", "名称", "node", "节点"),
    "order_column": ("order", "sequence", "顺序", "序号", "step", "步骤"),
    "metric_column": ("metric", "指标", "measure"),
    "stage_column": ("stage", "阶段", "处理状态", "before_after"),
    "threshold_column": ("threshold", "阈值", "cutoff"),
    "actual_column": ("actual_class", "actual", "true_label", "真实类别", "实际类别"),
    "predicted_class_column": ("predicted_class", "predicted_label", "预测类别"),
    "iteration_column": ("iteration", "iter", "迭代", "step", "步骤"),
    "observed_column": ("observed", "actual", "观测", "真实值"),
    "predicted_column": ("predicted", "prediction", "预测", "预测值"),
    "resampling_method": ("bootstrap", "重采样"),
    "response_column": ("response", "target", "metric", "响应", "目标变量", "指标"),
    "pair_column": ("pair", "pair_id", "subject", "样本对", "个体", "配对编号"),
    "vif_column": ("vif", "variance_inflation_factor", "方差膨胀因子"),
    "pvalue_column": ("pvalue", "p_value", "p值", "显著性"),
    "fpr_column": ("fpr", "false_positive_rate", "假阳性率"),
    "tpr_column": ("tpr", "true_positive_rate", "sensitivity", "真阳性率", "灵敏度"),
    "auc_column": ("auc", "roc_auc", "曲线下面积"),
    "feature_column": ("feature", "variable", "特征", "变量"),
    "shap_column": ("shap", "shap_value", "shap值", "预测贡献"),
    "feature_value_column": ("feature_value", "特征值", "变量值"),
    "interaction_column": ("interaction", "interaction_value", "交互变量", "交互值"),
    "item_column": ("item", "item_id", "sample_id", "对象", "对象编号", "样本编号"),
    "set_column": ("set", "set_name", "集合", "集合名称"),
    "membership_column": ("membership", "member", "属于", "成员标记"),
    "longitude_column": ("longitude", "lon", "lng", "经度", "x_coord"),
    "latitude_column": ("latitude", "lat", "纬度", "y_coord"),
    "region_column": ("region", "区域", "行政区", "地区"),
    "x1_column": ("fpr", "prevalence", "x1"),
    "y1_column": ("tpr", "ppv", "y1"),
    "x2_column": ("recall", "prevalence", "x2"),
    "y2_column": ("precision", "npv", "y2"),
    "value1_column": ("marginal_abs_delta", "marginal_delta", "value1"),
    "value2_column": ("residual_delta", "cond_gain_median_delta_youden", "value2"),
}
NUMERIC_LOGICALS = {
    "x_column", "y_column", "value_column", "yerr_column", "low_column", "high_column", "baseline_column", "bound_column", "order_column",
    "lower_column", "upper_column", "predicted_column", "observed_column", "start_column", "end_column", "weight_column",
    "estimate_column", "threshold_column", "iteration_column", "vif_column", "pvalue_column", "fpr_column", "tpr_column", "auc_column",
    "shap_column", "feature_value_column", "interaction_column", "longitude_column", "latitude_column",
    "x1_column", "y1_column", "x2_column", "y2_column", "value1_column", "value2_column",
}
CATEGORICAL_LOGICALS = {
    "category_column", "row_column", "column_column", "parameter_column", "group_column", "hue_column",
    "task_column", "source_column", "target_column", "label_column",
    "stage_column", "actual_column", "predicted_class_column", "response_column", "pair_column", "feature_column",
    "item_column", "set_column", "membership_column", "region_column",
}


def _column_names(data_analysis: dict[str, Any]) -> list[str]:
    return [str(item.get("name")) for item in data_analysis.get("columns", []) if item.get("name")]


def _column_types(data_analysis: dict[str, Any]) -> dict[str, str]:
    numeric = {str(value) for value in data_analysis.get("numeric_columns", [])}
    categorical = {str(value) for value in data_analysis.get("categorical_columns", [])}
    return {name: "numeric" if name in numeric else "categorical" if name in categorical else "other" for name in _column_names(data_analysis)}


def _compatible(template_id: str, encoding: dict[str, Any], data_analysis: dict[str, Any]) -> tuple[list[str], list[str]]:
    names = set(_column_names(data_analysis))
    types = _column_types(data_analysis)
    metadata = TEMPLATE_REGISTRY[template_id]
    missing: list[str] = []
    wrong_type: list[str] = []
    for logical in metadata["required_columns"]:
        column = str(encoding.get(logical, ""))
        if column not in names:
            missing.append(logical)
            continue
        expected = metadata.get("required_column_types", {}).get(logical)
        if expected and types.get(column) != expected:
            wrong_type.append(logical)
    return missing, wrong_type


def _hard_filter_reasons(
    template_id: str,
    request: dict[str, Any],
    encoding: dict[str, Any],
    data_analysis: dict[str, Any],
) -> list[str]:
    """Return deterministic eligibility failures before semantic ranking.

    Manifests deliberately keep human-readable statistical preconditions as
    audit metadata.  This function enforces only the conditions that can be
    proven from the frozen request and data profile without inferring facts.
    """
    metadata = TEMPLATE_REGISTRY[template_id]
    reasons: list[str] = []
    shape = metadata.get("data_shape", {})
    minimum_rows = shape.get("minimum_rows")
    row_count = data_analysis.get("row_count")
    if minimum_rows is not None and row_count is not None and int(row_count) < int(minimum_rows):
        reasons.append(f"row_count_below_minimum:{row_count}<{minimum_rows}")
    if shape.get("distinct_required_columns"):
        selected = [str(encoding.get(role, "")) for role in metadata["required_columns"]]
        selected = [column for column in selected if column]
        if len(selected) != len(set(selected)):
            reasons.append("required_columns_must_be_distinct")
    hard_filters = metadata.get("hard_filters", {})
    for field in hard_filters.get("required_request_fields", []):
        if not request.get(field):
            reasons.append(f"missing_request_field:{field}")
    for field in hard_filters.get("reject_if_request_contains", []):
        if request.get(field):
            reasons.append(f"rejected_request_field:{field}")
    return reasons


def validate_template_encoding(template_id: str, encoding: dict[str, Any], data_analysis: dict[str, Any]) -> dict[str, Any]:
    if template_id not in TEMPLATE_REGISTRY:
        return {"valid": False, "missing_required_columns": [], "wrong_type_columns": [], "reason": "unregistered_template"}
    missing, wrong_type = _compatible(template_id, encoding, data_analysis)
    return {
        "valid": not missing and not wrong_type,
        "missing_required_columns": missing,
        "wrong_type_columns": wrong_type,
        "reason": "compatible" if not missing and not wrong_type else "incompatible_encoding",
    }


def complete_encoding(
    template_id: str,
    requested: dict[str, Any],
    data_analysis: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    encoding = dict(requested or {})
    names = _column_names(data_analysis)
    lowered = {name.lower(): name for name in names}
    numeric = [str(item) for item in data_analysis.get("numeric_columns", [])]
    categorical = [str(item) for item in data_analysis.get("categorical_columns", [])]
    required = TEMPLATE_REGISTRY[template_id]["required_columns"]
    optional = TEMPLATE_REGISTRY[template_id]["optional_columns"]
    for logical in [*required, *optional]:
        if str(encoding.get(logical, "")).strip() in names:
            continue
        match = None
        for synonym in COLUMN_SYNONYMS.get(logical, ()):
            if synonym.lower() in lowered:
                match = lowered[synonym.lower()]
                break
        if match is None:
            if logical in NUMERIC_LOGICALS:
                used = {str(value) for value in encoding.values()}
                match = next((name for name in numeric if name not in used), None)
            elif logical in CATEGORICAL_LOGICALS:
                used = {str(value) for value in encoding.values()}
                match = next((name for name in categorical if name not in used), None)
        if match is not None:
            encoding[logical] = match
    encoding.setdefault("x_scale", "linear")
    encoding.setdefault("y_scale", "linear")
    missing, wrong_type = _compatible(template_id, encoding, data_analysis)
    return encoding, [*missing, *[f"{logical}:wrong_type" for logical in wrong_type]]


def _request_text(request: dict[str, Any]) -> str:
    return " ".join(
        [str(request.get("purpose", "")), str(request.get("reader_question", "")), str(request.get("caption_intent", ""))]
        + [str(item) for item in request.get("candidate_visuals", [])]
    ).lower()


def _keyword_matches(keyword: str, text: str) -> bool:
    normalized = keyword.lower()
    if normalized.isascii():
        return re.search(rf"(?<![a-z0-9]){re.escape(normalized)}(?![a-z0-9])", text) is not None
    return normalized in text


def search_template_candidates(request: dict[str, Any], data_analysis: dict[str, Any]) -> list[dict[str, Any]]:
    """Search registered executable templates before any model is consulted."""
    text = _request_text(request)
    explicit = str(request.get("template_id", "")).strip()
    requested_encoding = request.get("encoding_requirements", {})
    candidates: list[dict[str, Any]] = []
    for template_id, metadata in TEMPLATE_REGISTRY.items():
        if not metadata.get("selection_eligible", True):
            continue
        encoding, missing = complete_encoding(template_id, requested_encoding, data_analysis)
        wrong_type = [item for item in missing if item.endswith(":wrong_type")]
        missing_required = [item for item in missing if not item.endswith(":wrong_type")]
        hard_filter_reasons = _hard_filter_reasons(template_id, request, encoding, data_analysis)
        matched: list[str] = []
        score = 0
        if explicit and explicit == template_id:
            score += 1000
            matched.append("explicit_template_id")
        kind = str(request.get("kind", ""))
        if kind in metadata.get("supported_kinds", []) and KIND_WEIGHTS.get(kind, 0):
            score += KIND_WEIGHTS[kind]
            matched.append("kind")
        if str(request.get("template_family", "")) == metadata.get("family"):
            score += 60
            matched.append("template_family")
        keyword_hits = [keyword for keyword in metadata.get("keywords", []) if _keyword_matches(keyword, text)]
        if keyword_hits:
            score += min(50, 15 * len(keyword_hits))
            matched.extend(f"keyword:{keyword}" for keyword in keyword_hits)
        if template_id == FAMILY_DEFAULTS.get(str(request.get("template_family", ""))):
            score += 10
            matched.append("family_default")
        if template_id == KIND_DEFAULTS.get(kind):
            score += 10
            matched.append("kind_default")
        declared_roles = set(requested_encoding) & set(metadata["required_columns"])
        if declared_roles:
            score += 12 * len(declared_roles)
            matched.extend(f"declared_role:{role}" for role in sorted(declared_roles))
        candidates.append({
            "template_id": template_id,
            "score": score,
            "matched_signals": matched,
            "missing_required_columns": missing_required,
            "wrong_type_columns": wrong_type,
            "hard_filter_reasons": hard_filter_reasons,
            "eligibility": "eligible" if not missing_required and not wrong_type and not hard_filter_reasons else "rejected",
            "encoding_requirements": encoding,
            "catalog_source": metadata.get("catalog_source", "jinja"),
            "selection_eligible": True,
        })
    candidates.sort(key=lambda item: (len(item["missing_required_columns"]), len(item["wrong_type_columns"]), len(item["hard_filter_reasons"]), -item["score"], item["template_id"]))
    return candidates


def choose_template(request: dict[str, Any], data_analysis: dict[str, Any] | None = None) -> str:
    if data_analysis is not None:
        all_candidates = search_template_candidates(request, data_analysis)
        candidates = [item for item in all_candidates if item["score"] > 0 and item["eligibility"] == "eligible"]
        explicit = str(request.get("template_id", "")).strip()
        if explicit and any(item["template_id"] == explicit and item["eligibility"] == "rejected" for item in all_candidates):
            return ""
        return str(candidates[0]["template_id"]) if candidates else ""
    explicit = str(request.get("template_id", "")).strip()
    return explicit if explicit in TEMPLATE_REGISTRY else FAMILY_DEFAULTS.get(str(request.get("template_family", "")), "")


def match_request(
    request: dict[str, Any],
    data_analysis: dict[str, Any],
    *,
    palette_id: str | None = None,
) -> dict[str, Any]:
    candidates = search_template_candidates(request, data_analysis)
    usable = [item for item in candidates if item["score"] > 0 and item["eligibility"] == "eligible"]
    explicit = str(request.get("template_id", "")).strip()
    # A caller that explicitly selected a registered template must see why it
    # is unsafe, rather than silently receiving a different figure type.
    if explicit and any(item["template_id"] == explicit and item["eligibility"] == "rejected" for item in candidates):
        usable = []
    provisional_template = str(usable[0]["template_id"]) if usable else str(request.get("template_id", ""))
    chosen_palette = palette_id or preferred_palette_id(request, provisional_template)
    palette_candidates = rank_palette_candidates(request, provisional_template)
    chosen_palette_name = next(
        (str(item["name"]) for item in palette_candidates if item["palette_id"] == chosen_palette),
        chosen_palette,
    )
    palette_rationale = (
        f"从可视化审美平台实时色板中按图形语义排序，首选“{chosen_palette_name}”；"
        "配置模型可在候选色板中基于前端审美改选，但必须说明图义与可读性理由。"
    )
    if not usable:
        return {
            "figure_id": request["id"], "kind": request["kind"], "template_id": "", "palette_id": chosen_palette,
            "encoding_requirements": dict(request.get("encoding_requirements", {})),
            "template_selection_rationale": "模板库中没有同时满足请求意图、数据列和数据类型要求的已注册模板；需要扩充模板或由本地 Codex 处理。",
            "catalog_status": "catalog_no_match", "needs_template_extension": True,
            "template_candidates": candidates[:8], "missing_required_columns": sorted({column for item in candidates for column in item["missing_required_columns"]}),
            "evidence_refs": list(request.get("evidence_refs", [])), "palette_candidates": palette_candidates,
            "palette_selection_rationale": palette_rationale,
        }
    selected = usable[0]
    metadata = TEMPLATE_REGISTRY[selected["template_id"]]
    return {
        "figure_id": request["id"], "kind": request["kind"], "template_id": selected["template_id"], "palette_id": chosen_palette,
        "encoding_requirements": selected["encoding_requirements"],
        "template_selection_rationale": f"优先检索已注册模板库，按数据列兼容性、图表 kind/family 与语义信号排序，命中“{metadata['description']}”；最终排版由本地 Codex 复核。",
        "catalog_status": "matched", "needs_template_extension": False,
        "template_candidates": candidates[:8], "missing_required_columns": [],
        "evidence_refs": list(request.get("evidence_refs", [])), "palette_candidates": palette_candidates,
        "palette_selection_rationale": palette_rationale,
    }


def list_available_templates() -> dict[str, Any]:
    try:
        from scientific_palette_studio.rendering import CHART_SPECS
        studio = [
            {"template_id": spec.id, "name": spec.name, "name_en": spec.name_en, "group": spec.group, "description": spec.description,
             "catalog_source": "studio", "selection_eligible": False, "renderer_only": True}
            for spec in CHART_SPECS
        ]
    except ImportError:
        studio = []
    jinja = [{"template_id": key, **value} for key, value in TEMPLATE_REGISTRY.items()]
    return {
        "jinja_templates": jinja,
        "studio_renderers": studio,
        "jinja_template_count": len(jinja),
        "studio_renderer_count": len(studio),
        "catalog_policy": "data_compatibility_then_kind_family_semantics",
        "model_selection_policy": "registered_jinja_templates_only",
    }
