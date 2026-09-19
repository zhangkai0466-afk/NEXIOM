from __future__ import annotations

from typing import Any


PRINCIPLE_KINDS = {"conceptual_diagram", "model_flow", "mechanism_diagram", "timeline"}


def generate_principle_figure_prompt(
    visual_request: dict[str, Any],
    section_context: str,
    *,
    visual_form: str = "",
) -> dict[str, Any]:
    kind = str(visual_request.get("kind", ""))
    if kind not in PRINCIPLE_KINDS:
        raise ValueError(f"仅 B 类原理图支持 prompt 生成: {kind}")
    purpose = str(visual_request.get("purpose", ""))
    annotations = [str(item) for item in visual_request.get("required_annotations", [])]
    forbidden = [str(item) for item in visual_request.get("forbidden_claims", [])]
    prompt = (
        f"绘制用于数学建模竞赛论文的{kind}。视觉形式：{visual_form or '简洁二维矢量示意图'}。"
        f"图的唯一论证任务：{purpose}。必须标注：{'、'.join(annotations) if annotations else '关键对象与关系'}。"
        "白色或配色方案背景，结构线使用中性灰，数据或区域填充不得使用黑色描边；中文标签清晰且不重叠。"
        f"不得表达或暗示：{'、'.join(forbidden) if forbidden else '输入证据以外的结论'}。"
        f"上下文仅用于构图，不得新增事实：{section_context[:1200]}"
    )
    return {
        "figure_id": visual_request.get("id"),
        "kind": kind,
        "prompt": prompt,
        "requires_evidence_review": True,
        "requires_codex_editorial_review": True,
    }

