from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import Callable, Iterable

import matplotlib

matplotlib.use("Agg")

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.patches import FancyArrowPatch

from .catalog import PROJECT_ROOT, load_palettes
from .models import Palette
from .templates import TEMPLATES_BY_ID


GENERATED_ROOT = PROJECT_ROOT / "generated" / "previews"
FILL_EDGE = "none"
_RENDER_LOCK = RLock()


@dataclass(frozen=True)
class ChartSpec:
    id: str
    name: str
    name_en: str
    group: str
    description: str


CHART_SPECS = (
    ChartSpec("cluster-scatter", "聚类散点", "Clustered scatter", "distribution", "观察多类别点云在空间中的识别度。"),
    ChartSpec("violin-box", "小提琴与箱线", "Violin + box", "distribution", "比较分布形态、中位数与数据离散程度。"),
    ChartSpec("density-ridges", "山峦密度", "Ridgeline density", "distribution", "用错层密度曲线比较多组分布。"),
    ChartSpec("histogram-density", "直方密度", "Histogram + density", "distribution", "检查半透明频数填充和密度轮廓。"),
    ChartSpec("response-curves", "响应曲线", "Response curves", "trend", "比较多条非线性响应轨迹。"),
    ChartSpec("spectral-fit", "谱峰拟合", "Spectral peak fitting", "trend", "展示多个谱峰分量与合成信号。"),
    ChartSpec("stacked-area", "堆叠面积", "Stacked area", "trend", "展示组成随时间的连续变化。"),
    ChartSpec("survival-curves", "生存曲线", "Survival curves", "trend", "检查阶梯曲线与置信区间的区分。"),
    ChartSpec("error-bars", "误差柱状", "Bars + uncertainty", "comparison", "比较分类结果和不确定性。"),
    ChartSpec("forest-plot", "森林图", "Forest plot", "comparison", "并列展示效应值及其置信区间。"),
    ChartSpec("dumbbell", "哑铃比较", "Dumbbell comparison", "comparison", "比较同一对象的起点、终点和变化幅度。"),
    ChartSpec("clustered-heatmap", "聚类热图", "Clustered heatmap", "matrix", "检查连续色阶与行注释色的协同。"),
    ChartSpec("correlation-bubbles", "相关气泡矩阵", "Correlation bubbles", "matrix", "用颜色和气泡面积共同表达相关强度。"),
    ChartSpec("parallel-coordinates", "平行坐标", "Parallel coordinates", "matrix", "对比多个方案在多维指标上的整体轮廓。"),
    ChartSpec("radial-profile", "径向构成", "Radial profile", "radial", "比较极坐标扇区的相对大小。"),
    ChartSpec("feature-network", "环形关联", "Circular feature map", "network", "展示节点、弦线和辅助层的关联结构。"),
)


def configure_matplotlib() -> None:
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
            "font.size": 9.2,
            "axes.labelsize": 9.4,
            "axes.linewidth": 0.75,
            "axes.axisbelow": True,
            "axes.spines.right": False,
            "axes.spines.top": False,
            "xtick.labelsize": 8.4,
            "ytick.labelsize": 8.4,
            "legend.fontsize": 8.0,
            "legend.frameon": False,
            "svg.fonttype": "none",
            "svg.hashsalt": "scientific-palette-studio",
            "pdf.fonttype": 42,
        }
    )


def normalize_indices(
    palette: Palette,
    indices: Iterable[int],
    *,
    allow_empty: bool = False,
) -> tuple[int, ...]:
    normalized = tuple(sorted(set(indices)))
    if not normalized:
        if allow_empty:
            return ()
        raise ValueError("At least one color must be selected")
    if normalized[0] < 0 or normalized[-1] >= palette.count:
        raise ValueError("Color index is out of range")
    return normalized


def normalize_extension_indices(palette: Palette, indices: Iterable[int]) -> tuple[int, ...]:
    normalized = tuple(sorted(set(indices)))
    if not normalized:
        return ()
    if normalized[0] < 0 or normalized[-1] >= len(palette.extension_colors):
        raise ValueError("Extension color index is out of range")
    return normalized


