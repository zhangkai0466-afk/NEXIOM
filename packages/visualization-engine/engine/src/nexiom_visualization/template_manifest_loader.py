from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator


class TemplateManifestError(ValueError):
    """Raised when the executable template catalogue is malformed or inconsistent."""


def manifest_schema_path() -> Path:
    return Path(__file__).resolve().parents[2] / "contracts" / "template_manifest-1.0.0.schema.json"


def manifest_root() -> Path:
    return Path(__file__).resolve().parents[2] / "templates" / "manifests"


def _validate(payload: dict[str, Any], source: Path) -> None:
    schema = json.loads(manifest_schema_path().read_text(encoding="utf-8"))
    errors = sorted(Draft7Validator(schema).iter_errors(payload), key=lambda error: list(error.absolute_path))
    if errors:
        detail = "; ".join(f"/{'/'.join(map(str, error.absolute_path))}: {error.message}" for error in errors)
        raise TemplateManifestError(f"模板 manifest 无效 ({source}): {detail}")


def load_template_registry(root: str | Path | None = None) -> dict[str, dict[str, Any]]:
    directory = Path(root).expanduser().resolve() if root else manifest_root()
    files = sorted(directory.glob("*.json"))
    if not files:
        raise TemplateManifestError(f"未找到模板 manifest: {directory}")
    registry: dict[str, dict[str, Any]] = {}
    template_dir = directory.parent
    for source in files:
        payload = json.loads(source.read_text(encoding="utf-8"))
        _validate(payload, source)
        for spec in payload["templates"]:
            template_id = spec["template_id"]
            if template_id in registry:
                raise TemplateManifestError(f"重复 template_id: {template_id} ({source})")
            path = Path(spec["template_path"])
            if path.is_absolute() or ".." in path.parts or not (template_dir / path).is_file():
                raise TemplateManifestError(f"模板文件不存在或路径不安全: {template_id} -> {path}")
            registry[template_id] = dict(spec)
    return registry
