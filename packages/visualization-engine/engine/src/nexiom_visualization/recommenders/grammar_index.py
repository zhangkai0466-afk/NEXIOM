from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from ..template_registry import TEMPLATE_REGISTRY


def _index_path() -> Path:
    return Path(__file__).resolve().parents[3] / "corpus" / "visual_grammar_index.json"


def _origin_path() -> Path:
    return Path(__file__).resolve().parents[3] / "corpus" / "originlab_graph_catalog.json"


def _research_reference_path() -> Path:
    return Path(__file__).resolve().parents[3] / "corpus" / "research_plot_reference_inventory.json"


def _normalized(value: str) -> str:
    return re.sub(r"[\s_\-/–—()（）]+", "", str(value).lower())


def _entries() -> list[dict[str, Any]]:
    payload = json.loads(_index_path().read_text(encoding="utf-8"))
    discovery = [{
        **item,
        "status": "name_index_only",
        "template_id": "",
        "catalog_source": "curated_scientific_name_index",
        "data_shape": item.get("data_shape", "必须提供与该图语义对应的真实观测、分组或统计量，不得由图名反推数据。"),
        "use_when": item.get("use_when", item["reader_question"]),
        "avoid_when": item.get("avoid_when", "数据结构或统计前提不满足，或该读者问题可由更简单的图表直接回答。"),
    } for item in payload["entries"]]
    origin_payload = json.loads(_origin_path().read_text(encoding="utf-8"))
    origin = []
    for group in origin_payload["groups"]:
        for graph_type in group["types"]:
            origin.append({
                "name": graph_type,
                "aliases": [],
                "family": group["family"],
                "reader_question": group["use_when"],
                "status": "name_index_only",
                "template_id": "",
                "catalog_source": "originlab_official_graphing",
                "origin_group": group["name"],
                "data_shape": group["data_shape"],
                "use_when": group["use_when"],
                "avoid_when": group["avoid_when"],
                "source_url": origin_payload["source"]["url"],
            })
    reference_payload = json.loads(_research_reference_path().read_text(encoding="utf-8"))
    appearance_payload = json.loads((_research_reference_path().parent / "reference_appearance_audit.json").read_text(encoding="utf-8"))
    appearances = {item["image"]: item for item in appearance_payload["entries"]}
    references = [{
        **item,
        "aliases": item.get("aliases", []),
        "catalog_source": "user_research_plot_reference",
        "source_image": item.get("image", ""),
        **appearances.get(item.get("image"), {}).get("catalogue_override", {}),
        "reference_variants": [appearances[item["image"]]] if item.get("image") in appearances else [],
    } for item in reference_payload["entries"]]
    additional = appearance_payload.get("additional_reference")
    if additional:
        references.append({
            "name": additional["name"], "aliases": ["浅填充深描边", "空心散点分组柱"],
            "family": "comparison", "reader_question": "组间摘要差异是否掩盖原始观测的离散？",
            "data_shape": "类别、组别、逐观测数值；区间及检验另需明确计算依据。",
            "use_when": "同时需要类别摘要和原始点，且柱高统计量明确。",
            "avoid_when": additional["caution"], "status": "name_index_only", "template_id": "",
            "related_template_id": additional["related_template_id"],
            "catalog_source": "user_research_plot_reference", "source_image": additional["image"],
            "reference_variants": [additional],
        })
    executable = []
    for template_id, spec in TEMPLATE_REGISTRY.items():
        executable.append({
            "name": spec["description"],
            "aliases": [template_id, *spec.get("keywords", [])],
            "family": spec["family"],
            "reader_question": spec["reader_question"],
            "status": "executable",
            "template_id": template_id,
            "catalog_source": "local_jinja_manifest",
            "data_shape": spec.get("data_shape", {}),
            "use_when": spec["reader_question"],
            "avoid_when": "；".join(spec.get("forbidden_use_cases", [])),
            "statistical_preconditions": spec.get("statistical_preconditions", []),
            "forbidden_use_cases": spec.get("forbidden_use_cases", []),
        })
    merged: dict[str, dict[str, Any]] = {}
    for entry in [*executable, *references, *discovery, *origin]:
        key = _normalized(entry["name"])
        if key not in merged:
            merged[key] = {**entry, "catalog_sources": [entry["catalog_source"]]}
            continue
        current = merged[key]
        current.setdefault("reference_variants", []).extend(entry.get("reference_variants", []))
        current["catalog_sources"] = list(dict.fromkeys([*current.get("catalog_sources", []), entry["catalog_source"]]))
        current["aliases"] = list(dict.fromkeys([*current.get("aliases", []), *entry.get("aliases", [])]))
        if entry["status"] == "executable" and current["status"] != "executable":
            preserved_sources = current["catalog_sources"]
            merged[key] = {**entry, "catalog_sources": preserved_sources}
        elif entry["catalog_source"] == "originlab_official_graphing" and current["status"] != "executable":
            for field in ("origin_group", "source_url", "data_shape", "use_when", "avoid_when"):
                current[field] = entry[field]
        else:
            for field in ("origin_group", "source_url", "data_shape", "use_when", "avoid_when"):
                if entry.get(field) and not current.get(field):
                    current[field] = entry[field]
    # A reference screenshot may give an executable template a second, more
    # colloquial name.  Keep that vocabulary as aliases, but count/render the
    # template only once by its stable template_id.
    consolidated: list[dict[str, Any]] = []
    executable_by_id: dict[str, dict[str, Any]] = {}
    for entry in merged.values():
        template_id = str(entry.get("template_id", ""))
        if entry.get("status") != "executable" or not template_id:
            consolidated.append(entry)
            continue
        if template_id not in executable_by_id:
            executable_by_id[template_id] = entry
            consolidated.append(entry)
            continue
        target = executable_by_id[template_id]
        target.setdefault("reference_variants", []).extend(entry.get("reference_variants", []))
        target["aliases"] = list(dict.fromkeys([
            *target.get("aliases", []), entry.get("name", ""), *entry.get("aliases", []),
        ]))
        target["catalog_sources"] = list(dict.fromkeys([
            *target.get("catalog_sources", []), *entry.get("catalog_sources", []),
        ]))
        if entry.get("source_image"):
            target.setdefault("reference_images", []).append(entry["source_image"])
    return consolidated