def subset_palette(palette: Palette, indices: Iterable[int]) -> Palette:
    normalized = normalize_indices(palette, indices)
    colors = tuple(palette.colors[index] for index in normalized)
    accent_index = normalized.index(palette.accent_index) if palette.accent_index in normalized else 0
    return palette.model_copy(
        update={"colors": colors, "count": len(colors), "accent_index": accent_index, "extension_groups": ()}
    )


def compose_palette(
    palette: Palette,
    color_indices: Iterable[int],
    extension_indices: Iterable[int] = (),
) -> Palette:
    normalized_colors = normalize_indices(palette, color_indices, allow_empty=True)
    normalized_extensions = normalize_extension_indices(palette, extension_indices)

    colors = []
    seen: set[str] = set()
    for color in (
        *(palette.colors[index] for index in normalized_colors),
        *(palette.extension_colors[index] for index in normalized_extensions),
    ):
        key = color.hex.upper()
        if key not in seen:
            colors.append(color)
            seen.add(key)

    if not colors:
        raise ValueError("At least one main or extension color must be selected")

    accent_hex = palette.colors[palette.accent_index].hex.upper()
    accent_index = next(
        (index for index, color in enumerate(colors) if color.hex.upper() == accent_hex),
        0,
    )
    return palette.model_copy(
        update={
            "colors": tuple(colors),
            "count": len(colors),
            "accent_index": accent_index,
            "extension_groups": (),
        }
    )


def selection_key(
    palette: Palette,
    indices: Iterable[int],
    extension_indices: Iterable[int] = (),
) -> str:
    normalized = normalize_indices(palette, indices, allow_empty=True)
    normalized_extensions = normalize_extension_indices(palette, extension_indices)
    if normalized == tuple(range(palette.count)) and not normalized_extensions:
        return "all"
    color_key = "colors-" + ("-".join(str(index + 1) for index in normalized) if normalized else "none")
    if not normalized_extensions:
        return color_key
    extension_key = "extensions-" + "-".join(str(index + 1) for index in normalized_extensions)
    return f"{color_key}--{extension_key}"


def _rng(palette: Palette, offset: int) -> np.random.Generator:
    seed = sum((index + 1) * ord(char) for index, char in enumerate(palette.id)) + offset
    return np.random.default_rng(seed)


def _colors(palette: Palette, count: int) -> list[str]:
    return [palette.hex_colors[index % palette.count] for index in range(count)]


def _continuous_colors(palette: Palette) -> list[str]:
    return palette.hex_colors if palette.count > 1 else [palette.hex_colors[0], palette.hex_colors[0]]


def _new_axes(*, polar: bool = False) -> tuple[plt.Figure, plt.Axes]:
    subplot_kw = {"projection": "polar"} if polar else None
    fig, ax = plt.subplots(figsize=(6.4, 4.0), subplot_kw=subplot_kw)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")
    ax.set_axisbelow(True)
    return fig, ax


def _finish(ax: plt.Axes, palette: Palette) -> None:
    ax.tick_params(color="#92949A", labelcolor=palette.ink, width=0.65, length=3.2)
    ax.xaxis.label.set_color(palette.ink)
    ax.yaxis.label.set_color(palette.ink)
    for spine in ax.spines.values():
        spine.set_color("#BFC1C5")
        spine.set_linewidth(0.7)


def _cluster_scatter(palette: Palette) -> plt.Figure:
    fig, ax = _new_axes()
    rng = _rng(palette, 10)
    angles = np.linspace(0, 2 * np.pi, palette.count, endpoint=False) + 0.2
    radii = np.where(np.arange(palette.count) % 2 == 0, 3.1, 2.4)
    for index, (angle, radius, color) in enumerate(zip(angles, radii, palette.hex_colors)):
        center = np.array([np.cos(angle), np.sin(angle)]) * radius
        rotation = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
        cloud = rng.normal(size=(48, 2)) @ np.diag([0.66, 0.33]) @ rotation.T + center
        ax.scatter(cloud[:, 0], cloud[:, 1], s=20, color=color, alpha=0.88, edgecolors=FILL_EDGE)
        ax.text(center[0], center[1], str(index + 1), ha="center", va="center", fontsize=8.0, color=palette.ink)
    ax.set_xlabel("Latent dimension 1")
    ax.set_ylabel("Latent dimension 2")
    ax.set_xticks([-4, 0, 4])
    ax.set_yticks([-4, 0, 4])
    ax.set_aspect("equal", adjustable="box")
    _finish(ax, palette)
    return fig


