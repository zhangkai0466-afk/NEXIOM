from __future__ import annotations

import csv
import io
from pathlib import Path
from typing import Iterable

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LinearSegmentedColormap

from .models import Palette
from .templates import TEMPLATES_BY_ID


def parse_delimited_data(content: bytes, filename: str) -> tuple[list[str], dict[str, list[float]], list[list[str]]]:
    text = content.decode("utf-8-sig")
    delimiter = "\t" if Path(filename).suffix.lower() in {".tsv", ".tab"} else ","
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;")
        delimiter = dialect.delimiter
    except csv.Error:
        pass
    rows = list(csv.reader(io.StringIO(text), delimiter=delimiter))
    if len(rows) < 2:
        raise ValueError("数据文件必须包含表头和至少一行数据")
    headers = [str(item).strip() or f"Column {index + 1}" for index, item in enumerate(rows[0])]
    values: dict[str, list[float]] = {header: [] for header in headers}
    raw_rows: list[list[str]] = []
    for row in rows[1:]:
        if not row or not any(cell.strip() for cell in row):
            continue
        padded = row + [""] * (len(headers) - len(row))
        raw_rows.append(padded[: len(headers)])
        for header, item in zip(headers, padded):
            try:
                values[header].append(float(item.strip()))
            except (ValueError, TypeError):
                pass
    numeric = {key: value for key, value in values.items() if len(value) >= 2}
    if not numeric:
        raise ValueError("至少需要一列包含两个或更多有效值的数值数据")
    return headers, numeric, raw_rows


def _colors(palette: Palette, count: int) -> list[str]:
    return [palette.hex_colors[index % palette.count] for index in range(count)]


def _continuous_cmap(palette: Palette) -> LinearSegmentedColormap:
    colors = palette.hex_colors
    if len(colors) == 1:
        colors = colors * 2
    return LinearSegmentedColormap.from_list(f"{palette.id}-data-continuous", colors, N=256)


def _new_axes() -> tuple[plt.Figure, plt.Axes]:
    fig, ax = plt.subplots(figsize=(7.2, 4.5))
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")
    return fig, ax


def _finish(ax: plt.Axes) -> None:
    ax.grid(axis="y", color="#E3E5E7", linewidth=0.7, alpha=0.8)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.tick_params(colors="#44484D", labelsize=8.5)


def _is_axis_column(name: str) -> bool:
    normalized = name.lower().replace("_", " ").replace("-", " ")
    tokens = (
        "time", "day", "hour", "week", "month", "year", "sample", "observation",
        "index", "wavelength", "frequency", "distance", "dose", "angle", "batch",
        "时间", "天", "小时", "样本", "序号", "波长", "频率", "距离", "剂量", "批次",
    )
    return normalized.strip() == "x" or any(token in normalized for token in tokens)


def _split_axis(
    numeric: dict[str, list[float]],
) -> tuple[str | None, np.ndarray, dict[str, list[float]]]:
    columns = list(numeric)
    if len(columns) > 1 and _is_axis_column(columns[0]):
        series = {column: numeric[column] for column in columns[1:]}
        length = min(len(numeric[columns[0]]), *(len(values) for values in series.values()))
        return columns[0], np.asarray(numeric[columns[0]][:length]), {
            column: values[:length] for column, values in series.items()
        }
    length = min(len(values) for values in numeric.values())
    return None, np.arange(length), {column: values[:length] for column, values in numeric.items()}


def _display_node(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:g}"


