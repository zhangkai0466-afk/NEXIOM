from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator


def contract_path() -> Path:
    return Path(__file__).resolve().parents[2] / "contracts" / "visual_design_output-1.0.0.schema.json"


def _payload(value_or_path: dict[str, Any] | str | Path) -> dict[str, Any]:
    if isinstance(value_or_path, dict):
        return value_or_path
    value = str(value_or_path)
    candidate = Path(value).expanduser()
    if candidate.is_file():
        return json.loads(candidate.read_text(encoding="utf-8"))
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise ValueError("visual_design_output 必须是 JSON 对象。")
    return parsed


def validate_visual_design_output(value_or_path: dict[str, Any] | str | Path) -> dict[str, Any]:
    payload = _payload(value_or_path)
    schema = json.loads(contract_path().read_text(encoding="utf-8"))
    errors = sorted(Draft7Validator(schema).iter_errors(payload), key=lambda error: list(error.absolute_path))
    return {
        "valid": not errors,
        "schema_version": "1.0.0",
        "contract_path": str(contract_path()),
        "errors": [
            {
                "path": "/" + "/".join(str(part) for part in error.absolute_path),
                "message": error.message,
                "validator": error.validator,
            }
            for error in errors
        ],
    }

