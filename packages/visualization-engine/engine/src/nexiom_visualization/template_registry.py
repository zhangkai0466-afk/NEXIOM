from __future__ import annotations

from typing import Any

from .template_manifest_loader import load_template_registry


DEFAULT_PALETTE_ID = "teal-ember-9"

# An invalid catalogue fails closed at import time: models can never select a
# renderer whose declared data contract has drifted from the template source.
TEMPLATE_REGISTRY: dict[str, dict[str, Any]] = load_template_registry()


def template_catalog() -> list[dict[str, Any]]:
    return [{"template_id": template_id, **metadata} for template_id, metadata in TEMPLATE_REGISTRY.items()]