def render_data_template(
    palette: Palette,
    template_id: str,
    numeric: dict[str, list[float]],
    output_dir: Path,
) -> tuple[list[Path], dict[str, object]]:
    template = TEMPLATES_BY_ID.get(template_id)
    if template is None:
        raise KeyError(template_id)
    columns = list(numeric)
    colors = _colors(palette, len(columns))
    fig, ax = _new_axes()
    family = template.family
    chart_mode = family
    finish_axes = True
    axis_column: str | None = None
    if family == "line":
        axis_column, x, series = _split_axis(numeric)
        colors = _colors(palette, len(series))
        for index, (column, values) in enumerate(series.items()):
            ax.plot(x, values, color=colors[index], linewidth=1.9, marker="o", markersize=3.2, label=column)
        ax.set_xlabel(axis_column or "Observation")
        ax.set_ylabel("Value")
    elif family == "scatter":
        x = np.array(numeric[columns[0]])
        for index, column in enumerate(columns[1:] or columns[:1]):
            y = np.array(numeric[column])
            size = min(len(x), len(y))
            ax.scatter(x[:size], y[:size], s=34, alpha=0.82, color=colors[index], edgecolors="white", linewidths=0.5, label=column)
        ax.set_xlabel(columns[0])
        ax.set_ylabel("Value")
    elif family == "bar":
        means = [float(np.mean(numeric[column])) for column in columns]
        errors = [float(np.std(numeric[column], ddof=1)) if len(numeric[column]) > 1 else 0.0 for column in columns]
        ax.bar(np.arange(len(columns)), means, yerr=errors, color=colors, capsize=4, edgecolor="none", error_kw={"ecolor": "#5B6066", "elinewidth": 0.9})
        ax.set_xticks(np.arange(len(columns)), columns, rotation=25, ha="right")
        ax.set_ylabel("Mean ± SD")
    elif family == "distribution":
        data = [numeric[column] for column in columns]
        bodies = ax.violinplot(data, showmedians=True, showextrema=True)
        for body, color in zip(bodies["bodies"], colors):
            body.set_facecolor(color)
            body.set_edgecolor("none")
            body.set_alpha(0.82)
        ax.set_xticks(np.arange(1, len(columns) + 1), columns, rotation=25, ha="right")
        ax.set_ylabel("Distribution")
    elif family == "matrix":
        matrix_columns = columns[1:] if len(columns) > 2 and _is_axis_column(columns[0]) else columns
        size = min(12, max(2, len(matrix_columns)))
        matrix = np.corrcoef(np.array([numeric[column][: min(map(len, numeric.values()))] for column in matrix_columns]))
        image = ax.imshow(
            matrix[:size, :size],
            cmap=_continuous_cmap(palette),
            vmin=-1,
            vmax=1,
            aspect="auto",
        )
        ax.set_xticks(range(size), matrix_columns[:size], rotation=35, ha="right")
        ax.set_yticks(range(size), matrix_columns[:size])
        colorbar = fig.colorbar(image, ax=ax, fraction=0.04, pad=0.03, label="Correlation")
        colorbar.outline.set_visible(False)
        for spine in colorbar.ax.spines.values():
            spine.set_visible(False)
    elif family == "area":
        axis_column, x, series = _split_axis(numeric)
        colors = _colors(palette, len(series))
        ax.stackplot(x, *series.values(), labels=series.keys(), colors=colors, alpha=0.84)
        ax.set_xlabel(axis_column or "Observation")
        ax.set_ylabel("Value")
    elif family == "polar":
        fig.delaxes(ax)
        ax = fig.add_subplot(111, projection="polar")
        id_column = columns[0] if len(columns) > 3 and ("id" in columns[0].lower() or "方案" in columns[0]) else None
        metric_columns = columns[1:] if id_column else columns
        length = min(len(numeric[column]) for column in columns)
        theta = np.linspace(0, 2 * np.pi, len(metric_columns), endpoint=False)
        closed_theta = np.append(theta, theta[0])
        profile_colors = _colors(palette, min(6, length))
        for row_index in range(min(6, length)):
            values = np.asarray([numeric[column][row_index] for column in metric_columns], dtype=float)
            closed_values = np.append(values, values[0])
            label = f"Profile {_display_node(numeric[id_column][row_index])}" if id_column else f"Profile {row_index + 1}"
            ax.plot(closed_theta, closed_values, color=profile_colors[row_index], linewidth=1.7, label=label)
            ax.fill(closed_theta, closed_values, color=profile_colors[row_index], alpha=0.08)
        ax.set_xticks(theta, metric_columns)
        ax.legend(loc="upper left", bbox_to_anchor=(1.04, 1.08), frameon=False, fontsize=7.5)
        chart_mode = "radar-comparison"
    elif family == "network":
        if len(columns) < 2:
            raise ValueError("网络关系图至少需要源节点列和目标节点列")
        length = min(map(len, numeric.values()))
        sources = np.asarray(numeric[columns[0]][:length])
        targets = np.asarray(numeric[columns[1]][:length])
        weights = np.asarray(numeric[columns[2]][:length]) if len(columns) > 2 else np.ones(length)
        nodes = sorted(set(sources.tolist()) | set(targets.tolist()))
        theta = np.linspace(0, 2 * np.pi, len(nodes), endpoint=False)
        positions = {node: (np.cos(angle), np.sin(angle)) for node, angle in zip(nodes, theta)}
        weight_span = float(np.ptp(weights)) or 1.0
        edge_colors = _colors(palette, length)
        for index, (source, target, weight) in enumerate(zip(sources, targets, weights)):
            start, end = positions[source], positions[target]
            width = 0.7 + 2.8 * (float(weight) - float(weights.min())) / weight_span
            ax.plot([start[0], end[0]], [start[1], end[1]], color=edge_colors[index], linewidth=width, alpha=0.42, zorder=1)
        node_colors = _colors(palette, len(nodes))
        ax.scatter([positions[node][0] for node in nodes], [positions[node][1] for node in nodes], s=260, c=node_colors, edgecolors="white", linewidths=1.2, zorder=3)
        for node in nodes:
            x_pos, y_pos = positions[node]
            ax.text(x_pos, y_pos, _display_node(node), ha="center", va="center", fontsize=8, color="#263238", zorder=4)
        ax.set_aspect("equal")
        ax.axis("off")
        finish_axes = False
        chart_mode = "weighted-network"
    elif family == "survival":
        axis_column, x, series = _split_axis(numeric)
        colors = _colors(palette, len(series))
        for index, (column, values) in enumerate(series.items()):
            ax.step(x, values, where="post", color=colors[index], linewidth=2.0, label=column)
        if all(0 <= value <= 1.05 for values in series.values() for value in values):
            ax.set_ylim(0, 1.05)
        ax.set_xlabel(axis_column or "Time")
        ax.set_ylabel("Survival probability")
        chart_mode = "survival-step"
    elif family == "scientific":
        axis_column, x, series = _split_axis(numeric)
        colors = _colors(palette, len(series))
        for index, (column, values) in enumerate(series.items()):
            normalized = column.lower()
            if "observed" in normalized or "signal" in normalized or "观测" in normalized:
                ax.plot(x, values, color="#555B61", linewidth=1.15, alpha=0.75, label=column)
            elif "fit" in normalized or "total" in normalized or "拟合" in normalized:
                ax.plot(x, values, color=colors[index], linewidth=2.25, label=column, zorder=4)
            else:
                ax.plot(x, values, color=colors[index], linewidth=1.1, linestyle="--", alpha=0.9, label=column)
                ax.fill_between(x, 0, values, color=colors[index], alpha=0.06)
        ax.set_xlabel(axis_column or "Scientific coordinate")
        ax.set_ylabel("Signal intensity")
        chart_mode = "spectral-components"
    elif family == "multivariate":
        id_column = columns[0] if len(columns) > 3 and ("id" in columns[0].lower() or "方案" in columns[0]) else None
        metric_columns = columns[1:] if id_column else columns
        length = min(len(numeric[column]) for column in columns)
        normalized = []
        for column in metric_columns:
            values = np.array(numeric[column][:length])
            span = np.ptp(values) or 1.0
            normalized.append((values - values.min()) / span)
        for index, row in enumerate(np.array(normalized).T[: min(80, length)]):
            ax.plot(np.arange(len(metric_columns)), row, color=colors[index % len(colors)], alpha=0.28, linewidth=0.8)
        ax.set_xticks(np.arange(len(metric_columns)), metric_columns, rotation=30, ha="right")
        ax.set_ylabel("Normalized value")
        ax.set_ylim(0, 1)
        chart_mode = "parallel-coordinates"
    elif family == "control":
        axis_column, x, series = _split_axis(numeric)
        colors = _colors(palette, len(series))
        limit_tokens = ("ucl", "lcl", "center", "mean", "limit", "上限", "下限", "中心")
        measurement_items = [(column, values) for column, values in series.items() if not any(token in column.lower() for token in limit_tokens)]
        limit_items = [(column, values) for column, values in series.items() if any(token in column.lower() for token in limit_tokens)]
        if not measurement_items:
            measurement_items = list(series.items())[:1]
            limit_items = []
        for index, (column, values) in enumerate(measurement_items):
            ax.plot(x, values, color=colors[index], linewidth=1.7, marker="o", markersize=3.8, label=column, zorder=3)
        if limit_items:
            for index, (column, values) in enumerate(limit_items):
                is_center = "center" in column.lower() or "mean" in column.lower() or "中心" in column
                ax.plot(x, values, color="#596168" if is_center else "#A14848", linewidth=1.15, linestyle="-" if is_center else "--", label=column)
        else:
            values = np.asarray(measurement_items[0][1])
            center = float(values.mean())
            sigma = float(values.std(ddof=1)) if len(values) > 1 else 0.0
            ax.axhline(center, color="#596168", linewidth=1.15, label="Center")
            ax.axhline(center + 3 * sigma, color="#A14848", linestyle="--", linewidth=1.15, label="UCL")
            ax.axhline(center - 3 * sigma, color="#A14848", linestyle="--", linewidth=1.15, label="LCL")
        ax.set_xlabel(axis_column or "Sample")
        ax.set_ylabel("Process measurement")
        chart_mode = "control-limits"
    else:
        for index, (column, values) in enumerate(numeric.items()):
            ax.hist(values, bins=16, alpha=0.35, color=colors[index], label=column)
        ax.set_xlabel("Value")
        ax.set_ylabel("Count")
    if len(columns) > 1 and family not in {"matrix", "polar", "multivariate", "network"}:
        ax.legend(frameon=False, fontsize=8)
    if finish_axes and family != "polar":
        _finish(ax)
    fig.tight_layout(pad=1.1)
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = [output_dir / f"{template_id}.svg", output_dir / f"{template_id}.png"]
    fig.savefig(paths[0], facecolor="white")
    fig.savefig(paths[1], dpi=260, facecolor="white")
    plt.close(fig)
    return paths, {
        "columns": columns,
        "row_count": min(len(values) for values in numeric.values()),
        "family": family,
        "chart_mode": chart_mode,
        "axis_column": axis_column,
    }
