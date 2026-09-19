from __future__ import annotations

import csv
from datetime import datetime
import hashlib
from pathlib import Path
from typing import Any


SUPPORTED_SUFFIXES = {".csv", ".tsv"}
MISSING_MARKERS = {"", "na", "n/a", "nan", "null", "none"}


def _read_text(path: Path) -> tuple[str, str]:
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return path.read_text(encoding=encoding), encoding
        except UnicodeDecodeError:
            continue
    raise UnicodeDecodeError("utf-8", b"", 0, 1, f"无法解码数据文件: {path}")


def _delimiter(path: Path, text: str) -> str:
    if path.suffix.lower() == ".tsv":
        return "\t"
    try:
        return csv.Sniffer().sniff(text[:8192], delimiters=",\t;").delimiter
    except csv.Error:
        return ","


def _infer_type(values: list[str]) -> str:
    nonmissing = [value.strip() for value in values if value.strip().lower() not in MISSING_MARKERS]
    if not nonmissing:
        return "empty"
    lowered = {value.lower() for value in nonmissing}
    if lowered <= {"true", "false", "yes", "no", "0", "1"}:
        return "boolean"
    try:
        integers = [int(value) for value in nonmissing]
    except ValueError:
        integers = []
    if len(integers) == len(nonmissing):
        return "integer"
    try:
        numbers = [float(value) for value in nonmissing]
    except ValueError:
        numbers = []
    if len(numbers) == len(nonmissing):
        return "number"
    parsed_dates = 0
    for value in nonmissing:
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
            parsed_dates += 1
        except ValueError:
            pass
    if parsed_dates == len(nonmissing):
        return "datetime"
    return "string"


def analyze_data_file(data_file: str | Path, *, sample_rows: int = 5) -> dict[str, Any]:
    path = Path(data_file).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"数据文件不存在: {path}")
    if path.suffix.lower() not in SUPPORTED_SUFFIXES:
        raise ValueError(f"只支持 CSV/TSV: {path}")
    text, encoding = _read_text(path)
    delimiter = _delimiter(path, text)
    reader = csv.DictReader(text.splitlines(), delimiter=delimiter)
    headers = [str(item).strip() for item in (reader.fieldnames or [])]
    if not headers or any(not header for header in headers):
        raise ValueError(f"数据文件缺少有效表头: {path}")
    rows = [{header: str(row.get(header, "") or "") for header in headers} for row in reader]
    columns = []
    for header in headers:
        values = [row[header] for row in rows]
        missing = sum(value.strip().lower() in MISSING_MARKERS for value in values)
        columns.append({
            "name": header,
            "inferred_type": _infer_type(values),
            "missing_count": missing,
            "nonmissing_count": len(values) - missing,
            "unique_count": len({value for value in values if value.strip().lower() not in MISSING_MARKERS}),
            "sample_values": [value for value in values if value.strip()][:sample_rows],
        })
    raw = path.read_bytes()
    return {
        "path": str(path),
        "suffix": path.suffix.lower(),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "size_bytes": len(raw),
        "encoding": encoding,
        "delimiter": "\\t" if delimiter == "\t" else delimiter,
        "row_count": len(rows),
        "column_count": len(headers),
        "columns": columns,
        "numeric_columns": [item["name"] for item in columns if item["inferred_type"] in {"integer", "number"}
                            or (item["inferred_type"] == "boolean" and all(
                                row[item["name"]].strip() in {"0", "1"}
                                or row[item["name"]].strip().lower() in MISSING_MARKERS for row in rows))],
        "categorical_columns": [item["name"] for item in columns if item["inferred_type"] in {"string", "boolean"}],
        "sample_rows": rows[:sample_rows],
    }