def _violin_box(palette: Palette) -> plt.Figure:
    fig, ax = _new_axes()
    ax.axhline(0, color="#D7D8DB", linewidth=0.75, zorder=0)
    rng = _rng(palette, 20)
    data = [rng.normal(loc=np.sin(i * 0.8) * 0.35, scale=0.42 + (i % 3) * 0.08, size=100) for i in range(palette.count)]
    violins = ax.violinplot(data, showmeans=False, showmedians=False, widths=0.82)
    for body, color in zip(violins["bodies"], palette.hex_colors):
        body.set_facecolor(color)
        body.set_edgecolor(FILL_EDGE)
        body.set_linewidth(0)
        body.set_alpha(0.92)
    for key in ("cmins", "cmaxes", "cbars"):
        violins[key].set_color("#9A9DA3")
        violins[key].set_linewidth(0.65)
    box = ax.boxplot(data, widths=0.16, patch_artist=True, showfliers=False)
    for patch in box["boxes"]:
        patch.set_facecolor("white")
        patch.set_edgecolor("#8F939A")
        patch.set_linewidth(0.7)
    for key in ("whiskers", "caps", "medians"):
        for artist in box[key]:
            artist.set_color("#8F939A")
            artist.set_linewidth(0.7)
    ax.set_xticks(range(1, palette.count + 1), [f"G{i}" for i in range(1, palette.count + 1)])
    ax.set_ylabel("Standardized response")
    _finish(ax, palette)
    return fig


def _density_ridges(palette: Palette) -> plt.Figure:
    fig, ax = _new_axes()
    x = np.linspace(-3.2, 3.2, 320)
    for index, color in enumerate(palette.hex_colors):
        center = -1.25 + 2.5 * index / max(1, palette.count - 1)
        width = 0.62 + 0.08 * (index % 3)
        density = np.exp(-0.5 * ((x - center) / width) ** 2)
        density += 0.42 * np.exp(-0.5 * ((x - center - 0.9) / (width * 0.65)) ** 2)
        density /= density.max()
        baseline = index * 0.78
        ax.fill_between(x, baseline, baseline + density * 0.92, color=color, alpha=0.82, linewidth=0, edgecolor=FILL_EDGE)
        ax.plot(x, baseline + density * 0.92, color=color, linewidth=1.15)
    ax.set_yticks(np.arange(palette.count) * 0.78, [f"Group {index + 1}" for index in range(palette.count)])
    ax.set_xlabel("Measured value")
    ax.set_ylabel("")
    ax.spines["left"].set_visible(False)
    ax.tick_params(axis="y", length=0)
    _finish(ax, palette)
    return fig


def _histogram_density(palette: Palette) -> plt.Figure:
    fig, ax = _new_axes()
    rng = _rng(palette, 30)
    x_grid = np.linspace(-3.3, 3.3, 320)
    for index, color in enumerate(palette.hex_colors):
        mean = -1.25 + 2.5 * index / max(1, palette.count - 1)
        scale = 0.55 + 0.07 * (index % 3)
        values = rng.normal(mean, scale, 180)
        ax.hist(values, bins=18, density=True, color=color, alpha=0.22, edgecolor=FILL_EDGE)
        density = np.exp(-0.5 * ((x_grid - mean) / scale) ** 2) / (scale * np.sqrt(2 * np.pi))
        ax.plot(x_grid, density, color=color, linewidth=1.55)
    ax.set_xlabel("Observed value")
    ax.set_ylabel("Density")
    _finish(ax, palette)
    return fig


