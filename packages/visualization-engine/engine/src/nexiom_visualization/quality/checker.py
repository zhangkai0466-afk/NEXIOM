from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any


BAR_CALLS = {"bar", "barh"}
FILL_CALLS = {"scatter", "fill_between", "fill_betweenx", "hist", "stackplot"}
FOREGROUND_DATA_CALLS = {
    "bar", "barh", "scatter", "fill_between", "fill_betweenx", "hist", "stackplot",
    "plot", "errorbar", "imshow", "boxplot", "pie",
}
AXIS_LINE_CALLS = {"grid", "axhline", "axvline", "axline", "hlines", "vlines"}
CHINESE_FONTS = {"SimHei", "Microsoft YaHei", "Droid Sans Fallback", "WenQuanYi Micro Hei", "Heiti SC", "PingFang SC"}
READER_LAYER_FORBIDDEN_TERMS = ("算法 MCP", "algorithm_mcp", "Codex", "席位", "会议", "契约", "nexiom_visualization")


def _semantic_tokens(value: str) -> set[str]:
    normalized = re.sub(r"[\s_\-/（）()，,。.:：;；]+", "", str(value).lower())
    stop = {"标注", "显示", "注明", "对应", "结果", "参考", "线", "位置"}
    tokens = {normalized}
    for word in stop:
        normalized = normalized.replace(word, "")
    if normalized:
        tokens.add(normalized)
    return {item for item in tokens if item}


def check_request_fulfillment(request: dict[str, Any], encoding: dict[str, Any]) -> dict[str, Any]:
    """Verify semantic requirements before rendering.

    Layout defects are deliberately excluded: they are repaired locally or
    placed in the manual-adjustment queue, never sent back to the model.
    """
    violations: list[dict[str, Any]] = []
    notes = encoding.get("annotations", []) if isinstance(encoding.get("annotations", []), list) else []
    lines = encoding.get("reference_lines", []) if isinstance(encoding.get("reference_lines", []), list) else []
    visible = [str(item.get("text", "")) for item in notes if isinstance(item, dict)]
    visible += [str(item.get("label", "")) for item in lines if isinstance(item, dict)]
    visible_tokens = set().union(*(_semantic_tokens(item) for item in visible)) if visible else set()
    for required in request.get("required_annotations", []):
        required_text = str(required).strip()
        required_tokens = _semantic_tokens(required_text)
        has_text = bool(required_tokens & visible_tokens)
        requires_zero = "零" in required_text and any(word in required_text for word in ("线", "效应"))
        has_zero = any(
            isinstance(item, dict) and (item.get("x") == 0 or item.get("y") == 0)
            for item in lines
        )
        if not has_text or (requires_zero and not has_zero):
            violations.append({
                "type": "missing_required_annotation",
                "line_number": 0,
                "detail": f"请求要求的可见标注未落实到 encoding: {required_text}",
            })
    return {"quality_checks_passed": not violations, "violations": violations}


def _call_name(node: ast.Call) -> str:
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    if isinstance(node.func, ast.Name):
        return node.func.id
    return ""


def _edge_is_none(value: ast.AST) -> bool:
    if isinstance(value, ast.Constant):
        return value.value is None or str(value.value).lower() == "none"
    return isinstance(value, ast.Name) and value.id == "FILL_EDGE"


def _edge_is_black(value: ast.AST) -> bool:
    if not isinstance(value, ast.Constant) or not isinstance(value.value, str):
        return False
    return value.value.strip().lower() in {"black", "k", "#000", "#000000", "#000000ff"}


def _pie_wedge_is_safe(node: ast.Call) -> bool:
    wedge = next((kw.value for kw in node.keywords if kw.arg == "wedgeprops"), None)
    if not isinstance(wedge, ast.Dict):
        return False
    entries = {
        str(key.value): value for key, value in zip(wedge.keys, wedge.values)
        if isinstance(key, ast.Constant)
    }
    edge = entries.get("edgecolor") or entries.get("edgecolors")
    line = entries.get("linewidth")
    return edge is not None and _edge_is_none(edge) and isinstance(line, ast.Constant) and line.value == 0


def _keyword_value(node: ast.Call, name: str) -> ast.AST | None:
    return next((keyword.value for keyword in node.keywords if keyword.arg == name), None)


def _numeric_constant(value: ast.AST | None) -> float | None:
    if isinstance(value, ast.Constant) and isinstance(value.value, (int, float)):
        return float(value.value)
    return None


def _pie_zorder(node: ast.Call) -> float | None:
    wedge = _keyword_value(node, "wedgeprops")
    if not isinstance(wedge, ast.Dict):
        return None
    for key, value in zip(wedge.keys, wedge.values):
        if isinstance(key, ast.Constant) and key.value == "zorder":
            return _numeric_constant(value)
    return None


