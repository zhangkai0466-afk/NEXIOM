from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
from typing import Any

import matplotlib.image as mpimg
import numpy as np

from .artifacts import write_json


def _image_quality(path: Path) -> dict[str, Any]:
    image = np.asarray(mpimg.imread(path), dtype=float)
    if image.ndim == 2:
        gray = image
    else:
        rgb = image[..., :3]
        gray = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
    height, width = gray.shape[:2]
    non_background = gray < 0.975
    ink_ratio = float(np.mean(non_background))
    contrast_std = float(np.std(gray))
    return {
        "width_px": int(width),
        "height_px": int(height),
        "ink_ratio": round(ink_ratio, 5),
        "grayscale_std": round(contrast_std, 5),
        "grayscale_readable": contrast_std >= 0.035 and ink_ratio >= 0.005,
        "resolution_ok": width >= 900 and height >= 550,
    }


def render_and_inspect_figures(
    design_output: dict[str, Any],
    output_dir: str | Path,
    *,
    timeout_seconds: int = 180,
) -> dict[str, Any]:
    """Render every accepted source and perform local production QA.

    Minor layout observations are advisory. They are fixed by template rules or
    left in manual_adjustment_queue and never trigger a model call.
    """
    target = Path(output_dir).expanduser().resolve()
    rendered_root = target / "rendered"
    rendered_root.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    for figure in design_output.get("figures", []):
        figure_id = str(figure.get("figure_id", ""))
        record: dict[str, Any] = {
            "figure_id": figure_id,
            "status": "blocked_by_semantic_gate",
            "outputs": [],
            "blocking_issues": [],
            "manual_adjustment_queue": [],
        }
        if not figure.get("quality_checks_passed"):
            record["blocking_issues"] = list(figure.get("violations", []))
            records.append(record)
            continue
        script = Path(str(figure["python_code_path"])).resolve()
        figure_dir = rendered_root / figure_id
        command = [
            sys.executable, str(script), "--output-dir", str(figure_dir),
            "--formats", "pdf,png,svg", "--dpi", "300",
        ]
        try:
            completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout_seconds, check=False)
        except subprocess.TimeoutExpired:
            record["status"] = "render_failed"
            record["blocking_issues"].append({"type": "render_timeout", "detail": f"渲染超过 {timeout_seconds} 秒。"})
            records.append(record)
            continue
        if completed.returncode != 0:
            record["status"] = "render_failed"
            record["blocking_issues"].append({
                "type": "render_process_failed",
                "detail": (completed.stderr or completed.stdout)[-3000:],
            })
            records.append(record)
            continue
        frame_checks = []
        try:
            report = json.loads(completed.stdout)
            frame_checks = [check for check in report.get("runtime_rule_checks", []) if check.get("rule_id") == "PS-FRAME-001"]
        except (ValueError, TypeError, AttributeError) as exc:
            record["blocking_issues"].append({"type": "invalid_runtime_quality_report", "detail": str(exc)})
        record["runtime_rule_checks"] = frame_checks
        if not frame_checks or any(check.get("passed") is not True for check in frame_checks):
            record["blocking_issues"].append({
                "type": "rectangular_axis_frame_not_verified", "rule_id": "PS-FRAME-001",
                "detail": "缺少或未通过实际 Matplotlib 绘图区矩形边框检查。",
            })
        paths = sorted(path for path in figure_dir.glob("*") if path.suffix.lower() in {".pdf", ".png", ".svg"})
        suffixes = {path.suffix.lower() for path in paths}
        record["outputs"] = [
            {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "size_bytes": path.stat().st_size}
            for path in paths
        ]
        if suffixes != {".pdf", ".png", ".svg"}:
            record["blocking_issues"].append({"type": "missing_output_format", "detail": f"实际格式: {sorted(suffixes)}"})
        png = next((path for path in paths if path.suffix.lower() == ".png"), None)
        if png:
            image_report = _image_quality(png)
            record["image_quality"] = image_report
            if not image_report["resolution_ok"]:
                record["blocking_issues"].append({"type": "insufficient_resolution", "detail": str(image_report)})
            if not image_report["grayscale_readable"]:
                record["blocking_issues"].append({"type": "grayscale_unreadable", "detail": str(image_report)})
        encoding = figure.get("encoding_requirements", {})
        category_keys = ("category_column", "row_column", "column_column", "parameter_column")
        if any(encoding.get(key) for key in category_keys):
            record["manual_adjustment_queue"].append({
                "type": "final_label_spacing_review",
                "detail": "确定性旋转与 tight-layout 已执行；入稿时按实际栏宽目检，必要时人工微调。",
            })
        if encoding.get("group_column") or encoding.get("hue_column"):
            record["manual_adjustment_queue"].append({
                "type": "final_legend_position_review",
                "detail": "图例遮挡由本地规则优先外移；入稿时只需人工确认最终位置。",
            })
        record["status"] = "production_ready" if not record["blocking_issues"] else "blocked_by_render_gate"
        records.append(record)
    ready = bool(records) and all(item["status"] == "production_ready" for item in records)
    manifest = {
        "schema_version": "visual_production_manifest/1.0.0",
        "status": "formal_landing_ready" if ready else "blocked",
        "ai_repair_policy": {
            "semantic_or_design_failure": "may_return_to_visual_design_model",
            "label_overlap_legend_occlusion_margin_fontsize": "deterministic_fix_then_manual_adjustment;never_return_to_ai",
        },
        "figures": records,
        "summary": {
            "total": len(records),
            "production_ready": sum(item["status"] == "production_ready" for item in records),
            "blocked": sum(item["status"] != "production_ready" for item in records),
            "manual_adjustments": sum(len(item["manual_adjustment_queue"]) for item in records),
        },
    }
    path = write_json(target / "visual_production_manifest-1.0.0.json", manifest)
    return {**manifest, "manifest_path": str(path)}
