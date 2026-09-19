from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


ORIGIN_SOURCE = (
    "OriginLab Graph Gallery and product workflow pages "
    "(https://www.originlab.com/graphgallery); local renderer is an "
    "Origin-inspired recipe, not an Origin .otp file"
)


@dataclass(frozen=True)
class OriginTemplate:
    id: str
    name: str
    name_en: str
    workflow: str
    workflow_name: str
    family: str
    family_name: str
    description: str
    renderer: str
    input_shape: str
    analysis_task: str
    paper_use: str
    evidence_requirements: tuple[str, ...]
    source: str = ORIGIN_SOURCE


_WORKFLOWS: tuple[tuple[str, str, str], ...] = (
    ("graphing", "绘图", "Graphing"),
    ("statistics", "统计", "Statistics"),
    ("data-analysis", "数据分析", "Data analysis"),
    ("quality", "质量改进", "Quality improvement"),
    ("life-science", "生命科学", "Life science"),
    ("batch", "批处理", "Batch operations"),
)

_FAMILIES: tuple[tuple[str, str, str, str, str, str, str], ...] = (
    ("line", "折线与趋势", "Line and trend", "response-curves", "time or ordered series", "show change, response, or trajectory", "support a trend claim"),
    ("scatter", "散点与拟合", "Scatter and fit", "cluster-scatter", "paired numeric observations", "inspect association, clusters, and fit", "show relationship and model adequacy"),
    ("bar", "柱状与条形", "Bar and column", "error-bars", "categories with summary values", "compare groups or scenarios", "compare model outputs or conditions"),
    ("distribution", "分布统计", "Distribution", "violin-box", "replicates or grouped samples", "show spread, skew, and outliers", "support robustness and variability"),
    ("matrix", "矩阵与热图", "Matrix and heatmap", "clustered-heatmap", "feature by sample matrix", "reveal patterns, clusters, and correlation", "summarize high-dimensional evidence"),
    ("area", "面积与堆叠", "Area and stacked", "stacked-area", "time by component table", "show composition and cumulative change", "explain resource or contribution structure"),
    ("polar", "极坐标与雷达", "Polar and radar", "radial-profile", "angular or multi-criterion values", "compare profiles and cycles", "compare alternatives across criteria"),
    ("network", "网络与关系", "Network and relationship", "feature-network", "nodes and edge relationships", "explain connectivity and structure", "explain mechanism or dependency"),
    ("survival", "生存与事件", "Survival and reliability", "survival-curves", "time-to-event records", "compare event-free trajectories", "report survival or reliability evidence"),
    ("scientific", "专业科学图", "Scientific specialty", "spectral-fit", "signal, spectrum, or scientific coordinate data", "show peaks, components, or domain structure", "present domain-specific evidence"),
    ("multivariate", "多变量分析", "Multivariate", "parallel-coordinates", "observations across multiple metrics", "compare profiles across dimensions", "support multi-objective comparison"),
    ("control", "质量控制图", "Quality control", "error-bars", "ordered process measurements", "detect drift, limits, and special causes", "support validation and process stability"),
)

_VARIANTS: tuple[tuple[str, str, str], ...] = (
    ("overview", "概览", "Overview"),
    ("grouped", "分组", "Grouped"),
    ("stacked", "堆叠", "Stacked"),
    ("normalized", "归一化", "Normalized"),
    ("with-error", "含误差", "With error bars"),
    ("with-labels", "含标签", "With labels"),
    ("publication", "出版级", "Publication"),
    ("comparison", "对比", "Comparison"),
    ("compact", "紧凑", "Compact"),
)

_WORKFLOW_BY_FAMILY = {
    "line": ("graphing", "statistics"),
    "scatter": ("graphing", "statistics", "data-analysis"),
    "bar": ("graphing", "statistics", "quality", "life-science"),
    "distribution": ("statistics", "quality", "life-science"),
    "matrix": ("graphing", "statistics", "data-analysis", "life-science"),
    "area": ("graphing", "data-analysis"),
    "polar": ("graphing", "data-analysis", "life-science"),
    "network": ("graphing", "data-analysis", "life-science"),
    "survival": ("statistics", "life-science"),
    "scientific": ("graphing", "data-analysis", "life-science"),
    "multivariate": ("statistics", "data-analysis", "quality"),
    "control": ("quality", "statistics", "batch"),
}


def load_templates() -> tuple[OriginTemplate, ...]:
    workflows = {item[0]: item for item in _WORKFLOWS}
    templates: list[OriginTemplate] = []
    # The 12 families x 9 variants are the 108 reusable recipes in the workbench.
    for family_id, family_name, family_en, renderer, input_shape, task, paper_use in _FAMILIES:
        workflow_ids = _WORKFLOW_BY_FAMILY[family_id]
        for variant_index, (variant_id, variant_name, variant_en) in enumerate(_VARIANTS):
            workflow_id = workflow_ids[variant_index % len(workflow_ids)]
            workflow = workflows[workflow_id]
            template_id = f"origin-{family_id}-{variant_id}"
            templates.append(
                OriginTemplate(
                    id=template_id,
                    name=f"{family_name}{variant_name}",
                    name_en=f"{variant_en} {family_en}",
                    workflow=workflow_id,
                    workflow_name=workflow[1],
                    family=family_id,
                    family_name=family_name,
                    description=f"{task}; {variant_en.lower()} reusable template for evidence-grounded analysis.",
                    renderer=renderer,
                    input_shape=input_shape,
                    analysis_task=task,
                    paper_use=paper_use,
                    evidence_requirements=("source artifact or reproducible result", "units and grouping definition", "caption boundary"),
                )
            )
    return tuple(templates)


TEMPLATES = load_templates()
TEMPLATES_BY_ID = {template.id: template for template in TEMPLATES}


def template_payload(template: OriginTemplate) -> dict[str, Any]:
    return asdict(template)
