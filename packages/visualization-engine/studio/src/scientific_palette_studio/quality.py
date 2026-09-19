from __future__ import annotations

from itertools import combinations

import numpy as np

from .models import PairResult, Palette, QualityReport


_CVD_MATRICES = {
    "deuteranopia": np.array(
        [[0.367, 0.861, -0.228], [0.280, 0.673, 0.047], [-0.012, 0.043, 0.969]]
    ),
    "protanopia": np.array(
        [[0.152, 1.053, -0.205], [0.115, 0.786, 0.099], [-0.004, -0.048, 1.052]]
    ),
}


def hex_to_rgb(value: str) -> np.ndarray:
    value = value.lstrip("#")
    return np.array([int(value[index : index + 2], 16) for index in (0, 2, 4)]) / 255.0


def _linearize(rgb: np.ndarray) -> np.ndarray:
    return np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)


def _rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    linear = _linearize(rgb)
    xyz = linear @ np.array(
        [[0.4124564, 0.2126729, 0.0193339],
         [0.3575761, 0.7151522, 0.1191920],
         [0.1804375, 0.0721750, 0.9503041]]
    )
    xyz /= np.array([0.95047, 1.0, 1.08883])
    delta = 6 / 29
    f = np.where(xyz > delta**3, np.cbrt(xyz), xyz / (3 * delta**2) + 4 / 29)
    return np.stack((116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])), axis=-1)


def _simulate_cvd(rgb: np.ndarray, kind: str) -> np.ndarray:
    return np.clip(rgb @ _CVD_MATRICES[kind].T, 0.0, 1.0)


def _minimum_delta(rgb: np.ndarray) -> PairResult:
    lab = _rgb_to_lab(rgb)
    distances = [
        PairResult(first=i, second=j, delta_e=float(np.linalg.norm(lab[i] - lab[j])))
        for i, j in combinations(range(len(lab)), 2)
    ]
    return min(distances, key=lambda item: item.delta_e)


def _relative_luminance(rgb: np.ndarray) -> float:
    linear = _linearize(rgb)
    return float(0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2])


def contrast_against_white(rgb: np.ndarray) -> float:
    return 1.05 / (_relative_luminance(rgb) + 0.05)


def audit_palette(palette: Palette) -> QualityReport:
    rgb = np.stack([hex_to_rgb(value) for value in palette.hex_colors])
    normal = _minimum_delta(rgb)
    deuteranopia = _minimum_delta(_simulate_cvd(rgb, "deuteranopia"))
    protanopia = _minimum_delta(_simulate_cvd(rgb, "protanopia"))
    contrasts = [contrast_against_white(color) for color in rgb]
    cvd_floor = min(deuteranopia.delta_e, protanopia.delta_e)

    if normal.delta_e >= 14 and cvd_floor >= 8:
        label, tone = "区分度良好", "good"
    elif normal.delta_e >= 9 and cvd_floor >= 5:
        label, tone = "建议辅助编码", "watch"
    else:
        label, tone = "需纹理或标记", "review"

    return QualityReport(
        min_delta_e=round(normal.delta_e, 1),
        min_delta_pair=normal.model_copy(update={"delta_e": round(normal.delta_e, 1)}),
        min_deuteranopia_delta_e=round(deuteranopia.delta_e, 1),
        min_protanopia_delta_e=round(protanopia.delta_e, 1),
        min_white_contrast=round(min(contrasts), 2),
        pale_fill_count=sum(value < 3.0 for value in contrasts),
        accessibility_label=label,
        accessibility_tone=tone,
    )

