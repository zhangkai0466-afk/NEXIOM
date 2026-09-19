from __future__ import annotations

import ast
import io
import re
import tokenize
from dataclasses import dataclass

from .models import Palette


HEX_PATTERN = re.compile(r"(?<![0-9A-Fa-f])#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})(?![0-9A-Fa-f])")
MAX_SOURCE_BYTES = 1_000_000


@dataclass(frozen=True)
class ColorReplacement:
    original: str
    replacement: str
    occurrences: int


def _source_lines(source: str) -> list[str]:
    return source.splitlines(keepends=True) or [""]


def _absolute_offsets(source: str) -> list[int]:
    offsets = [0]
    for line in _source_lines(source):
        offsets.append(offsets[-1] + len(line))
    return offsets


def _token_span(offsets: list[int], start: tuple[int, int], end: tuple[int, int]) -> tuple[int, int]:
    return offsets[start[0] - 1] + start[1], offsets[end[0] - 1] + end[1]


def _hex_tokens(source: str) -> list[tuple[int, int, str]]:
    offsets = _absolute_offsets(source)
    tokens: list[tuple[int, int, str]] = []
    try:
        stream = tokenize.generate_tokens(io.StringIO(source).readline)
        for token in stream:
            if token.type != tokenize.STRING:
                continue
            start, end = _token_span(offsets, token.start, token.end)
            value = source[start:end]
            for match in HEX_PATTERN.finditer(value):
                tokens.append((start + match.start(), start + match.end(), match.group(0)))
    except (IndentationError, SyntaxError, tokenize.TokenError):
        # Syntax validation is performed by recolor_source; this keeps the
        # scanner useful for returning a precise error from the API.
        return []
    return tokens


def _normalise_hex(value: str) -> str:
    if len(value) == 4:
        return "#" + "".join(channel * 2 for channel in value[1:]).upper()
    return value.upper()


def recolor_source(source: str, palette: Palette) -> tuple[str, list[ColorReplacement], list[str]]:
    """Replace HEX colors inside Python string literals without executing source."""
    encoded_size = len(source.encode("utf-8"))
    if encoded_size > MAX_SOURCE_BYTES:
        raise ValueError("Python 源码不能超过 1 MB")
    try:
        ast.parse(source)
    except (IndentationError, SyntaxError) as exc:
        location = f"第 {exc.lineno} 行" if exc.lineno else ""
        raise ValueError(f"Python 源码语法无效{location}：{exc.msg}") from exc

    tokens = _hex_tokens(source)
    ordered_colors: list[str] = []
    counts: dict[str, int] = {}
    for _, _, original in tokens:
        key = _normalise_hex(original)
        counts[key] = counts.get(key, 0) + 1
        if key not in ordered_colors:
            ordered_colors.append(key)

    palette_colors = [color.upper() for color in palette.hex_colors]
    if not ordered_colors:
        return source, [], ["未识别到字符串中的 HEX 颜色；命名色和运行时生成的颜色未做改写。"]

    mapping = {
        original: palette_colors[index % len(palette_colors)]
        for index, original in enumerate(ordered_colors)
    }
    replacements = [
        ColorReplacement(original, mapping[original], counts[original])
        for original in ordered_colors
    ]
    warnings: list[str] = []
    if len(ordered_colors) > len(palette_colors):
        warnings.append(f"源码包含 {len(ordered_colors)} 种颜色，已循环使用当前 {len(palette_colors)} 色色库。")

    rewritten = source
    for start, end, original in reversed(tokens):
        rewritten = rewritten[:start] + mapping[_normalise_hex(original)] + rewritten[end:]
    return rewritten, replacements, warnings