def _response_curves(palette: Palette) -> plt.Figure:
    fig, ax = _new_axes()
    ax.axhline(0.5, color="#C8C9CC", linewidth=0.8, linestyle=(0, (3, 2)), zorder=0)
    x = np.linspace(-3.0, 3.0, 90)
    midpoints = np.linspace(-1.55, 1.55, palette.count)
    for index, (midpoint, color) in enumerate(zip(midpoints, palette.hex_colors)):
        slope = 1.45 + 0.11 * (index % 3)
        ceiling = 0.72 + 0.035 * index
        y = ceiling / (1 + np.exp(-slope * (x - midpoint)))
        ax.plot(x, y, color=color, linewidth=2.0, marker="o", markevery=[18, 40, 62, 84], markersize=3.5, markeredgecolor="white", markeredgewidth=0.45, zorder=3)
    ax.set_xlabel("Log concentration")
    ax.set_ylabel("Normalized response")
    ax.set_ylim(-0.03, 1.08)
    _finish(ax, palette)
    return fig


def _spectral_fit(palette: Palette) -> plt.Figure:
    fig, ax = _new_axes()
    x = np.linspace(400, 700, 600)
    centers = np.linspace(440, 660, palette.count)
    widths = np.linspace(17, 29, palette.count)[::-1]
    components = []
    for index, (center, width, color) in enumerate(zip(centers, widths, palette.hex_colors)):
        amplitude = 0.34 + 0.12 * np.sin(index * 1.3) + 0.025 * index
        component = amplitude * np.exp(-0.5 * ((x - center) / width) ** 2)
        components.append(component)
        ax.fill_between(x, component, color=color, alpha=0.34, linewidth=0, edgecolor=FILL_EDGE)
        ax.plot(x, component, color=color, linewidth=1.1, alpha=0.95)
    total = np.sum(components, axis=0)
    rng = _rng(palette, 40)
    observed = total + rng.normal(scale=0.008, size=x.size)
    ax.plot(x, observed, color="#777B82", linewidth=0.7, alpha=0.7)
    ax.plot(x, total, color=palette.ink, linewidth=1.65)
    ax.set_xlabel("Wavelength (nm)")
    ax.set_ylabel("Intensity (a.u.)")
    ax.set_ylim(0, total.max() * 1.12)
    _finish(ax, palette)
    return fig


def _stacked_area(palette: Palette) -> plt.Figure:
    fig, ax = _new_axes()
    x = np.linspace(0, 12, 80)
    series = []
    for index in range(palette.count):
        signal = 0.45 + 0.18 * np.sin(x * (0.45 + index * 0.04) + index * 0.7)
        signal += 0.06 * index + 0.03 * np.cos(x * 1.25 - index)
        series.append(np.clip(signal, 0.08, None))
    ax.stackplot(x, series, colors=palette.hex_colors, alpha=0.92, edgecolor=FILL_EDGE, linewidth=0)
    ax.set_xlabel("Time (months)")
    ax.set_ylabel("Relative composition")
    ax.set_xlim(x.min(), x.max())
    _finish(ax, palette)
    return fig


def _survival_curves(palette: Palette) -> plt.Figure:
    fig, ax = _new_axes()
    time = np.arange(0, 25, 2)
    for index, color in enumerate(palette.hex_colors):
        rate = 0.025 + 0.011 * index
        survival = np.exp(-rate * time ** 1.12)
        lower = np.clip(survival - 0.035 - index * 0.002, 0, 1)
        upper = np.clip(survival + 0.035 + index * 0.002, 0, 1)
        ax.fill_between(time, lower, upper, step="post", color=color, alpha=0.12, linewidth=0, edgecolor=FILL_EDGE)
        ax.step(time, survival, where="post", color=color, linewidth=1.75)
    ax.set_xlabel("Follow-up (months)")
    ax.set_ylabel("Event-free probability")
    ax.set_ylim(0, 1.03)
    _finish(ax, palette)
    return fig


