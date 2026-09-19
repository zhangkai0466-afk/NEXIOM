from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


class PaletteColor(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    name_en: str
    hex: str
    role: str

    @model_validator(mode="after")
    def validate_hex(self) -> "PaletteColor":
        if not HEX_RE.match(self.hex):
            raise ValueError(f"Invalid color value: {self.hex}")
        return self


class PaletteExtensionGroup(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str
    name: str
    name_en: str
    colors: tuple[PaletteColor, ...]

    @model_validator(mode="after")
    def validate_group(self) -> "PaletteExtensionGroup":
        if not self.colors:
            raise ValueError(f"{self.id}: extension group must contain at least one color")
        if len({color.hex.upper() for color in self.colors}) != len(self.colors):
            raise ValueError(f"{self.id}: duplicate extension colors are not allowed within a group")
        return self


class Palette(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str
    name: str
    name_en: str
    kind: Literal["categorical", "continuous"]
    count: int = Field(ge=2, le=24)
    description: str
    source_note: str
    background: str
    ink: str
    accent_index: int = Field(ge=0)
    tags: tuple[str, ...]
    colors: tuple[PaletteColor, ...]
    extension_groups: tuple[PaletteExtensionGroup, ...] = ()

    @model_validator(mode="after")
    def validate_palette(self) -> "Palette":
        if len(self.colors) != self.count:
            raise ValueError(f"{self.id}: count does not match colors")
        if self.accent_index >= self.count:
            raise ValueError(f"{self.id}: accent_index is out of range")
        if not HEX_RE.match(self.background) or not HEX_RE.match(self.ink):
            raise ValueError(f"{self.id}: invalid background or ink")
        if len({color.hex.upper() for color in self.colors}) != self.count:
            raise ValueError(f"{self.id}: duplicate colors are not allowed")
        if len({group.id for group in self.extension_groups}) != len(self.extension_groups):
            raise ValueError(f"{self.id}: duplicate extension group ids are not allowed")
        return self

    @property
    def hex_colors(self) -> list[str]:
        return [color.hex.upper() for color in self.colors]

    @property
    def extension_colors(self) -> tuple[PaletteColor, ...]:
        return tuple(color for group in self.extension_groups for color in group.colors)


class PairResult(BaseModel):
    first: int
    second: int
    delta_e: float


class QualityReport(BaseModel):
    min_delta_e: float
    min_delta_pair: PairResult
    min_deuteranopia_delta_e: float
    min_protanopia_delta_e: float
    min_white_contrast: float
    pale_fill_count: int
    accessibility_label: str
    accessibility_tone: str