def search_visual_grammar_terms(query: str = "", limit: int = 20, executable_only: bool = False) -> dict[str, Any]:
    from .research_cards import research_cards
    terms = [_normalized(term) for term in re.split(r"[\s,，;；]+", query.strip()) if term.strip()]
    ranked = []
    for entry in research_cards():
        if executable_only and entry["status"] != "executable":
            continue
        searchable = _normalized(" ".join([entry["name"], entry["family"], entry["reader_question"], entry["contribution"], entry["preparation"], *entry.get("aliases", []), json.dumps(entry.get("reference_variants", []), ensure_ascii=False)]))
        if terms and not all(term in searchable for term in terms):
            continue
        exact_alias = any(_normalized(query) == _normalized(alias) for alias in [entry["name"], *entry.get("aliases", [])])
        score = 100 if exact_alias else sum(10 for term in terms if term in searchable)
        ranked.append((score, entry["status"] == "executable", entry))
    ranked.sort(key=lambda item: (-item[0], -int(item[1]), item[2]["name"]))
    results = [item[2] for item in ranked[: max(1, min(int(limit), 100))]]
    return {
        "schema_version": "visual_grammar_search/1.0.0",
        "query": query,
        "result_count": len(results),
        "total_indexed": len(_entries()),
        "results": results,
        "status_meaning": {
            "executable": "已有确定性Jinja模板，可在证据列满足时直接生成",
            "name_index_only": "已知图名与用途，但尚未承诺本地模板；模型可据此提出扩展请求",
        },
        "selection_rule": "先问读者问题，再核验证据形状和统计前提；偏好样式只在论证适配的候选中比较，不保证入选、不为用图造数据。executable仅指基础模板，参考外观是否实现须另看reference_variants。",
    }


def full_visual_grammar_catalogue() -> list[dict[str, Any]]:
    """Unpaginated inventory for exhaustive local planning, unlike UI search."""
    return _entries()


def visual_grammar_index_summary() -> dict[str, Any]:
    entries = _entries()
    raw_sources = [
        *json.loads(_index_path().read_text(encoding="utf-8"))["sources"],
        json.loads(_origin_path().read_text(encoding="utf-8"))["source"],
    ]
    sources = list({item["url"]: item for item in raw_sources}.values())
    return {
        "schema_version": "visual_grammar_index_summary/1.0.0",
        "total_indexed": len(entries),
        "executable_count": sum(item["status"] == "executable" for item in entries),
        "name_index_only_count": sum(item["status"] == "name_index_only" for item in entries),
        "originlab_official_type_count": sum("originlab_official_graphing" in item.get("catalog_sources", []) for item in entries),
        "user_reference_image_count": len(json.loads(_research_reference_path().read_text(encoding="utf-8"))["entries"]),
        "families": sorted({item["family"] for item in entries}),
        "official_origin_claim": "OriginLab官方当前表述为 over 100 built-in graph types，不是固定108个模板。",
        "sources": sources,
    }