def _error_bars(palette: Palette) -> plt.Figure:
    fig, ax = _new_axes()
    rng = _rng(palette, 50)
    values = 0.64 + rng.uniform(0.05, 0.25, palette.count)
    errors = rng.uniform(0.018, 0.048, palette.count)
    x = np.arange(palette.count)
    ax.bar(
        x,
        values,
        yerr=errors,
        color=palette.hex_colors,
        width=0.72,
        edgecolor=FILL_EDGE,
        linewidth=0,
        error_kw={"elinewidth": 0.9, "capsize": 3.5, "capthick": 0.9, "ecolor": "#6F737A"},
    )
    ax.set_xticks(x, [f"M{i}" for i in range(1, palette.count + 1)])
    ax.set_ylabel("Validation score")
    ax.set_ylim(0.55, 0.98)
    ax.set_yticks([0.6, 0.7, 0.8, 0.9])
    _finish(ax, palette)
    return fig


def _forest_plot(palette: Palette) -> plt.Figure:
    fig, ax = _new_axes()
    rng = _rng(palette, 60)
    y = np.arange(palette.count)[::-1]
    effects = np.linspace(-0.28, 0.48, palette.count) + rng.normal(0, 0.06, palette.count)
    intervals = rng.uniform(0.12, 0.23, palette.count)
    ax.axvline(0, color="#AEB1B6", linewidth=0.9, linestyle=(0, (3, 2)), zorder=0)
    for row, effect, interval, color in zip(y, effects, intervals, palette.hex_colors):
        ax.errorbar(effect, row, xerr=interval, fmt="o", color=color, ecolor=color, elinewidth=1.5, capsize=3.5, markersize=7.5, markeredgewidth=0)
    ax.set_yticks(y, [f"Study {index + 1}" for index in range(palette.count)])
    ax.set_xlabel("Effect size (95% CI)")
    ax.set_ylabel("")
    ax.spines["left"].set_visible(False)
    ax.tick_params(axis="y", length=0)
    _finish(ax, palette)
    return fig


def _dumbbell(palette: Palette) -> plt.Figure:
    fig, ax = _new_axes()
    y = np.arange(palette.count)
    start = np.linspace(0.35, 0.62, palette.count)
    end = start + 0.12 + 0.08 * np.sin(np.arange(palette.count) * 0.9)
    for row, left, right, color in zip(y, start, end, palette.hex_colors):
        ax.plot([left, right], [row, row], color=color, linewidth=2.2, alpha=0.52)
        ax.scatter(left, row, s=58, color=color, alpha=0.35, edgecolors=FILL_EDGE, zorder=3)
        ax.scatter(right, row, s=68, color=color, edgecolors=FILL_EDGE, zorder=4)
    ax.set_yticks(y, [f"Item {index + 1}" for index in range(palette.count)])
    ax.set_xlabel("Measured score")
    ax.set_ylabel("")
    ax.spines["left"].set_visible(False)
    ax.tick_params(axis="y", length=0)
    _finish(ax, palette)
    return fig


def _clustered_heatmap(palette: Palette) -> plt.Figure:
    fig = plt.figure(figsize=(6.4, 4.0))
    grid = fig.add_gridspec(1, 2, width_ratios=[0.075, 1], wspace=0.04)
    strip_ax = fig.add_subplot(grid[0, 0])
    ax = fig.add_subplot(grid[0, 1])
    rng = _rng(palette, 70)
    columns = 11
    x = np.linspace(-1.0, 1.0, columns)
    matrix = np.vstack([np.sin((row + 1) * x * 1.25 + row * 0.4) for row in range(palette.count)])
    matrix += rng.normal(scale=0.18, size=matrix.shape)
    order = np.argsort(matrix.mean(axis=1))
    matrix = matrix[order]
    colors = [palette.hex_colors[index] for index in order]
    cmap = LinearSegmentedColormap.from_list(f"{palette.id}-continuous", _continuous_colors(palette), N=256)
    image = ax.imshow(matrix, cmap=cmap, aspect="auto", interpolation="nearest")
    strip_ax.imshow(np.arange(palette.count).reshape(-1, 1), cmap=mpl.colors.ListedColormap(colors), aspect="auto")
    strip_ax.set_axis_off()
    ax.set_xticks(range(columns), [f"S{i}" for i in range(1, columns + 1)])
    ax.set_yticks(range(palette.count), [f"F{i + 1}" for i in order])
    ax.tick_params(length=0, pad=3)
    for spine in ax.spines.values():
        spine.set_visible(False)
    cbar = fig.colorbar(image, ax=ax, fraction=0.035, pad=0.025)
    cbar.outline.set_visible(False)
    for spine in cbar.ax.spines.values():
        spine.set_visible(False)
    cbar.ax.tick_params(labelsize=8.0, length=2, width=0.5)
    cbar.set_label("Scaled value", fontsize=8.6)
    return fig


