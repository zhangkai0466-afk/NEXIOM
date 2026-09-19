from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, StrictUndefined

from ..artifacts import write_text
from ..template_registry import DEFAULT_PALETTE_ID, TEMPLATE_REGISTRY


OUTPUT_FORMATS = {"pdf", "png", "svg"}


def _environment(template_root: Path) -> Environment:
    return Environment(
        loader=FileSystemLoader(str(template_root)),
        undefined=StrictUndefined,
        autoescape=False,
        keep_trailing_newline=True,
    )


def generate_code(
    template_id: str,
    palette_id: str,
    encoding_requirements: dict[str, Any],
    data_file: str | Path,
    *,
    output_formats: list[str] | tuple[str, ...] = ("pdf", "png", "svg"),
    dpi: int = 300,
    figsize: tuple[float, float] = (6.4, 4.0),
    template_root: str | Path | None = None,
) -> str:
    if template_id not in TEMPLATE_REGISTRY:
        raise KeyError(f"未知 Jinja2 模板: {template_id}")
    try:
        from scientific_palette_studio.catalog import get_palette

        get_palette(palette_id or DEFAULT_PALETTE_ID)
    except ImportError as exc:
        raise RuntimeError("Science Palette Studio 不可用，无法校验 palette_id。") from exc
    allowed_scales = {"linear", "log", "symlog", "logit"}
    for key in ("x_scale", "y_scale"):
        if key in encoding_requirements and str(encoding_requirements[key]) not in allowed_scales:
            raise ValueError(f"{key} 必须是 {sorted(allowed_scales)} 之一。")
    formats = list(dict.fromkeys(str(item).lower() for item in output_formats))
    invalid = sorted(set(formats) - OUTPUT_FORMATS)
    if invalid or not formats:
        raise ValueError(f"无效输出格式: {invalid or formats}")
    if dpi < 72 or dpi > 1200:
        raise ValueError("dpi 必须在 72 到 1200 之间。")
    if len(figsize) != 2 or any(float(value) <= 0 for value in figsize):
        raise ValueError("figsize 必须包含两个正数。")
    root = Path(template_root).expanduser().resolve() if template_root else Path(__file__).resolve().parents[3] / "templates"
    config = {
        "template_id": template_id,
        "palette_id": palette_id or DEFAULT_PALETTE_ID,
        "data_file": str(Path(data_file).expanduser().resolve()),
        "encoding": dict(encoding_requirements),
        "output_formats": formats,
        "dpi": int(dpi),
        "figsize": [float(figsize[0]), float(figsize[1])],
    }
    template = _environment(root).get_template(TEMPLATE_REGISTRY[template_id]["template_path"])
    return template.render(config_json_literal=repr(json.dumps(config, ensure_ascii=False)))


def generate_code_file(
    output_path: str | Path,
    template_id: str,
    palette_id: str,
    encoding_requirements: dict[str, Any],
    data_file: str | Path,
    **options: Any,
) -> Path:
    code = generate_code(template_id, palette_id, encoding_requirements, data_file, **options)
    return write_text(output_path, code)
