from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
from typing import Any


MODEL_ROLE = "visual_designer"


def _as_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _registry_model_base_url(item: dict[str, Any], provider: dict[str, Any]) -> str:
    if str(item.get("base_url_mode", "inherit")).strip().lower() == "override":
        return str(item.get("base_url", "")).strip()
    return str(provider.get("base_url", "")).strip()


@dataclass(frozen=True)
class RouteConfig:
    name: str
    base_url: str
    api_key: str


@dataclass(frozen=True)
class ModelConfig:
    name: str
    label: str
    provider: str
    role: str
    model: str
    base_url: str
    api_key: str
    enabled: bool = True
    backup_routes: tuple[RouteConfig, ...] = ()

    @property
    def route_chain(self) -> tuple[RouteConfig, ...]:
        return (RouteConfig("primary", self.base_url, self.api_key), *self.backup_routes)


@dataclass(frozen=True)
class Settings:
    project_root: Path
    runs_dir: Path
    models: tuple[ModelConfig, ...]
    model_name: str
    timeout_seconds: int = 900
    max_tokens: int | None = 16000
    retry_attempts: int = 3
    retry_backoff_seconds: float = 1.0
    meeting_deadline_seconds: int = 720
    stream_responses: bool = True
    route_failure_threshold: int = 2

    @property
    def model_configured(self) -> bool:
        return len(self.models) == 1 and all(
            model.enabled and model.api_key and model.base_url and model.model for model in self.models
        )

    @property
    def model(self) -> ModelConfig:
        if len(self.models) != 1:
            raise ValueError("可视化设计 MCP 必须且只能配置一个模型。")
        return self.models[0]


def validate_visual_design_roster(settings: Settings, *, require_credentials: bool = True) -> None:
    if len(settings.models) != 1 or settings.models[0].name != settings.model_name or settings.models[0].role != MODEL_ROLE:
        raise ValueError("可视化设计 MCP 必须且只能配置一个 visual_designer 模型。")
    if require_credentials and not settings.model_configured:
        raise ValueError("可视化设计模型须配置 model、Base URL 与 API key。")


def load_settings() -> Settings:
    from adapter import load_settings as nexiom_load
    return nexiom_load()