def _correlation_bubbles(palette: Palette) -> plt.Figure:
    fig, ax = _new_axes()
    rng = _rng(palette, 80)
    size = max(5, palette.count)
    raw = rng.normal(size=(size, size))
    corr = np.corrcoef(raw)
    for row in range(size):
        for column in range(size):
            value = corr[row, column]
            color = palette.hex_colors[row % palette.count]
            ax.scatter(column, row, s=34 + abs(value) * 430, color=color, alpha=0.24 + abs(value) * 0.68, edgecolors=FILL_EDGE)
    labels = [f"V{i}" for i in range(1, size + 1)]
    ax.set_xticks(range(size), labels)
    ax.set_yticks(range(size), labels)
    ax.set_xlim(-0.6, size - 0.4)
    ax.set_ylim(size - 0.4, -0.6)
    ax.set_aspect("equal")
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.tick_params(length=0)
    return fig


def _parallel_coordinates(palette: Palette) -> plt.Figure:
    fig, ax = _new_axes()
    rng = _rng(palette, 90)
    dimensions = 5
    x = np.arange(dimensions)
    for position in x:
        ax.axvline(position, color="#D8D9DC", linewidth=0.75, zorder=0)
    for index, color in enumerate(palette.hex_colors):
        center = 0.25 + 0.5 * (index + 1) / (palette.count + 1)
        values = np.clip(center + 0.18 * np.sin(x * 1.15 + index) + rng.normal(0, 0.035, dimensions), 0.04, 0.96)
        ax.plot(x, values, color=color, linewidth=2.0, alpha=0.9, zorder=3)
        ax.scatter(x, values, s=24, color=color, edgecolors=FILL_EDGE, zorder=3)
    ax.set_xticks(x, [f"Metric {index + 1}" for index in range(dimensions)])
    ax.set_ylabel("Normalized score")
    ax.set_ylim(0, 1)
    ax.spines["bottom"].set_visible(False)
    ax.tick_params(axis="x", length=0)
    _finish(ax, palette)
    return fig


def _radial_profile(palette: Palette) -> plt.Figure:
    fig, ax = _new_axes(polar=True)
    rng = _rng(palette, 100)
    theta = np.linspace(0, 2 * np.pi, palette.count, endpoint=False)
    values = rng.uniform(0.58, 0.96, palette.count)
    width = 2 * np.pi / palette.count * 0.82
    ax.set_theta_offset(np.pi / 2)
    ax.set_theta_direction(-1)
    ax.set_xticks(theta, [f"C{i}" for i in range(1, palette.count + 1)])
    ax.set_yticks([0.25, 0.5, 0.75], ["25", "50", "75"])
    ax.set_ylim(0, 1.08)
    ax.grid(color="#D8D9DC", linewidth=0.65, alpha=0.8, zorder=0)
    ax.bar(theta, values, width=width, bottom=0.08, color=palette.hex_colors,
           edgecolor="white", linewidth=1.0, alpha=0.97, zorder=3)
    ax.spines["polar"].set_visible(False)
    ax.tick_params(colors=palette.ink, pad=3)
    return fig