def check_code_quality(
    python_code: str,
    *,
    caption_intent: str = "",
    required_annotations: list[str] | None = None,
) -> dict[str, Any]:
    violations: list[dict[str, Any]] = []
    try:
        tree = ast.parse(python_code)
    except SyntaxError as exc:
        return {
            "quality_checks_passed": False,
            "violations": [{"type": "syntax_error", "line_number": exc.lineno or 0, "detail": exc.msg}],
        }
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = _call_name(node)
        if name in BAR_CALLS:
            edge = next((kw.value for kw in node.keywords if kw.arg in {"edgecolor", "edgecolors"}), None)
            line = next((kw.value for kw in node.keywords if kw.arg == "linewidth"), None)
            width = _numeric_constant(line)
            if edge is None or _edge_is_none(edge) or _edge_is_black(edge):
                violations.append({
                    "type": "unsafe_bar_edge",
                    "line_number": node.lineno,
                    "detail": f"{name} 必须显式使用非黑色有色描边，推荐 edgecolor=系列颜色。",
                })
            if width is not None and width <= 0:
                violations.append({
                    "type": "unsafe_bar_edge",
                    "line_number": node.lineno,
                    "detail": f"{name} 的有色描边必须使用正 linewidth。",
                })
        if name in FILL_CALLS:
            edge = next((kw.value for kw in node.keywords if kw.arg in {"edgecolor", "edgecolors"}), None)
            line = next((kw.value for kw in node.keywords if kw.arg == "linewidth"), None)
            if edge is None or not _edge_is_none(edge):
                violations.append({
                    "type": "missing_fill_edge",
                    "line_number": node.lineno,
                    "detail": f"{name} 必须显式使用 edgecolor(s)=FILL_EDGE/'none'。",
                })
            if name != "scatter" and not (isinstance(line, ast.Constant) and line.value == 0):
                violations.append({
                    "type": "missing_fill_edge",
                    "line_number": node.lineno,
                    "detail": f"{name} 必须显式使用 linewidth=0。",
                })
        if name == "pie" and not _pie_wedge_is_safe(node):
            violations.append({
                "type": "missing_fill_edge",
                "line_number": node.lineno,
                "detail": "pie 必须使用 wedgeprops={'edgecolor': FILL_EDGE, 'linewidth': 0}。",
            })
        if name in AXIS_LINE_CALLS:
            zorder = _numeric_constant(_keyword_value(node, "zorder"))
            if zorder is None or zorder > 1:
                violations.append({
                    "type": "axis_line_above_data",
                    "line_number": node.lineno,
                    "detail": f"{name} 属于轴线层，必须显式使用 zorder<=1。",
                })
        if name in FOREGROUND_DATA_CALLS:
            zorder = _pie_zorder(node) if name == "pie" else _numeric_constant(_keyword_value(node, "zorder"))
            if zorder is None or zorder < 2:
                violations.append({
                    "type": "data_layer_not_foreground",
                    "line_number": node.lineno,
                    "detail": f"{name} 属于核心图形层，必须显式使用 zorder>=2。",
                })
    if "axes.axisbelow" not in python_code or "set_axisbelow(True)" not in python_code:
        violations.append({
            "type": "missing_axis_below",
            "line_number": 0,
            "detail": "必须同时设置 matplotlib.rcParams['axes.axisbelow']=True 和 ax.set_axisbelow(True)。",
        })
    if "ax.xaxis.set_zorder(1)" not in python_code or "ax.yaxis.set_zorder(1)" not in python_code or "spine.set_zorder(1)" not in python_code:
        violations.append({
            "type": "axis_line_above_data",
            "line_number": 0,
            "detail": "横纵坐标轴与 spine 必须固定在 zorder=1，低于核心图形层。",
        })
    for function in (node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == "render"):
        calls = [node for node in ast.walk(function) if isinstance(node, ast.Call)]
        layer_lines = [node.lineno for node in calls if _call_name(node) == "apply_axis_layer"]
        data_lines = [node.lineno for node in calls if _call_name(node) in FOREGROUND_DATA_CALLS]
        if data_lines and (not layer_lines or min(layer_lines) > min(data_lines)):
            violations.append({
                "type": "axis_layer_draw_order",
                "line_number": min(data_lines),
                "detail": "render() 必须先调用 apply_axis_layer，再绘制柱、折线、散点等核心图形。",
            })
    if "font.sans-serif" not in python_code or not any(font in python_code for font in CHINESE_FONTS):
        violations.append({
            "type": "missing_chinese_font",
            "line_number": 0,
            "detail": "缺少包含中文字体回退的 matplotlib font.sans-serif 配置。",
        })
    reader_text = " ".join([caption_intent, *(required_annotations or [])])
    for term in READER_LAYER_FORBIDDEN_TERMS:
        if term.lower() in reader_text.lower():
            violations.append({
                "type": "reader_layer_leak",
                "line_number": 0,
                "detail": f"读者可见文字包含内部流程术语: {term}",
            })
    return {
        "quality_checks_passed": not violations,
        "violations": violations,
        "runtime_rule_checks": [{
            "rule_id": "PS-FRAME-001", "status": "pending_render",
            "detail": "静态代码检查不能证明矩形闭合；保存图像前须检查实际 Matplotlib axes/spine。",
        }],
    }


def check_code_file(
    python_code_path: str | Path,
    *,
    caption_intent: str = "",
    required_annotations: list[str] | None = None,
) -> dict[str, Any]:
    path = Path(python_code_path).expanduser().resolve()
    report = check_code_quality(
        path.read_text(encoding="utf-8"),
        caption_intent=caption_intent,
        required_annotations=required_annotations,
    )
    return {"python_code_path": str(path), **report}
