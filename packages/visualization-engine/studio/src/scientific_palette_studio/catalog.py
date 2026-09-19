from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from .models import Palette


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_PATH = PROJECT_ROOT / "data" / "palettes.json"


@lru_cache(maxsize=1)
def load_palettes() -> tuple[Palette, ...]:
    with DATA_PATH.open("r", encoding="utf-8") as stream:
        payload = json.load(stream)
    return tuple(Palette.model_validate(item) for item in payload["palettes"])


def get_palette(palette_id: str) -> Palette:
    for palette in load_palettes():
        if palette.id == palette_id:
            return palette
    raise KeyError(palette_id)


def palette_python_source(palette: Palette) -> str:
    color_rows = ",\n    ".join(f'"{value}"' for value in palette.hex_colors)
    cmap_slug = palette.id.replace("-", "_")
    return (
        "from __future__ import annotations\n\n"
        "from matplotlib.colors import LinearSegmentedColormap, ListedColormap\n\n\n"
        f'PALETTE_NAME = "{palette.name_en}"\n'
        f'PALETTE_KIND = "{palette.kind}"\n'
        f"PALETTE: list[str] = [\n    {color_rows}\n]\n\n"
        f'BACKGROUND = "{palette.background}"\n'
        f'INK = "{palette.ink}"\n'
        f"ACCENT = PALETTE[{palette.accent_index}]\n\n"
        "\n"
        "def as_categorical() -> ListedColormap:\n"
        f'    return ListedColormap(PALETTE, name="{cmap_slug}_categorical")\n\n\n'
        "def as_continuous() -> LinearSegmentedColormap:\n"
        f'    return LinearSegmentedColormap.from_list("{cmap_slug}_continuous", PALETTE)\n\n\n'
        "categorical_cmap = as_categorical()\n"
        "continuous_cmap = as_continuous()\n"
    )