def _feature_network(palette: Palette) -> plt.Figure:
    fig, ax = _new_axes()
    theta = np.linspace(0, 2 * np.pi, palette.count, endpoint=False) + np.pi / 2
    positions = np.column_stack((np.cos(theta), np.sin(theta)))
    rng = _rng(palette, 110)
    for index in range(palette.count):
        for step in (2, 3):
            target = (index + step) % palette.count
            if index >= target:
                continue
            strength = rng.uniform(0.2, 0.75)
            patch = FancyArrowPatch(
                positions[index],
                positions[target],
                connectionstyle=f"arc3,rad={0.16 if (index + target) % 2 else -0.16}",
                arrowstyle="-",
                linewidth=0.55 + strength * 1.35,
                color=palette.hex_colors[index],
                alpha=0.24 + strength * 0.34,
            )
            ax.add_patch(patch)
    ax.scatter(positions[:, 0], positions[:, 1], s=440, color=palette.hex_colors, edgecolors="white", linewidths=1.4, zorder=4)
    for index, (x, y) in enumerate(positions):
        ax.text(x * 1.2, y * 1.2, f"F{index + 1}", ha="center", va="center", color=palette.ink, fontsize=8.4)
    ax.add_artist(plt.Circle((0, 0), 1.0, fill=False, color="#DCDDDF", linewidth=0.7, zorder=0))
    ax.set_xlim(-1.36, 1.36)
    ax.set_ylim(-1.28, 1.28)
    ax.set_aspect("equal")
    ax.set_axis_off()
    return fig


_RENDERERS: dict[str, Callable[[Palette], plt.Figure]] = {
    "cluster-scatter": _cluster_scatter,
    "violin-box": _violin_box,
    "density-ridges": _density_ridges,
    "histogram-density": _histogram_density,
    "response-curves": _response_curves,
    "spectral-fit": _spectral_fit,
    "stacked-area": _stacked_area,
    "survival-curves": _survival_curves,
    "error-bars": _error_bars,
    "forest-plot": _forest_plot,
    "dumbbell": _dumbbell,
    "clustered-heatmap": _clustered_heatmap,
    "correlation-bubbles": _correlation_bubbles,
    "parallel-coordinates": _parallel_coordinates,
    "radial-profile": _radial_profile,
    "feature-network": _feature_network,
}


def _save_figure_formats(
    fig: plt.Figure,
    output_dir: Path,
    stem: str,
    *,
    formats: Iterable[str],
    dpi: int,
    background: str,
) -> list[Path]:
    normalized = tuple(dict.fromkeys(str(value).strip().lower() for value in formats))
    unsupported = sorted(set(normalized) - {"svg", "png", "pdf"})
    if not normalized or unsupported:
        raise ValueError(f"Unsupported output formats: {unsupported or normalized}")
    if dpi < 72 or dpi > 1200:
        raise ValueError("dpi must be between 72 and 1200")
    paths: list[Path] = []
    for output_format in normalized:
        path = output_dir / f"{stem}.{output_format}"
        options = {"dpi": dpi} if output_format == "png" else {}
        fig.savefig(path, facecolor=background, **options)
        paths.append(path)
    return paths


def render_chart(
    palette: Palette,
    chart_id: str,
    output_dir: Path,
    *,
    formats: Iterable[str] = ("svg", "png"),
    dpi: int = 260,
    figsize: tuple[float, float] = (6.4, 4.0),
    background: str | None = None,
) -> list[Path]:
    with _RENDER_LOCK:
        configure_matplotlib()
        if chart_id not in _RENDERERS:
            raise KeyError(chart_id)
        if len(figsize) != 2 or any(float(value) <= 0 for value in figsize):
            raise ValueError("figsize must contain two positive values")
        output_dir.mkdir(parents=True, exist_ok=True)
        fig = _RENDERERS[chart_id](palette)
        fig.set_size_inches(float(figsize[0]), float(figsize[1]), forward=True)
        facecolor = background or palette.background
        fig.patch.set_facecolor(facecolor)
        for ax in fig.axes:
            ax.set_facecolor(facecolor)
        if chart_id == "clustered-heatmap":
            fig.subplots_adjust(left=0.08, right=0.9, bottom=0.14, top=0.97)
        else:
            fig.tight_layout(pad=1.0)
        try:
            return _save_figure_formats(
                fig, output_dir, chart_id, formats=formats, dpi=dpi, background=facecolor,
            )
        finally:
            plt.close(fig)


