from __future__ import annotations

import io
import json
import zipfile
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .catalog import PROJECT_ROOT, get_palette, load_palettes, palette_python_source
from .data_rendering import parse_delimited_data, render_data_template
from .models import Palette
from .quality import audit_palette
from .source_recolor import recolor_source as recolor_python_source
from .rendering import (
    CHART_SPECS,
    GENERATED_ROOT,
    compose_palette,
    normalize_extension_indices,
    normalize_indices,
    render_all,
    render_palette,
    render_palette_selection,
    render_template_selection,
)
from .templates import TEMPLATES, TEMPLATES_BY_ID, template_payload


FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"
GENERATED_ROOT.mkdir(parents=True, exist_ok=True)
DATA_UPLOAD_ROOT = GENERATED_ROOT / "data"
DATA_UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)


class RenderRequest(BaseModel):
    palette_id: str
    color_indices: list[int] = Field(default_factory=list)
    extension_indices: list[int] = Field(default_factory=list)
    template_id: str | None = None


class SourceRecolorRequest(BaseModel):
    palette_id: str
    source: str = Field(min_length=1, max_length=1_000_000)


def _chart_payload(palette: Palette, selection_key: str = "all") -> list[dict[str, str]]:
    prefix = f"/previews/{palette.id}"
    if selection_key != "all":
        prefix += f"/{selection_key}"
    return [
        {
            "id": spec.id,
            "name": spec.name,
            "name_en": spec.name_en,
            "group": spec.group,
            "description": spec.description,
            "svg_url": f"{prefix}/{spec.id}.svg",
            "png_url": f"{prefix}/{spec.id}.png",
        }
        for spec in CHART_SPECS
    ]


def _palette_payload(palette: Palette) -> dict:
    payload = palette.model_dump(mode="json")
    payload["quality"] = audit_palette(palette).model_dump(mode="json")
    payload["previews"] = _chart_payload(palette)
    return payload


def _parse_query_indices(value: str | None, label: str) -> tuple[int, ...] | None:
    if value is None:
        return None
    if not value.strip():
        return ()
    try:
        return tuple(int(item) for item in value.split(","))
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"{label}选择无效") from exc


def _resolve_selection(
    palette: Palette,
    indices: str | None,
    extensions: str | None,
) -> tuple[tuple[int, ...], tuple[int, ...], Palette]:
    parsed_indices = _parse_query_indices(indices, "color")
    if parsed_indices is None:
        normalized = tuple(range(palette.count))
    else:
        try:
            normalized = normalize_indices(palette, parsed_indices, allow_empty=True)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="颜色选择无效") from exc

    parsed_extensions = _parse_query_indices(extensions, "extension color") or ()
    try:
        normalized_extensions = normalize_extension_indices(palette, parsed_extensions)
        selected = compose_palette(palette, normalized, normalized_extensions)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return normalized, normalized_extensions, selected


@asynccontextmanager
async def lifespan(_: FastAPI):
    render_all(force=False)
    yield


app = FastAPI(title="Scientific Palette Studio", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str | int]:
    return {"status": "ok", "palettes": len(load_palettes()), "templates": len(TEMPLATES), "renderer": "python-matplotlib"}


@app.get("/api/templates")
def list_templates(family: str | None = None, workflow: str | None = None) -> list[dict[str, object]]:
    templates = TEMPLATES
    if family:
        templates = tuple(item for item in templates if item.family == family)
    if workflow:
        from .templates import _WORKFLOW_BY_FAMILY
        templates = tuple(item for item in templates if workflow in _WORKFLOW_BY_FAMILY.get(item.family, ()))
    return [template_payload(item) for item in templates]


@app.get("/api/templates/{template_id}")
def template_detail(template_id: str) -> dict[str, object]:
    template = TEMPLATES_BY_ID.get(template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="未找到指定模板")
    return template_payload(template)


@app.get("/favicon.ico", include_in_schema=False)
def favicon() -> Response:
    return Response(status_code=204)


@app.get("/api/palettes")
def list_palettes(count: int | None = None) -> list[dict]:
    palettes = load_palettes()
    if count is not None:
        palettes = tuple(palette for palette in palettes if palette.count == count)
    return [_palette_payload(palette) for palette in palettes]


@app.get("/api/palettes/{palette_id}")
def palette_detail(palette_id: str) -> dict:
    try:
        return _palette_payload(get_palette(palette_id))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="未找到指定色库") from exc


@app.post("/api/render")
def render_selection(request: RenderRequest) -> dict:
    try:
        palette = get_palette(request.palette_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="未找到指定色库") from exc
    try:
        if request.template_id and request.template_id not in TEMPLATES_BY_ID:
            raise HTTPException(status_code=400, detail="模板无效或不存在")
        normalized = normalize_indices(palette, request.color_indices, allow_empty=True)
        normalized_extensions = normalize_extension_indices(palette, request.extension_indices)
        key, selected, _ = render_palette_selection(
            palette,
            normalized,
            normalized_extensions,
            force=False,
        )
        template = TEMPLATES_BY_ID.get(request.template_id) if request.template_id else None
        template_preview = None
        if template is not None:
            _, _, template_paths = render_template_selection(
                palette, template.id, normalized, normalized_extensions, force=False,
            )
            relative = template_paths[0].relative_to(GENERATED_ROOT).as_posix()
            template_preview = {
                "template_id": template.id,
                "svg_url": f"/previews/{relative}",
                "png_url": f"/previews/{template_paths[1].relative_to(GENERATED_ROOT).as_posix()}",
            }
        else:
            template = None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "palette_id": palette.id,
        "selection_key": key,
        "color_indices": normalized,
        "extension_indices": normalized_extensions,
        "selected_count": selected.count,
        "previews": _chart_payload(palette, key),
        "template": template_payload(template) if template else None,
        "template_preview": template_preview,
    }