def render_template(
    palette: Palette,
    template_id: str,
    output_dir: Path,
    *,
    formats: Iterable[str] = ("svg", "png"),
    dpi: int = 260,
    figsize: tuple[float, float] = (6.4, 4.0),
    background: str | None = None,
) -> list[Path]:
    """Render one Origin-inspired template using its registered local renderer."""
    template = TEMPLATES_BY_ID.get(template_id)
    if template is None:
        raise KeyError(template_id)
    with _RENDER_LOCK:
        configure_matplotlib()
        if len(figsize) != 2 or any(float(value) <= 0 for value in figsize):
            raise ValueError("figsize must contain two positive values")
        output_dir.mkdir(parents=True, exist_ok=True)
        fig = _RENDERERS[template.renderer](palette)
        fig.set_size_inches(float(figsize[0]), float(figsize[1]), forward=True)
        facecolor = background or palette.background
        fig.patch.set_facecolor(facecolor)
        for ax in fig.axes:
            ax.set_facecolor(facecolor)
        if template.renderer == "clustered-heatmap":
            fig.subplots_adjust(left=0.08, right=0.9, bottom=0.14, top=0.97)
        else:
            fig.tight_layout(pad=1.0)
        try:
            return _save_figure_formats(
                fig, output_dir, template_id, formats=formats, dpi=dpi, background=facecolor,
            )
        finally:
            plt.close(fig)


def _render_to_directory(palette: Palette, output_dir: Path, *, force: bool) -> list[Path]:
    rendered: list[Path] = []
    for spec in CHART_SPECS:
        svg_path = output_dir / f"{spec.id}.svg"
        png_path = output_dir / f"{spec.id}.png"
        if force or not svg_path.exists() or not png_path.exists():
            rendered.extend(render_chart(palette, spec.id, output_dir))
        else:
            rendered.extend((svg_path, png_path))
    return rendered


def render_palette(palette: Palette, *, force: bool = False) -> list[Path]:
    with _RENDER_LOCK:
        return _render_to_directory(palette, GENERATED_ROOT / palette.id, force=force)


def render_palette_selection(
    palette: Palette,
    indices: Iterable[int],
    extension_indices: Iterable[int] = (),
    *,
    force: bool = False,
) -> tuple[str, Palette, list[Path]]:
    normalized = normalize_indices(palette, indices, allow_empty=True)
    normalized_extensions = normalize_extension_indices(palette, extension_indices)
    key = selection_key(palette, normalized, normalized_extensions)
    selected = compose_palette(palette, normalized, normalized_extensions)
    output_dir = GENERATED_ROOT / palette.id if key == "all" else GENERATED_ROOT / palette.id / key
    with _RENDER_LOCK:
        paths = _render_to_directory(selected, output_dir, force=force)
    return key, selected, paths


def render_template_selection(
    palette: Palette,
    template_id: str,
    indices: Iterable[int],
    extension_indices: Iterable[int] = (),
    *,
    force: bool = False,
) -> tuple[str, Palette, list[Path]]:
    normalized = normalize_indices(palette, indices, allow_empty=True)
    normalized_extensions = normalize_extension_indices(palette, extension_indices)
    key = selection_key(palette, normalized, normalized_extensions)
    selected = compose_palette(palette, normalized, normalized_extensions)
    output_dir = GENERATED_ROOT / palette.id / "templates" / template_id if key == "all" else GENERATED_ROOT / palette.id / key / "templates" / template_id
    paths = [output_dir / f"{template_id}.svg", output_dir / f"{template_id}.png"]
    with _RENDER_LOCK:
        if force or not all(path.exists() for path in paths):
            render_template(selected, template_id, output_dir)
    return key, selected, paths


def render_all(*, force: bool = False) -> list[Path]:
    rendered: list[Path] = []
    for palette in load_palettes():
        rendered.extend(render_palette(palette, force=force))
    return rendered