@app.post("/api/data/inspect")
async def inspect_data(file: UploadFile = File(...)) -> dict[str, object]:
    if not file.filename or Path(file.filename).suffix.lower() not in {".csv", ".tsv", ".tab"}:
        raise HTTPException(status_code=400, detail="仅支持 CSV 和 TSV 数据文件")
    try:
        content = await file.read()
        headers, numeric, rows = parse_delimited_data(content, file.filename)
    except (UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "filename": file.filename,
        "columns": headers,
        "numeric_columns": [{"name": name, "count": len(values)} for name, values in numeric.items()],
        "row_count": len(rows),
        "preview": rows[:5],
    }


@app.post("/api/render-data")
async def render_data(
    file: UploadFile = File(...),
    palette_id: str = Form(...),
    template_id: str = Form(...),
    color_indices: str = Form(""),
    extension_indices: str = Form(""),
) -> dict[str, object]:
    try:
        palette = get_palette(palette_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="未找到指定色库") from exc
    if template_id not in TEMPLATES_BY_ID:
        raise HTTPException(status_code=400, detail="模板无效或不存在")
    try:
        content = await file.read()
        _, numeric, rows = parse_delimited_data(content, file.filename or "data.csv")
        selected = normalize_indices(palette, tuple(int(item) for item in color_indices.split(",") if item.strip()), allow_empty=True) if color_indices.strip() else tuple(range(palette.count))
        extensions = normalize_extension_indices(palette, tuple(int(item) for item in extension_indices.split(",") if item.strip())) if extension_indices.strip() else ()
        composed = compose_palette(palette, selected, extensions)
        run_id = uuid.uuid4().hex[:12]
        output_dir = GENERATED_ROOT / "data-renders" / run_id
        paths, summary = render_data_template(composed, template_id, numeric, output_dir)
    except (UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "run_id": run_id,
        "filename": file.filename,
        "palette_id": palette.id,
        "template_id": template_id,
        "selected_count": composed.count,
        "summary": summary,
        "svg_url": f"/previews/{paths[0].relative_to(GENERATED_ROOT).as_posix()}",
        "png_url": f"/previews/{paths[1].relative_to(GENERATED_ROOT).as_posix()}",
        "row_count": len(rows),
    }


@app.post("/api/source/recolor")
def recolor_source(request: SourceRecolorRequest) -> dict[str, object]:
    """Statically rewrite HEX colors in uploaded Python plotting source."""
    try:
        palette = get_palette(request.palette_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="未找到指定色库") from exc
    try:
        source, replacements, warnings = recolor_python_source(request.source, palette)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "palette_id": palette.id,
        "palette_name": palette.name,
        "source": source,
        "replacements": [
            {
                "original": item.original,
                "replacement": item.replacement,
                "occurrences": item.occurrences,
            }
            for item in replacements
        ],
        "warnings": warnings,
    }


@app.get("/api/palettes/{palette_id}/python", response_class=PlainTextResponse)
def export_python(
    palette_id: str,
    indices: str | None = None,
    extensions: str | None = None,
) -> PlainTextResponse:
    try:
        palette = get_palette(palette_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="未找到指定色库") from exc
    _, _, selected = _resolve_selection(palette, indices, extensions)
    return PlainTextResponse(palette_python_source(selected))


@app.get("/api/palettes/{palette_id}/json")
def export_json(
    palette_id: str,
    indices: str | None = None,
    extensions: str | None = None,
) -> Response:
    try:
        palette = get_palette(palette_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="未找到指定色库") from exc
    _, _, selected = _resolve_selection(palette, indices, extensions)
    content = json.dumps(selected.model_dump(mode="json"), ensure_ascii=False, indent=2)
    return Response(
        content=content,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{palette.id}.json"'},
    )


@app.get("/api/palettes/{palette_id}/bundle.zip")
def export_bundle(
    palette_id: str,
    indices: str | None = None,
    extensions: str | None = None,
) -> Response:
    try:
        palette = get_palette(palette_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="未找到指定色库") from exc
    normalized, normalized_extensions, selected = _resolve_selection(palette, indices, extensions)
    key, _, _ = render_palette_selection(
        palette,
        normalized,
        normalized_extensions,
        force=False,
    )
    output_dir = GENERATED_ROOT / palette.id if key == "all" else GENERATED_ROOT / palette.id / key
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("palette.py", palette_python_source(selected))
        archive.writestr("palette.json", json.dumps(selected.model_dump(mode="json"), ensure_ascii=False, indent=2))
        for spec in CHART_SPECS:
            for extension in ("svg", "png"):
                path = output_dir / f"{spec.id}.{extension}"
                archive.write(path, f"previews/{path.name}")
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{palette.id}-bundle.zip"'},
    )


app.mount("/previews", StaticFiles(directory=GENERATED_ROOT), name="previews")

if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
else:
    @app.get("/", include_in_schema=False)
    def frontend_missing() -> JSONResponse:
        return JSONResponse({"detail": "Frontend build missing. Run npm install && npm run build in frontend/."}, status_code=503)
